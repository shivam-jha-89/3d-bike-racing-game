import * as THREE from 'three';
import { makeTile, makeSky, makeConcrete, makeGlow, makeFoliage } from './textures.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// two vertical quads crossed at 90° — a billboard tree canopy that reads
// from every angle without needing to face the camera (so it stays a single
// InstancedMesh). Base at y=0, canopy from yBase up to yBase+h.
function crossFoliageGeo(w, h, yBase) {
  const hw = w / 2;
  const pos = [], uv = [], nrm = [], idx = [];
  const addQuad = (ax, az) => {
    const b = pos.length / 3;
    pos.push(-hw * ax, yBase, -hw * az,  hw * ax, yBase, hw * az,
             hw * ax, yBase + h, hw * az,  -hw * ax, yBase + h, -hw * az);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    // normals point up so foliage is lit evenly from the sky (no dark backs)
    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  addQuad(1, 0);
  addQuad(0, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

// Track: an OPEN A->B Catmull-Rom spline sampled every ~3 m into a lookup
// table. Everything queries this table: physics (nearest centreline point,
// lateral offset, ground height), AI (curvature lookahead), rendering (road
// ribbon), and the React minimap. `s` clamps to [0, length] — no wrapping.

export class Track {
  constructor(def) {
    this.def = def;
    this.halfWidth = def.width / 2;
    this.wallDist = def.width / 2 + def.margin;

    const pts = def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    this.length = this.curve.getLength();
    this.finishS = this.length - 60; // the finish line, shy of the very end

    const N = (this.N = Math.max(400, Math.round(this.length / 3)));
    this.ds = this.length / (N - 1);
    this.samples = [];
    const tans = [];
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const p = this.curve.getPointAt(u);
      const t = this.curve.getTangentAt(u);
      t.y = 0;
      t.normalize();
      tans.push(t);
      this.samples.push({
        x: p.x, y: p.y + this.bump(u * this.length), z: p.z,
        tx: t.x, tz: t.z,
        nx: t.z, nz: -t.x, // left normal = up x tangent
        s: i * this.ds,
        angle: Math.atan2(t.x, t.z),
        curv: 0,
      });
    }
    // signed curvature from tangent rotation between neighbours, lightly
    // smoothed; the open ends just copy their neighbour
    const raw = [];
    for (let i = 0; i < N - 1; i++) {
      const a = tans[i], b = tans[i + 1];
      raw.push((a.x * b.z - a.z * b.x) / this.ds);
    }
    raw.push(raw[raw.length - 1]);
    for (let i = 0; i < N; i++) {
      const im = Math.max(0, i - 1), ip = Math.min(N - 1, i + 1);
      this.samples[i].curv = (raw[im] + raw[i] + raw[ip]) / 3;
    }

    // per-sample barrier distance: tunnels and bridges narrow the corridor
    // so physics can't clip through tunnel walls or off a bridge deck
    for (let i = 0; i < N; i++) {
      const s = i * this.ds;
      let wd = this.wallDist;
      if (this.isInTunnel(s)) wd = this.halfWidth + 1.6;
      else if (this.isOnBridge(s)) wd = this.halfWidth + 0.9;
      this.samples[i].wallD = wd;
      // per-side limits: guardrails narrow one side only (buildRoadFurniture)
      this.samples[i].wallL = wd;
      this.samples[i].wallR = wd;
    }

    this.disposables = [];
  }

  inRanges(s, ranges) {
    const f = s / this.length;
    return (ranges || []).some((r) => f >= r.from && f <= r.to);
  }

  isInTunnel(s) {
    return this.inRanges(s, this.def.tunnels);
  }

  isOnBridge(s) {
    return this.inRanges(s, this.def.bridges);
  }

  isInVillage(s) {
    return this.inRanges(s, this.def.villages);
  }

  // environment zone at stage fraction f — null means the track's default
  zoneAt(f) {
    for (const z of this.def.zones || []) {
      if (f >= z.from && f <= z.to) return z.kind;
    }
    return null;
  }

  // stretches that shed their fences: bare land opens up, towns and
  // lakesides have their own edges, rock gardens need the view
  zoneOpen(s) {
    const k = this.zoneAt(s / this.length);
    return k === 'barren' || k === 'burned' || k === 'town'
      || k === 'lake' || k === 'spires' || k === 'dunes';
  }

  // zones that bring their own dressing reject the default scenery
  zoneBare(k) {
    return k === 'barren' || k === 'burned' || k === 'town'
      || k === 'lake' || k === 'spires' || k === 'dunes' || k === 'orchard';
  }

  // Extra elevation on top of the spline: whoop rollers + tabletop jumps.
  // Used both by physics (ground height) and mesh building so they agree.
  bump(s) {
    const d = this.def;
    let h = 0;
    if (d.bumps) {
      // irregular dune rollers: seeded CLUSTERS of 3-5 gaussian swells with
      // long flat runs between — reads like natural desert, not corrugation
      if (!this._whoops) this._buildWhoops();
      for (const w of this._whoops) {
        const dx = s - w.s;
        if (dx > -45 && dx < 45) h += w.a * Math.exp(-(dx * dx) / (w.w * w.w));
      }
    }
    for (const j of d.jumps || []) {
      const c = j.sFrac * this.length;
      const dx = Math.abs(s - c); // open track: no wraparound distance
      h += j.height * Math.exp(-(dx * dx) / (j.width * j.width));
    }
    return h;
  }

  _buildWhoops() {
    let seed = 5;
    for (const ch of this.def.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rng = mulberry32(seed ^ 0x7a11);
    const amp = this.def.bumps.amp;
    const list = [];
    let s = 180 + rng() * 220; // the grid always sits flat
    while (s < this.length - 220) {
      const n = 3 + Math.floor(rng() * 3); // 3-5 rollers per cluster
      for (let k = 0; k < n && s < this.length - 220; k++) {
        list.push({ s, a: amp * (0.8 + rng() * 0.35), w: 13 + rng() * 4 });
        s += 55 + rng() * 30;
      }
      s += 190 + rng() * 170; // flat run before the next cluster
    }
    this._whoops = list;
  }

  // Nearest centreline sample to (x, z). `hint` is the previous result index;
  // we only search a window around it so nearby-but-separate track sections
  // can't steal the query (and it's cheap).
  nearest(x, z, hint = null) {
    const N = this.N;
    let best = -1, bestD = Infinity;
    const scan = (i) => {
      const sm = this.samples[i];
      const dx = x - sm.x, dz = z - sm.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    };
    if (hint == null) {
      for (let i = 0; i < N; i++) scan(i);
    } else {
      const lo = Math.max(0, hint - 30), hi = Math.min(N - 1, hint + 30);
      for (let i = lo; i <= hi; i++) scan(i);
    }
    const sm = this.samples[best];
    const dx = x - sm.x, dz = z - sm.z;
    const lateral = dx * sm.nx + dz * sm.nz;
    const along = dx * sm.tx + dz * sm.tz;
    const s = Math.min(Math.max(sm.s + along, 0), this.length);
    return { index: best, sample: sm, lateral, s };
  }

  clampS(s) {
    return Math.min(Math.max(s, 0), this.length);
  }

  sampleAt(s) {
    s = this.clampS(s);
    return this.samples[Math.min(this.N - 1, Math.round(s / this.ds))];
  }

  // Smoothly interpolated point on the centreline. Anything that PLACES an
  // object by s must use this, not sampleAt — nearest-sample rounding
  // quantizes positions to the 3 m grid and moving objects visibly jump.
  interpAt(s) {
    s = this.clampS(s);
    const f = s / this.ds;
    const i = Math.min(this.N - 2, Math.floor(f));
    const t = f - i;
    const a = this.samples[i], b = this.samples[i + 1];
    let tx = a.tx + (b.tx - a.tx) * t;
    let tz = a.tz + (b.tz - a.tz) * t;
    const inv = 1 / (Math.hypot(tx, tz) || 1);
    tx *= inv; tz *= inv;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      tx, tz, nx: tz, nz: -tx,
      angle: Math.atan2(tx, tz),
      curv: a.curv + (b.curv - a.curv) * t,
      wallD: a.wallD,
      wallL: a.wallL,
      wallR: a.wallR,
    };
  }

  // Continuous ground height along the stage. Physics divides height deltas
  // by dt to follow terrain, so this MUST interpolate — snapping to the
  // nearest 3 m sample turns every slope into velocity spikes.
  heightAt(s) {
    s = this.clampS(s);
    const f = s / this.ds;
    const i = Math.min(this.N - 2, Math.floor(f));
    const t = f - i;
    const a = this.samples[i], b = this.samples[i + 1];
    return a.y + (b.y - a.y) * t;
  }

  // ---------------------------------------------------------------- visuals

  build(scene) {
    const c = this.def.colors;
    scene.background = new THREE.Color(c.sky);
    scene.fog = new THREE.Fog(c.fog, 60, this.def.fogDist);

    // route bounding box — long A->B stages are nowhere near the origin,
    // so ground/sea/sky all centre on the route, and the sky dome follows
    // the camera (Game re-centres it each frame)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const sm of this.samples) {
      minX = Math.min(minX, sm.x); maxX = Math.max(maxX, sm.x);
      minZ = Math.min(minZ, sm.z); maxZ = Math.max(maxZ, sm.z);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const bboxR = Math.hypot(maxX - minX, maxZ - minZ) / 2;
    this.center = { x: cx, z: cz, r: bboxR };

    // gradient sky dome, sized to sit inside the fog-tied far plane
    const domeR = Math.max(600, this.def.fogDist * 1.15);
    const skyGeo = new THREE.SphereGeometry(domeR, 24, 12);
    const skyMat = new THREE.MeshBasicMaterial({
      map: makeSky({ horizon: c.fog, zenith: c.sky, night: !!this.def.night }),
      side: THREE.BackSide, fog: false, depthWrite: false,
    });
    const dome = new THREE.Mesh(skyGeo, skyMat);
    dome.renderOrder = -1;
    dome.frustumCulled = false;
    this.skyDome = dome; // Game keeps it centred on the camera
    scene.add(dome);
    this.disposables.push(skyGeo, skyMat);

    // night tracks run dim, moon-blue lighting; the city glows on its own
    const night = this.def.night;
    this.baseHemi = night ? night.hemi : 0.95;
    this.baseSun = night ? night.sun : 1.5; // lower sun angle needs more punch
    const hemi = new THREE.HemisphereLight(
      night ? 0xaabbee : 0xffffff, night ? 0x222236 : 0x777766, this.baseHemi);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(night ? night.sunColor : 0xfff2dd, this.baseSun);
    // day: ~30 degrees up so the disc sits IN the view down the road and
    // the glossy asphalt has something visible to glint back at
    if (night) sun.position.set(-200, 300, 150);
    else sun.position.set(-200, 108, 150);
    scene.add(sun);
    this.lights = { hemi, sun };

    // the visible sun disc, riding the camera-following sky dome — placed
    // along the SAME direction as the directional light, so the specular
    // glints on the asphalt actually point back at it
    if (!night) {
      const sunMat = new THREE.SpriteMaterial({
        map: makeGlow(), blending: THREE.AdditiveBlending,
        fog: false, depthWrite: false, transparent: true,
      });
      const sunSprite = new THREE.Sprite(sunMat);
      const sunDir = sun.position.clone().normalize();
      const sunR = domeR * 0.88;
      sunSprite.position.copy(sunDir).multiplyScalar(sunR);
      sunSprite.scale.setScalar(sunR * 0.34);
      dome.add(sunSprite);
      this.disposables.push(sunMat, sunMat.map);
    }

    // ground plane centred on the route — on island tracks the land ends
    // just past the road corridor and everything beyond is open sea
    let groundR = bboxR + Math.max(600, this.def.fogDist);
    if (this.def.island) {
      groundR = bboxR + this.def.island.margin;
      const seaMat = new THREE.MeshPhongMaterial({
        color: 0x1f6f9f, shininess: 110, specular: 0x88aabb,
      });
      const seaGeo = new THREE.CircleGeometry(bboxR + this.def.fogDist * 2, 32);
      const sea = new THREE.Mesh(seaGeo, seaMat);
      sea.layers.enable(1);
      sea.rotation.x = -Math.PI / 2;
      sea.position.set(cx, -4, cz); // small cliff drop from the land edge
      scene.add(sea);
      this.disposables.push(seaGeo, seaMat);
    }
    const groundGeo = new THREE.CircleGeometry(groundR, 48);
    const groundTex = makeTile(c.ground);
    groundTex.repeat.set(groundR / 4, groundR / 4); // ~8 m tiles
    const groundMat = new THREE.MeshLambertMaterial({ map: groundTex });
    this.applyWear(groundMat);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.layers.enable(1);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -0.35, cz);
    scene.add(ground);
    this.disposables.push(groundGeo, groundMat);

    // shoulder skips bridge spans (no grass floating over water)
    const shoulderMat = new THREE.MeshLambertMaterial({ map: makeTile(c.shoulder) });
    this.applyWear(shoulderMat, { dirt: true }); // heavy random dirt patches
    this.buildRibbon(scene, this.wallDist + 26, -0.28, shoulderMat, false,
      (i) => this.isOnBridge(i * this.ds), true);
    // glossy asphalt: phong speculars plus a grazing-angle fresnel sheen —
    // the road reads matte underfoot and glossy toward the horizon, like
    // real tarmac (and like wet tarmac at night, where the sheen is boosted)
    let roadMat;
    if (this.def.surface === 'dirt') {
      // neglected off-road: matte dirt with worn patches; the asphalt
      // shader (gloss/cracks/sparkle) is for roads somebody maintains
      roadMat = new THREE.MeshLambertMaterial({ map: this.makeRoadTexture() });
      this.applyWear(roadMat, { dirt: true });
    } else {
    const night2 = !!this.def.night;
    const wet = !!this.def.wet; // rain: the road turns to dark mirror
    roadMat = new THREE.MeshPhongMaterial({
      map: this.makeRoadTexture(),
      shininess: night2 ? 160 : wet ? 130 : 55,
      specular: new THREE.Color(night2 ? 0x7f90b0 : wet ? 0x8a95a5 : 0x505050),
    });
    roadMat.onBeforeCompile = (sh) => {
      sh.uniforms.uSheen = { value: night2 ? 0.34 : this.def.wet ? 0.3 : 0.16 };
      // wet night tarmac is smoother; dry day chip-seal is rougher
      sh.uniforms.uBump = { value: night2 ? 0.0015 : 0.003 };
      sh.uniforms.uHalfW = { value: this.halfWidth };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vGrainPos;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\nvGrainPos = (modelMatrix * vec4(position, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>',
          '#include <common>\n' +
          'uniform float uSheen;\n' +
          'uniform float uBump;\n' +
          'uniform float uHalfW;\n' +
          'varying vec2 vGrainPos;\n' +
          'float rhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n' +
          // smooth value noise — continuous, so it can drive bump derivatives
          'float rnoise(vec2 p) {\n' +
          '  vec2 i = floor(p), f = fract(p);\n' +
          '  vec2 u = f * f * (3.0 - 2.0 * f);\n' +
          '  return mix(mix(rhash(i), rhash(i + vec2(1.0, 0.0)), u.x),\n' +
          '             mix(rhash(i + vec2(0.0, 1.0)), rhash(i + vec2(1.0, 1.0)), u.x), u.y);\n' +
          '}\n' +
          // fine pepper grain on a JITTERED lattice: each ~2 cm cell is
          // shifted by low-frequency noise, so cells never line up into a
          // regular grid and can\'t alias into interference rings
          'float rgrain(vec2 p) {\n' +
          '  vec2 j = vec2(rnoise(p * 3.1), rnoise(p * 2.7 + 9.0)) * 2.0;\n' +
          '  return rhash(floor(p * 45.0 + j));\n' +
          '}\n' +
          // gentle large-scale undulation for the bump normal (continuous,
          // so its screen-space derivatives are meaningful)
          'float rrelief(vec2 p) {\n' +
          '  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p;\n' +
          '  return rnoise(p * 22.0) * 0.7 + rnoise(q * 43.0 + 31.7) * 0.3;\n' +
          '}\n' +
          // metre-scale patchiness: wear bands, repair seams, aggregate
          // density — smooth + low-frequency, so it stays visible (and
          // alias-free) all the way down the road
          'float rpatch(vec2 p) {\n' +
          '  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p;\n' +
          '  return rnoise(p * 0.9) * 0.6 + rnoise(q * 2.1 + 17.0) * 0.4;\n' +
          '}')
        .replace('#include <specularmap_fragment>',
          '#include <specularmap_fragment>\n' +
          // resolution-aware fade (mipmap logic): once a pixel\'s ground
          // footprint spans a sizeable fraction of a grain cell — far away
          // OR at grazing angles — dissolve the grain to its average BEFORE
          // undersampling can alias it into interference patterns
          'float cellPix = max(fwidth(vGrainPos.x), fwidth(vGrainPos.y)) * 45.0;\n' +
          'float aFade = clamp(1.3 - 2.2 * cellPix, 0.0, 1.0);\n' +
          'float gFade = clamp(1.0 - length(vViewPosition) / 45.0, 0.0, 1.0) * aFade;\n' +
          'float gMottle = rgrain(vGrainPos);\n' +
          // only a minority of aggregate faces are glossy — most grains go
          // matte, the top ~30% carry the glint. Far-field settles on the
          // same average so distance doesn\'t look shinier than near.
          'float gGloss = smoothstep(0.6, 0.78, gMottle);\n' +
          'float gPatch = rpatch(vGrainPos);\n' +
          // --- ragged broken edges: the damage band width wanders along the
          // road (mostly a sliver, occasionally a deep bite), and inside it
          // the asphalt crumbles: darker, browner, chunky, matte
          'float edgeM = (0.5 - abs(vMapUv.x - 0.5)) * 2.0 * uHalfW;\n' +
          'float rag = rnoise(vGrainPos * 1.7) * 0.55 + rnoise(vGrainPos * 6.3 + 4.2) * 0.45;\n' +
          'float wEdge = 0.06 + 1.3 * rag * rag * rag;\n' +
          'float brk = smoothstep(wEdge, wEdge * 0.3, edgeM);\n' +
          'diffuseColor.rgb = mix(diffuseColor.rgb,\n' +
          '  diffuseColor.rgb * vec3(0.62, 0.56, 0.50) * (0.7 + 0.6 * gMottle), brk);\n' +
          // --- cracks: ridged-noise lines gated to random patches (denser
          // near the edges). Analytic AA: the line WIDTH grows with the
          // pixel footprint while the darkness fades gently, so cracks stay
          // visible deep ahead as faint veins instead of popping in nearby
          'float crFw = max(fwidth(vGrainPos.x), fwidth(vGrainPos.y));\n' +
          'float crackPix = clamp(1.15 - 4.5 * crFw, 0.0, 1.0);\n' +
          'float crGate = smoothstep(0.56, 0.78, rnoise(vGrainPos * 0.21 + 3.1));\n' +
          'crGate = min(1.0, crGate + smoothstep(1.4, 0.2, edgeM) * 0.7);\n' +
          'float crRidge = abs(rnoise(vGrainPos * 1.15 + 7.7) * 2.0 - 1.0);\n' +
          'float crack = (1.0 - smoothstep(0.03, 0.10 + crFw * 2.3, crRidge)) * crGate * crackPix;\n' +
          // MAJOR fracture seams -- a coarser crack scale (lines metres
          // apart, wandering across the road). Energy-conserving AA: as a
          // pixel footprint outgrows the line, the line widens and fades in
          // proportion instead of disappearing -- so seams stay visible as
          // soft dark veins at 100 m and beyond
          'float mjRidge = abs(rnoise(vGrainPos * 0.33 + 41.0) * 2.0 - 1.0);\n' +
          'float mjAA = crFw * 0.53;\n' +
          'float mjGate = smoothstep(0.42, 0.66, rnoise(vGrainPos * 0.09 + 9.0));\n' +
          // compressed distance ramp: a seam is barely darker up close than
          // at 100 m, so it reads as a fixed feature you approach, not one
          // that develops under the wheel
          'float mjF = 0.06 / (0.06 + mjAA * 0.6);\n' +
          'float mj = (1.0 - smoothstep(0.05, 0.11 + mjAA, mjRidge))\n' +
          '  * (0.55 + 0.45 * mjF) * mjGate;\n' +
          'diffuseColor.rgb *= (1.0 - crack * 0.16) * (1.0 - mj * 0.22);\n' +
          'crack = max(crack, mj);\n' +
          'specularStrength *= mix(0.55, 0.08 + 1.9 * gGloss, gFade) * (0.7 + 0.6 * gPatch)\n' +
          '  * (1.0 - brk * 0.85) * (1.0 - crack * 0.3);')
        // bump roughness: tilt the shading normal by the grain field's
        // screen-space gradient (three's perturbNormalArb, inlined) so the
        // aggregate actually catches and sheds light. Fades with distance.
        .replace('#include <normal_fragment_maps>',
          '#include <normal_fragment_maps>\n' +
          // NO branch here: dFdx/dFdy are undefined across divergent control
          // flow, which drew a glitch line at the fade boundary. The amount
          // just scales to zero smoothly instead.
          'float bAmt = uBump * clamp(1.0 - length(vViewPosition) / 16.0, 0.0, 1.0) * aFade;\n' +
          'float bh = rrelief(vGrainPos);\n' +
          'vec3 bsx = dFdx(-vViewPosition);\n' +
          'vec3 bsy = dFdy(-vViewPosition);\n' +
          'vec3 br1 = cross(bsy, normal);\n' +
          'vec3 br2 = cross(normal, bsx);\n' +
          'float bdet = dot(bsx, br1);\n' +
          'vec3 bgrad = sign(bdet) * (dFdx(bh) * bAmt * br1 + dFdy(bh) * bAmt * br2);\n' +
          'normal = normalize(abs(bdet) * normal - bgrad);')
        .replace('#include <opaque_fragment>',
          // fresnel off the BUMPED normal, so the sheen itself is rough
          'float roadFres = pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), 5.0);\n' +
          'outgoingLight += vec3(0.72, 0.78, 0.92) * uSheen * roadFres *\n' +
          '  mix(0.75, 0.22 + 1.7 * gGloss, gFade) * (0.62 + 0.76 * gPatch) *\n' +
          '  (1.0 - brk) * (1.0 - crack * 0.3);\n' +
          // sparkles on a noise-jittered lattice — irregular, like stone chips
          'vec2 sp = vGrainPos + vec2(rnoise(vGrainPos * 13.0), rnoise(vGrainPos * 17.0 + 5.0)) * 0.05;\n' +
          'outgoingLight += vec3(1.0, 0.98, 0.9) *\n' +
          '  step(0.984, rhash(floor(sp * 40.0))) * roadFres * uSheen * 4.6 * aFade *\n' +
          '  clamp(1.0 - length(vViewPosition) / 130.0, 0.0, 1.0);\n' +
          // coarser glint tier that CROSS-FADES in where the fine grain has
          // mipped away, so the glossy band ahead still twinkles
          'float farPix = max(fwidth(vGrainPos.x), fwidth(vGrainPos.y)) * 5.0;\n' +
          'float farFade = clamp(1.3 - 2.2 * farPix, 0.0, 1.0);\n' +
          'outgoingLight += vec3(1.0, 0.98, 0.9) *\n' +
          '  step(0.978, rhash(floor(sp * 5.0 + 3.7))) * roadFres * uSheen * 2.0 *\n' +
          '  farFade * (1.0 - gFade);\n' +
          '#include <opaque_fragment>');
    };
    }
    this.buildRibbon(scene, this.halfWidth, 0.02, roadMat, true);
    this.buildEdgeDetail(scene);
    // start furniture near A, finish furniture near B
    const startIdx = Math.round(88 / this.ds);
    const finishIdx = Math.min(this.N - 3, Math.round(this.finishS / this.ds));
    this.buildLineAt(scene, startIdx);
    this.buildLineAt(scene, finishIdx);
    this.buildArch(scene, startIdx + 2, this.def.banners?.start || 'MOTOMAD');
    this.buildArch(scene, finishIdx + 2, this.def.banners?.finish || 'FINISH');
    this.buildWalls(scene);
    this.buildPosts(scene);
    this.buildScenery(scene);
    this.buildVillages(scene);
    this.buildZones(scene);
    this.buildLandmarks(scene);
    this.buildRoadFurniture(scene);
    this.buildApron(scene);
    this.buildValleyWalls(scene);
    this.buildTunnels(scene);
    this.buildBridges(scene);
  }

  // ---------------------------------------------------------- road furniture
  // The human-engineering layer, derived from the road geometry itself:
  // chevron boards before sharp bends (on the OUTSIDE of the turn),
  // guardrails on those bends and on high embankments, km posts, junction
  // stubs where dirt tracks meet the asphalt, memorial crosses where riders
  // didn't make the corner, a destination sign before the finish, and one
  // Freight Guild toll checkpoint per stage.
  buildRoadFurniture(scene) {
    let seed = 3;
    for (const ch of this.def.id) seed = (seed * 37 + ch.charCodeAt(0)) >>> 0;
    const rng = mulberry32(seed ^ 0x51f7);
    const hw = this.halfWidth;
    const N = this.N, ds = this.ds;
    const blocked = (i) => this.isOnBridge(i * ds) || this.isInTunnel(i * ds);

    const makeSign = (w, h, draw) => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      draw(cv.getContext('2d'));
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };
    const postMat = new THREE.MeshLambertMaterial({ color: 0x555a5e });
    const steel = new THREE.MeshLambertMaterial({ color: 0x8a9096, side: THREE.DoubleSide });
    this.disposables.push(postMat, steel);
    // a sign panel on one or two posts, facing oncoming traffic
    const signAt = (i, side, tex, pw, ph, ySign, twoPosts) => {
      const sm = this.samples[Math.max(0, Math.min(N - 1, i))];
      const grp = new THREE.Group();
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(pw, ph, 0.08),
        new THREE.MeshLambertMaterial({
          map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.3 }));
      panel.position.y = ySign;
      grp.add(panel);
      for (const px of twoPosts ? [-pw * 0.38, pw * 0.38] : [0]) {
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, ySign, 0.1), postMat);
        post.position.set(px, ySign / 2, -0.06);
        grp.add(post);
      }
      const d = hw + 1.9;
      grp.position.set(sm.x + sm.nx * d * side, sm.y, sm.z + sm.nz * d * side);
      grp.rotation.y = sm.angle + Math.PI;
      scene.add(grp);
      return grp;
    };

    // ---- find sharp bends: local maxima of |curv|, r < ~230 m ------------
    const bends = [];
    const thresh = 1 / 230;
    let last = -1e9;
    for (let i = 20; i < N - 20; i++) {
      const c = Math.abs(this.samples[i].curv);
      if (c < thresh) continue;
      let isMax = true;
      for (let j = i - 12; j <= i + 12; j++) {
        if (Math.abs(this.samples[j].curv) > c) { isMax = false; break; }
      }
      if (!isMax || i * ds - last < 150) continue;
      last = i * ds;
      bends.push(i);
    }

    // ---- chevron boards ~75 m before each bend, outside of the turn ------
    for (const bi of bends) {
      const si = bi - Math.round(75 / ds);
      if (si < 4 || blocked(si) || blocked(bi)) continue;
      const turn = this.samples[bi].curv; // >0 right turn, outside = left(+1)
      const outside = Math.sign(turn) || 1;
      const left = turn < 0; // arrows point where the road goes
      const tex = makeSign(256, 96, (g) => {
        g.fillStyle = '#c9a41e';
        g.fillRect(0, 0, 256, 96);
        g.fillStyle = '#191512';
        for (let k = 0; k < 3; k++) {
          const cx = 52 + k * 76;
          g.beginPath();
          if (left) {
            g.moveTo(cx + 16, 14); g.lineTo(cx - 16, 48); g.lineTo(cx + 16, 82);
            g.lineTo(cx + 16, 62); g.lineTo(cx - 2, 48); g.lineTo(cx + 16, 34);
          } else {
            g.moveTo(cx - 16, 14); g.lineTo(cx + 16, 48); g.lineTo(cx - 16, 82);
            g.lineTo(cx - 16, 62); g.lineTo(cx + 2, 48); g.lineTo(cx - 16, 34);
          }
          g.fill();
        }
        for (let k = 0; k < 30; k++) { // grime
          g.fillStyle = `rgba(40,30,16,${0.05 + Math.random() * 0.1})`;
          g.fillRect(Math.random() * 256, Math.random() * 96, 2 + Math.random() * 5, 1 + Math.random() * 3);
        }
      });
      signAt(si, outside, tex, 2.3, 0.9, 1.5, true);
    }

    // ---- guardrails: outside of sharp bends + both sides where high.
    // Dirt stages get NONE — nobody maintains barriers out there ---------
    const need = [new Uint8Array(N), new Uint8Array(N)]; // [left(+1), right(-1)]
    if (this.def.surface !== 'dirt') {
    for (const bi of bends) {
      const outside = Math.sign(this.samples[bi].curv) || 1;
      const span = Math.round(120 / ds);
      for (let j = Math.max(0, bi - span); j < Math.min(N, bi + span); j++) {
        need[outside > 0 ? 0 : 1][j] = 1;
      }
    }
    for (let i = 0; i < N; i++) {
      if (this.samples[i].y > 9) { need[0][i] = 1; need[1][i] = 1; }
    }
    const postGeo = new THREE.BoxGeometry(0.13, 0.62, 0.13);
    const railPosts = [];
    for (const [k, side] of [[0, 1], [1, -1]]) {
      let start = null;
      for (let i = 0; i <= N; i++) {
        const on = i < N && need[k][i] && !blocked(i);
        if (on && start === null) start = i;
        if (!on && start !== null) {
          if (i - start > 10) {
            const a = start, b = i - 1;
            const d = hw + 1.05;
            this.buildStrip(scene, a, b,
              (sm) => [sm.x + sm.nx * d * side, sm.y + 0.42, sm.z + sm.nz * d * side],
              (sm) => [sm.x + sm.nx * d * side, sm.y + 0.72, sm.z + sm.nz * d * side],
              steel);
            for (let j = a; j <= b; j += Math.max(1, Math.round(5 / ds))) {
              const sm = this.samples[j];
              railPosts.push([sm.x + sm.nx * d * side, sm.y + 0.31, sm.z + sm.nz * d * side]);
            }
            // rails are SOLID: narrow the physics corridor on this side,
            // ramping in over ~10 samples so entering the run never snaps
            const field = side > 0 ? 'wallL' : 'wallR';
            for (let j = a; j <= b; j++) {
              const t = Math.min(1, (j - a) / 10, (b - j) / 10);
              const cur = this.samples[j][field];
              const target = hw + 0.88; // just inside the visual rail
              this.samples[j][field] = Math.min(cur, cur - (cur - target) * t);
            }
          }
          start = null;
        }
      }
    }
    if (railPosts.length) {
      const posts = new THREE.InstancedMesh(postGeo, postMat, railPosts.length);
      const m4 = new THREE.Matrix4();
      railPosts.forEach(([x, y, z], i) => {
        m4.makeTranslation(x, y, z);
        posts.setMatrixAt(i, m4);
      });
      scene.add(posts);
      this.disposables.push(postGeo);
    }
    } // end no-rails-on-dirt

    // ---- km posts: every 1000 m on the right shoulder ---------------------
    const kmGeo = mergeGeometries([
      (() => { const g = new THREE.BoxGeometry(0.16, 0.95, 0.16); g.translate(0, 0.48, 0); return g; })(),
      (() => { const g = new THREE.BoxGeometry(0.18, 0.2, 0.18); g.translate(0, 1.02, 0); return g; })(),
    ]);
    const kms = [];
    for (let m = 1000; m < this.length - 200; m += 1000) {
      const i = Math.round(m / ds);
      if (blocked(i)) continue;
      const sm = this.samples[i];
      kms.push([sm.x + sm.nx * (hw + 1.5) * -1, sm.y, sm.z + sm.nz * (hw + 1.5) * -1]);
    }
    if (kms.length) {
      const posts = new THREE.InstancedMesh(kmGeo,
        new THREE.MeshLambertMaterial({ color: 0xd8d4c8 }), kms.length);
      const m4 = new THREE.Matrix4();
      kms.forEach(([x, y, z], i) => {
        m4.makeTranslation(x, y, z);
        posts.setMatrixAt(i, m4);
      });
      scene.add(posts);
      this.disposables.push(kmGeo);
    }

    // ---- junction stubs: dirt tracks meeting the asphalt ------------------
    const dirtMat = new THREE.MeshLambertMaterial({
      map: makeTile(0x7a6448, { contrast: 0.24 }),
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this.disposables.push(dirtMat, dirtMat.map);
    const nJunc = Math.max(2, Math.round(this.length / 1700));
    for (let j = 0; j < nJunc; j++) {
      const f = (j + 0.35 + rng() * 0.35) / nJunc;
      const i = Math.round(f * (N - 1));
      if (blocked(i) || this.isInVillage(i * ds)) continue;
      const sm = this.samples[i];
      const side = rng() > 0.5 ? 1 : -1;
      const skew = (rng() - 0.5) * 0.9;
      const far = 42;
      const dirX = sm.nx * side * Math.cos(skew) + sm.tx * Math.sin(skew);
      const dirZ = sm.nz * side * Math.cos(skew) + sm.tz * Math.sin(skew);
      const ex = sm.x + dirX * far, ez = sm.z + dirZ * far;
      const ey = this.sceneryGroundY(sm, far) + 0.08;
      const g2 = new THREE.BufferGeometry();
      const w0 = 3.4, w1 = 2.0;
      const pos = new Float32Array([
        sm.x + sm.nx * (hw - 0.2) * side - sm.tx * w0, sm.y + 0.03, sm.z + sm.nz * (hw - 0.2) * side - sm.tz * w0,
        sm.x + sm.nx * (hw - 0.2) * side + sm.tx * w0, sm.y + 0.03, sm.z + sm.nz * (hw - 0.2) * side + sm.tz * w0,
        ex - sm.tx * w1, ey, ez - sm.tz * w1,
        ex + sm.tx * w1, ey, ez + sm.tz * w1,
      ]);
      g2.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g2.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 6, 1, 6]), 2));
      g2.setIndex([0, 1, 2, 1, 3, 2]);
      g2.computeVertexNormals();
      scene.add(new THREE.Mesh(g2, dirtMat));
      this.disposables.push(g2);
      // battered mailbox where the dirt meets the road
      const mb = new THREE.Group();
      const mpost = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.1, 0.09), postMat);
      mpost.position.y = 0.55;
      mb.add(mpost);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.26),
        new THREE.MeshLambertMaterial({ color: 0x6a4a34 }));
      box.position.y = 1.16;
      box.rotation.z = (rng() - 0.5) * 0.3;
      mb.add(box);
      mb.position.set(
        sm.x + sm.nx * (hw + 1.4) * side + sm.tx * 4.5,
        sm.y, sm.z + sm.nz * (hw + 1.4) * side + sm.tz * 4.5);
      scene.add(mb);
    }

    // ---- memorial crosses on the outside of the worst bends ---------------
    const worst = [...bends].sort((a, b2) =>
      Math.abs(this.samples[b2].curv) - Math.abs(this.samples[a].curv)).slice(0, 3);
    for (const bi of worst) {
      if (blocked(bi)) continue;
      const sm = this.samples[bi];
      const outside = Math.sign(sm.curv) || 1;
      const grp = new THREE.Group();
      const white = new THREE.MeshLambertMaterial({ color: 0xe8e4da });
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 0.08), white);
      v.position.y = 0.45;
      grp.add(v);
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.08, 0.08), white);
      h.position.y = 0.62;
      grp.add(h);
      const fl = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 5),
        new THREE.MeshLambertMaterial({ color: 0x9a2430 }));
      fl.position.set(0.1, 0.1, 0.08);
      grp.add(fl);
      const d = hw + 2.6;
      grp.position.set(sm.x + sm.nx * d * outside, sm.y, sm.z + sm.nz * d * outside);
      grp.rotation.y = sm.angle + Math.PI + (rng() - 0.5) * 0.5;
      scene.add(grp);
    }

    // ---- destination sign 1 km out ----------------------------------------
    const destName = this.def.banners?.finish || 'FINISH';
    const di = Math.round((this.finishS - 1000) / ds);
    if (di > 0 && !blocked(di)) {
      const tex = makeSign(512, 128, (g) => {
        g.fillStyle = '#2a4a30';
        g.fillRect(0, 0, 512, 128);
        g.strokeStyle = '#cfd4c0';
        g.lineWidth = 5;
        g.strokeRect(8, 8, 496, 112);
        g.fillStyle = '#e6ead8';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        let px = 52;
        do { g.font = `bold ${px}px Arial, sans-serif`; px -= 2; }
        while (px > 20 && g.measureText(destName).width > 380);
        g.fillText(destName, 226, 52);
        g.font = 'bold 34px Arial, sans-serif';
        g.fillText('1', 448, 52);
        g.font = '26px Arial, sans-serif';
        g.fillText('last fuel before town', 256, 98);
      });
      signAt(di, -1, tex, 4.2, 1.1, 2.6, true);
    }

    // ---- Freight Guild toll checkpoint, once per stage ---------------------
    for (let tryf = 0; tryf < 8; tryf++) {
      const f = 0.52 + tryf * 0.035;
      const i = Math.round(f * (N - 1));
      if (f > 0.92 || blocked(i) || this.isInVillage(i * ds)) continue;
      const sm = this.samples[i];
      const side = -1;
      const grp = new THREE.Group();
      const booth = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.5, 2.2),
        new THREE.MeshLambertMaterial({ map: makeConcrete() }));
      booth.position.y = 1.25;
      grp.add(booth);
      const win = new THREE.Mesh(new THREE.BoxGeometry(2.26, 0.6, 1.5),
        new THREE.MeshLambertMaterial({ color: 0x14181c }));
      win.position.y = 1.7;
      grp.add(win);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.18, 2.8), rustFor());
      roof.position.y = 2.6;
      grp.add(roof);
      // barrier arm, raised (the Guild knows better than to stop bikes)
      const pivot = new THREE.Group();
      const armLen = 5.4;
      for (let seg = 0; seg < 6; seg++) {
        const piece = new THREE.Mesh(new THREE.BoxGeometry(armLen / 6, 0.14, 0.1),
          new THREE.MeshLambertMaterial({ color: seg % 2 ? 0xd8d0c0 : 0x9a2430 }));
        piece.position.x = (seg + 0.5) * (armLen / 6);
        pivot.add(piece);
      }
      pivot.position.set(1.3, 1.0, 1.6);
      pivot.rotation.z = 1.15; // open
      grp.add(pivot);
      const tolTex = makeSign(256, 64, (g) => {
        g.fillStyle = '#7a5c38'; g.fillRect(0, 0, 256, 64);
        g.fillStyle = '#17110a';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = 'bold 30px Arial Black, sans-serif';
        g.fillText('TOLL — GUILD ROAD', 128, 34, 240);
      });
      const tol = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.65, 0.08),
        new THREE.MeshLambertMaterial({
          map: tolTex, emissive: 0xffffff, emissiveMap: tolTex, emissiveIntensity: 0.3 }));
      tol.position.set(0, 3.15, 0);
      grp.add(tol);
      const d = hw + 2.6;
      grp.position.set(sm.x + sm.nx * d * side, sm.y, sm.z + sm.nz * d * side);
      grp.rotation.y = sm.angle + Math.PI;
      scene.add(grp);
      break;
    }

    function rustFor() {
      return new THREE.MeshLambertMaterial({ color: 0x4a352a });
    }
  }

  // ------------------------------------------------------------------ zones  // ------------------------------------------------------------------ zones
  // def.zones carves the stage into distinct environments. Beyond what the
  // scenery/fence hooks already do (bare stretches, dense groves, missing
  // fences), this builds the physical dressing: tinted ground aprons for
  // burned/salt/field stretches, rock walls for cuttings, charred snags in
  // the fire scars, hay bales in the fields.
  buildZones(scene) {
    const zones = this.def.zones;
    if (!zones || !zones.length) return;
    let seed = 7;
    for (const ch of this.def.id) seed = (seed * 33 + ch.charCodeAt(0)) >>> 0;
    const rng = mulberry32(seed ^ 0x2c2c);
    const wd = this.wallDist;

    const TINT = {
      burned: 0x221c16,
      barren: 0xc9c0a8,
      fields: 0x9a8a48,
      lake: 0x31504a, // waterlogged verge — the flood reads up to the road
    };

    // split a sample range into runs that avoid bridge spans
    const runsIn = (i0, i1) => {
      const runs = [];
      let start = null;
      for (let i = i0; i <= i1 + 1; i++) {
        const skip = i > i1 ? true : this.isOnBridge(i * this.ds);
        if (!skip && start === null) start = i;
        if (skip && start !== null) {
          if (i - start > 4) runs.push([start, i - 1]);
          start = null;
        }
      }
      return runs;
    };

    for (const z of zones) {
      const i0 = Math.max(0, Math.floor(z.from * (this.N - 1)));
      const i1 = Math.min(this.N - 1, Math.floor(z.to * (this.N - 1)));
      const runs = runsIn(i0, i1);

      // tinted ground apron flanking the road through the zone
      if (TINT[z.kind] != null) {
        const mat = new THREE.MeshLambertMaterial({
          map: makeTile(TINT[z.kind], { contrast: z.kind === 'burned' ? 0.35 : 0.2 }) });
        this.disposables.push(mat, mat.map);
        for (const side of [1, -1]) {
          for (const [a, b] of runs) {
            // fade the tint in and out over ~60 m by narrowing the strips
            const ramp = (sm) => Math.max(0.05, Math.min(1,
              (sm.s - a * this.ds) / 60, (b * this.ds - sm.s) / 60));
            // inner strip rides ON the shoulder plateau (or it would hide
            // in the moat below the raised roadbed), outer skirt falls
            // away with the terrain
            this.buildStrip(scene, a, b,
              (sm) => [sm.x + sm.nx * (wd + 1.2) * side, sm.y - 0.2,
                sm.z + sm.nz * (wd + 1.2) * side],
              (sm) => {
                const w = 1.2 + 23.8 * ramp(sm);
                return [sm.x + sm.nx * (wd + w) * side, sm.y - 0.2,
                  sm.z + sm.nz * (wd + w) * side];
              },
              mat);
            if (z.kind !== 'lake') { // the lake's outer skirt IS the water
              this.buildStrip(scene, a, b,
                (sm) => {
                  const w = 1.2 + 23.8 * ramp(sm);
                  return [sm.x + sm.nx * (wd + w) * side, sm.y - 0.2,
                    sm.z + sm.nz * (wd + w) * side];
                },
                (sm) => {
                  const w = 25 + 70 * ramp(sm);
                  return [sm.x + sm.nx * (wd + w) * side,
                    this.sceneryGroundY(sm, w) + 0.06,
                    sm.z + sm.nz * (wd + w) * side];
                },
                mat);
            }
          }
        }
      }

      // cutting: close rock walls squeeze the road for the stretch
      if (z.kind === 'cut') {
        const rockMat = new THREE.MeshLambertMaterial({
          map: makeTile(0x7d6c58, { contrast: 0.34 }) }); // raw blasted rock
        this.disposables.push(rockMat, rockMat.map);
        for (const side of [1, -1]) {
          for (const [a, b] of runs) {
            const ramp = (sm) => Math.max(0, Math.min(1,
              (sm.s - a * this.ds) / 80, (b * this.ds - sm.s) / 80));
            this.buildStrip(scene, a, b,
              (sm) => [sm.x + sm.nx * (wd + 4) * side, sm.y - 0.25,
                sm.z + sm.nz * (wd + 4) * side],
              (sm) => [sm.x + sm.nx * (wd + 13) * side,
                sm.y - 0.25 + 6.5 * ramp(sm),
                sm.z + sm.nz * (wd + 13) * side],
              rockMat);
            this.buildStrip(scene, a, b,
              (sm) => [sm.x + sm.nx * (wd + 13) * side,
                sm.y - 0.25 + 6.5 * ramp(sm),
                sm.z + sm.nz * (wd + 13) * side],
              (sm) => [sm.x + sm.nx * (wd + 26) * side,
                this.sceneryGroundY(sm, 26) + 0.5 * ramp(sm),
                sm.z + sm.nz * (wd + 26) * side],
              rockMat);
          }
        }
      }

      // fire scar: charred snags — bare trunks with a stub branch or two
      if (z.kind === 'burned') {
        const snag = mergeGeometries([
          (() => { const g = new THREE.CylinderGeometry(0.09, 0.22, 5.4, 5);
            g.translate(0, 2.7, 0); return g; })(),
          (() => { const g = new THREE.BoxGeometry(1.7, 0.09, 0.09);
            g.translate(0.6, 3.4, 0); const m = new THREE.Matrix4()
              .makeRotationZ(0.5); g.applyMatrix4(m); return g; })(),
          (() => { const g = new THREE.BoxGeometry(1.2, 0.08, 0.08);
            g.translate(-0.45, 2.3, 0); const m = new THREE.Matrix4()
              .makeRotationZ(-0.4); g.applyMatrix4(m); return g; })(),
        ]);
        const zoneLen = (i1 - i0) * this.ds;
        const n = Math.max(8, Math.round(zoneLen / 8));
        const snags = new THREE.InstancedMesh(snag,
          new THREE.MeshLambertMaterial({ color: 0x191512 }), n);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
        const pos = new THREE.Vector3(), sc = new THREE.Vector3();
        for (let k = 0; k < n; k++) {
          const si = i0 + Math.floor(rng() * (i1 - i0));
          const sm = this.samples[si];
          if (this.isOnBridge(sm.s)) continue;
          const side = rng() > 0.5 ? 1 : -1;
          const dd = 2 + rng() * 46;
          e.set((rng() - 0.5) * 0.24, rng() * Math.PI * 2, (rng() - 0.5) * 0.24);
          q.setFromEuler(e);
          pos.set(
            sm.x + sm.nx * (wd + dd) * side,
            this.sceneryGroundY(sm, dd),
            sm.z + sm.nz * (wd + dd) * side);
          const s2 = 0.6 + rng() * 1.1;
          sc.set(s2, s2, s2);
          m4.compose(pos, q, sc);
          snags.setMatrixAt(k, m4);
        }
        scene.add(snags);
        this.disposables.push(snag);
      }

      // town: a ruined main street — blocks crowd both sides of the road
      if (z.kind === 'town') {
        const facade = (base) => {
          const cv = document.createElement('canvas');
          cv.width = 128; cv.height = 128;
          const g = cv.getContext('2d');
          g.fillStyle = base;
          g.fillRect(0, 0, 128, 128);
          for (let fy = 0; fy < 4; fy++) {
            for (let fx = 0; fx < 5; fx++) {
              const broken = rng() < 0.3;
              g.fillStyle = broken ? '#0d0b09' : 'rgba(20,22,26,0.85)';
              g.fillRect(10 + fx * 24, 12 + fy * 28, 14, 18);
              if (broken && rng() < 0.5) { // boarded
                g.fillStyle = '#4a3c28';
                g.fillRect(10 + fx * 24, 18 + fy * 28, 14, 7);
              }
            }
          }
          for (let k = 0; k < 40; k++) {
            g.fillStyle = `rgba(30,24,16,${0.05 + rng() * 0.12})`;
            g.fillRect(rng() * 128, rng() * 128, 2 + rng() * 8, 1 + rng() * 4);
          }
          const tex = new THREE.CanvasTexture(cv);
          tex.colorSpace = THREE.SRGBColorSpace;
          return tex;
        };
        const walls = ['#8a7a62', '#7d6a55', '#6e6a60'].map((c) =>
          new THREE.MeshLambertMaterial({ map: facade(c) }));
        const roofM = new THREE.MeshLambertMaterial({ color: 0x3a3530 });
        this.disposables.push(...walls, roofM);
        for (let i = i0; i < i1; i += Math.max(1, Math.round((11 + rng() * 6) / this.ds))) {
          const sm = this.samples[i];
          if (this.isOnBridge(sm.s) || this.isInTunnel(sm.s)) continue;
          for (const side of [1, -1]) {
            if (rng() < 0.18) continue; // gaps — rubble lots
            const wB = 6 + rng() * 5, dB = 5 + rng() * 4;
            const floors = 1 + Math.floor(rng() * 3);
            const hB = floors * 2.9 + rng();
            const wallM = walls[Math.floor(rng() * walls.length)];
            const b = new THREE.Mesh(
              new THREE.BoxGeometry(wB, hB, dB),
              [wallM, wallM, roofM, roofM, wallM, wallM]);
            const dd = 3.2 + rng() * 3 + dB / 2;
            b.position.set(
              sm.x + sm.nx * (wd + dd) * side,
              this.sceneryGroundY(sm, dd) + hB / 2,
              sm.z + sm.nz * (wd + dd) * side);
            b.rotation.y = sm.angle + (rng() - 0.5) * 0.08;
            scene.add(b);
          }
        }
      }

      // lakeside: flat water hugging the road, reeds on the shore, a
      // half-sunk rowing boat someone never came back for
      if (z.kind === 'lake') {
        const waterM = new THREE.MeshPhongMaterial({
          color: 0x35586a, shininess: 130, specular: 0x9ab8c8,
          transparent: true, opacity: 0.9,
        });
        this.disposables.push(waterM);
        // low causeways flood BOTH sides; higher roads get a single shore
        let minY = Infinity;
        for (let i = i0; i <= i1; i++) minY = Math.min(minY, this.samples[i].y);
        const waterY = minY - 0.6;
        const sides = minY < 6 ? [1, -1] : [rng() > 0.5 ? 1 : -1];
        const side = sides[0]; // reeds and the boat take the first shore
        for (const sd of sides) {
          for (const [a, b] of runs) {
            this.buildStrip(scene, a, b,
              (sm) => [sm.x + sm.nx * (wd + 20) * sd, waterY, sm.z + sm.nz * (wd + 20) * sd],
              (sm) => [sm.x + sm.nx * (wd + 150) * sd, waterY, sm.z + sm.nz * (wd + 150) * sd],
              waterM);
          }
        }
        // reeds along the shore edge
        const reedGeo = new THREE.CylinderGeometry(0.02, 0.035, 1.6, 4);
        reedGeo.translate(0, 0.8, 0);
        const reedM = new THREE.MeshLambertMaterial({ color: 0x5e6b32 });
        const zoneLen = (i1 - i0) * this.ds;
        const nR = Math.round(zoneLen / 1.1);
        const reeds = new THREE.InstancedMesh(reedGeo, reedM, nR);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
        const pos = new THREE.Vector3(), sc = new THREE.Vector3();
        for (let k = 0; k < nR; k++) {
          const si = i0 + Math.floor(rng() * (i1 - i0));
          const sm = this.samples[si];
          const dd = 21 + rng() * 7;
          e.set((rng() - 0.5) * 0.3, rng() * Math.PI, (rng() - 0.5) * 0.3);
          q.setFromEuler(e);
          pos.set(
            sm.x + sm.nx * (wd + dd) * side,
            waterY + 0.05,
            sm.z + sm.nz * (wd + dd) * side);
          const s2 = 0.7 + rng() * 0.8;
          sc.set(s2, s2, s2);
          m4.compose(pos, q, sc);
          reeds.setMatrixAt(k, m4);
        }
        scene.add(reeds);
        this.disposables.push(reedGeo, reedM);
        // the boat
        const bi = Math.round((i0 + i1) / 2);
        const bsm = this.samples[bi];
        const hull = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 3.4),
          new THREE.MeshLambertMaterial({ map: makeTile(0x5a4630, { contrast: 0.3 }) }));
        hull.position.set(
          bsm.x + bsm.nx * (wd + 32) * side, waterY + 0.08,
          bsm.z + bsm.nz * (wd + 32) * side);
        hull.rotation.set(0.12, rng() * Math.PI, -0.18);
        scene.add(hull);
      }

      // orchard: planted rows — nothing says humans like agriculture grids
      if (z.kind === 'orchard') {
        const treeGeo = mergeGeometries([
          (() => { const g = new THREE.CylinderGeometry(0.09, 0.13, 1.4, 5);
            g.translate(0, 0.7, 0); return g; })(),
          (() => { const g = new THREE.SphereGeometry(1.05, 7, 6);
            g.scale(1, 0.85, 1); g.translate(0, 2.0, 0); return g; })(),
        ]);
        const treeM = new THREE.MeshLambertMaterial({ color: 0x5f7a34 });
        const side = rng() > 0.5 ? 1 : -1;
        const rowStep = Math.max(2, Math.round(8.5 / this.ds));
        const rows = [];
        for (let i = i0; i < i1; i += rowStep) rows.push(i);
        const perRow = 7;
        const trees = new THREE.InstancedMesh(treeGeo, treeM, rows.length * perRow);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
        const pos = new THREE.Vector3(), sc = new THREE.Vector3();
        let ti = 0;
        for (const ri of rows) {
          const sm = this.samples[ri];
          if (this.isOnBridge(sm.s)) continue;
          for (let k = 0; k < perRow; k++) {
            const dd = 6 + k * 6.5;
            e.set(0, rng() * Math.PI, 0);
            q.setFromEuler(e);
            pos.set(
              sm.x + sm.nx * (wd + dd) * side,
              this.sceneryGroundY(sm, dd),
              sm.z + sm.nz * (wd + dd) * side);
            const s2 = 0.85 + rng() * 0.4;
            sc.set(s2, s2, s2);
            m4.compose(pos, q, sc);
            trees.setMatrixAt(ti++, m4);
          }
        }
        trees.count = ti;
        scene.add(trees);
        this.disposables.push(treeGeo, treeM);
      }

      // spires: a garden of towering rock pillars
      if (z.kind === 'spires') {
        const spireGeo = new THREE.CylinderGeometry(0.32, 1, 1, 6);
        spireGeo.translate(0, 0.5, 0);
        const spireM = new THREE.MeshLambertMaterial({
          map: makeTile(this.def.valley?.color ?? 0x9a6b48, { contrast: 0.3 }) });
        const zoneLen = (i1 - i0) * this.ds;
        const n = Math.round(zoneLen / 22);
        const spires = new THREE.InstancedMesh(spireGeo, spireM, n);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
        const pos = new THREE.Vector3(), sc = new THREE.Vector3();
        for (let k = 0; k < n; k++) {
          const si = i0 + Math.floor(rng() * (i1 - i0));
          const sm = this.samples[si];
          if (this.isOnBridge(sm.s)) continue;
          const side = rng() > 0.5 ? 1 : -1;
          const dd = 12 + rng() * 70;
          e.set((rng() - 0.5) * 0.1, rng() * Math.PI, (rng() - 0.5) * 0.1);
          q.setFromEuler(e);
          pos.set(
            sm.x + sm.nx * (wd + dd) * side,
            this.sceneryGroundY(sm, dd) - 0.5,
            sm.z + sm.nz * (wd + dd) * side);
          sc.set(2.2 + rng() * 3.4, 9 + rng() * 17, 2.2 + rng() * 3.4);
          m4.compose(pos, q, sc);
          spires.setMatrixAt(k, m4);
        }
        scene.add(spires);
        this.disposables.push(spireGeo, spireM);
      }

      // dunes: smooth sand swells rolling to the horizon
      if (z.kind === 'dunes') {
        const duneGeo = new THREE.SphereGeometry(1, 10, 7);
        const duneM = new THREE.MeshLambertMaterial({
          map: makeTile(0xc4a26a, { contrast: 0.12 }) });
        const zoneLen = (i1 - i0) * this.ds;
        const n = Math.round(zoneLen / 26);
        const dunes = new THREE.InstancedMesh(duneGeo, duneM, n);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
        const pos = new THREE.Vector3(), sc = new THREE.Vector3();
        for (let k = 0; k < n; k++) {
          const si = i0 + Math.floor(rng() * (i1 - i0));
          const sm = this.samples[si];
          const side = rng() > 0.5 ? 1 : -1;
          const dd = 22 + rng() * 90;
          const r = 9 + rng() * 16;
          e.set(0, rng() * Math.PI, 0);
          q.setFromEuler(e);
          pos.set(
            sm.x + sm.nx * (wd + dd) * side,
            this.sceneryGroundY(sm, dd) - r * 0.24,
            sm.z + sm.nz * (wd + dd) * side);
          sc.set(r, r * 0.32, r * (0.7 + rng() * 0.6));
          m4.compose(pos, q, sc);
          dunes.setMatrixAt(k, m4);
        }
        scene.add(dunes);
        this.disposables.push(duneGeo, duneM);
      }

      // fields: hay bales dotted through the crop stretch
      if (z.kind === 'fields') {
        const baleGeo = new THREE.CylinderGeometry(0.75, 0.75, 1.5, 10);
        baleGeo.rotateZ(Math.PI / 2);
        const baleMat = new THREE.MeshLambertMaterial({
          map: makeTile(0xb0954e, { contrast: 0.28 }) });
        const zoneLen = (i1 - i0) * this.ds;
        const n = Math.max(4, Math.round(zoneLen / 34));
        const bales = new THREE.InstancedMesh(baleGeo, baleMat, n);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
        const pos = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
        for (let k = 0; k < n; k++) {
          const si = i0 + Math.floor(rng() * (i1 - i0));
          const sm = this.samples[si];
          if (this.isOnBridge(sm.s)) continue;
          const side = rng() > 0.5 ? 1 : -1;
          const dd = 6 + rng() * 40;
          e.set(0, rng() * Math.PI, 0);
          q.setFromEuler(e);
          pos.set(
            sm.x + sm.nx * (wd + dd) * side,
            this.sceneryGroundY(sm, dd) + 0.75,
            sm.z + sm.nz * (wd + dd) * side);
          m4.compose(pos, q, sc);
          bales.setMatrixAt(k, m4);
        }
        scene.add(bales);
        this.disposables.push(baleGeo, baleMat);
      }
    }
  }

  // -------------------------------------------------------------- landmarks  // -------------------------------------------------------------- landmarks
  // def.landmarks picks from a menu of roadside set dressing so every road
  // has its own silhouette: wrecked cars, marching pylon lines with sagging
  // wires, weathered billboards, concrete ruins, and one-off set pieces
  // (gas station, water tower, radio mast, wind turbines, crashed airliner).
  buildLandmarks(scene) {
    const kinds = this.def.landmarks;
    if (!kinds || !kinds.length) return;
    let seed = 0;
    for (const ch of this.def.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rng = mulberry32(seed ^ 0xbeef);
    const wd = this.wallDist;

    // a stage fraction is "clear" if it avoids bridges, tunnels and villages
    const clear = (f) => {
      const pad = 0.012;
      const hit = (rs) => (rs || []).some((r) => f >= r.from - pad && f <= r.to + pad);
      return !hit(this.def.bridges) && !hit(this.def.tunnels) && !hit(this.def.villages);
    };
    const smAt = (f) => this.samples[
      Math.min(this.N - 1, Math.floor((f * this.length) / this.ds))];
    const groundAt = (sm, dd) => this.sceneryGroundY(sm, dd);
    const place = (obj, sm, dd, side, rot = 0) => {
      obj.position.set(
        sm.x + sm.nx * (wd + dd) * side,
        groundAt(sm, dd),
        sm.z + sm.nz * (wd + dd) * side);
      obj.rotation.y = rot;
      scene.add(obj);
    };

    const steel = new THREE.MeshLambertMaterial({ color: 0x3c3f42 });
    const concrete = new THREE.MeshLambertMaterial({ map: makeConcrete() });
    const wood = new THREE.MeshLambertMaterial({ color: 0x5a4630 });
    const rustDark = new THREE.MeshLambertMaterial({ color: 0x4a352a });
    this.disposables.push(steel, concrete, wood, rustDark);
    const bx = (w, h, d, x, y, z, ry = 0, rz = 0) => {
      const g = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Matrix4()
        .makeRotationFromEuler(new THREE.Euler(0, ry, rz));
      m.setPosition(x, y, z);
      g.applyMatrix4(m);
      return g;
    };

    // ---- wrecked cars: one merged hulk, instanced with rust tints --------
    if (kinds.includes('wrecks')) {
      const hulk = mergeGeometries([
        bx(4.0, 0.6, 1.75, 0, 0.62, 0),          // body
        bx(1.9, 0.55, 1.6, -0.35, 1.18, 0),      // cabin
        bx(0.7, 0.35, 1.7, 1.9, 0.5, 0),         // crumpled nose
      ]);
      const n = Math.max(6, Math.round(this.length / 420));
      const wrecks = new THREE.InstancedMesh(
        hulk, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
      const m4 = new THREE.Matrix4(), e = new THREE.Euler(), q = new THREE.Quaternion();
      const pos = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
      const col = new THREE.Color();
      let placed = 0;
      for (let k = 0; k < n * 4 && placed < n; k++) {
        const f = rng();
        if (!clear(f)) continue;
        const sm = smAt(f);
        const side = rng() > 0.5 ? 1 : -1;
        const dd = 3 + rng() * 8;
        e.set((rng() - 0.5) * 0.12, rng() * Math.PI * 2, (rng() - 0.5) * 0.18);
        q.setFromEuler(e);
        pos.set(
          sm.x + sm.nx * (wd + dd) * side,
          groundAt(sm, dd) + 0.05,
          sm.z + sm.nz * (wd + dd) * side);
        const s2 = 0.85 + rng() * 0.35;
        sc.set(s2, s2, s2);
        m4.compose(pos, q, sc);
        wrecks.setMatrixAt(placed, m4);
        // rust browns, the odd burned-out black
        if (rng() < 0.25) col.setHex(0x241f1c);
        else col.setHSL(0.06 + rng() * 0.04, 0.45 + rng() * 0.2, 0.22 + rng() * 0.12);
        wrecks.setColorAt(placed, col);
        placed++;
      }
      wrecks.count = placed;
      wrecks.castShadow = false;
      scene.add(wrecks);
      this.disposables.push(hulk);
    }

    // ---- pylon line: merged lattice tower, instanced; wires as GL lines --
    if (kinds.includes('pylons')) {
      const legT = 0.09;
      const pylon = mergeGeometries([
        bx(0.24, 12, 0.24, -1.3, 6, -1.3, 0, legT),
        bx(0.24, 12, 0.24, 1.3, 6, -1.3, 0, -legT),
        bx(0.24, 12, 0.24, -1.3, 6, 1.3, 0, legT),
        bx(0.24, 12, 0.24, 1.3, 6, 1.3, 0, -legT),
        bx(0.3, 9, 0.3, 0, 15.5, 0),
        bx(6.2, 0.28, 0.28, 0, 13.2, 0),
        bx(5.0, 0.26, 0.26, 0, 16.0, 0),
        bx(3.6, 0.24, 0.24, 0, 18.6, 0),
      ]);
      const step = 210; // metres between towers
      const count = Math.floor(this.length / step);
      const towers = new THREE.InstancedMesh(pylon, steel, count);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const pos = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
      const side = 1, dd = 34;
      const anchors = [];
      let placed = 0;
      for (let i = 0; i < count; i++) {
        const f = (i + 0.5) * step / this.length;
        if (!clear(f)) { anchors.push(null); continue; }
        const sm = smAt(f);
        const toppled = rng() < 0.1;
        e.set(0, sm.angle + (rng() - 0.5) * 0.2, toppled ? 1.25 : 0);
        q.setFromEuler(e);
        pos.set(
          sm.x + sm.nx * (wd + dd) * side,
          groundAt(sm, dd),
          sm.z + sm.nz * (wd + dd) * side);
        m4.compose(pos, q, sc);
        towers.setMatrixAt(placed, m4);
        anchors.push(toppled ? null : pos.clone());
        placed++;
      }
      towers.count = placed;
      scene.add(towers);
      this.disposables.push(pylon);
      // sagging cables between consecutive standing towers
      const wirePts = [];
      for (let i = 1; i < anchors.length; i++) {
        const a = anchors[i - 1], b = anchors[i];
        if (!a || !b) continue;
        for (const h of [13.2, 16.0]) {
          const SEG = 6;
          for (let sgi = 0; sgi < SEG; sgi++) {
            for (const t of [sgi / SEG, (sgi + 1) / SEG]) {
              const sag = Math.sin(t * Math.PI) * -2.2;
              wirePts.push(
                a.x + (b.x - a.x) * t,
                a.y + h + (b.y - a.y) * t + sag,
                a.z + (b.z - a.z) * t);
            }
          }
        }
      }
      if (wirePts.length) {
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wirePts), 3));
        const wm = new THREE.LineBasicMaterial({ color: 0x14161a, transparent: true, opacity: 0.65 });
        scene.add(new THREE.LineSegments(wg, wm));
        this.disposables.push(wg, wm);
      }
    }

    // ---- billboards: weathered wasteland ads facing oncoming riders ------
    if (kinds.includes('billboards')) {
      const ADS = [
        ['EAT AT BRINEWORKS', 'the fish is probably fish'],
        ['NEO-CITY', 'the lights still work'],
        ['FREIGHT GUILD', 'we own the asphalt'],
        ['RUST IN PEACE', 'memorial services & parts'],
        ['FUEL UP. PRAY. RIDE.', 'last pumps before the belt'],
        ['ROOM & BOARD', 'bullet holes patched free'],
      ];
      const n = Math.max(3, Math.round(this.length / 1500));
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5 + rng() * 0.3) / n;
        if (!clear(f)) continue;
        const sm = smAt(f);
        const side = i % 2 ? 1 : -1;
        const ad = ADS[Math.floor(rng() * ADS.length)];
        const cv = document.createElement('canvas');
        cv.width = 256; cv.height = 128;
        const g = cv.getContext('2d');
        g.fillStyle = `hsl(${38 + rng() * 14}, 26%, ${62 + rng() * 12}%)`;
        g.fillRect(0, 0, 256, 128);
        g.fillStyle = 'rgba(40,30,18,0.85)';
        g.textAlign = 'center';
        g.font = 'bold 26px Arial Black, sans-serif';
        g.fillText(ad[0], 128, 56, 236);
        g.font = 'italic 15px Georgia, serif';
        g.fillText(ad[1], 128, 86, 236);
        for (let k = 0; k < 26; k++) { // grime streaks running down
          g.fillStyle = `rgba(60,45,28,${0.05 + rng() * 0.1})`;
          const x = rng() * 256;
          g.fillRect(x, 0, 1 + rng() * 3, 40 + rng() * 88);
        }
        g.globalCompositeOperation = 'destination-out'; // torn corner
        g.beginPath();
        const cx = rng() > 0.5 ? 256 : 0;
        g.moveTo(cx, 128); g.lineTo(cx ? 256 - 40 - rng() * 40 : 40 + rng() * 40, 128);
        g.lineTo(cx, 70 + rng() * 40); g.fill();
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;
        const grp = new THREE.Group();
        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(6.4, 3.2, 0.15),
          new THREE.MeshLambertMaterial({
            map: tex, side: THREE.DoubleSide,
            // pale paper reads even on the shadow side
            emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35,
          }));
        panel.position.y = 4.6;
        panel.rotation.z = (rng() - 0.5) * 0.06;
        grp.add(panel);
        for (const px of [-2.4, 2.4]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 4.8, 0.22), wood);
          post.position.set(px, 2.2, -0.1);
          grp.add(post);
        }
        // face oncoming traffic, slight scatter
        place(grp, sm, 9 + rng() * 4, side, sm.angle + Math.PI + (side > 0 ? -0.32 : 0.32));
      }
    }

    // ---- concrete ruins: broken shells of pre-war buildings --------------
    if (kinds.includes('ruins')) {
      const n = Math.max(3, Math.round(this.length / 1300));
      for (let i = 0; i < n; i++) {
        const f = (i + 0.2 + rng() * 0.5) / n;
        if (!clear(f)) continue;
        const sm = smAt(f);
        const side = rng() > 0.5 ? 1 : -1;
        const grp = new THREE.Group();
        const walls = 2 + Math.floor(rng() * 3);
        for (let w = 0; w < walls; w++) {
          const sub = new THREE.Group();
          const wl = 3.5 + rng() * 5;
          const steps = 2 + Math.floor(rng() * 3);
          for (let st = 0; st < steps; st++) { // jagged stepped top
            const hh = 1.2 + rng() * 3.2;
            const wall = new THREE.Mesh(
              new THREE.BoxGeometry(wl / steps, hh, 0.4), concrete);
            wall.position.set(
              -wl / 2 + (st + 0.5) * (wl / steps) + (rng() - 0.5) * 0.2,
              hh / 2, 0);
            sub.add(wall);
          }
          sub.position.set((rng() - 0.5) * 9, 0, (rng() - 0.5) * 9);
          sub.rotation.y = rng() * Math.PI;
          grp.add(sub);
        }
        // rubble heaps
        for (let r = 0; r < 4; r++) {
          const rub = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5 + rng() * 0.8), concrete);
          rub.position.set((rng() - 0.5) * 10, 0.3, (rng() - 0.5) * 10);
          grp.add(rub);
        }
        place(grp, sm, 16 + rng() * 14, side, rng() * Math.PI);
      }
    }

    // ---- wind turbines: tall, some dead, one broken ----------------------
    if (kinds.includes('turbines')) {
      const n = 4 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n + (rng() - 0.5) * 0.06;
        if (!clear(f)) continue;
        const sm = smAt(f);
        const side = rng() > 0.6 ? -1 : 1;
        const grp = new THREE.Group();
        const white = new THREE.MeshLambertMaterial({ color: 0xd8d4cc });
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.5, 19, 8), white);
        pole.position.y = 9.5;
        grp.add(pole);
        const nac = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.9), white);
        nac.position.set(0.2, 19, 0);
        grp.add(nac);
        const hubA = rng() * Math.PI * 2;
        const missing = rng() < 0.3 ? Math.floor(rng() * 3) : -1;
        for (let b = 0; b < 3; b++) {
          if (b === missing) continue;
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.18, 7.2, 0.6), white);
          blade.geometry.translate(0, 3.6, 0);
          blade.position.set(-0.75, 19, 0);
          blade.rotation.x = hubA + (b * Math.PI * 2) / 3;
          grp.add(blade);
        }
        if (rng() < 0.2) grp.rotation.z = 0.5 + rng() * 0.4; // one keeled over
        place(grp, sm, 45 + rng() * 40, side, rng() * Math.PI);
      }
    }

    // ---- one-off set pieces at fixed stage fractions ----------------------
    const oneOff = (f0, builder) => {
      for (let tryf = 0; tryf < 8; tryf++) {
        const f = f0 + tryf * 0.03;
        if (f > 0.95 || !clear(f)) continue;
        const sm = smAt(f);
        builder(sm);
        return;
      }
    };

    if (kinds.includes('gasstation')) {
      oneOff(0.42, (sm) => {
        const grp = new THREE.Group();
        const canopy = new THREE.Mesh(new THREE.BoxGeometry(10, 0.5, 6), rustDark);
        canopy.position.y = 4.4;
        canopy.rotation.z = 0.05;
        grp.add(canopy);
        for (const px of [-4, 4]) {
          const pil = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.4, 0.4), concrete);
          pil.position.set(px, 2.2, 0);
          grp.add(pil);
        }
        const kiosk = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.6, 2.6), concrete);
        kiosk.position.set(-2.6, 1.3, -1.4);
        grp.add(kiosk);
        for (const px of [-0.8, 1.4]) {
          const pump = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.15, 0.4),
            new THREE.MeshLambertMaterial({ color: 0x7a2a20 }));
          pump.position.set(px, 0.57, 0.6);
          grp.add(pump);
        }
        const sign = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.12), rustDark);
        sign.position.set(4.6, 5.6, 2.6);
        grp.add(sign);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 5.6, 6), steel);
        pole.position.set(4.6, 2.8, 2.6);
        grp.add(pole);
        const side = rng() > 0.5 ? 1 : -1;
        place(grp, sm, 8, side, sm.angle + (side > 0 ? Math.PI : 0));
      });
    }

    if (kinds.includes('watertower')) {
      oneOff(0.68, (sm) => {
        const grp = new THREE.Group();
        for (const [lx, lz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.24, 8, 0.24), steel);
          leg.position.set(lx * 0.8, 4, lz * 0.8);
          leg.rotation.z = -lx * 0.06;
          leg.rotation.x = lz * 0.06;
          grp.add(leg);
        }
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 3.2, 12), rustDark);
        tank.position.y = 9.6;
        grp.add(tank);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(2.35, 1.1, 12), steel);
        cap.position.y = 11.75;
        grp.add(cap);
        place(grp, sm, 22 + rng() * 10, rng() > 0.5 ? 1 : -1, rng() * Math.PI);
      });
    }

    if (kinds.includes('radiomast')) {
      oneOff(0.55, (sm) => {
        const grp = new THREE.Group();
        for (let seg = 0; seg < 3; seg++) {
          const w2 = 0.7 - seg * 0.2;
          const m = new THREE.Mesh(new THREE.BoxGeometry(w2, 10, w2), steel);
          m.position.y = 5 + seg * 10;
          grp.add(m);
        }
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 5),
          new THREE.MeshBasicMaterial({ color: 0xff3020 }));
        tip.position.y = 30.4;
        grp.add(tip);
        // guy wires
        const gw = [];
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2;
          gw.push(0, 24, 0, Math.cos(a) * 11, 0, Math.sin(a) * 11);
        }
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gw), 3));
        grp.add(new THREE.LineSegments(wg,
          new THREE.LineBasicMaterial({ color: 0x14161a, transparent: true, opacity: 0.6 })));
        place(grp, sm, 26 + rng() * 12, rng() > 0.5 ? 1 : -1, 0);
      });
    }

    if (kinds.includes('plane')) {
      oneOff(0.3, (sm) => {
        const grp = new THREE.Group();
        const alu = new THREE.MeshLambertMaterial({ color: 0x8a8d90 });
        const fus = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 2.1, 17, 10), alu);
        fus.rotation.z = Math.PI / 2 - 0.09; // nose ploughed in
        fus.position.y = 1.4;
        grp.add(fus);
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4.2, 2.6), alu);
        fin.position.set(-8, 3.6, 0);
        fin.rotation.x = 0.15;
        grp.add(fin);
        const wing = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.32, 2.6), alu);
        wing.position.set(4, 0.35, 7.5);
        wing.rotation.y = 0.7;
        wing.rotation.z = 0.06;
        grp.add(wing);
        const wing2 = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.3, 2.2), alu);
        wing2.position.set(-2, 0.9, -3.4);
        wing2.rotation.y = -0.4;
        wing2.rotation.z = -0.12;
        grp.add(wing2);
        place(grp, sm, 20 + rng() * 8, rng() > 0.5 ? 1 : -1, rng() * Math.PI);
      });
    }
  }

  // wide grass slope from the shoulder down to the plain — sells an
  // elevated road as a hillside terrace instead of a floating causeway  // wide grass slope from the shoulder down to the plain — sells an
  // elevated road as a hillside terrace instead of a floating causeway
  buildApron(scene) {
    const a = this.def.apron;
    if (!a) return;
    const W = a.width || 70;
    const mat = new THREE.MeshLambertMaterial({
      map: makeTile(a.color ?? this.def.colors.ground, { contrast: 0.2 }) });
    this.applyWear(mat, { dirt: true });
    this.disposables.push(mat, mat.map);
    const nearBridge = (i) => {
      const fr = ((i % this.N) * this.ds) / this.length;
      return (this.def.bridges || []).some((b) => fr >= b.from - 0.012 && fr <= b.to + 0.012);
    };
    const runs = [];
    let start = null;
    for (let i = 0; i <= this.N; i++) {
      const skip = i === this.N ? true : nearBridge(i);
      if (!skip && start === null) start = i;
      if (skip && start !== null) {
        if (i - start > 5) runs.push([start, i - 1]);
        start = null;
      }
    }
    const wd = this.wallDist;
    // on tight bends the offset curve would sweep past the arc centre and
    // fold into spikes — clamp the apron width by the local turn radius
    const wAt = (sm) => {
      const r = 1 / Math.max(1e-4, Math.abs(sm.curv));
      return Math.max(18, Math.min(W, 0.75 * r - wd));
    };
    for (const side of [1, -1]) {
      for (const [i0, i1] of runs) {
        this.buildStrip(scene, i0, i1,
          (sm) => [sm.x + sm.nx * (wd + 25) * side, sm.y - 0.3, sm.z + sm.nz * (wd + 25) * side],
          (sm) => {
            const w = wAt(sm);
            return [sm.x + sm.nx * (wd + w) * side, -0.32, sm.z + sm.nz * (wd + w) * side];
          },
          mat);
      }
    }
  }

  // roadside settlements: little clusters of houses along the stretches the
  // route marks as villages. style 'coast' = plaster + terracotta hip roofs,
  // style 'stilt' = wooden huts on posts with thatch gables.
  buildVillages(scene) {
    const vills = this.def.villages;
    if (!vills || !vills.length) return;
    const rng = mulberry32(7331);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const roofGeo = new THREE.ConeGeometry(1, 1, 4);
    roofGeo.rotateY(Math.PI / 4);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const postGeo = new THREE.CylinderGeometry(0.09, 0.11, 1, 5);
    const coastWalls = [0xe8e0cc, 0xd8b890, 0xc8a08a, 0xe0cfae].map(
      (cc) => new THREE.MeshLambertMaterial({ map: makeTile(cc, { contrast: 0.14 }) }));
    const stiltWalls = [0x7a5a38, 0x6b4e30, 0x8a6a42].map(
      (cc) => new THREE.MeshLambertMaterial({ map: makeTile(cc, { contrast: 0.22 }) }));
    const coastRoof = [0xa0522d, 0x8f4a2a, 0xb0603a].map(
      (cc) => new THREE.MeshLambertMaterial({ map: makeTile(cc, { contrast: 0.18 }) }));
    const stiltRoof = [0xa8935a, 0x968248, 0x8a7a46].map(
      (cc) => new THREE.MeshLambertMaterial({ map: makeTile(cc, { contrast: 0.26 }) }));
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x2c241c });
    const postMat = new THREE.MeshLambertMaterial({ color: 0x4e3a24 });
    for (const m of [...coastWalls, ...stiltWalls, ...coastRoof, ...stiltRoof]) {
      this.disposables.push(m.map);
    }
    this.disposables.push(roofGeo, boxGeo, postGeo, ...coastWalls, ...stiltWalls,
      ...coastRoof, ...stiltRoof, darkMat, postMat);

    for (const v of vills) {
      const stilt = v.style === 'stilt';
      const walls = stilt ? stiltWalls : coastWalls;
      const roofs = stilt ? stiltRoof : coastRoof;
      const sA = v.from * this.length, sB = v.to * this.length;
      // one hut roughly every 20 m, alternating sides so the road threads
      // between the houses instead of skirting a row
      let side = rng() > 0.5 ? 1 : -1;
      for (let s0 = sA; s0 < sB; s0 += 17 + rng() * 9) {
        side = -side;
        const sm = this.samples[Math.min(this.N - 1, Math.floor(s0 / this.ds))];
        if (this.isOnBridge(sm.s)) continue;
        const dd = 2.5 + rng() * 6;
        const dist = this.wallDist + dd;
        const x = sm.x + sm.nx * dist * side;
        const z = sm.z + sm.nz * dist * side;
        const y = this.sceneryGroundY(sm, dd) + 0.05;

        const grp = new THREE.Group();
        const w = 4.2 + rng() * 2.2, d = 3.8 + rng() * 2.0;
        const h = stilt ? 2.4 + rng() * 0.6 : 3.0 + rng() * 1.4;
        const lift = stilt ? 1.1 + rng() * 0.4 : 0;
        const body = new THREE.Mesh(boxGeo, pick(walls));
        body.scale.set(w, h, d);
        body.position.y = lift + h / 2;
        grp.add(body);
        if (stilt) {
          for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const post = new THREE.Mesh(postGeo, postMat);
            post.scale.y = lift + 0.3;
            post.position.set(px * w * 0.42, (lift + 0.3) / 2, pz * d * 0.42);
            grp.add(post);
          }
        }
        const roof = new THREE.Mesh(roofGeo, pick(roofs));
        const rh = stilt ? 1.6 + rng() * 0.6 : 1.1 + rng() * 0.7;
        roof.scale.set(w * 0.82, rh, d * 0.82);
        roof.position.y = lift + h + rh / 2 - 0.02;
        grp.add(roof);
        // door + a window or two on the side facing the road
        const door = new THREE.Mesh(boxGeo, darkMat);
        door.scale.set(0.7, 1.35, 0.06);
        door.position.set((rng() - 0.5) * w * 0.4, lift + 0.68, d / 2 + 0.02);
        grp.add(door);
        for (let k = 0; k < 1 + Math.floor(rng() * 2); k++) {
          const win = new THREE.Mesh(boxGeo, darkMat);
          win.scale.set(0.6, 0.6, 0.06);
          win.position.set((k === 0 ? -1 : 1) * w * 0.28, lift + h * 0.62, d / 2 + 0.02);
          grp.add(win);
        }
        grp.position.set(x, y, z);
        // face the road, with a little scatter so it isn't a parade line
        grp.rotation.y = Math.atan2(sm.nx * side, sm.nz * side) + (rng() - 0.5) * 0.4;
        const sc = 1.0 + rng() * 0.4;
        grp.scale.set(sc, sc, sc);
        scene.add(grp);
      }
    }
  }

  // rising ridges along both sides of the road — the "you're in a valley"
  // enclosure. Interrupted around bridges so the ravine reads as a real gap.
  buildValleyWalls(scene) {
    const v = this.def.valley;
    if (!v) return;
    const mat = new THREE.MeshLambertMaterial({ color: v.color, side: THREE.DoubleSide });
    this.disposables.push(mat);
    const nearBridge = (i) => {
      const fr = ((i % this.N) * this.ds) / this.length;
      return (this.def.bridges || []).some((b) => fr >= b.from - 0.015 && fr <= b.to + 0.015);
    };
    const runs = [];
    let start = null;
    for (let i = 0; i <= this.N; i++) {
      const skip = i === this.N ? true : nearBridge(i);
      if (!skip && start === null) start = i;
      if (skip && start !== null) {
        if (i - start > 5) runs.push([start, i - 1]);
        start = null;
      }
    }
    const wd = this.wallDist;
    for (const side of [1, -1]) {
      for (const [a, b] of runs) {
        // ramp the ridge height down near the run ends so interrupted walls
        // sink into the ground instead of showing tall cut faces at the gap
        const ramp = (sm) => Math.max(0, Math.min(1,
          (sm.s - a * this.ds) / 70, (b * this.ds - sm.s) / 70));
        this.buildStrip(scene, a, b,
          (sm) => [sm.x + sm.nx * (wd + 24) * side, sm.y - 0.2, sm.z + sm.nz * (wd + 24) * side],
          (sm) => [sm.x + sm.nx * (wd + 52) * side, sm.y - 0.2 + 10.2 * ramp(sm), sm.z + sm.nz * (wd + 52) * side],
          mat);
        this.buildStrip(scene, a, b,
          (sm) => [sm.x + sm.nx * (wd + 52) * side, sm.y - 0.2 + 10.2 * ramp(sm), sm.z + sm.nz * (wd + 52) * side],
          (sm) => [sm.x + sm.nx * (wd + 110) * side, sm.y - 0.2 + 34.2 * ramp(sm), sm.z + sm.nz * (wd + 110) * side],
          mat);
      }
    }
  }

  // ground height for scenery at lateral distance `dd` beyond the barrier:
  // valley tracks climb the ridge profile, open tracks fall away to the plain
  sceneryGroundY(sm, dd) {
    if (this.def.apron) {
      const W = this.def.apron.width || 70;
      if (dd < 25) return sm.y - 0.28;
      if (dd < W) return (sm.y - 0.3) * (1 - (dd - 25) / (W - 25)) - 0.3;
      return -0.3;
    }
    if (!this.def.valley) {
      return sm.y * Math.max(0, 1 - dd / 35) - 0.3;
    }
    if (dd < 24) return sm.y - 0.25;
    if (dd < 52) return sm.y - 0.2 + ((dd - 24) / 28) * 10;
    return sm.y + 9.8 + Math.min(1, (dd - 52) / 58) * 24;
  }

  // dense instanced forest — a handful of draw calls for hundreds of
  // trees. kind 'pine' (default) or 'sequoia' (towering redwoods). Three
  // foliage texture VARIANTS split across instanced meshes, so the wood
  // isn't 1100 copies of one sprite.
  buildForest(scene) {
    const f = this.def.forest;
    const rng = mulberry32(9001);
    const sequoia = f.kind === 'sequoia';
    const trunkGeo = sequoia
      ? new THREE.CylinderGeometry(0.38, 0.85, 15, 7)
      : new THREE.CylinderGeometry(0.22, 0.32, 2.2, 5);
    trunkGeo.translate(0, sequoia ? 7.5 : 1.1, 0);
    // crossed-billboard canopy with an alpha-cut foliage sprite: ragged
    // silhouette + see-through gaps instead of a solid cone
    const leafGeo = sequoia
      ? crossFoliageGeo(7.5, 15, 6.5)
      : crossFoliageGeo(4.6, 5.4, 1.5);
    const trunkMat = new THREE.MeshLambertMaterial({
      color: f.trunkColor || (sequoia ? 0x7a4530 : 0x5a3d24) });
    const baseLeaf = f.leafColor || (sequoia ? 0x3f6f3a : 0x6fae55);
    const leafMats = [0, 1, 2].map((v) => new THREE.MeshLambertMaterial({
      map: makeFoliage(sequoia ? 'sequoia' : 'pine', (baseLeaf ^ 0x51) + v * 977),
      color: baseLeaf, alphaTest: 0.3, side: THREE.DoubleSide,
    }));
    this.disposables.push(trunkGeo, leafGeo, trunkMat,
      ...leafMats, ...leafMats.map((m) => m.map));
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, f.count);
    const leafVariants = leafMats.map(
      (m) => new THREE.InstancedMesh(leafGeo, m, f.count));
    const vCount = [0, 0, 0];
    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3(), sc = new THREE.Vector3();
    const q = new THREE.Quaternion(), e = new THREE.Euler();
    const icol = new THREE.Color();
    let placed = 0, guard = 0;
    while (placed < f.count && guard++ < f.count * 10) {
      const si = Math.floor(rng() * this.N);
      const sm = this.samples[si];
      if (this.isOnBridge(sm.s)) continue;
      // zones reshape the wood: bare stretches reject, groves pull the
      // trees in tight against the road
      const zk = this.zoneAt(sm.s / this.length);
      if (this.zoneBare(zk)) continue;
      const side = rng() > 0.5 ? 1 : -1;
      const dd = f.minDist + rng() * f.spread * (zk === 'grove' ? 0.45 : 1);
      const x = sm.x + sm.nx * (this.wallDist + dd) * side;
      const z = sm.z + sm.nz * (this.wallDist + dd) * side;
      // clearance: fine check near the source sample, coarse everywhere else
      let ok = true;
      const lo = Math.max(0, si - 60), hi = Math.min(this.N - 1, si + 60);
      for (let j = lo; j <= hi; j += 3) {
        const qs = this.samples[j];
        const dx = x - qs.x, dz = z - qs.z;
        if (dx * dx + dz * dz < (this.wallDist + 2.5) ** 2) { ok = false; break; }
      }
      if (ok) {
        for (let j = 0; j < this.N; j += 24) {
          const qs = this.samples[j];
          const dx = x - qs.x, dz = z - qs.z;
          if (dx * dx + dz * dz < (this.wallDist + 2.5) ** 2) { ok = false; break; }
        }
      }
      if (!ok) continue;
      const s = f.minScale + rng() * (f.maxScale - f.minScale);
      pos.set(x, this.sceneryGroundY(sm, dd), z);
      e.set(0, rng() * Math.PI * 2, 0);
      q.setFromEuler(e);
      sc.setScalar(s);
      m4.compose(pos, q, sc);
      trunks.setMatrixAt(placed, m4);
      const v = placed % 3; // spread instances across the texture variants
      const leaves = leafVariants[v];
      leaves.setMatrixAt(vCount[v], m4);
      // worn woodland: every tree its own shade, the odd one dying brown
      const dry = rng() < 0.16;
      const br = 0.7 + rng() * 0.55;
      if (dry) icol.setRGB(br * 1.12, br * 0.82, br * 0.42);
      else icol.setRGB(br * (0.82 + rng() * 0.3), br, br * (0.78 + rng() * 0.25));
      leaves.setColorAt(vCount[v], icol);
      icol.setScalar(0.7 + rng() * 0.55);
      trunks.setColorAt(placed, icol);
      vCount[v]++;
      placed++;
    }
    trunks.count = placed;
    for (let v = 0; v < 3; v++) leafVariants[v].count = vCount[v];
    scene.add(trunks, ...leafVariants);
  }

  // fade the scene when the player is inside a tunnel (Game drives this)
  setLightDim(d) {
    if (!this.lights) return;
    this.lights.hemi.intensity = this.baseHemi * (1 - 0.55 * d);
    this.lights.sun.intensity = this.baseSun * (1 - 0.75 * d);
  }

  // marker posts just behind the barriers — near-field objects whipping past
  // are the strongest speed cue the scene has
  buildPosts(scene) {
    const step = Math.max(2, Math.round(30 / this.ds)); // one every ~30 m per side
    const count = Math.floor(this.N / step) * 2;
    const geo = new THREE.BoxGeometry(0.16, 2.1, 0.16); // tall enough to clear the 1 m wall
    // weathered marker posts: faded red, dirt-stained white
    const colA = this.def.surface === 'asphalt' ? 0xa8402c : 0x7d5226;
    const colB = 0xc9c0ae;
    // night city: the delineators GLOW (cyan one side of alternation, pink
    // the other) — the Akira lane-light look
    const matA = this.def.neon
      ? new THREE.MeshBasicMaterial({ color: 0x5ae8ff })
      : new THREE.MeshLambertMaterial({ color: colA });
    const matB = this.def.neon
      ? new THREE.MeshBasicMaterial({ color: 0xff4a88 })
      : new THREE.MeshLambertMaterial({ color: colB });
    const meshA = new THREE.InstancedMesh(geo, matA, Math.ceil(count / 2) + 2);
    const meshB = new THREE.InstancedMesh(geo, matB, Math.ceil(count / 2) + 2);
    const m4 = new THREE.Matrix4();
    let a = 0, b = 0, n = 0;
    for (let i = 0; i < this.N; i += step) {
      const sm = this.samples[i];
      if (this.isInTunnel(i * this.ds) || this.isOnBridge(i * this.ds)
        || this.isInVillage(i * this.ds) || this.zoneOpen(i * this.ds)) continue;
      for (const side of [1, -1]) {
        const d = this.wallDist + 0.7;
        m4.makeTranslation(sm.x + sm.nx * d * side, sm.y + 0.95, sm.z + sm.nz * d * side);
        if (n % 2 === 0) meshA.setMatrixAt(a++, m4);
        else meshB.setMatrixAt(b++, m4);
        n++;
      }
    }
    meshA.count = a;
    meshB.count = b;
    scene.add(meshA, meshB);
    this.disposables.push(geo, matA, matB);
  }

  // Ribbons are built in ~450 m chunks so three.js frustum-culls the road
  // piecewise — with the camera far plane tied to the fog distance, only
  // the chunks around the rider are ever processed.
  buildRibbon(scene, halfW, yOff, material, withUVs = false, skipFn = null, tileUV = false) {
    const N = this.N;
    // road textures span the width exactly (u 0..1 keeps the edge lines);
    // tiled surfaces (grass shoulder) get square ~8 m tiles instead
    const uMax = tileUV ? (halfW * 2) / 8 : 1;
    const vTile = tileUV ? 8 : 9;
    const CHUNK = 150; // samples per chunk (~450 m)
    for (let c0 = 0; c0 < N - 1; c0 += CHUNK) {
      const c1 = Math.min(c0 + CHUNK, N - 1);
      const rows = c1 - c0 + 1;
      const pos = new Float32Array(rows * 2 * 3);
      const uv = new Float32Array(rows * 2 * 2);
      for (let i = c0; i <= c1; i++) {
        const sm = this.samples[i];
        const r = i - c0;
        const o = r * 6;
        pos[o + 0] = sm.x + sm.nx * halfW; pos[o + 1] = sm.y + yOff; pos[o + 2] = sm.z + sm.nz * halfW;
        pos[o + 3] = sm.x - sm.nx * halfW; pos[o + 4] = sm.y + yOff; pos[o + 5] = sm.z - sm.nz * halfW;
        const v = (i * this.ds) / vTile;
        uv[r * 4 + 0] = 0; uv[r * 4 + 1] = v;
        uv[r * 4 + 2] = uMax; uv[r * 4 + 3] = v;
      }
      const idx = [];
      for (let i = c0; i < c1; i++) {
        if (skipFn && skipFn(i)) continue;
        const r = i - c0;
        const a = r * 2, b = r * 2 + 1, d = r * 2 + 2, e = r * 2 + 3;
        idx.push(a, b, d, b, e, d);
      }
      if (!idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (withUVs || tileUV) geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const rib = new THREE.Mesh(geo, material);
      rib.layers.enable(1); // ground layer: sampled by the soft-particle depth pass
      scene.add(rib);
      this.disposables.push(geo);
    }
    this.disposables.push(material);
  }

  makeRoadTexture() {
    const c = this.def.colors;
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const g = cv.getContext('2d');
    g.fillStyle = c.road;
    g.fillRect(0, 0, 256, 256);
    // surface noise
    for (let i = 0; i < 900; i++) {
      const v = Math.random();
      g.fillStyle = `rgba(${v > 0.5 ? 255 : 0},${v > 0.5 ? 255 : 0},${v > 0.5 ? 255 : 0},0.05)`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 3, 3);
    }
    if (this.def.surface === 'asphalt') {
      // edge lines + dashed centre line — someone still paints these roads
      g.fillStyle = c.roadEdge;
      g.fillRect(4, 0, 6, 256);
      g.fillRect(246, 0, 6, 256);
      g.fillStyle = '#d8d8d8';
      for (let y = 0; y < 256; y += 64) g.fillRect(125, y, 6, 32);
    } else {
      // decades-dead road: mostly dirt, twin wheel ruts worn smooth, a
      // weed strip up the crown, and the last ragged scabs of asphalt
      g.fillStyle = 'rgba(0,0,0,0.16)'; // ruts
      g.fillRect(52, 0, 34, 256);
      g.fillRect(168, 0, 34, 256);
      g.fillStyle = 'rgba(255,240,210,0.07)'; // polished rut centres
      g.fillRect(60, 0, 18, 256);
      g.fillRect(176, 0, 18, 256);
      for (let i = 0; i < 130; i++) { // weeds up the crown + verges
        const x = Math.random() < 0.6 ? 116 + Math.random() * 24
          : Math.random() < 0.5 ? Math.random() * 18 : 238 + Math.random() * 18;
        g.fillStyle = `rgba(${60 + Math.random() * 30},${85 + Math.random() * 40},40,${0.25 + Math.random() * 0.3})`;
        g.fillRect(x, Math.random() * 256, 2 + Math.random() * 3, 3 + Math.random() * 5);
      }
      // asphalt scabs: ragged dark patches the frost never finished
      for (let i = 0; i < 7; i++) {
        const px = Math.random() * 256, py = Math.random() * 256;
        const w = 26 + Math.random() * 60, h2 = 20 + Math.random() * 46;
        g.fillStyle = `rgba(${56 + Math.random() * 14},${56 + Math.random() * 14},${60 + Math.random() * 14},0.85)`;
        g.beginPath();
        const n = 6 + Math.floor(Math.random() * 3);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          const r = 0.5 + Math.random() * 0.5;
          const vx = px + Math.cos(a) * w * r, vy = py + Math.sin(a) * h2 * r;
          k === 0 ? g.moveTo(vx, vy) : g.lineTo(vx, vy);
        }
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(20,18,16,0.5)'; // crumbled edge
        g.lineWidth = 2;
        g.stroke();
      }
      // loose stones
      for (let i = 0; i < 220; i++) {
        const v = Math.random();
        g.fillStyle = `rgba(${v > 0.5 ? 255 : 30},${v > 0.5 ? 245 : 26},${v > 0.5 ? 225 : 22},0.1)`;
        g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 2);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  // checkered line across the road at the given sample (start + finish)
  buildLineAt(scene, sIdx) {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 32;
    const g = cv.getContext('2d');
    for (let x = 0; x < 8; x++)
      for (let y = 0; y < 2; y++) {
        g.fillStyle = (x + y) % 2 ? '#111' : '#fff';
        g.fillRect(x * 16, y * 16, 16, 16);
      }
    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const a = this.samples[Math.max(0, sIdx)];
    const b = this.samples[Math.min(this.N - 1, sIdx + 1)];
    const hw = this.halfWidth;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      a.x + a.nx * hw, a.y + 0.06, a.z + a.nz * hw,
      a.x - a.nx * hw, a.y + 0.06, a.z - a.nz * hw,
      b.x + b.nx * hw, b.y + 0.06, b.z + b.nz * hw,
      b.x - b.nx * hw, b.y + 0.06, b.z - b.nz * hw,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), 2));
    geo.setIndex([0, 1, 2, 1, 3, 2]);
    scene.add(new THREE.Mesh(geo, mat));
    this.disposables.push(geo, mat);
  }

  // multi-scale wear for grass/ground, same recipe that made the asphalt
  // read as real: metre-scale dry straw patches, bald dirt spots, and a
  // fine mottle — all from world-anchored value noise
  applyWear(mat, opts = {}) {
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWearPos;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\nvWearPos = (modelMatrix * vec4(position, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>',
          '#include <common>\n' +
          'varying vec2 vWearPos;\n' +
          'float whash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n' +
          'float wnoise(vec2 p) {\n' +
          '  vec2 i = floor(p), f = fract(p);\n' +
          '  vec2 u = f * f * (3.0 - 2.0 * f);\n' +
          '  return mix(mix(whash(i), whash(i + vec2(1.0, 0.0)), u.x),\n' +
          '             mix(whash(i + vec2(0.0, 1.0)), whash(i + vec2(1.0, 1.0)), u.x), u.y);\n' +
          '}')
        .replace('#include <map_fragment>',
          '#include <map_fragment>\n' +
          'vec2 wq = mat2(0.8, -0.6, 0.6, 0.8) * vWearPos;\n' +
          'float wPatch = wnoise(vWearPos * 0.13) * 0.55 + wnoise(wq * 0.31 + 11.0) * 0.45;\n' +
          'float wDry = smoothstep(0.52, 0.78, wPatch);\n' +
          'float wBald = smoothstep(' + (opts.dirt ? '0.5, 0.72' : '0.70, 0.88') + ', wnoise(vWearPos * 0.47 + 23.0));\n' +
          // sun-scorched straw patches, then worn-to-dirt bald spots
          'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.28, 1.06, 0.55), wDry * 0.7);\n' +
          'diffuseColor.rgb = mix(diffuseColor.rgb,\n' +
          '  vec3(0.40, 0.34, 0.25) * (0.75 + 0.5 * wnoise(vWearPos * 3.7)), wBald * 0.8);\n' +
          'diffuseColor.rgb *= 0.86 + 0.28 * wnoise(vWearPos * 2.1 + 5.0);' +
          (opts.cracks
            // dry-mud cracking: ridged-noise seams, resolution-faded like
            // the road cracks so they never alias
            ? '\nfloat cw = abs(wnoise(vWearPos * 0.95 + 4.7) * 2.0 - 1.0);' +
              '\nfloat cfw = max(fwidth(vWearPos.x), fwidth(vWearPos.y));' +
              '\nfloat cr = (1.0 - smoothstep(0.04, 0.12 + cfw * 2.2, cw)) * clamp(1.15 - 4.0 * cfw, 0.0, 1.0);' +
              '\ndiffuseColor.rgb *= 1.0 - cr * 0.4;'
            : ''));
    };
  }

  // raised roadbed: the tarmac sits ~0.3 m proud of the surrounding
  // grass, with a short dirt embankment sloping down each side — the road
  // reads as BUILT, not painted onto the field
  buildEdgeDetail(scene) {
    const hw = this.halfWidth;
    const bankMat = new THREE.MeshLambertMaterial({
      map: makeTile(0x8f7a56, { contrast: 0.24 }) });
    this.applyWear(bankMat);
    this.disposables.push(bankMat, bankMat.map);
    const CH = 120; // chunked for frustum culling, like the road itself
    for (const side of [1, -1]) {
      for (let c0 = 0; c0 < this.N - 1; c0 += CH) {
        const c1 = Math.min(c0 + CH, this.N - 1);
        let ok = true;
        for (let i = c0; i <= c1; i += 5) {
          const ss = i * this.ds;
          if (this.isOnBridge(ss) || this.isInTunnel(ss)) { ok = false; break; }
        }
        if (!ok) continue;
        this.buildStrip(scene, c0, c1,
          (sm) => [sm.x + sm.nx * hw * side, sm.y + 0.02, sm.z + sm.nz * hw * side],
          (sm) => [sm.x + sm.nx * (hw + 1.9) * side, sm.y - 0.26, sm.z + sm.nz * (hw + 1.9) * side],
          bankMat);
      }
    }
  }

  buildWalls(scene) {
    // prison-yard fencing: rusty chain-link on steel posts, barbed wire on
    // top. Drawn once into a canvas (diamond lattice + two barbed strands),
    // alpha-tested so the mesh is see-through between the wires.
    // one long 1024px strip (~13.6 m of fence per repeat, vs 3.4 m before)
    // so the worn pattern takes 4x longer to visibly repeat, and every
    // stretch of it corrodes differently
    const W = 1024, TOP = 28;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = 128;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, 128);
    const rng = mulberry32(777);
    const rust = (dark = 0) => {
      const t = rng();
      const r = 100 - dark + t * 70, gr = 58 - dark + t * 34, b = 34 - dark + t * 18;
      return `rgb(${r | 0},${gr | 0},${b | 0})`;
    };
    // open diamond lattice: thinner wire, wider spacing, and per-segment
    // alpha so some stretches of netting have corroded half away
    g.lineWidth = 2.2;
    for (let x = -32; x < W + 32; x += 22) {
      g.globalAlpha = 0.55 + rng() * 0.45;
      g.strokeStyle = rust();
      g.beginPath(); g.moveTo(x, TOP); g.lineTo(x + 100, 128); g.stroke();
      g.globalAlpha = 0.55 + rng() * 0.45;
      g.strokeStyle = rust();
      g.beginPath(); g.moveTo(x, 128); g.lineTo(x + 100, TOP); g.stroke();
    }
    g.globalAlpha = 1;
    // rusted-through damage: many bites of many sizes, plus a couple of
    // big torn gaps
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 26; i++) {
      g.beginPath();
      g.arc(rng() * W, TOP + 10 + rng() * 90, 2 + rng() * 9, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.ellipse(rng() * W, 95 + rng() * 30, 14 + rng() * 22, 9 + rng() * 14,
        rng() * 3, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    // top rail (patchy) + two sagging barbed strands with jittered barbs
    g.lineWidth = 3.5;
    for (let x = 0; x < W; x += 64) {
      g.globalAlpha = 0.7 + rng() * 0.3;
      g.strokeStyle = rust(8);
      g.beginPath(); g.moveTo(x, TOP); g.lineTo(x + 64, TOP); g.stroke();
    }
    g.globalAlpha = 1;
    g.lineWidth = 1.8;
    for (const yw of [9, 18]) {
      g.strokeStyle = rust(10);
      g.beginPath();
      g.moveTo(0, yw);
      for (let x = 0; x <= W; x += 32) {
        g.lineTo(x, yw + Math.sin(x * 0.05 + yw) * 1.5 + (rng() - 0.5) * 2);
      }
      g.stroke();
      let x = 4 + rng() * 8;
      while (x < W) {
        g.globalAlpha = 0.6 + rng() * 0.4;
        g.strokeStyle = rust(10);
        const yj = yw + (rng() - 0.5) * 3;
        g.beginPath(); g.moveTo(x - 3, yj - 4); g.lineTo(x + 3, yj + 4); g.stroke();
        g.beginPath(); g.moveTo(x + 3, yj - 4); g.lineTo(x - 3, yj + 4); g.stroke();
        x += 8 + rng() * 14; // irregular barb spacing
      }
      g.globalAlpha = 1;
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    const mat = new THREE.MeshLambertMaterial({
      map: tex, side: THREE.DoubleSide, alphaTest: 0.28,
      transparent: true, opacity: 0.85,
    });

    const N = this.N, wd = this.wallDist, H = 2.3;
    const CHUNK = 150;
    for (const side of [1, -1]) {
      for (let c0 = 0; c0 < N - 1; c0 += CHUNK) {
        const c1 = Math.min(c0 + CHUNK, N - 1);
        const rows = c1 - c0 + 1;
        const pos = new Float32Array(rows * 2 * 3);
        const uv = new Float32Array(rows * 2 * 2);
        for (let i = c0; i <= c1; i++) {
          const sm = this.samples[i];
          const x = sm.x + sm.nx * wd * side, z = sm.z + sm.nz * wd * side;
          const r = i - c0;
          const o = r * 6;
          pos[o + 0] = x; pos[o + 1] = sm.y - 0.2; pos[o + 2] = z;
          pos[o + 3] = x; pos[o + 4] = sm.y + H; pos[o + 5] = z;
          // v: bottom vertex -> texture bottom, top vertex -> texture top
          // (barbed strands live at the canvas top = the top of the fence)
          uv[r * 4 + 0] = (i * this.ds) / 13.6; uv[r * 4 + 1] = 0;
          uv[r * 4 + 2] = (i * this.ds) / 13.6; uv[r * 4 + 3] = 1;
        }
        const idx = [];
        for (let i = c0; i < c1; i++) {
          // tunnels/bridges replace the stock barrier with their own
          // structure; villages open up so the houses sit right by the road
          if (this.isInTunnel(i * this.ds) || this.isOnBridge(i * this.ds)
            || this.isInVillage(i * this.ds) || this.zoneOpen(i * this.ds)) continue;
          const r = i - c0;
          const a = r * 2, b = r * 2 + 1, d = r * 2 + 2, e = r * 2 + 3;
          idx.push(a, b, d, b, e, d);
        }
        if (!idx.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        scene.add(new THREE.Mesh(geo, mat));
        this.disposables.push(geo);
      }
    }
    this.disposables.push(mat);

    // steel posts every ~6 m, each with its own rust shade
    const step = Math.max(1, Math.round(6 / this.ds));
    const postGeo = new THREE.CylinderGeometry(0.05, 0.065, H + 0.5, 5);
    postGeo.translate(0, (H + 0.5) / 2 - 0.25, 0);
    const postMat = new THREE.MeshLambertMaterial({ color: 0x7a5638 });
    const posts = new THREE.InstancedMesh(
      postGeo, postMat, Math.ceil(N / step) * 2 + 4);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    let p = 0;
    for (let i = 0; i < N; i += step) {
      const sm = this.samples[i];
      if (this.isInTunnel(i * this.ds) || this.isOnBridge(i * this.ds)
        || this.isInVillage(i * this.ds) || this.zoneOpen(i * this.ds)) continue;
      for (const side of [1, -1]) {
        m4.makeTranslation(sm.x + sm.nx * wd * side, sm.y, sm.z + sm.nz * wd * side);
        posts.setMatrixAt(p, m4);
        col.setScalar(0.62 + rng() * 0.75);
        posts.setColorAt(p, col);
        p++;
      }
    }
    posts.count = p;
    scene.add(posts);
    this.disposables.push(postGeo, postMat);
  }

  buildArch(scene, sIdx, label) {
    const sm = this.samples[Math.min(this.N - 1, Math.max(0, sIdx))];
    const grp = new THREE.Group();
    const pillarMat = new THREE.MeshLambertMaterial({ color: 0x333340 });
    const pillarGeo = new THREE.BoxGeometry(0.8, 7, 0.8);
    for (const side of [1, -1]) {
      const p = new THREE.Mesh(pillarGeo, pillarMat);
      p.position.set((this.halfWidth + 1.5) * side, 3.5, 0);
      grp.add(p);
    }
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 64;
    const g = cv.getContext('2d');
    // rugged wasteland banner: weathered brown canvas, black stencil text
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#8a6a42');
    grad.addColorStop(0.5, '#7a5c38');
    grad.addColorStop(1, '#654a2c');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 64);
    // grain streaks + sun-bleach + grime blotches
    for (let i = 0; i < 90; i++) {
      const y = Math.random() * 64;
      g.strokeStyle = Math.random() > 0.5
        ? `rgba(40,28,14,${0.04 + Math.random() * 0.1})`
        : `rgba(220,200,160,${0.03 + Math.random() * 0.07})`;
      g.lineWidth = 0.5 + Math.random() * 1.6;
      g.beginPath();
      g.moveTo(Math.random() * 512, y);
      g.lineTo(Math.random() * 512, y + (Math.random() - 0.5) * 6);
      g.stroke();
    }
    for (let i = 0; i < 14; i++) {
      g.fillStyle = `rgba(30,20,10,${0.05 + Math.random() * 0.1})`;
      g.beginPath();
      g.ellipse(Math.random() * 512, Math.random() * 64,
        8 + Math.random() * 30, 4 + Math.random() * 10, Math.random() * 3, 0, Math.PI * 2);
      g.fill();
    }
    // darkened ragged top/bottom edges
    g.fillStyle = 'rgba(25,16,8,0.5)';
    g.fillRect(0, 0, 512, 3);
    g.fillRect(0, 61, 512, 3);
    g.fillStyle = '#17110a';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // shrink to fit: settlement names can run longer than the old labels
    let px = 44;
    do {
      g.font = `bold italic ${px}px Arial Black, sans-serif`;
      px -= 2;
    } while (px > 18 && g.measureText(label || 'MOTOMAD').width > 480);
    g.fillText(label || 'MOTOMAD', 256, 34);
    // wear on the lettering: thin banner-coloured scratches across everything
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = `rgba(122,92,56,${0.25 + Math.random() * 0.35})`;
      g.lineWidth = 0.5 + Math.random() * 1.1;
      g.beginPath();
      const y = Math.random() * 64;
      g.moveTo(Math.random() * 200, y);
      g.lineTo(312 + Math.random() * 200, y + (Math.random() - 0.5) * 8);
      g.stroke();
    }
    const bannerTex = new THREE.CanvasTexture(cv);
    bannerTex.colorSpace = THREE.SRGBColorSpace; // authored colors, not washed out
    const bannerMat = new THREE.MeshBasicMaterial({ map: bannerTex, side: THREE.DoubleSide });
    const banner = new THREE.Mesh(new THREE.BoxGeometry(this.halfWidth * 2 + 4, 1.4, 0.3), [
      pillarMat, pillarMat, pillarMat, pillarMat, bannerMat, bannerMat,
    ]);
    banner.position.y = 6.6;
    grp.add(banner);
    grp.position.set(sm.x, sm.y, sm.z);
    grp.rotation.y = sm.angle;
    scene.add(grp);
    this.disposables.push(pillarGeo, pillarMat, bannerMat);
  }

  // strip of quads between two offset curves along a sample index range
  buildStrip(scene, i0, i1, fA, fB, material) {
    const pos = [];
    const uvs = [];
    const idx = [];
    let v = 0;
    for (let i = i0; i <= i1; i++) {
      const sm = this.samples[Math.min(this.N - 1, Math.max(0, i))];
      const a = fA(sm), b = fB(sm);
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      const tv = ((i - i0) * this.ds) / 8;
      uvs.push(0, tv, 1, tv);
      if (i > i0) idx.push(v - 2, v - 1, v, v - 1, v + 1, v);
      v += 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.layers.enable(1);
    scene.add(mesh);
    this.disposables.push(geo);
    return mesh;
  }

  buildTunnels(scene) {
    for (const t of this.def.tunnels || []) {
      const i0 = Math.max(0, Math.floor(t.from * (this.N - 1)));
      const i1 = Math.min(this.N - 1, Math.floor(t.to * (this.N - 1)));
      const w = this.halfWidth + 2.0, h = 4.3;
      const shell = new THREE.MeshLambertMaterial({ map: makeConcrete(), side: THREE.DoubleSide });
      this.disposables.push(shell);
      // side walls + flat ceiling
      for (const side of [1, -1]) {
        this.buildStrip(scene, i0, i1,
          (sm) => [sm.x + sm.nx * w * side, sm.y - 0.2, sm.z + sm.nz * w * side],
          (sm) => [sm.x + sm.nx * w * side, sm.y + h, sm.z + sm.nz * w * side],
          shell);
      }
      this.buildStrip(scene, i0, i1,
        (sm) => [sm.x + sm.nx * w, sm.y + h, sm.z + sm.nz * w],
        (sm) => [sm.x - sm.nx * w, sm.y + h, sm.z - sm.nz * w],
        shell);

      // ceiling light strips every ~12 m
      const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0 });
      const lightGeo = new THREE.BoxGeometry(0.35, 0.1, 2.6);
      this.disposables.push(lightMat, lightGeo);
      const step = Math.max(1, Math.round(12 / this.ds));
      for (let i = i0 + step; i < i1; i += step) {
        const sm = this.samples[Math.min(this.N - 1, i)];
        const l = new THREE.Mesh(lightGeo, lightMat);
        l.position.set(sm.x, sm.y + h - 0.08, sm.z);
        l.rotation.y = sm.angle;
        scene.add(l);
      }

      // portals at both ends
      const portalMat = new THREE.MeshLambertMaterial({ color: 0x4a4a54 });
      const colGeo = new THREE.BoxGeometry(1.2, h + 1.2, 1.6);
      const lintelGeo = new THREE.BoxGeometry(w * 2 + 2.6, 1.4, 1.6);
      this.disposables.push(portalMat, colGeo, lintelGeo);
      for (const iEnd of [i0, i1]) {
        const sm = this.samples[Math.min(this.N - 1, iEnd)];
        const grp = new THREE.Group();
        for (const side of [1, -1]) {
          const col = new THREE.Mesh(colGeo, portalMat);
          col.position.set((w + 0.7) * side, (h + 1.2) / 2 - 0.2, 0);
          grp.add(col);
        }
        const lintel = new THREE.Mesh(lintelGeo, portalMat);
        lintel.position.set(0, h + 0.4, 0);
        grp.add(lintel);
        grp.position.set(sm.x, sm.y, sm.z);
        grp.rotation.y = sm.angle;
        scene.add(grp);
      }
    }
  }

  buildBridges(scene) {
    for (const b of this.def.bridges || []) {
      const i0 = Math.max(0, Math.floor(b.from * (this.N - 1)));
      const i1 = Math.min(this.N - 1, Math.floor(b.to * (this.N - 1)));
      const edge = this.halfWidth + 0.55;
      const parapet = new THREE.MeshLambertMaterial({
        map: makeTile(0xb4b4bc, { contrast: 0.08 }), side: THREE.DoubleSide,
      });
      const girder = new THREE.MeshLambertMaterial({
        map: makeTile(0x86452f, { contrast: 0.28, density: 900 }), side: THREE.DoubleSide,
      });
      const under = new THREE.MeshLambertMaterial({ color: 0x33333a, side: THREE.DoubleSide });
      this.disposables.push(parapet, girder, under);

      for (const side of [1, -1]) {
        // low parapet + thin top rail
        this.buildStrip(scene, i0, i1,
          (sm) => [sm.x + sm.nx * edge * side, sm.y + 0.02, sm.z + sm.nz * edge * side],
          (sm) => [sm.x + sm.nx * edge * side, sm.y + 0.6, sm.z + sm.nz * edge * side],
          parapet);
        this.buildStrip(scene, i0, i1,
          (sm) => [sm.x + sm.nx * edge * side, sm.y + 0.95, sm.z + sm.nz * edge * side],
          (sm) => [sm.x + sm.nx * edge * side, sm.y + 1.05, sm.z + sm.nz * edge * side],
          parapet);
        // steel girder fascia below the deck
        this.buildStrip(scene, i0, i1,
          (sm) => [sm.x + sm.nx * edge * side, sm.y + 0.05, sm.z + sm.nz * edge * side],
          (sm) => [sm.x + sm.nx * edge * side, sm.y - 1.15, sm.z + sm.nz * edge * side],
          girder);
      }
      // deck underside
      this.buildStrip(scene, i0, i1,
        (sm) => [sm.x + sm.nx * edge, sm.y - 1.15, sm.z + sm.nz * edge],
        (sm) => [sm.x - sm.nx * edge, sm.y - 1.15, sm.z - sm.nz * edge],
        under);

      // piers down to the ground/water every ~24 m
      const pierMat = new THREE.MeshLambertMaterial({ color: 0x8e8e96 });
      this.disposables.push(pierMat);
      const step = Math.max(1, Math.round(24 / this.ds));
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = i0; i <= i1; i++) {
        const sm = this.samples[Math.min(this.N - 1, i)];
        minX = Math.min(minX, sm.x); maxX = Math.max(maxX, sm.x);
        minZ = Math.min(minZ, sm.z); maxZ = Math.max(maxZ, sm.z);
        if ((i - i0) % step !== Math.floor(step / 2)) continue;
        const hP = sm.y - 0.6;
        if (hP < 1) continue;
        const pierGeo = new THREE.BoxGeometry(this.halfWidth * 1.2, hP, 1.6);
        this.disposables.push(pierGeo);
        const pier = new THREE.Mesh(pierGeo, pierMat);
        pier.position.set(sm.x, -0.4 + hP / 2, sm.z);
        pier.rotation.y = sm.angle;
        scene.add(pier);
      }

      // water (or nothing for a dry gulch — the ground shows instead)
      if (b.water) {
        const waterMat = new THREE.MeshPhongMaterial({
          color: 0x2a6a9a, shininess: 120, specular: 0x99bbcc,
          transparent: true, opacity: 0.92,
        });
        const waterGeo = new THREE.PlaneGeometry(maxX - minX + 130, maxZ - minZ + 130);
        this.disposables.push(waterMat, waterGeo);
        const water = new THREE.Mesh(waterGeo, waterMat);
        water.layers.enable(1);
        water.rotation.x = -Math.PI / 2;
        water.position.set((minX + maxX) / 2, -0.22, (minZ + maxZ) / 2);
        scene.add(water);
      }
    }
  }

  buildScenery(scene) {
    if (this.def.scenery === 'city') {
      this.buildCity(scene);
      return;
    }
    if (this.def.forest) {
      this.buildForest(scene);
      return;
    }
    const rng = mulberry32(this.def.id === 'riviera' ? 1337 : 4242);
    const grp = new THREE.Group();
    // worn palette variants — no two trees quite the same shade, some of
    // them halfway to straw
    const lamberts = (cols) => cols.map((cc) => new THREE.MeshLambertMaterial({ color: cc }));
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    // crossed-billboard foliage sprites, tinted per variant — ragged
    // canopies with see-through gaps instead of solid cones
    const foliageMat = (cols, kind) => cols.map((cc, i) => new THREE.MeshLambertMaterial({
      map: makeFoliage(kind, cc ^ (i * 97 + 13)), color: cc,
      alphaTest: 0.3, side: THREE.DoubleSide,
    }));
    const mats = {
      trunk: lamberts([0x6b4a2a, 0x5a3d24, 0x7a5a36]),
      leaf: lamberts([0x2a6b32, 0x3b6b28, 0x56682c, 0x6b5f2a]),
      canopy: foliageMat([0x4f8a3a, 0x5f8a30, 0x74883a, 0x86773a], 'pine'),
      cactus: lamberts([0x4a7a3a, 0x5f7a3a, 0x3f6a34]),
      rock: lamberts([0x9a8a72, 0x847766, 0xa89880]),
    };
    for (const m of mats.canopy) this.disposables.push(m.map);
    const geos = {
      trunk: new THREE.CylinderGeometry(0.22, 0.3, 2.2, 6),
      leaf: new THREE.ConeGeometry(1.7, 4.2, 7),
      canopy: crossFoliageGeo(4.0, 4.8, 1.3),
      cactus: new THREE.CylinderGeometry(0.4, 0.45, 3.2, 7),
      arm: new THREE.CylinderGeometry(0.25, 0.25, 1.3, 6),
      rock: new THREE.DodecahedronGeometry(1.1),
      palmTrunk: new THREE.CylinderGeometry(0.13, 0.24, 4.4, 5),
      frond: (() => {
        const g2 = new THREE.BoxGeometry(2.4, 0.07, 0.55);
        g2.translate(1.05, 0, 0); // inner end at the crown pivot
        return g2;
      })(),
    };
    for (const k in geos) this.disposables.push(geos[k]);
    for (const k in mats) this.disposables.push(...mats[k]);

    const placed = [];
    const count = Math.min(420, Math.round(this.length / 17));
    for (let i = 0; i < count; i++) {
      const sm = this.samples[Math.floor(rng() * this.N)];
      if (this.isOnBridge(sm.s)) continue; // no trees standing in the water
      const zk = this.zoneAt(sm.s / this.length);
      if (this.zoneBare(zk)) continue; // those zones dress themselves
      const side = rng() > 0.5 ? 1 : -1;
      const dist = this.wallDist + 7 + rng() * (zk === 'grove' ? 24 : 55);
      const x = sm.x + sm.nx * dist * side;
      const z = sm.z + sm.nz * dist * side;
      // keep clear of every part of the track, not just this sample
      let ok = true;
      for (let j = 0; j < this.N; j += 4) {
        const q = this.samples[j];
        const dx = x - q.x, dz = z - q.z;
        if (dx * dx + dz * dz < (this.wallDist + 4) ** 2) { ok = false; break; }
      }
      if (!ok) continue;
      for (const p of placed) {
        if ((x - p[0]) ** 2 + (z - p[1]) ** 2 < 36) { ok = false; break; }
      }
      if (!ok) continue;
      placed.push([x, z]);
      const y = sm.y * Math.max(0, 1 - (dist - this.wallDist) / 35) - 0.3;

      let obj;
      if (this.def.scenery === 'palm') {
        if (rng() > 0.3) {
          obj = new THREE.Group();
          const trunk = new THREE.Mesh(geos.palmTrunk, pick(mats.trunk));
          trunk.position.y = 2.2;
          obj.add(trunk);
          const frondMat = pick(mats.leaf);
          for (let k = 0; k < 6; k++) {
            const frond = new THREE.Mesh(geos.frond, frondMat);
            frond.position.y = 4.35;
            frond.rotation.order = 'YZX';
            frond.rotation.set(0, (k / 6) * Math.PI * 2 + rng(), -0.45 - rng() * 0.2);
            obj.add(frond);
          }
          obj.rotation.z = (rng() - 0.5) * 0.3; // seaside lean
          const s = 0.7 + rng() * 0.8;
          obj.scale.set(s, s, s);
        } else {
          obj = new THREE.Mesh(geos.rock, pick(mats.rock));
          obj.scale.setScalar(0.5 + rng() * 1.6);
          obj.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        }
      } else if (this.def.scenery === 'pine') {
        obj = new THREE.Group();
        const t = new THREE.Mesh(geos.trunk, pick(mats.trunk));
        t.position.y = 1.1;
        const l = new THREE.Mesh(geos.canopy, pick(mats.canopy));
        obj.add(t, l);
        const s = 0.7 + rng() * 0.9;
        obj.scale.set(s, s, s);
      } else if (rng() > 0.4) {
        obj = new THREE.Group();
        const cactusMat = pick(mats.cactus);
        const body = new THREE.Mesh(geos.cactus, cactusMat);
        body.position.y = 1.6;
        obj.add(body);
        const arm = new THREE.Mesh(geos.arm, cactusMat);
        arm.position.set(0.55, 1.9, 0);
        arm.rotation.z = -0.5;
        obj.add(arm);
        const s = 0.7 + rng() * 0.7;
        obj.scale.set(s, s, s);
      } else {
        obj = new THREE.Mesh(geos.rock, pick(mats.rock));
        obj.scale.setScalar(0.5 + rng() * 1.4);
        obj.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      }
      obj.position.set(x, y, z);
      obj.rotation.y = rng() * Math.PI * 2;
      grp.add(obj);
    }
    scene.add(grp);
  }

  // lit-window tower face; unlit MeshBasic so the city glows in the dark
  makeTowerTexture(variant) {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 128;
    const g = cv.getContext('2d');
    g.fillStyle = ['#0d0f16', '#10121c', '#0b0d13'][variant];
    g.fillRect(0, 0, 64, 128);
    const litColors = [['#ffd9a0', '#ffedcc'], ['#9fc4ff', '#d6e6ff'], ['#ffd9a0', '#9fc4ff']][variant];
    const rng = mulberry32(77 + variant);
    for (let y = 4; y < 124; y += 8) {
      for (let x = 4; x < 60; x += 8) {
        if (rng() < 0.38) {
          g.fillStyle = litColors[rng() > 0.5 ? 0 : 1];
          g.globalAlpha = 0.55 + rng() * 0.45;
          g.fillRect(x, y, 5, 4);
        }
      }
    }
    g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  makeBillboardTexture(rng) {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 64;
    const g = cv.getContext('2d');
    g.fillStyle = '#0a0a12';
    g.fillRect(0, 0, 128, 64);
    const palette = ['#ff2a6a', '#2ae0ff', '#ffaa22', '#b12aff', '#ff2222', '#2aff88'];
    // abstract glyph blocks — reads as kanji signage from a moving bike
    for (let i = 0; i < 26; i++) {
      g.fillStyle = palette[Math.floor(rng() * palette.length)];
      const w = 3 + rng() * 16, h = 3 + rng() * (rng() > 0.6 ? 34 : 8);
      g.fillRect(rng() * 120, rng() * 56, w, h);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  buildCity(scene) {
    const cfg = this.def.city;
    const rng = mulberry32(2019);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0); // base at ground
    this.disposables.push(boxGeo);
    const dark = new THREE.MeshBasicMaterial({ color: 0x08080e });
    this.disposables.push(dark);

    // --- towers: 3 texture variants, instanced (windowed sides, dark roof)
    const perVariant = Math.ceil(cfg.towers / 3);
    const towerMeshes = [];
    for (let v = 0; v < 3; v++) {
      const tex = this.makeTowerTexture(v);
      const faceMat = new THREE.MeshBasicMaterial({ map: tex });
      this.disposables.push(tex, faceMat);
      const im = new THREE.InstancedMesh(
        boxGeo, [faceMat, faceMat, dark, dark, faceMat, faceMat], perVariant);
      im.count = 0;
      towerMeshes.push(im);
      scene.add(im);
    }
    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3();
    const q = new THREE.Quaternion(), e = new THREE.Euler();
    let placed = 0, guard = 0;
    const sites = [];
    while (placed < cfg.towers && guard++ < cfg.towers * 12) {
      const sm = this.samples[Math.floor(rng() * this.N)];
      const side = rng() > 0.5 ? 1 : -1;
      const dist = this.wallDist + 20 + rng() * 95;
      const x = sm.x + sm.nx * dist * side;
      const z = sm.z + sm.nz * dist * side;
      const w = 16 + rng() * 30, d = 16 + rng() * 30;
      let ok = true;
      const clear = this.wallDist + 6 + Math.max(w, d) * 0.72;
      for (let j = 0; j < this.N; j += 3) {
        const qs = this.samples[j];
        const dx = x - qs.x, dz = z - qs.z;
        if (dx * dx + dz * dz < clear * clear) { ok = false; break; }
      }
      if (!ok) continue;
      for (const s2 of sites) {
        if ((x - s2[0]) ** 2 + (z - s2[1]) ** 2 < 26 * 26) { ok = false; break; }
      }
      if (!ok) continue;
      sites.push([x, z]);
      const h = 30 + rng() * rng() * 170; // mostly mid-rise, a few monsters
      pos.set(x, -0.3, z);
      e.set(0, sm.angle + (rng() - 0.5) * 0.3, 0);
      q.setFromEuler(e);
      scl.set(w, h, d);
      m4.compose(pos, q, scl);
      const im = towerMeshes[placed % 3];
      im.setMatrixAt(im.count++, m4);
      placed++;
    }

    // --- freestanding neon signs near the road
    const neonMats = [0xff2a6a, 0x2ae0ff, 0xffaa22, 0xb12aff, 0xff3333].map((cl) => {
      const m = new THREE.MeshBasicMaterial({ color: cl });
      this.disposables.push(m);
      return m;
    });
    for (let i = 0; i < cfg.neons; i++) {
      const sm = this.samples[Math.floor(rng() * this.N)];
      if (this.isInTunnel(sm.s)) continue;
      const side = rng() > 0.5 ? 1 : -1;
      const dist = this.wallDist + 8 + rng() * 34;
      const vertical = rng() > 0.45;
      const sign = new THREE.Mesh(boxGeo, neonMats[Math.floor(rng() * neonMats.length)]);
      sign.scale.set(
        vertical ? 1.6 : 8 + rng() * 13,
        vertical ? 9 + rng() * 15 : 2.2,
        0.5);
      sign.position.set(
        sm.x + sm.nx * dist * side,
        3 + rng() * 34,
        sm.z + sm.nz * dist * side);
      sign.rotation.y = sm.angle + (rng() - 0.5) * 0.7;
      scene.add(sign);
    }

    // --- big glyph billboards
    for (let i = 0; i < (cfg.billboards || 0); i++) {
      const sm = this.samples[Math.floor(rng() * this.N)];
      if (this.isInTunnel(sm.s)) continue;
      const side = rng() > 0.5 ? 1 : -1;
      const tex = this.makeBillboardTexture(rng);
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
      this.disposables.push(tex, mat);
      const bb = new THREE.Mesh(new THREE.PlaneGeometry(24, 12), mat);
      const dist = this.wallDist + 14 + rng() * 40;
      bb.position.set(
        sm.x + sm.nx * dist * side,
        10 + rng() * 30,
        sm.z + sm.nz * dist * side);
      bb.rotation.y = sm.angle + Math.PI / 2 + (rng() - 0.5) * 0.5;
      scene.add(bb);
      this.disposables.push(bb.geometry);
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose && d.dispose();
    this.disposables = [];
  }
}

// deterministic PRNG so scenery doesn't reshuffle every mount
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
