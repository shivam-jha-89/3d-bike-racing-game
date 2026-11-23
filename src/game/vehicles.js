import * as THREE from 'three';

// Attack helicopter: hunts the pack from the air at bike pace, strafing
// across the road and firing the same slow lead-aimed rockets as the
// roadside launcher towers (via LauncherBattery.fireRocket). Twelve pistol
// hits and it plummets, detonating on ground impact. Game owns targeting,
// firing and blast damage; this class owns the mesh, flight and hit points.
export class GunshipSquad {
  constructor(scene, track, count = 2) {
    this.scene = scene;
    this.track = track;
    this.list = [];
    for (let i = 0; i < count; i++) {
      const v = this.buildGunship(i);
      // both ships hold station AHEAD of the player, inside their own
      // 45-130 m firing band, lobbing rockets back at the oncoming pack
      v.leadBase = i === 0 ? 60 : 95;
      v.s = 0;
      v.lateral = 0;
      v.worldY = 60; // starts high, descends into the fight
      v.alt = 9 + i * 1.5;
      v.phase = i * 2.1;
      v.phaseAlt = i * 1.3;
      v.roll = 0;
      v.maxHp = 12;
      v.hp = 12;
      v.dead = false;
      v.falling = false;
      v.flying = true;
      v.vy = 0;
      v.deadT = 0;
      v.burnT = 0;
      v.gunCd = 5 + i * 2;
      v.justCrashed = false;
      v.target = null;
      this.list.push(v);
      scene.add(v.mesh);
    }
  }

  buildGunship(i) {
    const grp = new THREE.Group();
    grp.rotation.order = 'YXZ';
    const body = new THREE.MeshPhongMaterial({ color: 0x3b463a, shininess: 40 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x181c18 });
    const glass = new THREE.MeshPhongMaterial({ color: 0x1a2630, shininess: 120, specular: 0x88aacc });
    const gunMetal = new THREE.MeshPhongMaterial({ color: 0x2c3034, shininess: 70 });

    // fuselage: tapered nose + main body
    const fuse = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 3.6), body);
    fuse.position.set(0, 0, 0.2);
    grp.add(fuse);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 1.2), body);
    nose.position.set(0, -0.1, 2.0);
    grp.add(nose);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 1.3), glass);
    canopy.position.set(0, 0.35, 1.7);
    grp.add(canopy);
    // engine hump under the rotor
    const hump = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 1.8), dark);
    hump.position.set(0, 0.9, -0.1);
    grp.add(hump);

    // tail boom + fin
    const boom = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 3.4), body);
    boom.position.set(0, 0.4, -3.0);
    grp.add(boom);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.2, 0.8), body);
    fin.position.set(0, 0.9, -4.5);
    grp.add(fin);
    const stab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 0.6), body);
    stab.position.set(0, 0.55, -4.2);
    grp.add(stab);

    // stub wings with rocket pods (menace)
    for (const side of [1, -1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.7), dark);
      wing.position.set(1.0 * side, -0.15, 0.1);
      grp.add(wing);
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.0, 8), gunMetal);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(1.55 * side, -0.25, 0.1);
      grp.add(pod);
    }

    // landing skids
    for (const side of [1, -1]) {
      const skid = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 2.6), dark);
      skid.position.set(0.7 * side, -1.0, 0.1);
      grp.add(skid);
      for (const z of [1.0, -0.8]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08), dark);
        strut.position.set(0.7 * side, -0.75, z);
        grp.add(strut);
      }
    }

    // chin gun turret (yaws toward the target, like the old truck turret)
    const turret = new THREE.Group();
    turret.position.set(0, -0.7, 2.0);
    turret.add(new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), gunMetal));
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 1.0), dark);
    barrel.position.set(0, -0.05, 0.6);
    turret.add(barrel);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, -0.05, 1.2);
    turret.add(muzzle);
    grp.add(turret);

    // main rotor: hub + long blades, spins around Y
    const rotor = new THREE.Group();
    rotor.position.set(0, 1.35, -0.1);
    rotor.add(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.3, 8), gunMetal));
    for (let b = 0; b < 4; b++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 8.4), dark);
      blade.rotation.y = (b * Math.PI) / 2;
      rotor.add(blade);
    }
    grp.add(rotor);
    // tail rotor spins around X on the fin
    const tailRotor = new THREE.Group();
    tailRotor.position.set(0.2, 0.9, -4.6);
    for (let b = 0; b < 2; b++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.5, 0.14), dark);
      blade.rotation.z = b * (Math.PI / 2);
      tailRotor.add(blade);
    }
    grp.add(tailRotor);

    // red belly beacon
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xff2222 }));
    beacon.position.set(0, -0.85, -0.2);
    grp.add(beacon);

    const mats = [];
    const seen = new Set();
    grp.traverse((o) => {
      if (o.material && !seen.has(o.material) && o.material !== glass) {
        seen.add(o.material);
        mats.push({ m: o.material, hex: o.material.color.getHex() });
      }
    });
    return { mesh: grp, mats, turret, muzzle, rotor, tailRotor };
  }

  update(dt, playerS) {
    const L = this.track.length;
    // player's along-track speed, for station-keeping feed-forward
    const playerV = this.prevPlayerS != null
      ? clamp((playerS - this.prevPlayerS) / dt, 0, 90) : 0;
    this.prevPlayerS = playerS;
    for (const v of this.list) {
      // rotors keep spinning until it hits the ground
      if (!v.dead || v.falling) {
        v.rotor.rotation.y += 42 * dt;
        v.tailRotor.rotation.x += 55 * dt;
      }

      if (v.falling) {
        // shot down: plummet, spinning, until it meets the road
        v.vy -= 22 * dt;
        v.worldY += v.vy * dt;
        v.s = Math.min(v.s + v.speed * dt, L - 10);
        v.speed *= 0.98;
        v.mesh.rotation.y += 7 * dt;
        v.mesh.rotation.z = Math.min(v.mesh.rotation.z + 1.6 * dt, 1.3);
        v.mesh.rotation.x = Math.min(v.mesh.rotation.x + 0.9 * dt, 0.7);
        const sm = this.track.interpAt(v.s);
        if (v.worldY <= sm.y + 0.4) {
          v.worldY = sm.y + 0.4;
          v.falling = false;
          v.flying = false;
          v.dead = true;
          v.justCrashed = true; // Game reads this to detonate + score
          v.deadT = 26;
          v.burnT = 9;
          for (const e of v.mats) e.m.color.setHex(0x141414);
        }
        const smp = this.track.interpAt(v.s);
        v.mesh.position.set(smp.x + smp.nx * v.lateral, v.worldY, smp.z + smp.nz * v.lateral);
        continue;
      }

      if (v.dead) {
        // burning wreck on the road
        v.deadT -= dt;
        if (v.deadT <= 0) this.respawn(v, playerS);
        const sm = this.track.interpAt(v.s);
        v.mesh.position.set(sm.x + sm.nx * v.lateral, v.worldY, sm.z + sm.nz * v.lateral);
        continue;
      }

      // --- alive: hunt the player's track position at bike pace
      v.phase += dt * 0.7;
      v.phaseAlt += dt * 1.3;
      // A->B stage: hold station ahead of the player at firing distance,
      // but never past the finish
      const targetS = Math.min(playerS + v.leadBase, L - 90);
      const gap = targetS - v.s;
      // match the player's pace + close the gap: holds the lead distance
      // steady instead of orbiting it. Tops out around 260 km/h.
      v.speed = clamp(playerV + gap * 0.6, 4, 72);
      v.s = Math.min(Math.max(v.s + v.speed * dt, 0), L - 12);

      // strafe across the road, banking into the slide
      const halfW = this.track.halfWidth;
      const targetLat = Math.sin(v.phase) * (halfW + 3);
      const prevLat = v.lateral;
      v.lateral += (targetLat - v.lateral) * Math.min(1, dt * 2);
      const latVel = (v.lateral - prevLat) / dt;
      v.roll += (clamp(-latVel * 0.05, -0.5, 0.5) - v.roll) * Math.min(1, dt * 4);

      // descend from the spawn height, then bob
      const sm = this.track.interpAt(v.s);
      const cruiseY = sm.y + v.alt + Math.sin(v.phaseAlt) * 1.2;
      v.worldY += (cruiseY - v.worldY) * Math.min(1, dt * 1.5);

      v.mesh.position.set(sm.x + sm.nx * v.lateral, v.worldY, sm.z + sm.nz * v.lateral);
      v.mesh.rotation.set(0.06, sm.angle, v.roll);
    }
  }

  // called by Game on the 12th hit: begin the death plunge
  startFalling(v) {
    if (v.dead || v.falling) return;
    v.falling = true;
    v.vy = 1.5; // slight pop, then gravity takes over
    v.target = null;
  }

  respawn(v, playerS) {
    const L = this.track.length;
    v.s = Math.min(playerS + 250 + Math.random() * 300, L - 200);
    v.hp = v.maxHp;
    v.dead = false;
    v.falling = false;
    v.flying = true;
    v.burnT = 0;
    v.gunCd = 5;
    v.worldY = 55;
    v.vy = 0;
    v.mesh.rotation.set(0, 0, 0);
    for (const e of v.mats) e.m.color.setHex(e.hex);
  }

  resetAll() {
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      v.s = 0;
      v.lateral = 0;
      v.worldY = 60;
      v.phase = i * 2.1;
      v.phaseAlt = i * 1.3;
      v.roll = 0;
      v.hp = v.maxHp;
      v.dead = false;
      v.falling = false;
      v.flying = true;
      v.vy = 0;
      v.burnT = 0;
      v.gunCd = 5 + i * 2;
      v.justCrashed = false;
      v.target = null;
      v.mesh.rotation.set(0, 0, 0);
      for (const e of v.mats) e.m.color.setHex(e.hex);
    }
  }
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// Fuel tankers circulating the circuit as rolling hazards. Three pistol
// hits and they go up — Game owns the explosion effects and blast damage;
// this class owns movement, meshes and hit points.

export class TankerFleet {
  constructor(scene, track, count = 4) {
    this.scene = scene;
    this.track = track;
    this.list = [];
    for (let i = 0; i < count; i++) {
      const v = this.buildTanker(i);
      v.s = ((i + 0.6) / count) * track.length;
      v.lateral = i % 2 === 0 ? -2.7 : 2.7;
      v.speed = 12 + (i % 3) * 2.5;
      v.hp = 3;
      v.dead = false;
      v.deadT = 0;
      v.burnT = 0;
      this.list.push(v);
      scene.add(v.mesh);
    }
  }

  buildTanker(i) {
    const grp = new THREE.Group();
    const cabMat = new THREE.MeshPhongMaterial({
      color: [0x3a6ea5, 0xa53a3a, 0x3aa56e, 0xa5883a, 0x7a3aa5][i % 5],
      shininess: 60,
    });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x1c1c22 });
    const tankMat = new THREE.MeshPhongMaterial({ color: 0xd8d8de, shininess: 110, specular: 0x999999 });
    const bandMat = new THREE.MeshLambertMaterial({ color: 0xd42b1e });

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 7.6), darkMat);
    chassis.position.set(0, 0.55, -0.4);
    grp.add(chassis);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.9, 1.7), cabMat);
    cab.position.set(0, 1.55, 2.9);
    grp.add(cab);
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 0.06), darkMat);
    windshield.position.set(0, 1.95, 3.78);
    grp.add(windshield);

    // the cistern
    const tankGeo = new THREE.CylinderGeometry(1.0, 1.0, 5.6, 14);
    tankGeo.rotateX(Math.PI / 2);
    const tank = new THREE.Mesh(tankGeo, tankMat);
    tank.position.set(0, 1.9, -1.0);
    grp.add(tank);
    for (const z of [-2.4, 0.4]) {
      const bandGeo = new THREE.CylinderGeometry(1.03, 1.03, 0.32, 14);
      bandGeo.rotateX(Math.PI / 2);
      const band = new THREE.Mesh(bandGeo, bandMat);
      band.position.set(0, 1.9, z - 1.0 + 1.0);
      band.position.z = z;
      grp.add(band);
    }
    // hazard diamond on the back
    const hazard = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.05),
      new THREE.MeshLambertMaterial({ color: 0xe8a01c }));
    hazard.position.set(0, 1.7, -4.0);
    hazard.rotation.z = Math.PI / 4;
    grp.add(hazard);

    // wheels
    const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 10);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const z of [2.7, -1.7, -3.3]) {
      for (const side of [1, -1]) {
        const w = new THREE.Mesh(wheelGeo, darkMat);
        w.position.set(0.95 * side, 0.5, z);
        grp.add(w);
      }
    }

    // remember original colours so wrecks can be re-painted on respawn
    const mats = [];
    const seen = new Set();
    grp.traverse((o) => {
      if (o.material && !seen.has(o.material)) {
        seen.add(o.material);
        mats.push({ m: o.material, hex: o.material.color.getHex() });
      }
    });
    return { mesh: grp, mats };
  }

  update(dt, playerS) {
    for (const v of this.list) {
      if (v.dead) {
        v.deadT -= dt;
        if (v.deadT <= 0) this.respawn(v, playerS);
      } else {
        v.s += v.speed * dt;
        if (v.s > this.track.length - 60) this.respawn(v, playerS);
      }
      const sm = this.track.interpAt(v.s);
      v.mesh.position.set(sm.x + sm.nx * v.lateral, sm.y, sm.z + sm.nz * v.lateral);
      v.mesh.rotation.y = sm.angle;
    }
  }

  // charred wreck; Game handles the pyrotechnics
  wreck(v) {
    v.dead = true;
    v.deadT = 25;
    v.burnT = 7;
    v.speed = 0;
    v.mesh.rotation.z = 0.12;
    for (const e of v.mats) e.m.color.setHex(0x181818);
  }

  respawn(v, playerS) {
    const L = this.track.length;
    v.s = Math.min(playerS + 350 + Math.random() * 400, L - 150);
    if (v.s < playerS + 60) v.s = Math.min(playerS + 120, L - 100);
    v.hp = 3;
    v.dead = false;
    v.burnT = 0;
    v.mesh.rotation.z = 0;
    for (const e of v.mats) e.m.color.setHex(e.hex);
  }

  resetAll() {
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      v.s = ((i + 0.6) / this.list.length) * this.track.length;
      v.hp = 3;
      v.dead = false;
      v.burnT = 0;
      v.mesh.rotation.z = 0;
      for (const e of v.mats) e.m.color.setHex(e.hex);
    }
  }
}

// Static rocket emplacements dug in by the roadside, just past the barriers.
// Each one tracks the player, lead-aims and fires a SLOW rocket — no homing,
// so a decisive turn after the launch warning makes it sail past. Two pistol
// hits kill an emplacement for the rest of the stage (they never respawn —
// an A->B road you only ride once). Game owns launch warnings, smoke trails
// and blast damage; this class owns meshes, aiming, cooldowns and rocket
// kinematics.
const ROCKET_SPEED = 31.5; // m/s (~113 km/h): slow enough to outride and outturn
const ROCKET_LIFE = 12;    // enough for a full-range (~300 m) flight
const ROCKET_TURN = 0.85;  // rad/s of homing: a ~37 m turning circle — lazy

export class LauncherBattery {
  constructor(scene, track) {
    this.scene = scene;
    this.track = track;
    this.list = [];
    this.rockets = [];
    this.events = []; // {type:'launch'|'burst', x,y,z} drained by Game each frame
    this.rocketGeo = null;

    // one emplacement every ~750 m, alternating sides, never inside a
    // tunnel or on a bridge (nudge downstream until clear)
    const L = track.length;
    let idx = 0;
    for (let s0 = 620; s0 < L - 450; s0 += 750) {
      let s = s0 + (((idx * 7919) % 13) / 13 - 0.5) * 160;
      let tries = 0;
      while ((track.isInTunnel(s) || track.isOnBridge(s)) && tries++ < 8) s += 70;
      if (track.isInTunnel(s) || track.isOnBridge(s)) continue;
      const side = idx % 2 === 0 ? 1 : -1;
      const sm = track.interpAt(s);
      const lat = ((sm.wallD || track.wallDist) + 3.4) * side;
      const v = this.buildLauncher(idx);
      v.s = s;
      v.side = side;
      v.lateral = lat; // shared hazard loop reads this (far outside the road)
      v.mesh.position.set(sm.x + sm.nx * lat, sm.y - 0.12, sm.z + sm.nz * lat);
      // face the road so the tubes read as a threat even before they turn
      v.mesh.rotation.y = sm.angle + (Math.PI / 2) * side;
      v.baseYaw = v.mesh.rotation.y;
      v.headPos = new THREE.Vector3(
        v.mesh.position.x, v.mesh.position.y + 5.0, v.mesh.position.z);
      v.maxHp = 2;
      v.hp = 2;
      v.dead = false;
      v.burnT = 0;
      v.cd = 1.5 + (idx % 3) * 1.1; // stagger the first volley
      v.burstLeft = 0;
      this.list.push(v);
      scene.add(v.mesh);
      idx++;
    }
  }

  buildLauncher(i) {
    const grp = new THREE.Group();
    const concrete = new THREE.MeshLambertMaterial({ color: 0x8d8d86 });
    const metal = new THREE.MeshPhongMaterial({ color: 0x4a5348, shininess: 45 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x22251f });
    const hazard = new THREE.MeshLambertMaterial({ color: 0xe0b020 });

    // concrete pad + sandbag lip
    const pad = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 2.6), concrete);
    pad.position.y = 0.25;
    grp.add(pad);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.3, 2.9), dark);
    lip.position.y = 0.15;
    grp.add(lip);
    // hazard stripes on the pad edge facing the road
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 0.1), hazard);
    stripe.position.set(0, 0.42, 1.31);
    grp.add(stripe);

    // lattice tower — the launcher sits high so it reads from hundreds of
    // metres out and can be engaged long before it fires
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.55, 3.4, 0.55), concrete);
    mast.position.y = 2.1;
    grp.add(mast);
    for (const [bx, bz] of [[0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.4, 0.14), dark);
      leg.position.set(bx, 2.1, bz);
      leg.rotation.z = -bx * 0.09;
      leg.rotation.x = bz * 0.09;
      grp.add(leg);
    }
    // hazard band mid-mast + crew platform on top
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, 0.62), hazard);
    band.position.y = 2.6;
    grp.add(band);
    const platform = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.22, 1.9), metal);
    platform.position.y = 3.85;
    grp.add(platform);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.08, 2.0), hazard);
    rail.position.y = 4.35;
    grp.add(rail);

    // blinking beacon so it pops at range (pulsed in update)
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xff2222 }));
    beacon.position.set(0.75, 4.35, 0.75);
    grp.add(beacon);

    // pedestal on the platform
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 0.9, 10), metal);
    pedestal.position.y = 4.4;
    grp.add(pedestal);

    // rotating head: twin rocket tubes + sight block — oversized on purpose,
    // it's the pistol target and has to be easy to hit from a moving bike
    const head = new THREE.Group();
    head.position.y = 5.0;
    const cradle = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.75, 1.3), metal);
    head.add(cradle);
    const muzzles = [];
    for (const sx of [0.5, -0.5]) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 2.3, 10), dark);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(sx, 0.15, 0.35);
      head.add(tube);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.05, 6, 12), hazard);
      ring.position.set(sx, 0.15, 1.5);
      head.add(ring);
      const m = new THREE.Object3D();
      m.position.set(sx, 0.15, 1.55);
      head.add(m);
      muzzles.push(m);
    }
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.45), dark);
    sight.position.set(0, 0.62, -0.2);
    head.add(sight);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xff3322 }));
    eye.position.set(0, 0.62, 0.06);
    head.add(eye);
    grp.add(head);

    const mats = [];
    const seen = new Set();
    grp.traverse((o) => {
      if (o.material && o.material.color && !seen.has(o.material)) {
        seen.add(o.material);
        mats.push({ m: o.material, hex: o.material.color.getHex() });
      }
    });
    return { mesh: grp, head, muzzles, beacon, nextTube: 0, mats };
  }

  // target: {x, y, z, vx, vz, valid} — the player (tower aiming/lead).
  // riders: [{x, y, z}] — every live bike; rockets lazily home on the
  // nearest one and their proximity fuse checks all of them.
  update(dt, target, firing, riders = [], rateMul = 1) {
    this.clock = (this.clock || 0) + dt;
    for (const v of this.list) {
      if (v.dead) continue;
      // beacon blink: visible-from-afar warning light
      v.beacon.scale.setScalar(Math.sin(this.clock * 5 + v.s) > 0 ? 1.4 : 0.6);
      // cooldowns always run — a tower must be READY when a 280 km/h bike
      // blows through its 150 m firing window. rateMul is the difficulty
      // dial: 0 freezes the towers entirely.
      v.cd -= dt * rateMul;
      const hp = v.headPos;
      const dx = target.x - hp.x, dz = target.z - hp.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 500) continue; // start pre-aiming well before the band

      // slew the head onto the player (world yaw -> local head yaw)
      const wantYaw = Math.atan2(dx, dz) - v.baseYaw;
      let dyaw = wantYaw - v.head.rotation.y;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      v.head.rotation.y += clamp(dyaw, -2.2 * dt, 2.2 * dt);
      // pitch the tubes at the target height
      const wantPitch = clamp(Math.atan2(hp.y - (target.y + 0.8), dist), -0.5, 0.35);
      v.head.rotation.x += (wantPitch - v.head.rotation.x) * Math.min(1, dt * 3);

      const aimed = Math.abs(dyaw) < 0.25;
      // long-range only: rockets need >= ~2.2 s of flight so there is always
      // time to see the warning and swerve; inside 100 m they hold fire.
      // Fire pattern: bursts of 3 rockets 0.3 s apart, then a 3 s pause.
      if (firing && target.valid && aimed && v.cd <= 0 && dist > 100 && dist < 250) {
        if (v.burstLeft <= 0) v.burstLeft = 3;
        this.launch(v, target);
        v.burstLeft--;
        v.cd = v.burstLeft > 0 ? 0.3 : 3.0;
      }
    }

    // rockets: lazy homing toward the nearest bike, proximity fuse on any
    // bike, contact fuse on the ground
    const UP = new THREE.Vector3(0, 1, 0);
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.life -= dt;

      // nearest live bike to this rocket
      let nb = null, nd2 = Infinity;
      for (const b of riders) {
        const dx = b.x - r.pos.x, dy = (b.y + 0.8) - r.pos.y, dz = b.z - r.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < nd2) { nd2 = d2; nb = b; }
      }

      // LAZY tracking: gently bend toward the nearest bike, but only while
      // it is still in front of the rocket — once overflown it never loops
      // back. Tracking also cuts out inside 12 m: the terminal stretch is
      // pure ballistics, so a late juke beats it and it can't micro-correct
      // onto a swerving bike at the end
      if (nb && nd2 < 110 * 110 && nd2 > 12 * 12) {
        const want = new THREE.Vector3(
          nb.x - r.pos.x, (nb.y + 0.8) - r.pos.y, nb.z - r.pos.z);
        if (want.dot(r.vel) > 0) {
          want.normalize();
          const dir = r.vel.clone().normalize();
          const angle = dir.angleTo(want);
          const maxTurn = ROCKET_TURN * dt;
          if (angle > 1e-4) {
            dir.lerp(want, Math.min(1, maxTurn / angle)).normalize();
            r.vel.copy(dir).multiplyScalar(ROCKET_SPEED);
            r.mesh.quaternion.setFromUnitVectors(UP, dir);
          }
        }
      }

      const px = r.pos.x, py = r.pos.y, pz = r.pos.z;
      r.pos.addScaledVector(r.vel, dt);
      r.mesh.position.copy(r.pos);
      // tight proximity fuse, swept over this frame's flight segment so a
      // head-on closing speed can't step across the tiny fuse sphere
      let near = false;
      if (nb) {
        const sx = r.pos.x - px, sy = r.pos.y - py, sz = r.pos.z - pz;
        const wx = nb.x - px, wy = (nb.y + 0.8) - py, wz = nb.z - pz;
        const segLen2 = sx * sx + sy * sy + sz * sz;
        const tt = segLen2 > 0 ? clamp((wx * sx + wy * sy + wz * sz) / segLen2, 0, 1) : 0;
        const cx = wx - sx * tt, cy = wy - sy * tt, cz = wz - sz * tt;
        near = cx * cx + cy * cy + cz * cz < 1.1 * 1.1;
      }
      const q = this.track.nearest(r.pos.x, r.pos.z, r.hint);
      r.hint = q.index;
      const groundY = Math.abs(q.lateral) < this.track.halfWidth + 30
        ? q.sample.y : q.sample.y - 2;
      if (near || r.life <= 0 || r.pos.y <= groundY + 0.35) {
        this.events.push({ type: 'burst', x: r.pos.x, y: Math.max(r.pos.y, groundY + 0.4), z: r.pos.z });
        this.scene.remove(r.mesh);
        this.rockets.splice(i, 1);
      }
    }
  }

  launch(v, target) {
    v.mesh.updateWorldMatrix(true, true);
    const muzzle = new THREE.Vector3();
    v.muzzles[v.nextTube].getWorldPosition(muzzle);
    v.nextTube = (v.nextTube + 1) % v.muzzles.length;
    this.fireRocket(muzzle, target);
  }

  // shared by the towers AND the gunships — one rocket model everywhere.
  // target: {x, y, z, vx, vz, atPlayer?}; atPlayer=false suppresses the
  // player-facing warning flash in Game.
  fireRocket(muzzle, target) {
    // lead-aim: solve |P + V t| = c t for the intercept time, then fly
    // STRAIGHT there — the whole point is that changing course after the
    // launch makes the rocket miss
    const px = target.x - muzzle.x, py = (target.y + 0.8) - muzzle.y, pz = target.z - muzzle.z;
    const a = target.vx * target.vx + target.vz * target.vz - ROCKET_SPEED * ROCKET_SPEED;
    const b = 2 * (px * target.vx + pz * target.vz);
    const c = px * px + py * py + pz * pz;
    let t = 1.2;
    const disc = b * b - 4 * a * c;
    if (Math.abs(a) > 1e-4 && disc > 0) {
      const rt = Math.sqrt(disc);
      const t1 = (-b - rt) / (2 * a), t2 = (-b + rt) / (2 * a);
      t = Math.min(t1 > 0.05 ? t1 : Infinity, t2 > 0.05 ? t2 : Infinity);
      if (!isFinite(t)) t = 1.2;
      t = clamp(t, 0.3, 10); // slow rockets at long range need long leads
    }
    const aim = new THREE.Vector3(
      px + target.vx * t, py, pz + target.vz * t).normalize();

    if (!this.rocketGeo) {
      this.rocketGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.9, 6);
      this.rocketGeo.translate(0, 0.45, 0);
      const nose = new THREE.ConeGeometry(0.09, 0.25, 6);
      nose.translate(0, 1.0, 0);
      this.noseGeo = nose;
      this.rocketMat = new THREE.MeshLambertMaterial({ color: 0xd8d4c8 });
      this.flameMat = new THREE.MeshBasicMaterial({
        color: 0xffaa33, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
    }
    const grp = new THREE.Group();
    grp.add(new THREE.Mesh(this.rocketGeo, this.rocketMat));
    grp.add(new THREE.Mesh(this.noseGeo, this.rocketMat));
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.17, 6, 5), this.flameMat);
    flame.position.y = -0.08;
    grp.add(flame);
    grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), aim);
    grp.position.copy(muzzle);
    this.scene.add(grp);
    this.rockets.push({
      mesh: grp, pos: muzzle.clone(),
      vel: aim.multiplyScalar(ROCKET_SPEED),
      life: ROCKET_LIFE, hint: null,
    });
    this.events.push({
      type: 'launch', x: muzzle.x, y: muzzle.y, z: muzzle.z,
      atPlayer: target.atPlayer !== false,
    });
  }

  // second pistol hit: dead for the rest of the stage
  wreck(v) {
    v.dead = true;
    v.burnT = 8;
    v.beacon.scale.setScalar(0.6); // warning light dies with it
    v.head.rotation.x = 0.55; // tubes knocked skyward
    v.head.rotation.z = 0.3;
    for (const e of v.mats) e.m.color.setHex(0x181818);
  }

  clearRockets() {
    for (const r of this.rockets) this.scene.remove(r.mesh);
    this.rockets.length = 0;
    this.events.length = 0;
  }

  resetAll() {
    this.clearRockets();
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      v.hp = v.maxHp;
      v.dead = false;
      v.burnT = 0;
      v.cd = 1.5 + (i % 3) * 1.1;
      v.burstLeft = 0;
      v.head.rotation.set(0, 0, 0);
      for (const e of v.mats) e.m.color.setHex(e.hex);
    }
  }
}

// ---------------------------------------------------------------------------
// DroneSwarm — quad-rotor bomb drones that shadow the rider pack from ~13 m
// up and roll grenades onto whoever is underneath. Slow drift, audible rotor
// position, and a blinking belly light telegraph the next drop; grenades
// fall ballistically so speed changes dodge them. Three pistol rounds each.
// ---------------------------------------------------------------------------

export class DroneSwarm {
  constructor(scene, track, n = 2) {
    this.scene = scene;
    this.track = track;
    this.list = [];
    this.nades = [];
    this.events = [];
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2e3236 });
    const armMat = new THREE.MeshLambertMaterial({ color: 0x1c1f22 });
    const rotorMat = new THREE.MeshLambertMaterial({
      color: 0x888c90, transparent: true, opacity: 0.55 });
    for (let i = 0; i < n; i++) {
      const grp = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.55), bodyMat);
      grp.add(body);
      const rotors = [];
      for (const [ax, az] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.07), armMat);
        arm.position.set(ax * 0.32, 0.04, az * 0.32);
        arm.rotation.y = Math.atan2(az, ax);
        grp.add(arm);
        const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.015, 10), rotorMat);
        rotor.position.set(ax * 0.44, 0.09, az * 0.44);
        grp.add(rotor);
        rotors.push(rotor);
      }
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5),
        new THREE.MeshBasicMaterial({ color: 0xff2820 }));
      eye.position.y = -0.11;
      grp.add(eye);
      scene.add(grp);
      this.list.push({
        mesh: grp, rotors, eye,
        s: 40 + i * 55, lateral: (i % 2 ? 2.5 : -2.5), alt: 12.5 + i * 1.5,
        hp: 3, maxHp: 3, dead: false,
        dropCd: 4 + Math.random() * 3, phase: Math.random() * 9,
      });
    }
    this.nadeGeo = new THREE.SphereGeometry(0.13, 7, 6);
    this.nadeMat = new THREE.MeshLambertMaterial({ color: 0x35452c });
  }

  reset() {
    for (let i = 0; i < this.list.length; i++) {
      const d = this.list[i];
      d.dead = false;
      d.hp = d.maxHp;
      d.mesh.visible = true;
      d.s = 40 + i * 55;
      d.dropCd = 4 + Math.random() * 3;
    }
    for (const nd of this.nades) this.scene.remove(nd.mesh);
    this.nades.length = 0;
    this.events.length = 0;
  }

  update(dt, riders, playerS, active, rateMul = 1) {
    const t = performance.now() / 1000;
    for (const d of this.list) {
      if (d.dead) continue;
      d.phase += dt;
      // shadow the pack: hold a slot ahead of the player, weave gently
      const wantS = playerS + 25 + this.list.indexOf(d) * 45;
      d.s += clamp(wantS - d.s, -14 * dt, 20 * dt);
      d.lateral = Math.sin(d.phase * 0.45) * 3.2;
      const sm = this.track.interpAt(d.s);
      const bob = Math.sin(d.phase * 1.7) * 0.4;
      d.mesh.position.set(
        sm.x + sm.nx * d.lateral,
        sm.y + d.alt + bob,
        sm.z + sm.nz * d.lateral);
      d.mesh.rotation.y = sm.angle;
      d.mesh.rotation.z = Math.sin(d.phase * 0.9) * 0.08;
      for (const r of d.rotors) r.rotation.y += dt * 40;
      // belly light blinks faster as the drop comes due
      d.eye.material.color.setHex(
        Math.sin(t * (d.dropCd < 1.2 ? 22 : 6)) > 0 ? 0xff2820 : 0x551008);

      d.dropCd -= dt * rateMul;
      if (d.dropCd <= 0 && active) {
        // only bomb when somebody is actually underneath-ish
        let below = false;
        for (const b of riders) {
          const dx = b.x - d.mesh.position.x, dz = b.z - d.mesh.position.z;
          if (dx * dx + dz * dz < 30 * 30) { below = true; break; }
        }
        d.dropCd = 3.6 + Math.random() * 2.6;
        if (below) {
          const mesh = new THREE.Mesh(this.nadeGeo, this.nadeMat);
          mesh.position.copy(d.mesh.position);
          mesh.position.y -= 0.3;
          this.scene.add(mesh);
          this.nades.push({
            mesh,
            pos: mesh.position,
            vel: new THREE.Vector3((Math.random() - 0.5) * 1.5, -1.5, (Math.random() - 0.5) * 1.5),
            hint: 0,
          });
          this.events.push({ type: 'drop', x: mesh.position.x, y: mesh.position.y, z: mesh.position.z });
        }
      }
    }

    // grenades: pure ballistics — a burst on the deck or against a bike
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const nd = this.nades[i];
      nd.vel.y -= 9.81 * dt;
      nd.pos.addScaledVector(nd.vel, dt);
      nd.mesh.rotation.x += dt * 7;
      let hit = false;
      for (const b of riders) {
        const dx = b.x - nd.pos.x, dy = (b.y + 0.8) - nd.pos.y, dz = b.z - nd.pos.z;
        if (dx * dx + dy * dy + dz * dz < 1.4 * 1.4) { hit = true; break; }
      }
      const q = this.track.nearest(nd.pos.x, nd.pos.z, nd.hint);
      nd.hint = q.index;
      if (hit || nd.pos.y <= q.sample.y + 0.25) {
        this.events.push({
          type: 'boom',
          x: nd.pos.x, y: Math.max(nd.pos.y, q.sample.y + 0.3), z: nd.pos.z,
        });
        this.scene.remove(nd.mesh);
        this.nades.splice(i, 1);
      }
    }
  }
}
