import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';

// ---------------------------------------------------------------------------
// PostFX — one hand-rolled fullscreen pass (no EffectComposer):
//   * blast ripples: radial screen-space distortion rings from explosions
//   * grade: gentle saturation/contrast lift, soft glow, vignette
// The scene renders into a multisampled RT, then the quad shader writes to
// the canvas. One extra pass, trivially cheap on anything with a GPU.
// ---------------------------------------------------------------------------

const MAX_RIPPLES = 4;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const QUAD_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform float uTime;
  uniform float uAspect;
  uniform float uGlow;       // soft bloom-ish lift (night/neon tracks)
  // ripples: xy = screen uv centre, z = age 0..1, w = strength
  uniform vec4 uRipples[${MAX_RIPPLES}];

  void main() {
    vec2 uv = vUv;

    // --- explosion shockwaves: expanding rings of radial displacement
    for (int i = 0; i < ${MAX_RIPPLES}; i++) {
      vec4 r = uRipples[i];
      if (r.w <= 0.001) continue;
      vec2 d = vUv - r.xy;
      d.x *= uAspect;
      float dist = length(d);
      float radius = r.z * 0.55;                       // grows across the screen
      float ring = exp(-pow((dist - radius) * 22.0, 2.0));
      float fade = (1.0 - r.z);
      uv += normalize(d + 1e-5) * ring * fade * r.w * 0.022 / uAspect;
    }

    vec3 col = texture2D(tDiffuse, uv).rgb;

    // --- grade: soft glow lift (neon pops at night), saturation, contrast
    col += col * col * uGlow;
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, 1.08);                  // +8% saturation
    col = mix(col, smoothstep(0.0, 1.0, col), 0.22);   // gentle s-curve

    // --- vignette (gentle)
    vec2 vd = vUv - 0.5;
    col *= 1.0 - dot(vd, vd) * 0.32;

    gl_FragColor = vec4(col, 1.0);
    // the offscreen pass skips the renderer's canvas colorspace step, so
    // convert linear -> sRGB here or the whole game renders gamma-dark
    #include <colorspace_fragment>
  }
`;

export class PostFX {
  constructor(renderer, width, height, opts = {}) {
    this.renderer = renderer;
    const pr = renderer.getPixelRatio();
    this.rt = new THREE.WebGLRenderTarget(width * pr, height * pr, {
      samples: 4, // keep MSAA through the offscreen pass
    });
    this.uniforms = {
      tDiffuse: { value: this.rt.texture },
      uTime: { value: 0 },
      uAspect: { value: width / Math.max(1, height) },
      uGlow: { value: opts.night ? 0.33 : 0.10 },
      uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, 1, 0)) },
    };
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: QUAD_FRAG,
      uniforms: this.uniforms, depthWrite: false, depthTest: false,
    });
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    this.ripples = this.uniforms.uRipples.value;
    this.rippleIdx = 0;
    this._v = new THREE.Vector3();
  }

  resize(width, height) {
    const pr = this.renderer.getPixelRatio();
    this.rt.setSize(width * pr, height * pr);
    this.uniforms.uAspect.value = width / Math.max(1, height);
  }

  // project a world-space blast onto the screen and start a ripple there
  rippleAt(worldPos, camera, strength = 1) {
    this._v.set(worldPos.x, worldPos.y, worldPos.z).project(camera);
    if (this._v.z > 1 || this._v.z < -1) return; // behind the camera
    const r = this.ripples[this.rippleIdx];
    this.rippleIdx = (this.rippleIdx + 1) % MAX_RIPPLES;
    r.set((this._v.x + 1) / 2, (this._v.y + 1) / 2, 0, strength);
  }

  render(scene, camera, dt) {
    this.uniforms.uTime.value += dt;
    for (const r of this.ripples) {
      if (r.w > 0.001) {
        r.z += dt * 1.6; // ring expansion over ~0.6 s
        if (r.z >= 1) r.set(0, 0, 1, 0);
      }
    }
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  dispose() {
    this.rt.dispose();
  }
}

// ---------------------------------------------------------------------------
// GroundDepth — a cheap half-res depth-only prepass over just the ground
// geometry (road, shoulders, terrain strips, water; everything tagged on
// layer 1). Particle shaders sample it to fade out where they'd otherwise
// slice through the ground — classic soft particles, without needing the
// main pass's (multisampled) depth buffer.
// ---------------------------------------------------------------------------

export class GroundDepth {
  constructor(renderer, width, height) {
    this.renderer = renderer;
    const pr = renderer.getPixelRatio();
    this.rt = new THREE.WebGLRenderTarget(
      Math.max(2, Math.floor(width * pr / 2)), Math.max(2, Math.floor(height * pr / 2)));
    this.rt.depthTexture = new THREE.DepthTexture(this.rt.width, this.rt.height);
    // gl_FragCoord in the MAIN pass runs over the full-res target — the
    // particle shaders divide by this to get screen UVs
    this.screen = new THREE.Vector2(width * pr, height * pr);
    this.override = new THREE.MeshBasicMaterial();
    this.override.colorWrite = false; // depth only
  }

  resize(width, height) {
    const pr = this.renderer.getPixelRatio();
    this.rt.setSize(Math.max(2, Math.floor(width * pr / 2)), Math.max(2, Math.floor(height * pr / 2)));
    this.rt.depthTexture.image.width = this.rt.width;
    this.rt.depthTexture.image.height = this.rt.height;
    this.screen.set(width * pr, height * pr);
  }

  render(scene, camera) {
    const r = this.renderer;
    const prevOverride = scene.overrideMaterial;
    const prevFog = scene.fog;
    scene.overrideMaterial = this.override;
    scene.fog = null;
    camera.layers.set(1);
    r.setRenderTarget(this.rt);
    r.render(scene, camera);
    r.setRenderTarget(null);
    camera.layers.set(0);
    scene.overrideMaterial = prevOverride;
    scene.fog = prevFog;
  }

  dispose() {
    this.rt.dispose();
  }
}

// shared GLSL: linearize a perspective depth value to view-space z
const SOFT_GLSL = /* glsl */ `
  uniform sampler2D tGDepth;
  uniform vec2 uScreen;
  uniform vec3 uSoftP; // near, far, fade distance (m)
  float sdViewZ(float d, float n, float f) { return (n * f) / ((f - n) * d - f); }
  float softFade() {
    float sd = texture2D(tGDepth, gl_FragCoord.xy / uScreen).x;
    float sceneZ = sdViewZ(sd, uSoftP.x, uSoftP.y);
    float fragZ = sdViewZ(gl_FragCoord.z, uSoftP.x, uSoftP.y);
    return clamp((fragZ - sceneZ) / uSoftP.z, 0.0, 1.0);
  }
`;

// retrofit soft-particle fade onto a stock three.js material (PointsMaterial
// etc.) — fades fragments approaching tagged ground geometry
export function makeSoft(mat, gdepth, camera, softDist = 1.2) {
  const additive = mat.blending === THREE.AdditiveBlending;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tGDepth = { value: gdepth.rt.depthTexture };
    sh.uniforms.uScreen = { value: gdepth.screen };
    sh.uniforms.uSoftP = { value: new THREE.Vector3(camera.near, camera.far, softDist) };
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', SOFT_GLSL + '\nvoid main() {')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        {
          float soft = softFade();
          gl_FragColor.a *= soft;
          ${additive ? 'gl_FragColor.rgb *= soft;' : ''}
        }`);
  };
  mat.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// ExplosionFX — world-space detail for every blast:
//   * fireball: noise-displaced shader sphere, white-hot core rolling over
//     to orange then gone (~0.7 s)
//   * shockwave: flat expanding additive ring hugging the ground
// Meshes are pooled; Game calls spawn() from every explosion site.
// ---------------------------------------------------------------------------

const FIRE_VERT = /* glsl */ `
  uniform float uAge;
  varying float vNoise;
  varying vec3 vNormal;
  // cheap 3D wobble — three sine fields beat against each other
  float wob(vec3 p, float t) {
    return sin(p.x * 5.1 + t * 9.0) * sin(p.y * 4.3 - t * 7.0) * sin(p.z * 4.7 + t * 8.0);
  }
  void main() {
    vNormal = normal;
    float n = wob(position, uAge * 2.0);
    vNoise = n;
    vec3 p = position * (1.0 + uAge * 1.9) + normal * n * (0.25 + uAge * 0.55);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FIRE_FRAG = /* glsl */ `
  precision highp float;
  uniform float uAge;
  uniform sampler2D tGDepth;
  uniform vec2 uScreen;
  uniform vec3 uSoftP;
  varying float vNoise;
  varying vec3 vNormal;
  float fbViewZ(float d, float n, float f) { return (n * f) / ((f - n) * d - f); }
  void main() {
    // white-hot core -> orange -> deep red as it ages; noise mottles it
    vec3 hot = vec3(1.0, 0.97, 0.75);
    vec3 mid = vec3(1.0, 0.45, 0.08);
    vec3 old = vec3(0.45, 0.08, 0.02);
    vec3 col = mix(hot, mid, smoothstep(0.0, 0.45, uAge + vNoise * 0.15));
    col = mix(col, old, smoothstep(0.45, 0.95, uAge + vNoise * 0.1));
    float alpha = (1.0 - uAge) * (0.9 - vNoise * 0.25);
    // soft fade against the ground so the dome never slices the road
    float sd = texture2D(tGDepth, gl_FragCoord.xy / uScreen).x;
    float soft = clamp((fbViewZ(gl_FragCoord.z, uSoftP.x, uSoftP.y)
      - fbViewZ(sd, uSoftP.x, uSoftP.y)) / uSoftP.z, 0.0, 1.0);
    gl_FragColor = vec4(col * soft, max(alpha, 0.0) * soft);
  }
`;

const POOL = 4;

export class ExplosionFX {
  constructor(scene, gdepth, camera) {
    this.scene = scene;
    this.items = [];
    const ringGeo = new THREE.RingGeometry(0.82, 1.0, 40);
    const ballGeo = new THREE.SphereGeometry(1, 20, 16);
    for (let i = 0; i < POOL; i++) {
      const fireMat = new THREE.ShaderMaterial({
        vertexShader: FIRE_VERT, fragmentShader: FIRE_FRAG,
        uniforms: {
          uAge: { value: 1 },
          tGDepth: { value: gdepth.rt.depthTexture },
          uScreen: { value: gdepth.screen },
          uSoftP: { value: new THREE.Vector3(camera.near, camera.far, 2.2) },
        },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const ball = new THREE.Mesh(ballGeo, fireMat);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffcc88, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ball.visible = ring.visible = false;
      scene.add(ball, ring);
      this.items.push({ ball, ring, fireMat, ringMat, age: 1, scale: 1 });
    }
    this.next = 0;
  }

  spawn(p, scale = 1, air = false) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % POOL;
    it.age = 0;
    it.scale = scale;
    it.air = air;
    it.ball.position.set(p.x, p.y + (air ? 0 : 0.6 * scale), p.z);
    it.ball.scale.setScalar(1.6 * scale);
    it.ball.visible = true;
    if (air) {
      it.ring.visible = false; // a flak burst owns no patch of ground
    } else {
      it.ring.position.set(p.x, Math.max(p.y - 0.8, 0.15) + 0.25, p.z);
      it.ring.scale.setScalar(0.5);
      it.ring.visible = true;
    }
  }

  update(dt) {
    for (const it of this.items) {
      if (it.age >= 1) continue;
      it.age = Math.min(1, it.age + dt / 0.7);
      it.fireMat.uniforms.uAge.value = it.age;
      // the ring races outward ahead of the fireball and thins out
      it.ring.scale.setScalar(0.5 + it.age * 16 * it.scale);
      it.ringMat.opacity = 0.85 * (1 - it.age) * (1 - it.age);
      if (it.age >= 1) it.ball.visible = it.ring.visible = false;
      if (it.air) it.ring.visible = false;
    }
  }
}

// ---------------------------------------------------------------------------
// StreakField — instanced tapered glow streaks. Each instance is a quad
// stretched between a tail and head point, expanded PERPENDICULAR IN VIEW
// SPACE (always faces the camera), tapering toward the tail with a soft
// cross-section and a bright head. Replaces the old instanced-box ribbons,
// which showed their hard geometry edges from every angle.
// ---------------------------------------------------------------------------

const STREAK_VERT = /* glsl */ `
  attribute vec3 aTail;
  attribute vec3 aHead;
  attribute vec3 aCol;
  attribute float aWidth;
  varying vec2 vUv;
  varying vec3 vCol;
  void main() {
    vUv = uv;
    vCol = aCol;
    vec4 t4 = modelViewMatrix * vec4(aTail, 1.0);
    vec4 h4 = modelViewMatrix * vec4(aHead, 1.0);
    vec3 p = mix(t4.xyz, h4.xyz, uv.x);
    vec2 d = h4.xy - t4.xy;
    float L = length(d);
    vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
    vec2 perp = vec2(-dir.y, dir.x);
    p.xy += perp * (uv.y - 0.5) * aWidth * (0.35 + 0.65 * uv.x);
    gl_Position = projectionMatrix * vec4(p, 1.0);
  }
`;

const STREAK_FRAG = /* glsl */ `
  precision highp float;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vCol;
  void main() {
    float across = 1.0 - abs(vUv.y * 2.0 - 1.0);   // soft cross-section
    float tailFade = 0.15 + 0.85 * vUv.x;           // dim tail -> bright head
    float headCap = 1.0 - smoothstep(0.86, 1.0, vUv.x) * (1.0 - across); // rounded tip
    float a = pow(across, 1.7) * tailFade * headCap * uOpacity;
    gl_FragColor = vec4(vCol, a);
  }
`;

export class StreakField {
  constructor(scene, count, opts = {}) {
    this.count = count;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    this.tailA = new Float32Array(count * 3);
    this.headA = new Float32Array(count * 3);
    this.colA = new Float32Array(count * 3);
    this.widthA = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.tailA[i * 3 + 1] = -999;
      this.headA[i * 3 + 1] = -999;
    }
    geo.setAttribute('aTail', new THREE.InstancedBufferAttribute(this.tailA, 3));
    geo.setAttribute('aHead', new THREE.InstancedBufferAttribute(this.headA, 3));
    geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(this.colA, 3));
    geo.setAttribute('aWidth', new THREE.InstancedBufferAttribute(this.widthA, 1));
    geo.instanceCount = count;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG,
      uniforms: { uOpacity: { value: opts.opacity ?? 1 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: opts.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 5;
    scene.add(this.mesh);
    this.geo = geo;
  }

  set(i, tx, ty, tz, hx, hy, hz, r, g, b, w) {
    const o = i * 3;
    this.tailA[o] = tx; this.tailA[o + 1] = ty; this.tailA[o + 2] = tz;
    this.headA[o] = hx; this.headA[o + 1] = hy; this.headA[o + 2] = hz;
    this.colA[o] = r; this.colA[o + 1] = g; this.colA[o + 2] = b;
    this.widthA[i] = w;
  }

  hide(i) {
    const o = i * 3;
    this.tailA[o + 1] = this.headA[o + 1] = -999;
    this.widthA[i] = 0;
  }

  commit() {
    this.geo.attributes.aTail.needsUpdate = true;
    this.geo.attributes.aHead.needsUpdate = true;
    this.geo.attributes.aCol.needsUpdate = true;
    this.geo.attributes.aWidth.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// BlastStorm — the war-zone particle storm layered onto every explosion:
//   * embers: hundreds of additive sparks fading white->orange->red->out
//     (vertex-color fade: additive black == invisible, so each ember dims
//     individually with zero shader work)
//   * dirt: heavy brown debris fountaining up and raining back down, dying
//     where it lands
//   * shrapnel: glowing chunks stretched along their velocity — white-hot
//     streaks that arc, slow, and gutter out
// One pooled set of buffers shared by all blasts; also feeds rocket trails
// and burning wrecks so the whole battlefield keeps smouldering.
// ---------------------------------------------------------------------------

const EMBER_N = 900, DIRT_N = 600, SHRAP_N = 110;

// soft round sprite for point particles — the default PointsMaterial square
// reads as a hard box the moment particles get big or close
let _hardDot = null;
export function hardDotTexture() {
  if (_hardDot) return _hardDot;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.42, 'rgba(255,255,255,1)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  _hardDot = new THREE.CanvasTexture(c);
  return _hardDot;
}

let _softDot = null;
export function softDotTexture() {
  if (_softDot) return _softDot;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.72)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _softDot = new THREE.CanvasTexture(c);
  return _softDot;
}

export class BlastStorm {
  constructor(scene) {
    // --- embers: a bright head point + a RIBBON tail — an instanced thin
    // box stretched from the lagging tail point to the head, so the trail
    // has real world-space width (GL lines are stuck at 1px) and bends
    // with the particle's arc
    this.eGeo = new THREE.BufferGeometry();
    this.ePos = new Float32Array(EMBER_N * 3);
    this.eVel = new Float32Array(EMBER_N * 3);
    this.eTail = new Float32Array(EMBER_N * 3);
    this.eLife = new Float32Array(EMBER_N);
    this.eMax = new Float32Array(EMBER_N);
    this.eCol = new Float32Array(EMBER_N * 3);
    for (let i = 0; i < EMBER_N; i++) this.ePos[i * 3 + 1] = -999;
    this.eGeo.setAttribute('position', new THREE.BufferAttribute(this.ePos, 3));
    this.eGeo.setAttribute('color', new THREE.BufferAttribute(this.eCol, 3));
    const eMat = new THREE.PointsMaterial({
      size: 0.3, vertexColors: true, transparent: true, opacity: 1,
      depthWrite: false, blending: THREE.AdditiveBlending,
      map: hardDotTexture(),
    });
    this.embers = new THREE.Points(this.eGeo, eMat);
    this.embers.frustumCulled = false;
    this.embers.renderOrder = 5;
    scene.add(this.embers);

    this.eStreak = new StreakField(scene, EMBER_N, { opacity: 0.95 });

    // --- dirt: DARK debris ribbons (normal blending, so they read against
    // the bright sky where additive glow washes out), heavy gravity, dying
    // where they land
    this.dVelA = new Float32Array(DIRT_N * 3);
    this.dPosA = new Float32Array(DIRT_N * 3);
    this.dTail = new Float32Array(DIRT_N * 3);
    this.dLife = new Float32Array(DIRT_N);
    this.dGround = new Float32Array(DIRT_N);
    this.dStreak = new StreakField(scene, DIRT_N, { additive: false, opacity: 0.85 });
    this.dCol = new Float32Array(DIRT_N * 3);
    this.dNext = 0;
    this.eNext = 0;

    // --- shrapnel (glowing streaks stretched along velocity)
    this.sStreak = new StreakField(scene, SHRAP_N, { opacity: 0.95 });
    this.sVel = [];
    this.sLife = new Float32Array(SHRAP_N);
    this.sGround = new Float32Array(SHRAP_N);
    this.sPos = [];
    for (let i = 0; i < SHRAP_N; i++) {
      this.sVel.push(new THREE.Vector3());
      this.sPos.push(new THREE.Vector3(0, -999, 0));
    }
    this.sNext = 0;

    this._d = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  // one ember, e.g. shed by a rocket in flight or a burning wreck
  ember(x, y, z, vx = 0, vy = 1.5, vz = 0, life = 0.6) {
    const i = this.eNext;
    this.eNext = (this.eNext + 1) % EMBER_N;
    this.ePos[i * 3] = x; this.ePos[i * 3 + 1] = y; this.ePos[i * 3 + 2] = z;
    this.eTail[i * 3] = x; this.eTail[i * 3 + 1] = y; this.eTail[i * 3 + 2] = z;
    this.eVel[i * 3] = vx; this.eVel[i * 3 + 1] = vy; this.eVel[i * 3 + 2] = vz;
    this.eLife[i] = this.eMax[i] = life * (0.7 + Math.random() * 0.6);
  }

  // the main event: ember-ribbon storm + dirt streamers + shrapnel streaks
  blast(p, scale = 1) {
    const s = Math.min(scale, 2.2);
    const nE = Math.round(130 * s);
    for (let k = 0; k < nE; k++) {
      const i = this.eNext;
      this.eNext = (this.eNext + 1) % EMBER_N;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const v = (6 + Math.random() * 26) * (0.7 + s * 0.3);
      this.ePos[i * 3] = p.x; this.ePos[i * 3 + 1] = p.y + 0.4; this.ePos[i * 3 + 2] = p.z;
      this.eTail[i * 3] = p.x; this.eTail[i * 3 + 1] = p.y + 0.4; this.eTail[i * 3 + 2] = p.z;
      this.eVel[i * 3] = Math.sin(ph) * Math.cos(th) * v;
      this.eVel[i * 3 + 1] = Math.abs(Math.cos(ph)) * v * 0.9 + 3;
      this.eVel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * v;
      this.eLife[i] = this.eMax[i] = 0.7 + Math.random() * 1.2;
    }
    const nD = Math.round(100 * s);
    for (let k = 0; k < nD; k++) {
      const i = this.dNext;
      this.dNext = (this.dNext + 1) % DIRT_N;
      const th = Math.random() * Math.PI * 2;
      this.dPosA[i * 3] = p.x + Math.cos(th) * 0.6;
      this.dPosA[i * 3 + 1] = p.y + 0.2;
      this.dPosA[i * 3 + 2] = p.z + Math.sin(th) * 0.6;
      this.dTail[i * 3] = this.dPosA[i * 3];
      this.dTail[i * 3 + 1] = this.dPosA[i * 3 + 1];
      this.dTail[i * 3 + 2] = this.dPosA[i * 3 + 2];
      this.dVelA[i * 3] = Math.cos(th) * (2 + Math.random() * 9);
      this.dVelA[i * 3 + 1] = 9 + Math.random() * 17 * (0.7 + s * 0.3);
      this.dVelA[i * 3 + 2] = Math.sin(th) * (2 + Math.random() * 9);
      this.dLife[i] = 1.2 + Math.random() * 1.4;
      this.dGround[i] = p.y;
      const sh = 0.1 + Math.random() * 0.16; // sooty brown, near-black
      this.dCol[i * 3] = sh * 1.5;
      this.dCol[i * 3 + 1] = sh * 1.1;
      this.dCol[i * 3 + 2] = sh * 0.75;
    }
    const nS = Math.round(14 * s);
    for (let k = 0; k < nS; k++) {
      const i = this.sNext;
      this.sNext = (this.sNext + 1) % SHRAP_N;
      const th = Math.random() * Math.PI * 2;
      const up = 0.15 + Math.random() * 0.8;
      const v = 16 + Math.random() * 30;
      this.sPos[i].set(p.x, p.y + 0.6, p.z);
      this.sVel[i].set(Math.cos(th) * v * (1 - up), v * up, Math.sin(th) * v * (1 - up));
      this.sLife[i] = 1.1 + Math.random() * 1.1;
      this.sGround[i] = p.y;
    }
  }

  update(dt) {
    if (dt <= 0) return;
    // embers: drag + light gravity; the tail chases the head so each
    // ribbon bends along the particle's arc
    const tailK = Math.min(1, dt * 2.4);
    for (let i = 0; i < EMBER_N; i++) {
      if (this.eLife[i] <= 0) continue;
      this.eLife[i] -= dt;
      if (this.eLife[i] <= 0) {
        this.ePos[i * 3 + 1] = -999;
        this.eStreak.hide(i);
        continue;
      }
      const drag = Math.pow(0.35, dt);
      this.eVel[i * 3] *= drag;
      this.eVel[i * 3 + 1] = this.eVel[i * 3 + 1] * drag - 7 * dt;
      this.eVel[i * 3 + 2] *= drag;
      this.ePos[i * 3] += this.eVel[i * 3] * dt;
      this.ePos[i * 3 + 1] += this.eVel[i * 3 + 1] * dt;
      this.ePos[i * 3 + 2] += this.eVel[i * 3 + 2] * dt;
      this.eTail[i * 3] += (this.ePos[i * 3] - this.eTail[i * 3]) * tailK;
      this.eTail[i * 3 + 1] += (this.ePos[i * 3 + 1] - this.eTail[i * 3 + 1]) * tailK;
      this.eTail[i * 3 + 2] += (this.ePos[i * 3 + 2] - this.eTail[i * 3 + 2]) * tailK;
      const t = 1 - this.eLife[i] / this.eMax[i]; // 0 fresh -> 1 dead
      const flick = 0.75 + 0.25 * Math.sin(i * 37.7 + t * 40);
      const cr = (1.0 - t * 0.55) * flick;
      const cg = Math.max(0, 0.82 - t * 1.1) * flick;
      const cb = Math.max(0, 0.45 - t * 1.6) * flick;
      this.eCol[i * 3] = cr; this.eCol[i * 3 + 1] = cg; this.eCol[i * 3 + 2] = cb;
      this.eStreak.set(i,
        this.eTail[i * 3], this.eTail[i * 3 + 1], this.eTail[i * 3 + 2],
        this.ePos[i * 3], this.ePos[i * 3 + 1], this.ePos[i * 3 + 2],
        cr * 0.9, cg * 0.75, cb * 0.55, 0.055);
    }
    this.eGeo.attributes.position.needsUpdate = true;
    this.eGeo.attributes.color.needsUpdate = true;
    this.eStreak.commit();

    // dirt streamers: ballistic dark ribbons, dying where they land
    const dTailK = Math.min(1, dt * 4.5);
    for (let i = 0; i < DIRT_N; i++) {
      if (this.dLife[i] <= 0) continue;
      this.dLife[i] -= dt;
      this.dPosA[i * 3] += this.dVelA[i * 3] * dt;
      this.dPosA[i * 3 + 1] += this.dVelA[i * 3 + 1] * dt;
      this.dPosA[i * 3 + 2] += this.dVelA[i * 3 + 2] * dt;
      this.dVelA[i * 3 + 1] -= 26 * dt;
      this.dTail[i * 3] += (this.dPosA[i * 3] - this.dTail[i * 3]) * dTailK;
      this.dTail[i * 3 + 1] += (this.dPosA[i * 3 + 1] - this.dTail[i * 3 + 1]) * dTailK;
      this.dTail[i * 3 + 2] += (this.dPosA[i * 3 + 2] - this.dTail[i * 3 + 2]) * dTailK;
      if (this.dLife[i] <= 0 ||
          (this.dVelA[i * 3 + 1] < 0 && this.dPosA[i * 3 + 1] < this.dGround[i] + 0.05)) {
        this.dLife[i] = 0;
        this.dStreak.hide(i);
        continue;
      }
      this.dStreak.set(i,
        this.dTail[i * 3], this.dTail[i * 3 + 1], this.dTail[i * 3 + 2],
        this.dPosA[i * 3], this.dPosA[i * 3 + 1], this.dPosA[i * 3 + 2],
        this.dCol[i * 3], this.dCol[i * 3 + 1], this.dCol[i * 3 + 2], 0.08);
    }
    this.dStreak.commit();

    // shrapnel: streaks stretched along velocity, guttering as they slow
    for (let i = 0; i < SHRAP_N; i++) {
      if (this.sLife[i] <= 0) continue;
      this.sLife[i] -= dt;
      const P = this.sPos[i], V = this.sVel[i];
      V.multiplyScalar(Math.pow(0.55, dt));
      V.y -= 14 * dt;
      P.addScaledVector(V, dt);
      if (this.sLife[i] <= 0 || (V.y < 0 && P.y < this.sGround[i] + 0.05)) {
        this.sLife[i] = 0;
        this.sStreak.hide(i);
        continue;
      }
      const sp = V.length();
      this._d.copy(V).normalize();
      const len = Math.max(0.3, sp * 0.09);
      const heat = Math.min(1, sp / 30); // white-hot fast, dull amber slow
      this.sStreak.set(i,
        P.x - this._d.x * len, P.y - this._d.y * len, P.z - this._d.z * len,
        P.x, P.y, P.z,
        1.0, 0.55 + heat * 0.35, 0.2 + heat * 0.35, 0.06);
    }
    this.sStreak.commit();
  }
}

// ---------------------------------------------------------------------------
// GroundStamps — permanent scorch marks stamped on the ground at every blast.
// One InstancedMesh of flat quads with a charred radial texture; each stamp
// is placed for the rest of the stage (oldest recycled past the cap). Sits
// just above the surface with polygon offset so it never z-fights the road.
// ---------------------------------------------------------------------------

let _scorchTex = null;
function scorchTexture() {
  if (_scorchTex) return _scorchTex;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  // dark charred centre fading to nothing, with an irregular sooty rim
  const grad = g.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(6,5,4,0.92)');
  grad.addColorStop(0.45, 'rgba(20,16,12,0.72)');
  grad.addColorStop(0.75, 'rgba(30,24,18,0.32)');
  grad.addColorStop(1, 'rgba(30,24,18,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  // ragged blast-splatter tendrils + ash flecks
  let s = 0x9e3779b9;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  g.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2;
    const r = S / 2 * (0.5 + rnd() * 0.5);
    g.strokeStyle = `rgba(8,6,5,${0.3 + rnd() * 0.4})`;
    g.lineWidth = 1 + rnd() * 2.5;
    g.beginPath();
    g.moveTo(S / 2, S / 2);
    g.lineTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
    g.stroke();
  }
  // punch a soft transparent bite or two so it's not a perfect disc
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.arc(S / 2 + (rnd() - 0.5) * S * 0.5, S / 2 + (rnd() - 0.5) * S * 0.5,
      6 + rnd() * 12, 0, Math.PI * 2);
    g.fill();
  }
  _scorchTex = new THREE.CanvasTexture(c);
  return _scorchTex;
}

export class GroundStamps {
  constructor(scene, max = 60) {
    this.max = max;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2); // lie flat on the ground
    const mat = new THREE.MeshBasicMaterial({
      map: scorchTexture(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this.next = 0;
    this.count = 0;
    this.reset();
  }

  // lay a scorch at (x, groundY, z), flat, random yaw, sized by radius
  stamp(x, groundY, z, radius) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.count = Math.min(this.count + 1, this.max);
    this._q.setFromAxisAngle(this._up, Math.random() * Math.PI * 2);
    this._p.set(x, groundY + 0.05, z);
    this._s.set(radius, 1, radius);
    this._m4.compose(this._p, this._q, this._s);
    this.mesh.setMatrixAt(i, this._m4);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  reset() {
    this._m4.makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, this._m4);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.next = 0;
    this.count = 0;
  }
}

// ---------------------------------------------------------------------------
// SkidMarks — persistent rubber laid on the road by hard braking and
// powerslides. Each mark is one instanced flat quad stretched between the
// previous contact point and the current one, so a continuous slide draws a
// continuous stripe (curved through corners, segment by segment). Marks
// stay for the whole race; the oldest recycle past the cap.
// ---------------------------------------------------------------------------

export class SkidMarks {
  constructor(scene, max = 700) {
    this.max = max;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0.5, 0, 0); // tail at origin, stretches +X
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this.next = 0;
    this.last = null; // previous contact point of the current stripe
    this.reset();
  }

  // call every frame with the wheel contact point while skidding;
  // call breakStripe() when the skid ends so stripes don't join up
  addPoint(x, y, z, strength) {
    if (this.last) {
      const dx = x - this.last.x, dz = z - this.last.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) return;      // wait for enough travel
      if (len < 6) {              // teleport guard
        const i = this.next;
        this.next = (this.next + 1) % this.max;
        this._q.setFromAxisAngle(this._up, Math.atan2(-dz, dx));
        this._p.set(this.last.x, y + 0.035, this.last.z);
        this._s.set(len + 0.06, 1, 0.13 + strength * 0.08);
        this._m4.compose(this._p, this._q, this._s);
        this.mesh.setMatrixAt(i, this._m4);
        // darker rubber for harder slides
        this._c.setScalar(0.24 - strength * 0.16);
        this.mesh.setColorAt(i, this._c);
        this.mesh.instanceMatrix.needsUpdate = true;
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      }
    }
    this.last = { x, z };
  }

  breakStripe() {
    this.last = null;
  }

  reset() {
    this._m4.makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, this._m4);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.next = 0;
    this.last = null;
  }
}

// ---------------------------------------------------------------------------
// SmokePlumes — the black blast smoke, upgraded from flat additive dots to
// lit, billowing puffs: each sprite is noise-eroded (ragged edges that eat
// away as it ages), shaded by a fake sphere normal against the sun so the
// column has a bright side and a sooty core, and depth-faded against the
// ground so no puff ever slices the road. CPU-simmed like DustParticles
// (a few hundred sprites is nothing); same burst()/spawn() API.
// ---------------------------------------------------------------------------

const SMOKE_VERT = /* glsl */ `
  attribute float aLife;   // 1 fresh -> 0 spent
  attribute float aSeed;
  attribute float aSize;
  attribute float aKind;   // 0 = oily smoke, 1 = dust haze
  varying float vLife;
  varying float vSeed;
  varying float vKind;
  void main() {
    vLife = aLife;
    vSeed = aSeed;
    vKind = aKind;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float age = 1.0 - aLife;
    float size = aSize * (0.55 + age * 2.0); // puffs swell as they rise
    gl_PointSize = size * (340.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const SMOKE_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uLit;
  uniform vec3 uDark;
  uniform vec3 uDustLit;
  uniform vec3 uDustDark;
  uniform vec3 uSunView;  // sun direction in view space
  uniform float uOpacity;
  uniform sampler2D tGDepth;
  uniform vec2 uScreen;
  uniform vec3 uSoftP;
  varying float vLife;
  varying float vSeed;
  varying float vKind;
  float sdViewZ(float d, float n, float f) { return (n * f) / ((f - n) * d - f); }
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
               mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    if (vLife <= 0.0) discard;
    vec2 uv = gl_PointCoord - 0.5;
    float age = 1.0 - vLife;
    // slow tumble, direction set per-particle
    float ang = vSeed * 6.2832 + age * (vSeed > 0.5 ? 1.1 : -1.1);
    float ca = cos(ang), sa = sin(ang);
    uv = mat2(ca, -sa, sa, ca) * uv;
    float r = length(uv) * 2.0;
    if (r > 1.0) discard;
    // two-octave billow noise, unique per sprite, crawling as it ages
    vec2 np = uv * 3.1 + vSeed * 39.7;
    float n = vnoise(np + age * 0.9) * 0.65 + vnoise(np * 2.3 - age * 0.6) * 0.35;
    // ragged eroding edge: noise pushes the rim in and out, and the
    // erosion threshold rises with age so old puffs shred apart
    float edge = r + (n - 0.5) * 0.85 + age * 0.55;
    float alpha = smoothstep(1.05, 0.42, edge);
    alpha *= smoothstep(0.0, 0.18, age);          // fade in
    alpha *= smoothstep(0.0, 0.35, vLife);        // fade out
    // fake sphere normal lit by the sun: bright rim on the sun side,
    // noise modulation so the lighting reads as rolling billows
    vec3 N = normalize(vec3(uv * 2.0, sqrt(max(0.02, 1.0 - min(1.0, dot(uv * 2.0, uv * 2.0))))));
    float ndl = clamp(dot(N, uSunView) * 0.62 + 0.6, 0.0, 1.35);
    ndl *= 0.5 + 0.95 * n;
    vec3 col = mix(mix(uDark, uLit, ndl), mix(uDustDark, uDustLit, ndl), vKind);
    alpha *= 1.0 - vKind * 0.28; // haze is thinner than smoke
    // soft particles: melt into the ground instead of slicing it
    float sd = texture2D(tGDepth, gl_FragCoord.xy / uScreen).x;
    float soft = clamp((sdViewZ(gl_FragCoord.z, uSoftP.x, uSoftP.y)
      - sdViewZ(sd, uSoftP.x, uSoftP.y)) / uSoftP.z, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha * uOpacity * soft);
  }
`;

export class SmokePlumes {
  constructor(scene, gdepth, camera, opts = {}) {
    this.count = opts.count || 300;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.count * 3);
    this.vel = new Float32Array(this.count * 3);
    this.life = new Float32Array(this.count);
    this.maxLife = new Float32Array(this.count);
    this.aLife = new Float32Array(this.count);
    this.aSeed = new Float32Array(this.count);
    this.aSize = new Float32Array(this.count);
    this.aKind = new Float32Array(this.count);
    this.mode = new Uint8Array(this.count);  // 0 free puff, 1 column, 2 haze
    this.axX = new Float32Array(this.count); // column axis for mushroom spread
    this.axZ = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.pos[i * 3 + 1] = -999;
      this.aSeed[i] = Math.random();
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aLife', new THREE.BufferAttribute(this.aLife, 1));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(this.aSeed, 1));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1));
    this.geo.setAttribute('aKind', new THREE.BufferAttribute(this.aKind, 1));
    this.sunWorld = (opts.sunDir || new THREE.Vector3(-0.7, 0.5, 0.55)).clone().normalize();
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
      uniforms: {
        uLit: { value: new THREE.Color(opts.lit ?? 0x5d574e) },
        uDark: { value: new THREE.Color(opts.dark ?? 0x0b0a09) },
        uDustLit: { value: new THREE.Color(opts.dustLit ?? 0x9c8c72) },
        uDustDark: { value: new THREE.Color(opts.dustDark ?? 0x4b4238) },
        uSunView: { value: new THREE.Vector3(0, 1, 0) },
        uOpacity: { value: opts.opacity ?? 0.5 },
        tGDepth: { value: gdepth.rt.depthTexture },
        uScreen: { value: gdepth.screen },
        uSoftP: { value: new THREE.Vector3(camera.near, camera.far, opts.softDist ?? 1.8) },
      },
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6; // above the ember/dirt ribbons
    scene.add(this.points);
    this.next = 0;
    this.size = opts.size || 3.2;
    this.burstLife = opts.burstLife || 1.9;
    this.gravity = opts.gravity ?? -1.1; // buoyant by default
  }

  _emit(x, y, z, vx, vy, vz, life, size, kind = 0, mode = 0, ax = 0, az = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.aSize[i] = size;
    this.aKind[i] = kind;
    this.mode[i] = mode;
    this.axX[i] = ax; this.axZ[i] = az;
  }

  // radial burst (explosion smoke shell)
  burst(at, n, speed) {
    for (let k = 0; k < n; k++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const v = speed * (0.4 + Math.random() * 0.6);
      this._emit(at.x, at.y, at.z,
        Math.sin(ph) * Math.cos(th) * v, Math.abs(Math.cos(ph)) * v,
        Math.sin(ph) * Math.sin(th) * v,
        this.burstLife * (0.65 + Math.random() * 0.7),
        this.size * (0.8 + Math.random() * 0.5));
    }
  }

  // rising column (burning wreck / lingering blast smoke)
  spawn(at, intensity) {
    const n = Math.ceil(intensity * 3);
    for (let k = 0; k < n; k++) {
      this._emit(
        at.x + (Math.random() - 0.5) * 0.5, at.y, at.z + (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 2.5, 1.2 + Math.random() * 2, (Math.random() - 0.5) * 2.5,
        0.7 + Math.random() * 0.5,
        this.size * (0.7 + Math.random() * 0.5));
    }
  }

  // the movie shot: one cohesive smoke BLOB spawned around the fireball
  // that lifts off as a single rolling mass — near-uniform updraft, small
  // radial churn, expanding as it climbs (mode 1 handles the lift/stall)
  blob(at, n, scale = 1) {
    const lift = 2.4 + Math.min(1.2, scale * 0.35);
    for (let k = 0; k < n; k++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const rr = Math.pow(Math.random(), 0.6) * (0.9 + scale * 0.55);
      const ox = Math.sin(ph) * Math.cos(th) * rr;
      const oy = Math.abs(Math.cos(ph)) * rr * 0.8;
      const oz = Math.sin(ph) * Math.sin(th) * rr;
      this._emit(
        at.x + ox, at.y + oy, at.z + oz,
        ox * 0.8, lift + oy * 0.5 + Math.random() * 0.5, oz * 0.8, // rises together, churns apart slightly
        3.6 + Math.random() * 2.0,
        this.size * (1.15 + Math.random() * 0.6) * Math.min(1.5, 0.8 + scale * 0.3),
        0, 1, at.x, at.z);
    }
  }

  // thin dragged-up stem under the lifting blob — short-lived, weak rise
  column(at, n, scale = 1) {
    for (let k = 0; k < n; k++) {
      const th = Math.random() * Math.PI * 2;
      const rr = Math.random() * 0.6 * scale;
      this._emit(
        at.x + Math.cos(th) * rr, at.y + Math.random() * 1.0, at.z + Math.sin(th) * rr,
        (Math.random() - 0.5) * 0.8, 1.3 + Math.random() * 1.0,
        (Math.random() - 0.5) * 0.8,
        1.8 + Math.random() * 1.0,
        this.size * (0.6 + Math.random() * 0.35) * Math.min(1.5, 0.8 + scale * 0.3),
        0, 1, at.x, at.z);
    }
  }

  // low dusty pancake rolling outward from the blast base
  haze(at, n, scale = 1) {
    for (let k = 0; k < n; k++) {
      const th = Math.random() * Math.PI * 2;
      const rr = (0.8 + Math.random() * 1.8) * scale;
      const out = 3.0 + Math.random() * 3.0;
      this._emit(
        at.x + Math.cos(th) * rr, at.y + 0.3 + Math.random() * 0.7, at.z + Math.sin(th) * rr,
        Math.cos(th) * out, 0.5 + Math.random() * 0.7, Math.sin(th) * out,
        3.0 + Math.random() * 2.0,
        this.size * (1.3 + Math.random() * 0.9),
        1, 2);
    }
  }

  update(dt, camera) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) { this.aLife[i] = 0; continue; }
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -999; this.aLife[i] = 0; continue; }
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const age = 1 - this.life[i] / this.maxLife[i];
      if (this.mode[i] === 1) {
        // column: buoyant kick for the first stretch of REAL time (the
        // punch), then the top stalls and rolls outward from the axis —
        // a mushroom cap that hangs instead of climbing forever
        const rise = this.maxLife[i] - this.life[i];
        if (rise < 1.7) {
          this.vel[i * 3 + 1] += 1.5 * dt; // slow steady lift, one mass
        } else {
          this.vel[i * 3 + 1] *= Math.pow(0.45, dt);
          let ox = this.pos[i * 3] - this.axX[i], oz = this.pos[i * 3 + 2] - this.axZ[i];
          const ol = Math.hypot(ox, oz) + 1e-4;
          ox /= ol; oz /= ol;
          this.vel[i * 3] += ox * 1.8 * dt; // subtle mushroom, not a burst
          this.vel[i * 3 + 2] += oz * 1.8 * dt;
        }
        const drag = Math.pow(0.8, dt);
        this.vel[i * 3] *= drag;
        this.vel[i * 3 + 2] *= drag;
      } else if (this.mode[i] === 2) {
        // ground haze: hugs the deck, momentum bleeding off slowly
        this.vel[i * 3 + 1] *= Math.pow(0.45, dt);
        const drag = Math.pow(0.72, dt);
        this.vel[i * 3] *= drag;
        this.vel[i * 3 + 2] *= drag;
      } else {
        this.vel[i * 3 + 1] -= this.gravity * dt;
        // smoke decelerates sideways as it thickens
        const drag = Math.pow(0.5, dt);
        this.vel[i * 3] *= drag;
        this.vel[i * 3 + 2] *= drag;
      }
      this.aLife[i] = this.life[i] / this.maxLife[i];
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aKind.needsUpdate = true;
    if (camera) {
      this.mat.uniforms.uSunView.value
        .copy(this.sunWorld).transformDirection(camera.matrixWorldInverse);
    }
  }
}

// ---------------------------------------------------------------------------
// EmberSwarmGPU — 16k GPU-simulated blast motes on top of the CPU ribbons.
// Position/velocity live in float textures ping-ponged by
// GPUComputationRenderer; the sim integrates gravity + drag + CURL NOISE, so
// the swarm rolls and eddies like it's caught in the fireball's convection
// instead of flying in straight ballistic arcs. Spawning is done ON the GPU:
// blasts register an emitter slot (uniform), and dead particles near-
// instantly respawn from any emitter younger than ~0.14 s — both sim shaders
// run the same deterministic hash so pos and vel agree on every respawn.
// ---------------------------------------------------------------------------

const SWARM_SIZE = 128; // 16384 particles
const MAX_EMIT = 4;

const SIM_COMMON = /* glsl */ `
  uniform float uDt;
  uniform float uTime;
  uniform vec4 uEmit[${MAX_EMIT}];     // xyz = blast pos, w = spawn probability
  uniform float uEmitAge[${MAX_EMIT}];
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  // which emitter (if any) claims this dead particle this frame — must be
  // IDENTICAL in both sim passes so pos and vel spawn in lockstep
  int claimEmitter(vec2 uv) {
    for (int i = 0; i < ${MAX_EMIT}; i++) {
      if (uEmitAge[i] >= 0.0 && uEmitAge[i] < 0.14 && uEmit[i].w > 0.0) {
        if (hash13(vec3(uv * 61.7, uTime + float(i) * 7.31)) < uEmit[i].w) return i;
      }
    }
    return -1;
  }
`;

const SIM_NOISE = /* glsl */ `
  float vn3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
          mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
          mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  // curl of two offset noise fields — divergence-free swirl, cheap enough
  // to run per particle per frame
  vec3 curl(vec3 p) {
    const float e = 0.35;
    float n1, n2;
    n1 = vn3(p + vec3(0, e, 0)); n2 = vn3(p - vec3(0, e, 0));
    float a = (n1 - n2) / (2.0 * e);
    n1 = vn3(p + vec3(0, 0, e)); n2 = vn3(p - vec3(0, 0, e));
    float b = (n1 - n2) / (2.0 * e);
    n1 = vn3(p + vec3(e, 0, 0) + 17.3); n2 = vn3(p - vec3(e, 0, 0) + 17.3);
    float c = (n1 - n2) / (2.0 * e);
    n1 = vn3(p + vec3(0, e, 0) + 17.3); n2 = vn3(p - vec3(0, e, 0) + 17.3);
    float d = (n1 - n2) / (2.0 * e);
    return vec3(a - b, b - c, d - a);
  }
`;

const POS_SIM = SIM_COMMON + /* glsl */ `
  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 p = texture2D(texPos, uv);
    vec4 v = texture2D(texVel, uv);
    if (p.w > 0.0) {
      p.xyz += v.xyz * uDt;
      p.w -= uDt;
      if (p.w <= 0.0) p = vec4(0.0, -999.0, 0.0, 0.0);
    } else {
      int e = claimEmitter(uv);
      if (e >= 0) {
        vec3 j = vec3(hash13(vec3(uv, 1.7)), hash13(vec3(uv, 2.7)), hash13(vec3(uv, 3.7))) - 0.5;
        p.xyz = uEmit[e].xyz + j * 1.1;
        p.w = 0.45 + hash13(vec3(uv, 4.7)) * 1.35; // life in seconds
      }
    }
    gl_FragColor = p;
  }
`;

const VEL_SIM = SIM_COMMON + SIM_NOISE + /* glsl */ `
  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 p = texture2D(texPos, uv);
    vec4 v = texture2D(texVel, uv);
    if (p.w > 0.0) {
      float t = 1.0 - p.w / max(v.w, 0.001); // 0 fresh -> 1 dying
      float drag = pow(0.42, uDt);
      v.xyz *= drag;
      v.y -= 8.5 * uDt;
      // convection: curl-noise swirl, strongest while young and hot
      v.xyz += curl(p.xyz * 0.33 + uTime * 0.15) * (13.0 * (1.0 - t * 0.6)) * uDt;
    } else {
      int e = claimEmitter(uv);
      if (e >= 0) {
        float th = hash13(vec3(uv, 5.7)) * 6.2832;
        float ph = acos(2.0 * hash13(vec3(uv, 6.7)) - 1.0);
        float sp = 5.0 + hash13(vec3(uv, 7.7)) * 30.0;
        v.xyz = vec3(sin(ph) * cos(th), abs(cos(ph)) * 0.9 + 0.25, sin(ph) * sin(th)) * sp;
        v.w = 0.45 + hash13(vec3(uv, 4.7)) * 1.35; // mirror of pos.w at spawn
      }
    }
    gl_FragColor = v;
  }
`;

const SWARM_VERT = /* glsl */ `
  uniform sampler2D texPos;
  uniform sampler2D texVel;
  attribute vec2 ref;
  varying float vT;
  varying float vSeed;
  void main() {
    vec4 p = texture2D(texPos, ref);
    vec4 v = texture2D(texVel, ref);
    vSeed = fract(ref.x * 61.7 + ref.y * 213.3);
    if (p.w <= 0.0) {
      vT = 1.0;
      gl_PointSize = 0.0;
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // clipped away
      return;
    }
    vT = 1.0 - p.w / max(v.w, 0.001);
    vec4 mv = modelViewMatrix * vec4(p.xyz, 1.0);
    float size = (0.06 + vSeed * 0.08) * (1.0 - vT * 0.45);
    gl_PointSize = clamp(size * (420.0 / max(1.0, -mv.z)), 1.0, 9.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SWARM_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  varying float vT;
  varying float vSeed;
  void main() {
    if (vT >= 1.0) discard;
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.12, d);
    // white-hot -> amber -> dull red, with per-mote flicker
    float flick = 0.72 + 0.28 * sin(uTime * 34.0 + vSeed * 97.0);
    vec3 col = mix(vec3(1.0, 0.93, 0.68), vec3(1.0, 0.42, 0.07), smoothstep(0.0, 0.5, vT));
    col = mix(col, vec3(0.42, 0.07, 0.015), smoothstep(0.5, 0.95, vT));
    float fade = (1.0 - vT * vT) * flick;
    gl_FragColor = vec4(col * core * fade, 1.0);
  }
`;

export class EmberSwarmGPU {
  constructor(renderer, scene) {
    this.gpu = new GPUComputationRenderer(SWARM_SIZE, SWARM_SIZE, renderer);
    const pos0 = this.gpu.createTexture();
    const vel0 = this.gpu.createTexture();
    const pd = pos0.image.data;
    for (let i = 0; i < pd.length; i += 4) {
      pd[i] = 0; pd[i + 1] = -999; pd[i + 2] = 0; pd[i + 3] = 0; // dead
    }
    this.posVar = this.gpu.addVariable('texPos', POS_SIM, pos0);
    this.velVar = this.gpu.addVariable('texVel', VEL_SIM, vel0);
    this.gpu.setVariableDependencies(this.posVar, [this.posVar, this.velVar]);
    this.gpu.setVariableDependencies(this.velVar, [this.posVar, this.velVar]);
    this.emitVal = Array.from({ length: MAX_EMIT }, () => new THREE.Vector4(0, -999, 0, 0));
    this.emitAge = new Float32Array(MAX_EMIT).fill(99);
    for (const v of [this.posVar, this.velVar]) {
      v.material.uniforms.uDt = { value: 0.016 };
      v.material.uniforms.uTime = { value: 0 };
      v.material.uniforms.uEmit = { value: this.emitVal };
      v.material.uniforms.uEmitAge = { value: this.emitAge };
    }
    const err = this.gpu.init();
    if (err) console.error('EmberSwarmGPU:', err);

    // one point per texel, addressed by its texture coordinate
    const N = SWARM_SIZE * SWARM_SIZE;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const refs = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      refs[i * 2] = ((i % SWARM_SIZE) + 0.5) / SWARM_SIZE;
      refs[i * 2 + 1] = (Math.floor(i / SWARM_SIZE) + 0.5) / SWARM_SIZE;
    }
    geo.setAttribute('ref', new THREE.BufferAttribute(refs, 2));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SWARM_VERT, fragmentShader: SWARM_FRAG,
      uniforms: {
        texPos: { value: null }, texVel: { value: null }, uTime: { value: 0 },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.nextEmit = 0;
    this.time = 0;
  }

  blast(p, scale = 1) {
    const i = this.nextEmit;
    this.nextEmit = (this.nextEmit + 1) % MAX_EMIT;
    this.emitVal[i].set(p.x, p.y + 0.5, p.z, Math.min(0.5, 0.16 + scale * 0.14));
    this.emitAge[i] = 0;
  }

  update(dt) {
    if (dt <= 0) return;
    const step = Math.min(dt, 0.045);
    this.time += step;
    for (let i = 0; i < MAX_EMIT; i++) {
      if (this.emitAge[i] < 90) this.emitAge[i] += step;
    }
    for (const v of [this.posVar, this.velVar]) {
      v.material.uniforms.uDt.value = step;
      v.material.uniforms.uTime.value = this.time;
    }
    this.gpu.compute();
    this.mat.uniforms.texPos.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    this.mat.uniforms.texVel.value = this.gpu.getCurrentRenderTarget(this.velVar).texture;
    this.mat.uniforms.uTime.value = this.time;
  }

  dispose() {
    this.gpu.dispose();
  }
}

// ---------------------------------------------------------------------------
// SparkGlints — impact sparks as tiny velocity-stretched glints (StreakField
// under the hood) instead of round dots: white-hot slivers that fly out,
// arc under heavy gravity and gutter to orange, like grinder sparks.
// Drop-in for the old DustParticles sparks: burst(at, n, speed) + update(dt),
// plus spray(at, dir, ...) for directional muzzle spits.
// ---------------------------------------------------------------------------

export class SparkGlints {
  constructor(scene, count = 520) {
    this.count = count;
    this.field = new StreakField(scene, count, { opacity: 1, renderOrder: 6 });
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.max = new Float32Array(count);
    this.next = 0;
  }

  _emit(x, y, z, vx, vy, vz, life) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = this.max[i] = life;
  }

  // radial impact burst (bullet hits, rocket strikes)
  burst(at, n, speed) {
    n = Math.round(n * 1.7);
    for (let k = 0; k < n; k++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const v = speed * (0.5 + Math.random() * 1.0) * 1.25;
      this._emit(at.x, at.y, at.z,
        Math.sin(ph) * Math.cos(th) * v,
        Math.abs(Math.cos(ph)) * v * 0.9 + 1.5,
        Math.sin(ph) * Math.sin(th) * v,
        0.14 + Math.random() * 0.38);
    }
  }

  // directional cone (muzzle spit, grinding contact)
  spray(at, dir, n, speed, spread = 0.35) {
    for (let k = 0; k < n; k++) {
      const v = speed * (0.4 + Math.random() * 0.8);
      this._emit(at.x, at.y, at.z,
        (dir.x + (Math.random() - 0.5) * spread * 2) * v,
        (dir.y + (Math.random() - 0.5) * spread * 2) * v + 0.6,
        (dir.z + (Math.random() - 0.5) * spread * 2) * v,
        0.1 + Math.random() * 0.22);
    }
  }

  update(dt) {
    if (dt <= 0) return;
    const drag = Math.pow(0.22, dt);
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.field.hide(i); continue; }
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - 24 * dt;
      this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = 1 - this.life[i] / this.max[i];
      const flick = 0.7 + 0.3 * Math.sin(i * 51.3 + t * 55);
      // white-hot sliver cooling to orange, guttering out
      const r = 1.0 * flick;
      const g = (1.0 - t * 0.55) * flick;
      const b = Math.max(0, 0.85 - t * 1.7) * flick;
      // stretch along velocity: fast = long sliver, slow = glint
      const sx = this.vel[i * 3] * 0.05, sy = this.vel[i * 3 + 1] * 0.05, sz = this.vel[i * 3 + 2] * 0.05;
      this.field.set(i,
        this.pos[i * 3] - sx, this.pos[i * 3 + 1] - sy, this.pos[i * 3 + 2] - sz,
        this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2],
        r, g, b, 0.02 + (1 - t) * 0.022);
    }
    this.field.commit();
  }
}
