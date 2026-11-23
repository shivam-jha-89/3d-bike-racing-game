import * as THREE from 'three';
import { makeTile } from './textures.js';

// ---------------------------------------------------------------------------
// HubWorld — the RPG layer's town view: a fixed isometric (orthographic)
// camera over a wasteland village, a walkable rider, and a handful of NPCs
// to talk to. Original-Fallout staging: dusty brown palette, long low sun,
// campfire, junk props. React (HubScreen) polls `state` for proximity and
// drives dialogue; `locked` freezes movement while a conversation is open.
// ---------------------------------------------------------------------------

const VIEW_H = 17; // metres of world visible vertically

function figure({ jacket = 0x4a3c30, pants = 0x2e2a26, skin = 0xc09a78, hat = null }) {
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  const box = (w, h, d, c, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c));
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  const legL = box(0.16, 0.78, 0.2, pants, -0.11, 0.39, 0);
  const legR = box(0.16, 0.78, 0.2, pants, 0.11, 0.39, 0);
  box(0.5, 0.58, 0.3, jacket, 0, 1.07, 0);
  const armL = box(0.13, 0.55, 0.18, jacket, -0.32, 1.08, 0);
  const armR = box(0.13, 0.55, 0.18, jacket, 0.32, 1.08, 0);
  const head = box(0.3, 0.28, 0.28, skin, 0, 1.53, 0);
  if (hat !== null) box(0.34, 0.1, 0.32, hat, 0, 1.7, 0);
  // legs/arms pivot at the hip/shoulder: shift geometry so rotation looks right
  for (const limb of [legL, legR]) limb.geometry.translate(0, -0.39, 0), limb.position.y = 0.78;
  for (const limb of [armL, armR]) limb.geometry.translate(0, -0.27, 0), limb.position.y = 1.35;
  return { group: g, legL, legR, armL, armR, head };
}

function house(rng, opts = {}) {
  const g = new THREE.Group();
  const w = 3.6 + rng() * 2.2, d = 3.2 + rng() * 1.8, h = 2.4 + rng() * 1.0;
  const walls = [0x8a7d6a, 0x7d6f5c, 0x94836c, 0x6e6252][Math.floor(rng() * 4)];
  const roofC = [0x5f4636, 0x584a3a, 0x6b4a30][Math.floor(rng() * 3)];
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ map: makeTile(walls, { contrast: 0.22 }) }));
  body.position.y = h / 2;
  body.castShadow = body.receiveShadow = true;
  g.add(body);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(1, 1, 4),
    new THREE.MeshLambertMaterial({ map: makeTile(roofC, { contrast: 0.3 }) }));
  roof.geometry.rotateY(Math.PI / 4);
  roof.scale.set(w * 0.85, 0.9 + rng() * 0.6, d * 0.85);
  roof.position.y = h + roof.scale.y / 2 - 0.02;
  roof.castShadow = true;
  g.add(roof);
  const dark = new THREE.MeshLambertMaterial({ color: 0x241d16 });
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.4, 0.06), dark);
  door.position.set((rng() - 0.5) * w * 0.4, 0.7, d / 2 + 0.02);
  g.add(door);
  for (let k = 0; k < 1 + Math.floor(rng() * 2); k++) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.06), dark);
    win.position.set((k === 0 ? -1 : 1) * w * 0.28, h * 0.62, d / 2 + 0.02);
    g.add(win);
  }
  g.userData.radius = Math.max(w, d) * 0.62;
  if (opts.rot != null) g.rotation.y = opts.rot;
  return g;
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class HubWorld {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9a8468); // dusty haze
    this.scene.fog = new THREE.Fog(0x9a8468, 55, 110);

    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    this.camera = new THREE.OrthographicCamera(
      -VIEW_H * aspect / 2, VIEW_H * aspect / 2, VIEW_H / 2, -VIEW_H / 2, 0.1, 200);
    this.camOffset = new THREE.Vector3(16, 13.5, 16);

    // long low wasteland sun + warm bounce
    const hemi = new THREE.HemisphereLight(0xcbb392, 0x4a3c2e, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffd9a0, 1.45);
    sun.position.set(-22, 18, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.far = 90;
    this.scene.add(sun);

    // dirt ground
    const groundTex = makeTile(0x6e5c46, { contrast: 0.22 });
    groundTex.repeat.set(30, 30);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshLambertMaterial({ map: groundTex }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    // the old highway the village grew around — cracked strip of asphalt
    const roadTex = makeTile(0x4c4a48, { contrast: 0.18 });
    roadTex.repeat.set(2, 24);
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 240),
      new THREE.MeshLambertMaterial({ map: roadTex }));
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.02;
    road.receiveShadow = true;
    this.scene.add(road);

    // village: houses flanking the road
    const rng = mulberry32(4711);
    this.colliders = [];
    const lots = [
      [-8, -14, 0.5], [-9, -4, 0.2], [-8.5, 6, -0.3], [-9, 15, 0.4],
      [8, -11, -0.4], [8.5, -1, 0.1], [8, 9, -0.2], [9, 18, 0.3],
      [-15, 0, 1.1], [15, 4, -1.2],
    ];
    for (const [x, z, rot] of lots) {
      const hs = house(rng, { rot });
      hs.position.set(x, 0, z);
      this.scene.add(hs);
      this.colliders.push({ x, z, r: hs.userData.radius });
    }

    // junk props: barrels, crates
    const barrelMat = new THREE.MeshLambertMaterial({ map: makeTile(0x704a30, { contrast: 0.3 }) });
    const crateMat = new THREE.MeshLambertMaterial({ map: makeTile(0x6a5638, { contrast: 0.25 }) });
    for (let i = 0; i < 14; i++) {
      const side = rng() > 0.5 ? 1 : -1;
      const x = side * (4.8 + rng() * 9), z = -18 + rng() * 36;
      const barrel = rng() > 0.45;
      const m = barrel
        ? new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.9, 9), barrelMat)
        : new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 0.8), crateMat);
      m.position.set(x, barrel ? 0.45 : 0.35, z);
      m.rotation.y = rng() * Math.PI;
      m.castShadow = m.receiveShadow = true;
      this.scene.add(m);
      this.colliders.push({ x, z, r: 0.55 });
    }

    // campfire: flickering point light + ember cone
    this.fire = new THREE.PointLight(0xff8033, 1.6, 14, 1.6);
    this.fire.position.set(4.2, 1.0, 3.5);
    this.scene.add(this.fire);
    const embers = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 0.5, 7),
      new THREE.MeshBasicMaterial({ color: 0xff7a26 }));
    embers.position.set(4.2, 0.25, 3.5);
    this.scene.add(embers);
    this.colliders.push({ x: 4.2, z: 3.5, r: 0.8 });

    // the player's bike, parked where the stage ended
    const bike = new THREE.Group();
    const bmat = new THREE.MeshLambertMaterial({ color: 0x8a1f18 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.42, 0.4), bmat);
    frame.position.y = 0.62;
    frame.castShadow = true;
    bike.add(frame);
    const tmat = new THREE.MeshLambertMaterial({ color: 0x181818 });
    for (const wx of [-0.75, 0.75]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.16, 12), tmat);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(wx, 0.34, 0);
      wheel.castShadow = true;
      bike.add(wheel);
    }
    bike.position.set(1.8, 0, -8.5);
    bike.rotation.y = 0.5;
    bike.rotation.z = 0.16; // on its kickstand
    this.scene.add(bike);
    this.colliders.push({ x: 1.8, z: -8.5, r: 1.1 });

    // ------------------------------------------------------------ people
    this.player = figure({ jacket: 0x5a2320, pants: 0x2c2c30, hat: 0x8a1f18 });
    this.player.group.position.set(0, 0, -5);
    this.scene.add(this.player.group);
    this.heading = Math.PI; // facing the village

    this.npcs = [
      {
        id: 'harrow', name: 'HARROW', role: 'village elder',
        x: -6.2, z: -2.6, face: 0.9,
        fig: figure({ jacket: 0x6a6252, pants: 0x3a352c, skin: 0xb08d6c, hat: 0x4a4438 }),
      },
      {
        id: 'wrench', name: 'WRENCH', role: 'mechanic',
        x: 3.2, z: -7.2, face: -2.2,
        fig: figure({ jacket: 0x38445a, pants: 0x2a2a2a, skin: 0xc09a78 }),
      },
      {
        id: 'moth', name: 'MOTH', role: 'courier broker',
        x: 5.4, z: 4.6, face: -0.6,
        fig: figure({ jacket: 0x54402c, pants: 0x332e26, skin: 0xa8845e, hat: 0x241d16 }),
      },
    ];
    for (const n of this.npcs) {
      n.fig.group.position.set(n.x, 0, n.z);
      n.fig.group.rotation.y = n.face;
      this.scene.add(n.fig.group);
    }

    // ------------------------------------------------------------ input
    this.keys = {};
    this._down = (e) => { this.keys[e.key.toLowerCase()] = true; };
    this._up = (e) => { this.keys[e.key.toLowerCase()] = false; };
    window.addEventListener('keydown', this._down);
    window.addEventListener('keyup', this._up);

    this._resize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h);
      const a = w / h;
      this.camera.left = -VIEW_H * a / 2;
      this.camera.right = VIEW_H * a / 2;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this._resize);

    // React reads this once per frame
    this.state = { near: null, walking: false };
    this.locked = false; // dialogue open — no walking
    this.clock = 0;
    this.walkPhase = 0;
    this.disposed = false;
    this._last = performance.now();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  _tick(now) {
    if (this.disposed) return;
    requestAnimationFrame(this._tick);
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this.clock += dt;

    // camera-relative move axes (screen up/right projected onto the ground)
    let mx = 0, mz = 0;
    if (!this.locked) {
      const up = (this.keys['w'] || this.keys['arrowup']) ? 1 : 0;
      const dn = (this.keys['s'] || this.keys['arrowdown']) ? 1 : 0;
      const lf = (this.keys['a'] || this.keys['arrowleft']) ? 1 : 0;
      const rt = (this.keys['d'] || this.keys['arrowright']) ? 1 : 0;
      const f = up - dn, r = rt - lf;
      // camera sits at +X+Z looking back: screen-up is (-1,-1)/sqrt2 in xz
      const k = Math.SQRT1_2;
      mx = (-f * k) + (r * k);
      mz = (-f * k) + (-r * k);
    }
    const moving = (mx !== 0 || mz !== 0);
    const P = this.player.group.position;
    if (moving) {
      const len = Math.hypot(mx, mz);
      mx /= len; mz /= len;
      const SPEED = 4.4;
      P.x += mx * SPEED * dt;
      P.z += mz * SPEED * dt;
      // push out of props and houses
      for (const c of this.colliders) {
        const dx = P.x - c.x, dz = P.z - c.z;
        const d = Math.hypot(dx, dz);
        if (d < c.r + 0.35 && d > 1e-4) {
          const push = (c.r + 0.35 - d);
          P.x += (dx / d) * push;
          P.z += (dz / d) * push;
        }
      }
      P.x = Math.max(-24, Math.min(24, P.x));
      P.z = Math.max(-26, Math.min(28, P.z));
      const want = Math.atan2(mx, mz);
      let diff = want - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.heading += diff * Math.min(1, dt * 14);
      this.walkPhase += dt * 9;
    } else {
      this.walkPhase *= Math.pow(0.001, dt);
    }
    this.player.group.rotation.y = this.heading;

    // walk cycle / idle sway
    const sw = Math.sin(this.walkPhase) * (moving ? 0.65 : 0);
    this.player.legL.rotation.x = sw;
    this.player.legR.rotation.x = -sw;
    this.player.armL.rotation.x = -sw * 0.7;
    this.player.armR.rotation.x = sw * 0.7;
    for (const n of this.npcs) {
      const idle = Math.sin(this.clock * 1.3 + n.x * 7) * 0.045;
      n.fig.group.rotation.y = n.face + idle;
      n.fig.head.rotation.y = Math.sin(this.clock * 0.6 + n.z * 3) * 0.3;
    }

    // campfire flicker
    this.fire.intensity = 1.35 + Math.sin(this.clock * 11) * 0.2 + Math.sin(this.clock * 23.7) * 0.14;

    // nearest NPC in talking range
    let near = null, bestD = 2.4;
    for (const n of this.npcs) {
      const d = Math.hypot(P.x - n.x, P.z - n.z);
      if (d < bestD) { bestD = d; near = n; }
    }
    this.state.near = near ? { id: near.id, name: near.name, role: near.role } : null;
    this.state.walking = moving;
    // NPCs turn to face you when you're close
    if (near) {
      const n = this.npcs.find((q) => q.id === near.id);
      n.face += (Math.atan2(P.x - n.x, P.z - n.z) - n.face) * Math.min(1, dt * 4);
    }

    // camera follows
    this.camera.position.set(P.x, 0, P.z).add(this.camOffset);
    this.camera.lookAt(P.x, 1.1, P.z);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('keydown', this._down);
    window.removeEventListener('keyup', this._up);
    window.removeEventListener('resize', this._resize);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
