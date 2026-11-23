import * as THREE from 'three';
import { Track } from './track.js';
import { BikePhysics } from './physics.js';
import { AIRider } from './ai.js';
import { createBikeMesh, createBlobShadow, applyGearVisuals, markBounty } from './bikeMesh.js';
import { Input } from './input.js';
import { GameAudio } from './audio.js';
import { getBike, BIKES } from './bikes.js';
import { getTrack, reverseTrack } from './tracks.js';
import { getEquippedWeapon, WEAPONS, UNIQUES, weaponBase, loadArsenal, equipWeapon } from './weapons.js';
import { styledColors } from './style.js';
import { TankerFleet, GunshipSquad, LauncherBattery, DroneSwarm } from './vehicles.js';
import { PostFX, ExplosionFX, BlastStorm, GroundStamps, SkidMarks, softDotTexture, hardDotTexture,
  GroundDepth, makeSoft, SmokePlumes, EmberSwarmGPU, SparkGlints, StreakField } from './fx.js';
import { loadCareer, addPoints, applyUpgrades, racePayout } from './career.js';
import { loadSettings, MISSILE_MULT, AGGRO_MULT } from './settings.js';

const PHYS_DT = 1 / 120;
export const AI_NAMES = [
  'K. BLAZE', 'R. TORQUE', 'M. SLIDER', 'J. APEX', 'D. NITRO', 'T. VULTURE',
  'A. RAPTOR', 'S. COBRA', 'L. DUSTER', 'P. HAIRPIN', 'G. CHICANE', 'B. WOBBLE',
];
const AI_COUNT = 12;
// weapon frames the pack carries — visible furniture on their gun arms
const AI_GUNS = ['pistol', 'smg', 'scatter', 'rail', 'thumper'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const _fwd = new THREE.Vector3();
const _tail = new THREE.Vector3();
// leg-IK scratch vectors
const _ikF = new THREE.Vector3(), _ikF2 = new THREE.Vector3();
const _ikHip = new THREE.Vector3(), _ikD = new THREE.Vector3();
const _ikDir = new THREE.Vector3(), _ikPole = new THREE.Vector3();
const _ikKnee = new THREE.Vector3(), _ikTmp = new THREE.Vector3();
const _ikTmp2 = new THREE.Vector3(), _ikQi = new THREE.Quaternion();
const _DOWN = new THREE.Vector3(0, -1, 0);
// rider pose response rates (1/s): heavy mass shifts are slow, limbs quick
const POSE_RATES = {
  roll: 4.5, offX: 4.2, offY: 5.5, headRoll: 5,
  stand: 7, tuck: 4, legL: 8, legR: 8, kneeL: 6, kneeR: 6, legDown: 5,
};

export class Game {
  constructor(container, { bikeId, trackId, mode = 'race', rpgMods = null, reverse = false, banners = null, hunt = null, contract = null }) {
    this.container = container;
    this.mode = mode; // 'race' | 'knockout' | 'package'
    // career upgrades tune the player's machine, armour, pistol and focus
    this.career = loadCareer();
    const diff = loadSettings();
    this.missileMul = MISSILE_MULT[diff.missiles] ?? 1;
    this.aggroMul = AGGRO_MULT[diff.aggression] ?? 1;
    const up = this.career.upgrades;
    this.bikeDef = applyUpgrades(getBike(bikeId), up);
    if (this.rain) this.bikeDef = { ...this.bikeDef, grip: this.bikeDef.grip * 0.84 };
    // RPG perks stack multiplicatively on top of the career upgrades
    const pmod = rpgMods || { draft: 1, gunCd: 1, armour: 1, selfStun: 1, focus: 1, gunStun: 1 };
    // Tyrian layer: the equipped front weapon sets fire rate / pellets /
    // damage; career gun upgrades and perks still multiply on top
    this.weapon = getEquippedWeapon();
    this.gunCdMul = Math.pow(0.8, up.gun) * pmod.gunCd;
    this.gunCd = this.weapon.cd * this.gunCdMul;
    // Tyrian generator: shots draw from a charge pool that trickles back
    this.ammoMax = 35;
    this.ammo = this.ammoMax;
    this.ammoRegen = 3.15;
    this.dryT = 0;
    // Tyrian shield: armour soaks weapon hits until it's beaten flat, then
    // slowly rebuilds once nobody has hit you for a few seconds
    this.armorMax = 90 + 30 * up.armour;
    this.armor = this.armorMax;
    this.armorRegenDelay = 0;
    // life under the plate: hits past armour drain it; at zero the stage
    // is over for you
    this.hpMax = 100;
    this.hp = this.hpMax;
    this.playerDowned = false;
    this.gunStun = (1.8 + 0.25 * up.gun) * pmod.gunStun;
    this.armourScale = (1 - 0.18 * up.armour) * pmod.armour;
    this.immunTime = 5 + up.armour;
    this.focusMul = (1 + 0.3 * up.focus) * pmod.focus;
    this.draftMul = pmod.draft;
    this.selfStunMul = pmod.selfStun;
    this.trackDef = reverse ? reverseTrack(getTrack(trackId)) : getTrack(trackId);
    // weather roll: 1 in 5 stages runs in the rain — wet sheen on asphalt,
    // dimmed light, less grip for everyone, and a curtain of streaks
    this.rain = Math.random() < 0.2;
    if (this.rain) this.trackDef = { ...this.trackDef, wet: true };
    this.huntOpts = hunt; // assassination contract: { idx, name } or null
    this.contractOpts = contract; // counter/position objectives for the HUD
    // wasteland legs: the arches carry the place names you ride between
    if (banners) this.trackDef = { ...this.trackDef, banners };

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // far plane hugs the fog: everything past full fog saturation is culled,
    // so only a ~1 km bubble of the stage is ever processed
    this.camera = new THREE.PerspectiveCamera(
      64, container.clientWidth / container.clientHeight, 0.1,
      Math.max(750, this.trackDef.fogDist * 1.45));

    this.track = new Track(this.trackDef);
    this.track.build(this.scene);
    if (this.rain) {
      // storm light: greyer fog pulled closer, dimmer sun, leaden sky
      this.scene.fog.color.lerp(new THREE.Color(0x5c6570), 0.55);
      this.scene.fog.far *= 0.72;
      this.scene.traverse((o) => {
        if (o.isHemisphereLight) o.intensity *= 0.65;
        else if (o.isDirectionalLight) o.intensity *= 0.55;
      });
      if (this.track.skyDome) {
        this.track.skyDome.material.color.setHex(0x77808c);
      }
    }

    // post pass (heat haze, blast shockwave ripples, grade/vignette) and
    // pooled world-space explosion detail (shader fireballs + ground rings)
    this.fx = new PostFX(this.renderer, container.clientWidth, container.clientHeight,
      { night: !!this.trackDef.night });
    // half-res ground depth prepass: particles sample it to fade out where
    // they meet the road/terrain (soft particles) instead of slicing it
    this.gdepth = new GroundDepth(this.renderer, container.clientWidth, container.clientHeight);
    // 16k GPU-simulated ember motes swirling on curl noise, layered on blasts
    this.swarm = new EmberSwarmGPU(this.renderer, this.scene);
    this.boomFx = new ExplosionFX(this.scene, this.gdepth, this.camera);
    // the war-zone layer: ember storms, dirt fountains, shrapnel streaks,
    // and a heavy black smoke system for blasts and burning wrecks
    this.storm = new BlastStorm(this.scene);
    this.smoke = null; // created after DustParticles is in scope below
    // permanent charred scorch marks left on the ground by every blast
    this.stamps = new GroundStamps(this.scene);
    // rubber laid by hard braking and powerslides, kept for the whole race
    this.skids = new SkidMarks(this.scene);

    // player
    this.player = new BikePhysics(this.bikeDef, this.track);
    const pm = createBikeMesh(styledColors(this.bikeDef.colors), this.bikeDef.style || this.bikeDef.type, 7);
    this.playerPM = pm;
    // wear what you bought: weapon furniture, armour plate, engine hardware
    applyGearVisuals(pm, {
      weaponId: weaponBase(this.weapon.id), armourLvl: up.armour, engineLvl: up.engine });
    this.playerMesh = pm.group;
    this.playerWheels = pm.wheels;
    this.playerRider = pm.rider;
    this.playerTailOff = pm.tailOffset;
    this.scene.add(this.playerMesh);
    this.playerShadow = createBlobShadow();
    this.scene.add(this.playerShadow);

    // AI pack, paced off a simulated ideal lap: rank 0 runs ~2% off the
    // theoretical best (a real fight for the win), the tail ~21% off (fair
    // game on lap one). Track-favoured machinery fills the front ranks so
    // the surface modifiers can't scramble the intended spread.
    this.ais = [];
    this.aiMeshes = [];
    this.aiMatLists = [];
    this.aiColors = [];
    const cal = this.calibrateSkills();
    const favored = this.trackDef.bikeMods.sport.topSpeed >= this.trackDef.bikeMods.cross.topSpeed
      ? 'sport' : 'cross';
    for (let i = 0; i < AI_COUNT; i++) {
      // The pack rides the right tool for the surface. The mixed grid only
      // worked while the AI ignored aero drag — with an honest envelope a
      // motocrosser is ~20% off the pace on asphalt (and a superbike is
      // hopeless in the dunes), so an off-type rider is not a rival, just a
      // rolling roadblock. Variety now comes from paint, plate and gear.
      const type = favored;
      let bike = BIKES.find((b) => b.type === type);
      if (this.rain) bike = { ...bike, grip: bike.grip * 0.86 };
      const c = cal[type];
      // Target lap for this rank, inverted through T(s) = A + B/s. Anchored
      // to THIS BIKE's ideal, not the field's: now that the AI pay aero drag,
      // a motocrosser genuinely cannot run a superbike's pace on asphalt, and
      // asking it to only pinned it against the skill clamp. Pacing each
      // rider against their own machine keeps the ladder feasible — and lets
      // the wrong bike for the surface lose honestly, on merit.
      const target = c.ideal * (1.018 + (i / (AI_COUNT - 1)) * 0.19);
      const skill = clamp(c.B / Math.max(1, target - c.A), 0.68, 0.995);
      const slot = this.gridSlot(i);
      const ai = new AIRider(this.track, bike, { skill, startS: slot.s, startLat: slot.lat * 0.4 });
      ai.name = AI_NAMES[i];
      ai.lateral = slot.lat;
      this.ais.push(ai);

      const hue = (i * 0.31) % 1;
      const body = new THREE.Color().setHSL(hue, 0.72, 0.42);
      const accent = new THREE.Color().setHSL((hue + 0.5) % 1, 0.35, i % 2 ? 0.82 : 0.22);
      const colors = {
        body: body.getHex(), accent: accent.getHex(), rider: 0x222228,
        helmet: i % 3 === 0 ? 0xeeeeee : body.getHex(),
      };
      this.aiColors.push('#' + body.getHexString());
      const mesh = createBikeMesh(colors, bike.style || bike.type, i + 2);
      // dress the pack: the grid is ranked, so the front of it rides in
      // heavier plate and better hardware. The silhouette is honest — the
      // armour you can see is the armour you have to chew through.
      const tier = i < 2 ? 3 : i < 5 ? 2 : i < 9 ? 1 : 0;
      ai.armorMax = 70 + 30 * tier; // 70 at the tail, 160 for the leaders
      ai.armor = ai.armorMax;
      ai.gearTier = tier;
      // each rider carries a visible frame, spread deterministically
      ai.gunId = AI_GUNS[(i * 3 + 1) % AI_GUNS.length];
      applyGearVisuals(mesh, {
        weaponId: ai.gunId,
        armourLvl: tier,
        engineLvl: i < 3 ? 3 : i < 7 ? 2 : i < 10 ? 1 : 0,
        rank: tier, // amber chevrons: count them, that's their plate
      });
      if (this.huntOpts && this.huntOpts.idx === i) markBounty(mesh);
      this.aiMeshes.push(mesh);
      this.scene.add(mesh.group);
      const mats = [];
      mesh.group.traverse((o) => {
        const m = o.material;
        if (m && m.emissive && !mats.includes(m)) mats.push(m);
      });
      this.aiMatLists.push(mats);
      const p = ai.pose();
      mesh.group.position.set(p.x, p.y, p.z);
      mesh.group.rotation.y = p.heading;
    }

    this.dust = new DustParticles(this.scene, this.trackDef.surface === 'dirt' ? 0xc9a86a : 0x9a9a9a,
      { map: hardDotTexture() });
    makeSoft(this.dust.mat, this.gdepth, this.camera, 0.9);
    // blast smoke: lit, noise-eroded billows (see SmokePlumes in fx.js)
    const nightSmoke = !!this.trackDef.night;
    this.smoke = new SmokePlumes(this.scene, this.gdepth, this.camera, {
      size: 3.2, opacity: 0.52, count: 460, burstLife: 1.9, gravity: -1.1,
      dark: 0x0c0b0a, lit: nightSmoke ? 0x2a2c36 : 0x8d8478,
      dustLit: nightSmoke ? 0x33343c : 0x9c8c72,
      dustDark: nightSmoke ? 0x16171c : 0x4b4238,
      sunDir: new THREE.Vector3(-200, 108, 150).normalize(),
    });
    // active blast plumes: each keeps feeding the convection column for a
    // second or two so the cloud PUNCHES upward instead of one static puff
    this.plumes = [];

    // hazards: fuel tankers that go up after three hits, and attack
    // helicopters that hunt the pack from the air (twelve hits to down one)
    this.tankers = new TankerFleet(this.scene, this.track, 3);
    this.gunships = new GunshipSquad(this.scene, this.track, 2);
    // static roadside rocket emplacements: slow lead-aimed rockets you dodge
    // by turning; two pistol hits kill one for the rest of the stage
    this.launchers = new LauncherBattery(this.scene, this.track);
    // bomb drones shadowing the pack from above
    this.drones = new DroneSwarm(this.scene, this.track, 2);

    // Tyrian ground targets: explosive barrels along the shoulders — shoot
    // them (or clip one) and they go up, chaining to their neighbours
    this.barrels = [];
    this.barrelChain = [];
    {
      let bseed = 11;
      for (const ch of this.trackDef.id) bseed = (bseed * 31 + ch.charCodeAt(0)) >>> 0;
      const brng = () => {
        bseed = (bseed * 1664525 + 1013904223) >>> 0;
        return bseed / 4294967296;
      };
      const barrelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.95, 10);
      const sideMat = new THREE.MeshLambertMaterial({ color: 0xa32c1a });
      const capMat = new THREE.MeshLambertMaterial({ color: 0x2a2018 });
      const n = Math.round(this.track.length / 240);
      for (let k = 0; k < n * 3 && this.barrels.length < n; k++) {
        const s0 = brng() * this.track.length;
        if (this.track.isOnBridge(s0) || this.track.isInTunnel(s0)
          || this.track.isInVillage(s0)) continue;
        const sm = this.track.interpAt(s0);
        const side = brng() > 0.5 ? 1 : -1;
        const dd = this.track.halfWidth + 0.9 + brng() * 4.5;
        const mesh = new THREE.Mesh(barrelGeo, [sideMat, capMat, capMat]);
        const x = sm.x + sm.nx * dd * side, z = sm.z + sm.nz * dd * side;
        mesh.position.set(x, sm.y + 0.48, z);
        mesh.rotation.y = brng() * Math.PI;
        this.scene.add(mesh);
        this.barrels.push({ mesh, x, y: sm.y, z, alive: true });
      }
    }

    // CAPTURE THE PACKAGE: a glowing crate 500 m up the road. First touch
    // grabs it; any stun/crash drops it; deliver it to the finish to win.
    if (this.mode === 'package') {
      const grp = new THREE.Group();
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.7, 0.7),
        new THREE.MeshPhongMaterial({ color: 0xffb020, emissive: 0x804400, shininess: 60 }));
      crate.rotation.y = 0.6;
      grp.add(crate);
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(0.74, 0.16, 0.74),
        new THREE.MeshBasicMaterial({ color: 0xfff0a0 }));
      grp.add(band);
      // sky beam so the package reads from hundreds of metres out
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.9, 60, 8, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xffcc44, transparent: true, opacity: 0.16,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }));
      beam.position.y = 30;
      grp.add(beam);
      this.pkgMesh = grp;
      this.pkgBeam = beam;
      this.scene.add(grp);
    }

    // taillight streaks — long and bright at night, subtle by day
    const nightTrack = !!this.trackDef.night;
    this.trailLife = nightTrack ? 0.85 : 0.4;
    this.trailBoost = nightTrack ? 1.5 : 0.75;
    this.trailClock = 0;
    this.playerTrail = new LightTrail(this.scene, 0xff2a1a, this.trailLife);
    this.aiTrails = this.ais.map(() => new LightTrail(this.scene, 0xff2418, this.trailLife));
    // impact sparks: white-hot velocity-stretched glints (fx.SparkGlints)
    this.sparks = new SparkGlints(this.scene, 560);

    if (this.rain) {
      // the rain itself: a recycled box of streaks riding along with the
      // camera — each drop is a thin StreakField sliver falling at 26 m/s
      this.rainField = new StreakField(this.scene, 650, { additive: false, opacity: 0.38 });
      this.rainDrops = new Float32Array(650 * 3);
      for (let i = 0; i < 650; i++) {
        this.rainDrops[i * 3] = (Math.random() - 0.5) * 70;
        this.rainDrops[i * 3 + 1] = Math.random() * 26;
        this.rainDrops[i * 3 + 2] = (Math.random() - 0.5) * 70;
      }
      this.rainFlashPending = true;
    }

    // gunfire effects: muzzle flash + impact flash spheres
    const flashMat = () => new THREE.MeshBasicMaterial({
      color: 0xffeeaa, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.muzzleFlash = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 5), flashMat());
    this.impactFlash = new THREE.Mesh(new THREE.SphereGeometry(0.4, 6, 5), flashMat());
    this.muzzleFlash.visible = this.impactFlash.visible = false;
    this.scene.add(this.muzzleFlash, this.impactFlash);
    this.muzzleT = 0;
    this.impactT = 0;
    this.shake = 0;

    // hit-flash timers (material lists are collected in the AI build loop)
    this.aiFlash = this.ais.map(() => 0);
    // AI combat state: everyone is armed and wants to win
    this.combat = this.ais.map((_, i) => ({
      cd: 6 + i * 0.8 + Math.random() * 3, aimT: 0, hideT: 0, target: null,
    }));
    this.playerImmunT = 0;

    this.input = new Input();
    this.input.attach();
    this.input.mouse.x = container.clientWidth / 2;
    this.input.mouse.y = container.clientHeight / 2;
    this.gunOut = false;
    this.shootCd = 0;
    this.tracers = [];
    this.drawT = 0;   // arm-reach animation / not-ready-yet window
    this.btMeter = 1; // bullet-time resource
    this.btActive = false;
    this.input.onRightClick = () => {
      if (this.paused || this.hud.finished) return;
      this.gunOut = !this.gunOut;
      if (this.gunOut) this.drawT = 0.35; // reaching for the holster
      this.audio.ensure();
      this.audio.beep(this.gunOut ? 700 : 500, 0.06);
    };
    this.input.onLeftClick = () => this.tryShoot();
    this.audio = new GameAudio(this.bikeDef.style || this.bikeDef.type);
    this._gesture = () => this.audio.ensure();
    window.addEventListener('keydown', this._gesture);
    window.addEventListener('pointerdown', this._gesture);
    this._keydown = (e) => {
      if (e.key === 'm' || e.key === 'M') this.audio.muted = !this.audio.muted;
      // 1-5 swap between owned guns mid-ride (Tyrian style). Each key cycles
      // its frame: relics first (some frames carry two), factory gun last.
      const wi = parseInt(e.key, 10);
      if (wi >= 1 && wi <= 5) {
        const baseId = Object.keys(WEAPONS)[wi - 1];
        const a = loadArsenal();
        const candidates = [
          ...Object.keys(UNIQUES).filter((u) => UNIQUES[u].base === baseId && a.owned[u]),
          ...(a.owned[baseId] ? [baseId] : []),
        ];
        const id = candidates.length
          ? candidates[(candidates.indexOf(this.weapon.id) + 1) % candidates.length]
          : null;
        if (id) {
          equipWeapon(id);
          this.weapon = getEquippedWeapon();
          this.gunCd = this.weapon.cd * this.gunCdMul;
          this.hud.weaponName = this.weapon.unique
            ? this.weapon.name : `${this.weapon.name} MK${this.weapon.lvl}`;
          applyGearVisuals(this.playerPM, {
            weaponId: weaponBase(this.weapon.id),
            armourLvl: this.career.upgrades.armour,
            engineLvl: this.career.upgrades.engine,
          });
          this.hud.message = this.hud.weaponName;
          this.hud.messageT = 1.2;
          this.audio.beep(760, 0.05);
        }
      }
    };
    window.addEventListener('keydown', this._keydown);

    this._resize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.fx.resize(w, h);
      this.gdepth.resize(w, h);
    };
    window.addEventListener('resize', this._resize);

    this.paused = false;
    this.hud = {
      mode: 'countdown', countdown: 3, speedKmh: 0, gear: 1, rpm: 0,
      distKm: 0, remainKm: 0, totalKm: this.track.finishS / 1000,
      position: 1, racers: this.ais.length + 1,
      time: 0, lastLap: null, bestLap: null,
      message: '', messageT: 0, finished: false, results: null,
      lapTimes: [], airborne: false, wheelie: 0,
      gunOut: false, hitT: 0, mouseX: 0, mouseY: 0,
      weaponName: this.weapon.unique
        ? this.weapon.name : `${this.weapon.name} MK${this.weapon.lvl}`,
      mini: { player: [0, 0], ais: this.ais.map(() => [0, 0]) },
      aiColors: this.aiColors,
    };
    // minimap path, normalized to a 100x100 box (computed once for React)
    this.miniPath = this.computeMiniPath();

    this.initRace();

    this._acc = 0;
    this._last = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // Offline stage simulation: run the AI corner-speed model at full
  // commitment (no rubber band) to find the ideal A->B time per bike type,
  // plus a second point at lower skill so time inverts as T(s) = A + B/s.
  calibrateSkills() {
    const simLap = (bike, skill) => {
      const a = new AIRider(this.track, bike, { skill, startS: 0 });
      a.progress = 0;
      a.speed = 15;
      const dt = 1 / 60;
      let t = 0;
      while (a.progress < this.track.finishS && t < 600) {
        a.step(dt, a.progress, 0); // leader = itself: rubber band neutral
        t += dt;
      }
      return t;
    };
    const cal = {};
    for (const bike of BIKES) {
      if (cal[bike.type]) continue;
      const t1 = simLap(bike, 1.0);
      const t2 = simLap(bike, 0.85);
      const B = (t2 - t1) / (1 / 0.85 - 1);
      cal[bike.type] = { A: t1 - B, B, ideal: t1 };
    }
    this.idealLap = Math.min(...Object.values(cal).map((c) => c.ideal));
    return cal;
  }

  // 13-bike grid at the start of the stage, two per row; slot 0 is pole
  // (front row, just behind the start line at s=88), slot 12 (the player)
  // sits at the very back
  gridSlot(i) {
    return {
      s: 24 + (6 - Math.floor(i / 2)) * 8,
      lat: i === AI_COUNT ? 0 : i % 2 === 0 ? -2.8 : 2.8,
    };
  }

  initRace() {
    const pSlot = this.gridSlot(AI_COUNT); // back of the grid
    this.player.placeAt(pSlot.s, pSlot.lat);
    this.playerProgress = pSlot.s;
    this.prevS = this.player.info.s;
    this.raceT = -3.7; // countdown
    this.lastBeep = 4;
    this._lastGear = 1;
    this.gunOut = false;
    this.shootCd = 0;
    this.hud.hitT = 0;
    this.shake = 0;
    this.playerImmunT = 0;
    this.drawT = 0;
    this.btMeter = 1;
    this.btActive = false;
    this.statHits = 0;
    this.statBarrels = 0;
    this.ammo = this.ammoMax;
    this.armor = this.armorMax;
    this.armorRegenDelay = 0;
    this.hp = this.hpMax;
    this.hud.hunt = this.huntOpts
      ? { ...this.huntOpts, down: false, failed: false } : null;
    // live objective readout for counter contracts (towers, birds, escort)
    const c = this.contractOpts;
    this.hud.objective = null;
    if (c) {
      if (c.type === 'launchers') {
        this.hud.objective = { kind: 'launchers', need: c.n, have: 0, label: 'DESTROY LAUNCHERS' };
      } else if (c.type === 'gunships') {
        this.hud.objective = { kind: 'gunships', need: c.n, have: 0, label: 'DOWN GUNSHIPS' };
      } else if (c.type === 'milkrun') {
        this.hud.objective = { kind: 'milkrun', need: c.pos, have: 99, label: `FINISH TOP ${c.pos}` };
      } else if (c.type === 'delivery' && c.needHits) {
        // relic deliveries want the crate first AND blood on the road
        this.hud.objective = { kind: 'hits', need: c.needHits, have: 0, label: 'LAND RIDER HITS' };
      }
    }
    this.playerDowned = false;
    this.statKills = 0;
    this.statIntercepts = 0;
    this.statDrones = 0;
    if (this.drones) this.drones.reset();
    for (const ai of this.ais || []) {
      ai.armor = ai.armorMax;
      ai.hp = ai.hpMax;
      ai.armorRegenDelay = 0;
      // nobody restarts still on fire / iced over from the previous race
      ai.burnT = 0;
      ai.burnDps = 0;
      ai.shockLock = 0;
      ai.slowT = 0;
    }
    if (this.barrels) {
      this.barrelChain.length = 0;
      for (const b of this.barrels) { b.alive = true; b.mesh.visible = true; }
    }
    this.statBikeHits = 0;
    this.statTankers = 0;
    this.statGunships = 0;
    this.statLaunchers = 0;
    this.hud.earned = null;
    this.hud.gunshipInfo = null;
    this.hud.launcherInfo = null;
    if (this.gunships) this.gunships.resetAll();
    if (this.launchers) this.launchers.resetAll();
    if (this.stamps) this.stamps.reset(); // wipe last race's scorch marks
    if (this.skids) this.skids.reset();
    if (this.mode === 'package') {
      this.pkg = { holder: null, s: 500, lateral: 0 }; // holder: 'player' | ai index
      this.hud.package = { carrier: null, distM: 500 };
      const sm = this.track.interpAt(500);
      this.pkgMesh.position.set(sm.x, sm.y + 1.0, sm.z);
      this.pkgMesh.visible = true;
    }
    // knockout: last place eliminated every 15 s (first cut 20 s after GO)
    this.elimT = 20;
    this.elimOrder = [];
    for (const ai of this.ais || []) ai.eliminated = false;
    this.hud.knockout = this.mode === 'knockout'
      ? { nextIn: 20, remaining: (this.ais ? this.ais.length : AI_COUNT) + 1 }
      : null;
    if (this.tankers) this.tankers.resetAll();
    if (this.playerTrail) {
      this.playerTrail.clear();
      for (const tr of this.aiTrails) tr.clear();
    }
    for (const ai of this.ais || []) { ai.stunTimer = 0; ai.aiming = false; }
    if (this.combat) {
      for (let i = 0; i < this.combat.length; i++) {
        this.combat[i] = { cd: 6 + i * 0.8 + Math.random() * 3, aimT: 0, hideT: 0, target: null };
        const rider = this.aiMeshes[i].rider;
        rider.gunArm.visible = false;
        rider.armR.visible = true;
      }
    }
    if (this.aiMatLists) {
      this.aiFlash = this.aiFlash.map(() => 0);
      for (const mats of this.aiMatLists) for (const m of mats) m.emissive.setRGB(0, 0, 0);
    }
    this.prevReset = false;
    this.hud.finished = false;
    this.hud.results = null;
    this.hud.lapTimes = [];
    this.hud.lastLap = null;
    this.hud.bestLap = null;
    this.hud.mode = 'countdown';
    this.hud.message = '';
    for (let i = 0; i < this.ais.length; i++) {
      const ai = this.ais[i];
      const slot = this.gridSlot(i);
      ai.s = slot.s;
      ai.progress = ai.s;
      ai.speed = 0;
      ai.airborne = false;
      ai.prevGy = null;
      ai.vy = 0;
      ai.lateral = slot.lat;
      ai.finishTime = null;
    }
    this.snapCamera();
  }

  restart() {
    this.initRace();
    this.paused = false;
  }

  frame() {
    const now = performance.now();
    let dt = Math.min((now - this._last) / 1000, 0.05);
    this._last = now;
    if (this.paused) {
      this.audio.setEngine(0, 0, 1, 0);
      this.audio.setSlide(0);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const rawInput = this.input.update(dt);
    rawInput.oneHanded = this.gunOut; // pistol drawn = one hand on the bars
    this.shootCd = Math.max(0, this.shootCd - dt);
    this.drawT = Math.max(0, this.drawT - dt);
    const racing = this.raceT >= 0 && !this.hud.finished;

    // bullet time: hold SHIFT with the pistol out — the world slows and the
    // camera swings round so you can shoot at whoever's chasing you
    const btWant = racing && this.gunOut &&
      (this.input.has('Shift') || this.input.touch.focus) &&
      this.btMeter > 0.02 && !this.player.crashed;
    this.btActive = btWant;
    if (btWant) this.btMeter = Math.max(0, this.btMeter - dt / (2.5 * this.focusMul));
    else this.btMeter = Math.min(1, this.btMeter + (dt / 9) * this.focusMul);
    const simDt = dt * (this.btActive ? 0.35 : 1);
    this.trailClock += simDt;
    // pre-race: no inputs at all; post-race: gentle brake (< 0.5 so the
    // reverse-crawl logic never kicks in)
    const inp = racing
      ? rawInput
      : { throttle: 0, brake: this.hud.finished ? 0.45 : 0, steer: 0, rear: false, reset: false };

    // reset key (edge-triggered)
    if (rawInput.reset && !this.prevReset && racing) this.player.respawn();
    this.prevReset = rawInput.reset;

    // slipstream: tucked in close behind a bike ahead (same lane-ish),
    // strength rises as the gap closes — feeds physics, audio and HUD
    let draft = 0;
    if (racing && !this.player.crashed) {
      const pS = this.player.info.s, pLat = this.player.info.lateral;
      for (const ai of this.ais) {
        if (ai.eliminated) continue;
        const ds = ai.s - pS;
        if (ds > 2 && ds < 16 && Math.abs(ai.lateral - pLat) < 1.5) {
          draft = Math.max(draft, 1 - (ds - 2) / 14);
        }
      }
    }
    draft = Math.min(1, draft * this.draftMul);
    this.player.draft = draft;
    this.hud.draft = draft;

    this._acc += simDt;
    let steps = 0;
    while (this._acc >= PHYS_DT && steps < 10) {
      this.raceT += PHYS_DT;
      this.player.step(inp, PHYS_DT);
      if (this.raceT >= 0) {
        const leader = Math.max(this.playerProgress,
          ...this.ais.filter((a) => !a.eliminated).map((a) => a.progress));
        for (const ai of this.ais) {
          if (ai.eliminated) this.pullOver(ai);
          else ai.step(PHYS_DT, leader, this.raceT);
        }
      }
      this.trackProgress();
      this._acc -= PHYS_DT;
      steps++;
    }

    // incendiary victims trail embers while the burn ticks
    for (const ai of this.ais) {
      if (ai.eliminated || !(ai.burnT > 0)) continue;
      if (Math.random() < simDt * 9) {
        const p = ai.pose();
        this.sparks.burst(new THREE.Vector3(p.x, p.y + 0.7, p.z), 4, 3.5);
      }
    }

    // knockout clock
    if (racing && this.mode === 'knockout' && this.raceT > 0) {
      this.elimT -= simDt;
      if (this.elimT <= 0 && !this.hud.finished) {
        this.doElimination();
        this.elimT = 15;
      }
    }

    // barrel chain fuses + riding into one
    for (let i = this.barrelChain.length - 1; i >= 0; i--) {
      const q = this.barrelChain[i];
      q.t -= simDt;
      if (q.t <= 0) { this.barrelChain.splice(i, 1); this.explodeBarrel(q.b); }
    }
    if (racing && !this.player.crashed) {
      for (const b of this.barrels) {
        if (b.alive && Math.abs(this.player.x - b.x) < 1.4
          && Math.abs(this.player.z - b.z) < 1.4) {
          this.explodeBarrel(b);
          if (this.armor >= 1) {
            this.damagePlayer(45, 1.4);
            this.player.speed *= 0.5;
          } else {
            this.player.crash();
          }
          break;
        }
      }
    }
    if (this.input.fireHeld && this.gunOut) this.tryShoot();
    // generator + shield regeneration
    this.ammo = Math.min(this.ammoMax, this.ammo + this.ammoRegen * simDt);
    this.dryT = Math.max(0, this.dryT - dt);
    if (this.armorRegenDelay > 0) this.armorRegenDelay -= simDt;
    else this.armor = Math.min(this.armorMax, this.armor + 3 * simDt);
    this.hud.ammo = this.ammo;
    this.hud.ammoMax = this.ammoMax;
    // reticle readiness ring: how close the NEXT shot is, and which gate
    // is holding it (generator charge vs weapon cycle)
    {
      const ammoFrac = Math.min(1, this.ammo / this.weapon.cost);
      const cdFrac = this.gunCd > 0 ? 1 - Math.max(0, this.shootCd) / this.gunCd : 1;
      this.hud.shotFrac = Math.min(ammoFrac, cdFrac);
      this.hud.chargeGated = ammoFrac < 1 && ammoFrac <= cdFrac;
    }
    this.hud.armor = this.armor;
    this.hud.armorMax = this.armorMax;
    this.hud.hp = this.hp;
    this.hud.hpMax = this.hpMax;
    {
      const h = this.hud.hunt;
      if (h && !h.down && !h.failed && this.ais[h.idx]?.finishTime != null) {
        h.failed = true;
        this.flash('CONTRACT FAILED — TARGET FINISHED');
        this.audio.beep(180, 0.4);
      }
      const o = this.hud.objective;
      if (o) {
        const wasDone = o.done;
        if (o.kind === 'launchers') o.have = this.statLaunchers;
        else if (o.kind === 'gunships') o.have = this.statGunships;
        else if (o.kind === 'hits') o.have = this.statHits;
        else if (o.kind === 'milkrun') o.have = this.hud.position;
        o.done = o.kind === 'milkrun' ? o.have <= o.need : o.have >= o.need;
        if (o.done && !wasDone && o.kind !== 'milkrun') {
          // 'hits' is only half a relic delivery — the win still has to land
          this.flash(o.kind === 'hits' ? 'BLOOD PAID — NOW WIN THE RUN' : 'CONTRACT FILLED');
          this.audio.beep(980, 0.3);
        }
      }
      // the mark rides with a price over their head: a bobbing red pin,
      // visible through the pack, plus a live gap readout for the banner
      if (h) {
        const t = this.ais[h.idx];
        if (!h.down && !h.failed && t && !t.eliminated) {
          this.ensureHuntMarker();
          const p = t.pose();
          this.huntMarker.visible = true;
          this.huntMarker.position.set(
            p.x, p.y + 2.5 + Math.sin(this.raceT * 3) * 0.18, p.z);
          h.dist = Math.round(t.s - this.player.info.s);
          // grow with distance so the mark stays readable across the field
          const mScale = Math.min(4.5, 1.3 + Math.abs(h.dist) * 0.012);
          this.huntMarker.scale.set(mScale, mScale, 1);
        } else if (this.huntMarker) {
          this.huntMarker.visible = false;
        }
      }
    }
    // crosshair intel: who am I pointing at, and what's left of them
    this.hud.targetInfo = null;
    if (this.gunOut) {
      const { origin, dir } = this.aimRay();
      let bt = 220, tgt = null;
      const tv = new THREE.Vector3();
      for (const ai of this.ais) {
        if (ai.eliminated) continue;
        const p = ai.pose();
        tv.set(p.x - origin.x, p.y + 0.8 - origin.y, p.z - origin.z);
        const t = tv.dot(dir);
        if (t < 3 || t > bt) continue;
        const closest = Math.sqrt(Math.max(0, tv.lengthSq() - t * t));
        if (closest < 1.8) { bt = t; tgt = ai; }
      }
      if (tgt) {
        this.hud.targetInfo = {
          name: tgt.name || 'RIDER',
          armor: tgt.armor, armorMax: tgt.armorMax,
          hp: tgt.hp, hpMax: tgt.hpMax,
        };
      }
    }
    this.updateTankers(simDt, racing);
    if (this.mode === 'package') this.updatePackage(simDt, racing);
    this.pushApart(simDt);
    this.updateVisuals(simDt);
    if (racing && this.raceT > 2) this.updateCombat(simDt);
    if (this.track.skyDome) this.track.skyDome.position.copy(this.camera.position);
    this.updateHud(dt);
    this.updateAudio();
    this.boomFx.update(simDt);
    this.storm.update(simDt); // bullet time slows the ember storm too
    if (this.rainField) {
      if (this.rainFlashPending && racing) {
        this.rainFlashPending = false;
        this.flash('RAIN — SLICK ROAD');
      }
      const cx = this.camera.position.x, cy = this.camera.position.y,
        cz = this.camera.position.z;
      const wind = 3.5;
      for (let i = 0; i < 650; i++) {
        let dy = this.rainDrops[i * 3 + 1] - 26 * dt;
        let dx = this.rainDrops[i * 3] + wind * dt;
        if (dy < -6) { dy += 30; dx = (Math.random() - 0.5) * 70; }
        if (dx > 35) dx -= 70;
        this.rainDrops[i * 3] = dx;
        this.rainDrops[i * 3 + 1] = dy;
        const dz = this.rainDrops[i * 3 + 2];
        const x = cx + dx, y = cy + dy, z = cz + dz;
        this.rainField.set(i, x - 0.14, y + 1.3, z, x, y, z, 0.62, 0.68, 0.76, 0.02);
      }
      this.rainField.commit();
    }
    this.swarm.update(simDt);
    this.updatePlumes(simDt);
    this.smoke.update(simDt, this.camera);
    this.gdepth.render(this.scene, this.camera); // fresh ground depth for soft particles
    this.fx.render(this.scene, this.camera, dt);
  }

  // every explosion goes through here: fireball + ground shockwave ring in
  // the world, a radial distortion ripple on the screen, and the particle
  // storm — embers, dirt fountain, shrapnel streaks, black smoke column
  boom(p, scale = 1) {
    this.boomFx.spawn(p, scale);
    this.fx.rippleAt(p, this.camera, Math.min(1.4, scale));
    this.storm.blast(p, scale);
    this.swarm.blast(p, scale);
    // burn a permanent scorch into the ground beneath the blast
    const q = this.track.nearest(p.x, p.z, this.player.info.hint);
    const groundY = q.sample ? q.sample.y : p.y - 1;
    this.stamps.stamp(p.x, groundY, p.z, (2.4 + scale * 2.6) * (0.85 + Math.random() * 0.3));
    this.smoke.burst(p, Math.round(20 * scale), 4.5);
    // layered aftermath: dusty pancake rolling out at the base, and a
    // convection column that keeps punching smoke upward for ~1.5 s
    this.smoke.haze({ x: p.x, y: groundY + 0.2, z: p.z }, Math.round(9 * scale), scale);
    // the lifting blob: one rolling mass rising off the fireball, movies-style
    this.smoke.blob({ x: p.x, y: groundY + 1.0 + 0.6 * scale, z: p.z },
      Math.round(16 + 9 * scale), scale);
    // plus a short-lived stem dragged up underneath it
    this.plumes.push({
      x: p.x, y: groundY + 0.3, z: p.z, scale,
      t: 0, dur: 0.5 + 0.15 * scale, acc: 2,
    });
  }

  // feed the active blast columns a few puffs per frame while they last
  updatePlumes(dt) {
    for (let i = this.plumes.length - 1; i >= 0; i--) {
      const pl = this.plumes[i];
      pl.t += dt;
      if (pl.t >= pl.dur) { this.plumes.splice(i, 1); continue; }
      pl.acc += dt * (9 + 5 * pl.scale);
      const n = Math.floor(pl.acc);
      if (n > 0) {
        pl.acc -= n;
        this.smoke.column(pl, n, pl.scale);
      }
    }
  }

  // capture-the-package: free crate waits (and bobs); first touch grabs it;
  // a stun or crash makes the carrier drop it on the spot; carrying it
  // across the finish wins the race outright
  updatePackage(dt, racing) {
    const pkg = this.pkg;
    if (!pkg || this.hud.finished) return;
    this.pkgClock = (this.pkgClock || 0) + dt;
    const carrierPose = () => pkg.holder === 'player'
      ? { x: this.player.x, y: this.player.y, z: this.player.z, s: this.player.info.s }
      : (() => { const a = this.ais[pkg.holder]; const p = a.pose(); return { x: p.x, y: p.y, z: p.z, s: a.s }; })();

    if (pkg.holder === null) {
      // idle crate: bob, spin, beam pulsing
      const sm = this.track.interpAt(pkg.s);
      const x = sm.x + sm.nx * pkg.lateral, z = sm.z + sm.nz * pkg.lateral;
      this.pkgMesh.position.set(x, sm.y + 1.0 + Math.sin(this.pkgClock * 2.2) * 0.25, z);
      this.pkgMesh.rotation.y += dt * 1.2;
      this.pkgBeam.material.opacity = 0.12 + 0.07 * Math.sin(this.pkgClock * 3);
      if (!racing) return;
      // pickups: player first (ties go to the human), then AIs
      const P = this.player;
      if (!P.crashed && P.stunTimer <= 0 &&
          Math.hypot(P.x - x, P.z - z) < 2.6) {
        pkg.holder = 'player';
        this.flash('PACKAGE SECURED — DELIVER IT!');
        this.audio.beep(980, 0.2);
      } else {
        for (let i = 0; i < this.ais.length; i++) {
          const a = this.ais[i];
          if (a.eliminated || a.stunTimer > 0) continue;
          const pp = a.pose();
          if (Math.hypot(pp.x - x, pp.z - z) < 2.6) {
            pkg.holder = i;
            this.flash(`${AI_NAMES[i]} HAS THE PACKAGE!`);
            this.audio.beep(620, 0.15);
            break;
          }
        }
      }
    } else {
      // carried: ride on the carrier's tail; beam follows dimly
      const cp = carrierPose();
      this.pkgMesh.position.set(cp.x, cp.y + 1.55, cp.z);
      this.pkgMesh.rotation.y += dt * 3;
      this.pkgBeam.material.opacity = 0.07;
      // a stunned (or downed) carrier KEEPS the package — but it's loose in
      // their hands: any rider close enough can snatch it away
      const vulnerable = pkg.holder === 'player'
        ? (this.player.crashed || this.player.stunTimer > 0)
        : (this.ais[pkg.holder].stunTimer > 0);
      if (vulnerable) {
        const SNATCH = 3.2;
        let thief = null;
        if (pkg.holder !== 'player' && !this.player.crashed && this.player.stunTimer <= 0 &&
            Math.hypot(this.player.x - cp.x, this.player.z - cp.z) < SNATCH) {
          thief = 'player';
        } else {
          for (let i = 0; i < this.ais.length; i++) {
            if (i === pkg.holder) continue;
            const a = this.ais[i];
            if (a.eliminated || a.stunTimer > 0) continue;
            const pp = a.pose();
            if (Math.hypot(pp.x - cp.x, pp.z - cp.z) < SNATCH) { thief = i; break; }
          }
        }
        if (thief !== null) {
          pkg.holder = thief;
          if (thief === 'player') {
            this.flash('PACKAGE SNATCHED — DELIVER IT!');
            this.audio.beep(980, 0.2);
          } else {
            this.flash(`${AI_NAMES[thief]} SNATCHED THE PACKAGE!`);
            this.audio.beep(420, 0.2);
          }
        }
      }
      const dp = carrierPose(); // fresh — the holder may have just changed
      if (dp.s >= this.track.finishS) {
        // delivered!
        if (pkg.holder === 'player') this.finishRace();
        else this.packageOver(pkg.holder);
        return;
      }
    }
    // HUD: who has it / how far ahead it lies
    const carrier = pkg.holder === null ? null
      : pkg.holder === 'player' ? 'YOU' : AI_NAMES[pkg.holder];
    const refS = pkg.holder === null ? pkg.s : carrierPose().s;
    this.hud.package = {
      carrier,
      distM: Math.max(0, Math.round(refS - this.player.info.s)),
    };
  }

  // an AI delivered the package: they win, everyone else ranks by progress
  packageOver(winnerIdx) {
    if (this.hud.finished) return;
    this.hud.finished = true;
    this.hud.mode = 'finished';
    const others = this.ais
      .map((a, i) => ({ name: AI_NAMES[i], isPlayer: false, progress: a.progress, i }))
      .filter((e) => e.i !== winnerIdx);
    others.push({ name: 'YOU', isPlayer: true, progress: this.playerProgress });
    others.sort((a, b) => b.progress - a.progress);
    const entries = [
      { name: AI_NAMES[winnerIdx], isPlayer: false },
      ...others,
    ];
    this.hud.results = entries.map((e, i) => ({
      pos: i + 1, name: e.name, isPlayer: !!e.isPlayer, time: i === 0 ? formatTime(this.raceT) : '—',
    }));
    const me = this.hud.results.find((r) => r.isPlayer);
    this.awardEarnings(me.pos);
    this.audio.beep(300, 0.4);
  }

  trackProgress() {
    const s = this.player.info.s;
    // A->B stage: standings run on the furthest point reached down the road
    this.playerProgress = Math.max(this.playerProgress, s);
    this.prevS = s;
    if (s >= this.track.finishS) {
      // package mode: the line means nothing without the cargo
      if (this.mode !== 'package' || (this.pkg && this.pkg.holder === 'player')) {
        this.finishRace();
      }
    }
  }

  // eliminated riders coast to the barrier and park (the foot-down pose
  // comes free from the low-speed animation)
  pullOver(ai) {
    ai.speed = Math.max(0, ai.speed - 10 * PHYS_DT);
    const sm = this.track.interpAt(ai.s);
    const lim = ((sm.wallD || this.track.wallDist) - 1.6) * (ai.lateral >= 0 ? 1 : -1);
    ai.lateral += clamp(lim - ai.lateral, -3 * PHYS_DT, 3 * PHYS_DT);
    const dp = ai.speed * PHYS_DT;
    ai.s = Math.min(ai.s + dp, this.track.length - 4);
    ai.progress += dp;
    ai.lean *= 0.97;
    ai.latVel = (ai.latVel || 0) * 0.95; // don't freeze a stale heading offset
    ai.airborne = false; // parked riders sit on the ground
    ai.stunTimer = 0;
    ai.aiming = false;
  }

  doElimination() {
    const actives = this.ais.filter((a) => !a.eliminated);
    let lastAi = null, lastP = this.playerProgress;
    for (const ai of actives) {
      if (ai.progress < lastP) { lastP = ai.progress; lastAi = ai; }
    }
    if (lastAi) {
      lastAi.eliminated = true;
      this.elimOrder.push(lastAi);
      this.flash(`${AI_NAMES[this.ais.indexOf(lastAi)]} OUT!`);
      this.audio.beep(300, 0.25);
      if (this.ais.every((a) => a.eliminated)) this.knockoutOver(true);
    } else {
      this.knockoutOver(false); // the player was last
    }
  }

  knockoutOver(won) {
    if (this.hud.finished) return;
    this.hud.finished = true;
    this.hud.mode = 'finished';
    const actives = this.ais
      .filter((a) => !a.eliminated)
      .sort((a, b) => b.progress - a.progress);
    const name = (ai) => AI_NAMES[this.ais.indexOf(ai)];
    const entries = won
      ? [{ name: 'YOU', isPlayer: true }]
      : [...actives.map((a) => ({ name: name(a), isPlayer: false })),
         { name: 'YOU', isPlayer: true }];
    for (const ai of [...this.elimOrder].reverse()) {
      entries.push({ name: name(ai), isPlayer: false });
    }
    this.hud.results = entries.map((e, i) => ({
      pos: i + 1, name: e.name, isPlayer: !!e.isPlayer, time: '—',
    }));
    this.awardEarnings(won ? 1 : actives.length + 1);
    this.audio.beep(won ? 880 : 300, 0.4);
  }

  awardEarnings(pos) {
    const earned = racePayout(pos) + 15 * this.statHits +
      5 * this.statBikeHits + 40 * this.statTankers + 120 * this.statGunships +
      30 * this.statLaunchers + 8 * this.statBarrels + 60 * this.statKills +
      12 * this.statIntercepts + 45 * this.statDrones;
    const bank = addPoints(earned);
    this.hud.earned = {
      total: earned,
      purse: racePayout(pos),
      hits: this.statHits,
      bikeHits: this.statBikeHits,
      tankers: this.statTankers,
      gunships: this.statGunships,
      launchers: this.statLaunchers,
      barrels: this.statBarrels,
      kills: this.statKills,
      intercepts: this.statIntercepts,
      drones: this.statDrones,
      balance: bank.points,
    };
  }

  finishRace() {
    if (this.hud.finished) return;
    this.hud.finished = true;
    this.hud.mode = 'finished';
    const playerTime = this.raceT;
    const entries = [
      { name: 'YOU', isPlayer: true, progress: this.playerProgress, time: playerTime },
      ...this.ais.map((ai, i) => ({
        name: AI_NAMES[i], isPlayer: false, progress: ai.progress,
        time: ai.eliminated ? null : ai.finishTime, out: ai.eliminated,
      })),
    ];
    entries.sort((a, b) => {
      if (a.time !== null && b.time !== null) return a.time - b.time;
      if (a.time !== null) return -1;
      if (b.time !== null) return 1;
      return b.progress - a.progress;
    });
    // package mode: delivering IS winning. AIs cross the empty line on the
    // clock, but the cargo outranks the stopwatch — mirror of packageOver,
    // which already force-ranks an AI deliverer first. The finish-line check
    // keeps a RIDER DOWN finish (player killed holding the crate) honest.
    if (this.mode === 'package' && this.pkg && this.pkg.holder === 'player'
        && this.player.info.s >= this.track.finishS) {
      const meIdx = entries.findIndex((e) => e.isPlayer);
      if (meIdx > 0) entries.unshift(entries.splice(meIdx, 1)[0]);
    }
    this.hud.results = entries.map((e, i) => ({
      pos: i + 1, name: e.name, isPlayer: e.isPlayer, out: !!e.out,
      time: e.out ? 'OUT' : e.time !== null ? formatTime(e.time) : '—',
    }));
    // pay the rider: position purse + combat bonuses, banked to the career
    const me = this.hud.results.find((r) => r.isPlayer);
    this.awardEarnings(me.pos);
    this.audio.beep(880, 0.4);
  }

  // red skull pin floating over the assassination target — a sprite, so it
  // always faces the camera; depthTest off so the mark reads through the pack
  ensureHuntMarker() {
    if (this.huntMarker) return;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 96;
    const g = cv.getContext('2d');
    g.fillStyle = '#d42a1e';
    g.beginPath(); g.arc(48, 36, 26, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(48, 90); g.lineTo(32, 56); g.lineTo(64, 56);
    g.closePath(); g.fill();
    g.strokeStyle = 'rgba(20,0,0,0.5)';
    g.lineWidth = 4;
    g.beginPath(); g.arc(48, 36, 26, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#fff';
    g.font = 'bold 36px serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('\u2620', 48, 38);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false });
    this.huntMarker = new THREE.Sprite(mat);
    this.huntMarker.scale.set(1.5, 1.5, 1);
    this.huntMarker.renderOrder = 40;
    this.huntMarker.visible = false;
    this.scene.add(this.huntMarker);
  }

  // ray from the camera through the mouse — matches the on-screen reticle
  aimRay() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const v = new THREE.Vector3(
      (this.input.mouse.x / w) * 2 - 1,
      -(this.input.mouse.y / h) * 2 + 1,
      0.5);
    v.unproject(this.camera);
    const dir = v.sub(this.camera.position).normalize();
    return { origin: this.camera.position, dir };
  }

  // every weapon hit on the player lands here: armour soaks it into a
  // brief wobble; with the plate beaten flat you take the full stun
  damagePlayer(dmg, stunDur) {
    this.armorRegenDelay = 4.5;
    if (this.armor >= 1) {
      const spill = dmg - this.armor; // overflow once the plate cracks
      this.armor = Math.max(0, this.armor - dmg);
      if (spill <= 0) {
        this.player.stun(stunDur * 0.35);
        if (this.armor <= 0) this.flash('ARMOR DOWN!');
        return true; // fully absorbed
      }
      this.flash('ARMOR DOWN!');
      this._hurt(spill, stunDur * 0.7);
      return false;
    }
    this._hurt(dmg, stunDur);
    return false;
  }

  _hurt(dmg, stunDur) {
    this.hp = Math.max(0, this.hp - dmg);
    this.player.stun(stunDur);
    if (this.hp <= 0 && !this.playerDowned && !this.hud.finished) {
      this.playerDowned = true;
      this.flash('RIDER DOWN!');
      this.player.crash();
      this.audio.beep(160, 0.5);
      this.finishRace();
    }
  }

  // AI damage funnel: routes through their plate, and a drained life bar
  // takes them out of the stage for good. Elemental types trade raw damage
  // for one clean mechanic each; everything non-player-fired stays kinetic.
  aiHit(ai, dmg, stunDur, type = 'kinetic') {
    if (type === 'shock') { dmg *= 0.7; stunDur *= 1.5; }
    else if (type === 'cryo') dmg *= 0.85;
    const r = ai.takeHit(dmg, stunDur, type);
    if (r !== 'armor') {
      if (type === 'incendiary') {
        ai.burnT = Math.max(ai.burnT || 0, 3.0); // refresh, never stack
        ai.burnDps = 8;
      } else if (type === 'cryo') {
        ai.slowT = Math.max(ai.slowT || 0, 2.5);
      }
    } else if (type === 'shock' && (ai.shockLock || 0) <= 0) {
      // shock alone staggers through an intact plate — at half strength,
      // rate-limited so an SMG stream can't chain-stunlock a rider
      ai.stun(stunDur * 0.5);
      ai.shockLock = 0.8;
    }
    if (r === 'dead' && !ai.eliminated) this.riderDown(ai);
    return r;
  }

  riderDown(ai) {
    ai.eliminated = true;
    const p = ai.pose();
    this.boom({ x: p.x, y: p.y + 0.5, z: p.z }, 0.7);
    this.audio.explosion(new THREE.Vector3(p.x, p.y, p.z));
    this.flash(`${ai.name || 'RIDER'} IS OUT!`);
    this.statKills++;
    const h = this.hud.hunt;
    if (h && !h.down && !h.failed && ai === this.ais[h.idx]) {
      h.down = true;
      // relic assassin jobs also demand a top-3 finish — don't call it
      // filled while the placement clause is still open
      this.flash(h.needPos ? `MARK DOWN — FINISH TOP ${h.needPos}` : 'CONTRACT FILLED');
      this.audio.beep(980, 0.3);
    }
  }

  tryShoot() {
    if (!this.gunOut || this.drawT > 0 || this.shootCd > 0 || this.paused ||
        this.hud.finished || this.raceT < 0 || this.player.crashed) return;
    const w = this.weapon;
    if (this.ammo < w.cost) {
      // dry click: the generator hasn't caught up yet
      if (this.dryT <= 0) {
        this.audio.beep(170, 0.04);
        this.dryT = 0.18;
      }
      return;
    }
    this.ammo -= w.cost;
    this.shootCd = this.gunCd;
    this.audio.gunshot((w.base || w.id) === 'smg' ? 0.55 : 1);
    const { origin, dir } = this.aimRay();
    this.playerMesh.updateWorldMatrix(true, true);
    const muzzle = new THREE.Vector3();
    this.playerRider.muzzle.getWorldPosition(muzzle);

    // muzzle flash + a spit of sparks out of the barrel + recoil kick
    this.muzzleFlash.position.copy(muzzle);
    this.muzzleFlash.scale.setScalar(0.8 + Math.random() * 0.5);
    this.muzzleFlash.visible = true;
    this.sparks.spray(muzzle, dir, w.pellets > 2 ? 9 : 5, 11, 0.35);
    this.muzzleT = 0.06;
    this.shake = Math.max(this.shake, (w.base || w.id) === 'thumper' ? 0.45 : 0.25);

    // each pellet is its own ray inside the weapon's cone
    for (let pk = 0; pk < w.pellets; pk++) {
      const d2 = dir.clone();
      if (w.spread) {
        d2.x += (Math.random() - 0.5) * 2 * w.spread;
        d2.y += (Math.random() - 0.5) * 2 * w.spread;
        d2.z += (Math.random() - 0.5) * 2 * w.spread;
        d2.normalize();
      }
      this.firePellet(origin, d2, muzzle, w);
    }
  }

  firePellet(origin, dir, muzzle, w) {
    const RANGE = w.range || 160;
    const LAUNCHER_RANGE = 320; // towers are engageable before they can fire
    // hit zones: opponent RIDER (stun), opponent MACHINE (sparks), a
    // TANKER/GUNSHIP/LAUNCHER (chip its hit points), or a BARREL (boom)
    let best = null, bestT = LAUNCHER_RANGE, bestZone = null;
    const hitSphere = (px, py, pz, r, maxT = RANGE) => {
      const to = new THREE.Vector3(px - origin.x, py - origin.y, pz - origin.z);
      const t = to.dot(dir);
      if (t < 3 || t > maxT) return null;
      const closest = Math.sqrt(Math.max(0, to.lengthSq() - t * t));
      return closest < r ? t : null;
    };
    for (const ai of this.ais) {
      if (ai.eliminated) continue; // no shooting parked riders
      const p = ai.pose();
      const tRider = hitSphere(p.x, p.y + 1.15, p.z, 0.65);
      const tBike = hitSphere(p.x, p.y + 0.45, p.z, 1.35);
      const t = tRider !== null ? tRider : tBike;
      if (t !== null && t < bestT) {
        best = ai;
        bestT = t;
        bestZone = tRider !== null ? 'rider' : 'bike';
      }
    }
    for (const v of this.tankers.list) {
      if (v.dead) continue;
      const t = hitSphere(v.mesh.position.x, v.mesh.position.y + 1.6, v.mesh.position.z, 2.6);
      if (t !== null && t < bestT) {
        best = v;
        bestT = t;
        bestZone = 'tanker';
      }
    }
    for (const v of this.gunships.list) {
      if (v.dead || v.falling) continue;
      const t = hitSphere(v.mesh.position.x, v.mesh.position.y, v.mesh.position.z, 3.2);
      if (t !== null && t < bestT) {
        best = v;
        bestT = t;
        bestZone = 'gunship';
      }
    }
    for (const v of this.launchers.list) {
      if (v.dead) continue;
      // generous sphere + extended range: a tower is a big, fair target
      const t = hitSphere(v.headPos.x, v.headPos.y, v.headPos.z, 3.0, LAUNCHER_RANGE);
      if (t !== null && t < bestT) {
        best = v;
        bestT = t;
        bestZone = 'launcher';
      }
    }
    for (const b of this.barrels) {
      if (!b.alive) continue;
      const t = hitSphere(b.x, b.y + 0.5, b.z, 0.85);
      if (t !== null && t < bestT) {
        best = b;
        bestT = t;
        bestZone = 'barrel';
      }
    }
    for (const d of this.drones.list) {
      if (d.dead) continue;
      const t = hitSphere(d.mesh.position.x, d.mesh.position.y, d.mesh.position.z, 1.2, 220);
      if (t !== null && t < bestT) {
        best = d;
        bestT = t;
        bestZone = 'drone';
      }
    }
    for (const d of this.drones.list) {
      if (d.dead) continue;
      const t = hitSphere(d.mesh.position.x, d.mesh.position.y, d.mesh.position.z, 1.2, 220);
      if (t !== null && t < bestT) {
        best = d;
        bestT = t;
        bestZone = 'drone';
      }
    }
    for (const r of this.launchers.rockets) {
      // point defence: a generous sphere — hitting a rocket should feel
      // like sharp shooting, not pixel hunting
      const t = hitSphere(r.pos.x, r.pos.y, r.pos.z, 1.5, 260);
      if (t !== null && t < bestT) {
        best = r;
        bestT = t;
        bestZone = 'rocket';
      }
    }
    const end = new THREE.Vector3().copy(origin).addScaledVector(dir, best ? bestT : RANGE);
    this.spawnTracer(muzzle, end);

    const stun = this.gunStun * w.stun;
    if (best) {
      this.impactFlash.position.copy(end);
      this.impactFlash.scale.setScalar(0.8 + Math.random() * 0.6);
      this.impactFlash.visible = true;
      this.impactT = 0.12;
      if (bestZone === 'rider') {
        // 25 armour damage per point of weapon dmg: pistol MK1 strips a
        // full plate in 4 rounds, the 5th puts them down
        const verdict = this.aiHit(best, w.dmg * 25, stun, w.damageType);
        if (verdict === 'dead' && w.special === 'killRefund') {
          this.ammo = Math.min(this.ammoMax, this.ammo + 8); // the Taxman collects
        }
        if (verdict !== 'armor') {
          best.speed *= 0.7; // the hit itself costs them pace
          best.hitReactT = 0.9; // body flinch instead of a red flash
          this.sparks.burst(end, 24, 7);
          this.hud.hitT = 0.4;
          this.shake = Math.max(this.shake, 0.4);
          this.audio.hitRider(end);
          this.statHits++;
        } else {
          // clang: the plate ate it — flinch, no stun, small pace nick
          best.speed *= 0.96;
          best.hitReactT = 0.45;
          this.sparks.burst(end, 16, 6);
          this.hud.hitT = 0.25;
          this.audio.hitBike(end);
          this.statBikeHits++;
        }
      } else if (bestZone === 'tanker') {
        best.hp -= w.dmg;
        this.sparks.burst(end, 16, 7);
        this.hud.hitT = 0.25;
        this.audio.beep(620, 0.06);
        if (best.hp <= 0) this.explodeTanker(best, true);
      } else if (bestZone === 'gunship') {
        best.hp -= w.dmg;
        this.sparks.burst(end, 18, 8);
        this.hud.hitT = 0.25;
        this.hud.gunshipInfo = { hp: Math.max(0, Math.ceil(best.hp)), max: best.maxHp, t: 1.4 };
        this.audio.beep(480, 0.06); // armour clank
        if (best.hp <= 0) this.downGunship(best, true);
      } else if (bestZone === 'launcher') {
        best.hp -= w.dmg;
        this.sparks.burst(end, 16, 7);
        this.hud.hitT = 0.25;
        this.hud.launcherInfo = { hp: Math.max(0, Math.ceil(best.hp)), max: best.maxHp, t: 1.4 };
        this.audio.beep(560, 0.06);
        if (best.hp <= 0) this.destroyLauncher(best);
      } else if (bestZone === 'barrel') {
        this.explodeBarrel(best);
        this.hud.hitT = 0.3;
      } else if (bestZone === 'rocket') {
        this.interceptRocket(best);
        this.hud.hitT = 0.35;
      } else if (bestZone === 'drone') {
        best.hp -= w.dmg;
        this.sparks.burst(end, 14, 7);
        this.hud.hitT = 0.25;
        this.audio.beep(700, 0.05);
        if (best.hp <= 0) this.downDrone(best);
      } else {
        // machine hit: metal sparks and a clank, rider keeps control
        this.sparks.burst(end, 14, 6);
        this.hud.hitT = 0.2;
        this.audio.hitBike(end);
        this.statBikeHits++;
      }
    } else {
      this.sparks.burst(end, 6, 4); // dirt kick where the shot lands
    }

    // the Thumper's slug detonates wherever it lands
    if (w.boom) {
      this.boom({ x: end.x, y: end.y, z: end.z }, w.boom);
      this.audio.explosion(end);
      for (const ai of this.ais) {
        if (ai.eliminated) continue;
        const p = ai.pose();
        if (Math.hypot(p.x - end.x, p.z - end.z) < w.blast) {
          if (this.aiHit(ai, w.dmg * 20, stun * 0.8, w.damageType) !== 'armor') this.statHits++;
          ai.hitReactT = 0.9;
        }
      }
      for (const b of this.barrels) {
        if (b.alive && Math.hypot(b.x - end.x, b.z - end.z) < w.blast + 2) {
          this.barrelChain.push({ b, t: 0.1 + Math.random() * 0.1 });
        }
      }
      const pd = Math.hypot(this.player.x - end.x, this.player.z - end.z);
      if (pd < w.blast * 0.8) this.damagePlayer(12, 0.9 * this.selfStunMul); // own shrapnel
    }
  }

  downDrone(d) {
    d.dead = true;
    d.mesh.visible = false;
    const p = d.mesh.position;
    this.airBurst({ x: p.x, y: p.y, z: p.z });
    this.statDrones++;
    this.flash('DRONE DOWN');
  }

  // point defence: the rocket dies in the air — a flak burst, not a
  // ground strike. No ring, no scorch, no mushroom: a bright core, a
  // sphere of slivers, and a dark puff that hangs where it died.
  interceptRocket(r) {
    const idx = this.launchers.rockets.indexOf(r);
    if (idx === -1) return;
    this.launchers.rockets.splice(idx, 1);
    this.launchers.scene.remove(r.mesh);
    const p = { x: r.pos.x, y: r.pos.y, z: r.pos.z };
    this.airBurst(p);
    this.statIntercepts++;
    this.flash('INTERCEPTED!');
  }

  airBurst(p) {
    this.boomFx.spawn(p, 0.75, true); // fireball only, no ground ring
    this.fx.rippleAt(p, this.camera, 0.7);
    this.swarm.blast(p, 0.9);
    this.sparks.burst(p, 44, 13);
    // radial ember slivers in a full sphere — flak, not fountain
    for (let k = 0; k < 42; k++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const v = 9 + Math.random() * 22;
      this.storm.ember(p.x, p.y, p.z,
        Math.sin(ph) * Math.cos(th) * v, Math.cos(ph) * v, Math.sin(ph) * Math.sin(th) * v,
        0.5 + Math.random() * 0.4);
    }
    // one dark puff that hangs and shreds where the rocket died
    for (let k = 0; k < 7; k++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      this.smoke._emit(
        p.x, p.y, p.z,
        Math.sin(ph) * Math.cos(th) * 2.2, Math.cos(ph) * 2.2 + 0.4,
        Math.sin(ph) * Math.sin(th) * 2.2,
        1.3 + Math.random() * 0.7,
        2.0 + Math.random() * 1.2,
        0, 0);
    }
    this.impactFlash.position.set(p.x, p.y, p.z);
    this.impactFlash.scale.setScalar(2.0);
    this.impactFlash.visible = true;
    this.impactT = 0.2;
    this.audio.explosion(new THREE.Vector3(p.x, p.y, p.z));
    this.audio.beep(540, 0.07); // the sharp flak crack on top
    this.shake = Math.max(this.shake, 0.3);
  }

  // an explosive barrel goes up: blast, stun anyone beside it, and light
  // the fuse on every neighbour — Tyrian ground-target chains
  explodeBarrel(b) {
    if (!b.alive) return;
    b.alive = false;
    b.mesh.visible = false;
    const p = { x: b.x, y: b.y + 0.5, z: b.z };
    this.boom(p, 0.9);
    this.audio.explosion(new THREE.Vector3(p.x, p.y, p.z));
    this.statBarrels++;
    for (const ai of this.ais) {
      if (ai.eliminated) continue;
      const q = ai.pose();
      if (Math.hypot(q.x - b.x, q.z - b.z) < 7) {
        this.aiHit(ai, 35, this.gunStun);
        ai.hitReactT = 0.9;
      }
    }
    const pd = Math.hypot(this.player.x - b.x, this.player.z - b.z);
    if (pd < 5) this.damagePlayer(28, 1.1 * this.selfStunMul);
    for (const o of this.barrels) {
      if (o.alive && o !== b && Math.hypot(o.x - b.x, o.z - b.z) < 8) {
        this.barrelChain.push({ b: o, t: 0.12 + Math.random() * 0.12 });
      }
    }
  }

  spawnTracer(a, b) {
    let tr = this.tracers.find((t) => t.t <= 0);
    if (!tr) {
      if (this.tracers.length >= 14) return; // scatter fires 8 pellets
      const geo = new THREE.CylinderGeometry(0.02, 0.02, 1, 5, 1, true);
      geo.translate(0, 0.5, 0); // base at origin, extends +Y
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd890, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      tr = { mesh: new THREE.Mesh(geo, mat), t: 0 };
      tr.mesh.frustumCulled = false;
      this.scene.add(tr.mesh);
      this.tracers.push(tr);
    }
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    tr.mesh.position.copy(a);
    tr.mesh.scale.set(1, len, 1);
    tr.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    tr.mesh.visible = true;
    tr.mesh.material.opacity = 0.55;
    tr.t = 0.055;
    // a couple of tiny glints shed along the first stretch of the ray
    const dn = d; // normalized above
    for (let k = 0; k < 3; k++) {
      const at = 1.2 + Math.random() * Math.min(9, len * 0.4);
      this.sparks._emit(
        a.x + dn.x * at, a.y + dn.y * at, a.z + dn.z * at,
        (Math.random() - 0.5) * 1.6, (Math.random() - 0.2) * 1.4, (Math.random() - 0.5) * 1.6,
        0.1 + Math.random() * 0.14);
    }
  }

  updateTankers(dt, racing) {
    const L = this.track.length;
    this.tankers.update(dt, this.player.info.s);
    this.gunships.update(dt, this.player.info.s);
    this.updateGunships(dt, racing);
    this.updateLaunchers(dt, racing);
    for (const v of [...this.tankers.list, ...this.gunships.list, ...this.launchers.list]) {
      // a gunship that just hit the ground detonates
      if (v.justCrashed) {
        v.justCrashed = false;
        this.blastGunship(v);
      }
      // burning wrecks: black smoke column + rising embers
      if (v.burnT > 0) {
        v.burnT -= dt;
        if (Math.random() < dt * 14) {
          this.smoke.spawn({
            x: v.mesh.position.x, y: v.mesh.position.y + 2.6, z: v.mesh.position.z,
          }, 2);
        }
        if (Math.random() < dt * 20) {
          this.storm.ember(
            v.mesh.position.x + (Math.random() - 0.5) * 2,
            v.mesh.position.y + 1.5,
            v.mesh.position.z + (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 3, 2.5 + Math.random() * 3.5, (Math.random() - 0.5) * 3,
            1.1);
        }
      }
      if (!racing) continue;
      // ground-level obstacles only: airborne gunships aren't rammable, but
      // their burning wrecks on the road are
      const grounded = v.flying !== true;
      if (!grounded) continue;
      const P = this.player;
      if (!P.crashed) {
        const dx = P.x - v.mesh.position.x, dz = P.z - v.mesh.position.z;
        if (dx * dx + dz * dz < 2.4 * 2.4 &&
            Math.abs(P.y - v.mesh.position.y) < 3.5) P.crash();
      }
      // AI: swerve around it, or scrub off hard if they clip it
      for (const ai of this.ais) {
        const ds = v.s - ai.s;
        if (ds > 0 && ds < 28 && Math.abs(v.lateral - ai.lateral) < 3) {
          ai.lateral += (ai.lateral > v.lateral ? 1 : -1) * 9 * dt;
        }
        if (Math.abs(ds) < 4 && Math.abs(v.lateral - ai.lateral) < 2.2 && ai.stunTimer <= 0) {
          ai.stun(0.9);
          ai.speed *= 0.5;
        }
      }
    }
  }

  // gunships: acquire the nearest rider below, track with the chin turret
  // and fire the same slow lead-aimed rockets as the roadside towers —
  // physical, visible, and dodged the same way (turn after the warning).
  updateGunships(dt, racing) {
    for (const v of this.gunships.list) {
      if (v.dead || v.falling) continue;
      // targets: player + active AI within 130 m horizontally (it's overhead,
      // so vertical distance is ignored)
      let best = null, bestD = 130;
      const vp = v.mesh.position;
      if (!this.player.crashed && this.playerImmunT <= 0 && this.player.stunTimer <= 0) {
        const d = Math.hypot(this.player.x - vp.x, this.player.z - vp.z);
        if (d < bestD) { best = { isPlayer: true }; bestD = d; }
      }
      for (const ai of this.ais) {
        if (ai.eliminated || ai.stunTimer > 0) continue;
        const p = ai.pose();
        const d = Math.hypot(p.x - vp.x, p.z - vp.z);
        if (d < bestD) { best = { ai }; bestD = d; }
      }
      v.target = best;
      if (!best) continue;
      const tp = best.isPlayer
        ? { x: this.player.x, y: this.player.y + 0.9, z: this.player.z }
        : (() => { const p = best.ai.pose(); return { x: p.x, y: p.y + 0.9, z: p.z }; })();
      // yaw the chin gun toward the target (relative to the fuselage)
      const want = Math.atan2(tp.x - vp.x, tp.z - vp.z) - v.mesh.rotation.y;
      let dy = want - v.turret.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      v.turret.rotation.y += clamp(dy, -3 * dt, 3 * dt);

      if (racing && this.raceT > 2) {
        v.gunCd -= dt * this.missileMul;
        // minimum firing distance, same idea as the towers: a rocket needs
        // >= ~1.4 s of flight or it's an unavoidable point-blank hit. The
        // turret keeps tracking inside 45 m, it just holds fire.
        if (v.gunCd <= 0 && bestD > 45 && this.missileMul > 0) {
          // same slow, straight, lead-aimed rockets as the roadside towers —
          // physical and dodgeable, fired from the chin turret
          v.gunCd = 3.5 + Math.random() * 1.5;
          v.mesh.updateWorldMatrix(true, true);
          const muzzle = new THREE.Vector3();
          v.muzzle.getWorldPosition(muzzle);
          let tgt;
          if (best.isPlayer) {
            const P = this.player;
            tgt = {
              x: P.x, y: P.y, z: P.z,
              vx: Math.sin(P.heading) * P.speed,
              vz: Math.cos(P.heading) * P.speed,
              atPlayer: true,
            };
          } else {
            const p = best.ai.pose();
            tgt = {
              x: p.x, y: p.y, z: p.z,
              vx: Math.sin(p.heading) * best.ai.speed,
              vz: Math.cos(p.heading) * best.ai.speed,
              atPlayer: false,
            };
          }
          this.launchers.fireRocket(muzzle, tgt);
        }
      }
    }
  }

  // roadside rocket emplacements: feed them the player's position and
  // velocity for lead-aiming, then turn their events into warnings/blasts
  updateLaunchers(dt, racing) {
    const P = this.player;
    const target = {
      x: P.x, y: P.y, z: P.z,
      vx: Math.sin(P.heading) * P.speed,
      vz: Math.cos(P.heading) * P.speed,
      valid: !P.crashed && P.stunTimer <= 0,
    };
    // every live bike, for the rockets' lazy homing + proximity fuses
    const riders = [];
    if (!P.crashed) riders.push({ x: P.x, y: P.y, z: P.z });
    for (const ai of this.ais) {
      if (ai.eliminated) continue;
      const p = ai.pose();
      riders.push({ x: p.x, y: p.y, z: p.z });
    }
    this.launchers.update(dt, target,
      racing && this.raceT > 2 && !this.hud.finished && this.missileMul > 0,
      riders, this.missileMul);
    this.drones.update(dt, riders, this.player.info.s,
      racing && this.raceT > 2 && !this.hud.finished && this.missileMul > 0,
      this.missileMul);
    for (const ev of this.drones.events) {
      if (ev.type === 'drop') {
        this.audio.beep(340, 0.1); // the release click overhead
      } else {
        this.nadeBlast(ev);
      }
    }
    this.drones.events.length = 0;
    this.audio.updateRockets(this.launchers.rockets);

    // smoke trail + shed embers behind every rocket in flight
    for (const r of this.launchers.rockets) {
      if (Math.random() < dt * 26) {
        this.dust.spawn({
          x: r.pos.x - r.vel.x * 0.02,
          y: r.pos.y - r.vel.y * 0.02,
          z: r.pos.z - r.vel.z * 0.02,
        }, 1);
      }
      if (Math.random() < dt * 34) {
        this.storm.ember(
          r.pos.x - r.vel.x * 0.03, r.pos.y - r.vel.y * 0.03, r.pos.z - r.vel.z * 0.03,
          (Math.random() - 0.5) * 2, 0.5 + Math.random(), (Math.random() - 0.5) * 2, 0.45);
      }
    }

    for (const ev of this.launchers.events) {
      if (ev.type === 'launch') {
        if (ev.atPlayer) {
          this.flash('ROCKET! TURN!');
          this.audio.beep(190, 0.22);
        }
        this.audio.gunshot(0.7, new THREE.Vector3(ev.x, ev.y, ev.z));
      } else {
        this.rocketBlast(ev);
      }
    }
    this.launchers.events.length = 0;
  }

  // a dropped grenade going off: smaller than a rocket, still a bad day
  nadeBlast(p) {
    this.boom(p, 0.55);
    this.audio.explosion(new THREE.Vector3(p.x, p.y, p.z));
    this.sparks.burst(p, 30, 10);
    const P = this.player;
    const pd = Math.hypot(P.x - p.x, P.y + 0.8 - p.y, P.z - p.z);
    if (!P.crashed) {
      if (pd < 1.7) {
        if (this.armor >= 1) {
          this.damagePlayer(45, 1.3);
          P.speed *= 0.55;
          this.flash('GRENADE!');
        } else {
          P.crash();
        }
      } else if (pd < 3.6) {
        this.damagePlayer(18, 0.9);
        P.speed *= 0.75;
      }
    }
    this.shake = Math.max(this.shake, clamp(1.4 - pd / 10, 0.2, 0.9));
    for (const ai of this.ais) {
      const q = ai.pose();
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < 1.7) { if (this.aiHit(ai, 45, 1.6) !== 'armor') ai.speed *= 0.5; }
      else if (d < 3.6) this.aiHit(ai, 18, 0.9);
    }
    for (const b of this.barrels) {
      if (b.alive && Math.hypot(b.x - p.x, b.z - p.z) < 6) {
        this.barrelChain.push({ b, t: 0.12 + Math.random() * 0.1 });
      }
    }
  }

  rocketBlast(p) {
    this.impactFlash.position.set(p.x, p.y, p.z);
    this.impactFlash.scale.setScalar(2.6);
    this.impactFlash.visible = true;
    this.impactT = 0.28;
    this.sparks.burst(p, 50, 13);
    this.dust.burst({ x: p.x, y: p.y + 1, z: p.z }, 26, 7);
    this.boom(p, 0.8);
    this.audio.explosion(p);
    // tight blast: a near-miss you steered away from stays a miss
    const P = this.player;
    const pd = Math.hypot(P.x - p.x, P.y + 0.8 - p.y, P.z - p.z);
    if (!P.crashed) {
      if (pd < 1.4) {
        // with armour on your back a direct rocket is survivable — once
        if (this.armor >= 1) {
          this.damagePlayer(70, 1.6 * this.armourScale);
          P.speed *= 0.45;
          this.flash('ARMOR ATE A ROCKET!');
        } else {
          P.crash();
        }
      } else if (pd < 3.0) {
        this.damagePlayer(30, 1.2 * this.armourScale);
        P.speed *= 0.6;
        this.flash('BLAST!');
      }
    }
    this.shake = Math.max(this.shake, clamp(1.8 - pd / 12, 0.3, 1.2));
    // a rocket that lands in the pack is everyone's problem
    for (const ai of this.ais) {
      const pose = ai.pose();
      const d = Math.hypot(pose.x - p.x, pose.z - p.z);
      if (d < 1.4) { if (this.aiHit(ai, 60, 2.0) !== 'armor') ai.speed *= 0.35; else ai.speed *= 0.75; }
      else if (d < 3.0) { if (this.aiHit(ai, 30, 1.1) !== 'armor') ai.speed *= 0.65; else ai.speed *= 0.85; }
    }
  }

  // second pistol hit: the emplacement cooks off and stays dead all stage
  destroyLauncher(v) {
    this.launchers.wreck(v);
    const p = v.headPos;
    this.impactFlash.position.copy(p);
    this.impactFlash.scale.setScalar(3.4);
    this.impactFlash.visible = true;
    this.impactT = 0.32;
    this.sparks.burst({ x: p.x, y: p.y, z: p.z }, 60, 14);
    this.dust.burst({ x: p.x, y: p.y + 1.5, z: p.z }, 30, 7);
    this.boom({ x: p.x, y: p.y - 1.5, z: p.z }, 1.1);
    this.audio.explosion(p);
    this.shake = Math.max(this.shake, 0.5);
    this.statLaunchers++;
    this.hud.launcherInfo = null;
    this.flash('+30 LAUNCHER DESTROYED!');
  }

  // 12th hit lands: send it into the death plunge (blast comes on impact)
  downGunship(v, byPlayer) {
    this.gunships.startFalling(v);
    v.downedByPlayer = byPlayer;
    this.audio.beep(180, 0.5);
    this.flash('GUNSHIP DOWN!');
  }

  // ground impact: the actual explosion, blast damage and bounty
  blastGunship(v) {
    const p = v.mesh.position;
    this.impactFlash.position.set(p.x, p.y + 1.2, p.z);
    this.impactFlash.scale.setScalar(5.5);
    this.impactFlash.visible = true;
    this.impactT = 0.4;
    this.sparks.burst({ x: p.x, y: p.y + 1.2, z: p.z }, 110, 19);
    this.dust.burst({ x: p.x, y: p.y + 2, z: p.z }, 70, 10);
    this.boom({ x: p.x, y: p.y + 1.2, z: p.z }, 2.0);
    this.audio.explosion(p);
    this.audio.thud();
    const P = this.player;
    const pd = Math.hypot(P.x - p.x, P.z - p.z);
    if (!P.crashed) {
      if (pd < 8) P.crash();
      else if (pd < 18) {
        P.stun(1.3 * this.armourScale);
        P.speed *= 0.55;
        this.flash('BLAST!');
      }
    }
    this.shake = Math.max(this.shake, clamp(2.4 - pd / 18, 0.5, 1.6));
    for (const ai of this.ais) {
      const pose = ai.pose();
      const d = Math.hypot(pose.x - p.x, pose.z - p.z);
      if (d < 8) { ai.stun(2.8); ai.speed = 4; }
      else if (d < 18) { ai.stun(1.6); ai.speed *= 0.5; }
    }
    if (v.downedByPlayer) {
      this.statGunships++;
      this.flash('+120 GUNSHIP DESTROYED!');
    }
  }

  explodeTanker(v, byPlayer) {
    const p = v.mesh.position;
    this.tankers.wreck(v);
    this.impactFlash.position.set(p.x, p.y + 2, p.z);
    this.impactFlash.scale.setScalar(3.2);
    this.impactFlash.visible = true;
    this.impactT = 0.3;
    this.sparks.burst({ x: p.x, y: p.y + 2, z: p.z }, 70, 15);
    this.dust.burst({ x: p.x, y: p.y + 3, z: p.z }, 40, 8);
    this.boom({ x: p.x, y: p.y + 1.5, z: p.z }, 1.5);
    this.audio.explosion(p);
    // blast radius: crash up close, stun further out — riders AND player
    const P = this.player;
    const pd = Math.hypot(P.x - p.x, P.z - p.z);
    if (!P.crashed) {
      if (pd < 6) P.crash();
      else if (pd < 14) {
        P.stun(1.3 * this.armourScale);
        P.speed *= 0.55;
        this.flash('BLAST!');
      }
    }
    this.shake = Math.max(this.shake, clamp(2 - pd / 20, 0.4, 1.3));
    for (const ai of this.ais) {
      const pose = ai.pose();
      const d = Math.hypot(pose.x - p.x, pose.z - p.z);
      if (d < 6) { ai.stun(2.6); ai.speed = 4; }
      else if (d < 14) { ai.stun(1.5); ai.speed *= 0.5; }
    }
    if (byPlayer) {
      this.statTankers++;
      this.flash('+40 TANKER!');
    }
  }

  // Every AI wants the position ahead — clean if they're faster, dirty if
  // there's a pistol handy. Each rider periodically picks the nearest rival
  // ahead (player included), visibly aims for half a second, then fires with
  // distance-based accuracy.
  updateCombat(dt) {
    this.playerImmunT = Math.max(0, this.playerImmunT - dt);
    const racers = this.ais
      .map((a, i) => ({ progress: a.progress, ref: a, isPlayer: false, idx: i }))
      .filter((r) => !r.ref.eliminated);
    racers.push({ progress: this.playerProgress, ref: this.player, isPlayer: true, idx: -1 });

    for (let i = 0; i < this.ais.length; i++) {
      const ai = this.ais[i];
      if (ai.eliminated) continue;
      const c = this.combat[i];
      const rider = this.aiMeshes[i].rider;
      if (this.aggroMul <= 0) { // pacifist setting: guns stay holstered
        c.target = null;
        ai.aiming = false;
        rider.gunArm.visible = false;
        rider.armR.visible = true;
        continue;
      }
      c.cd -= dt * this.aggroMul;
      if (c.hideT > 0) {
        c.hideT -= dt;
        if (c.hideT <= 0 && !c.target) {
          rider.gunArm.visible = false;
          rider.armR.visible = true;
        }
      }
      if (ai.stunTimer > 0) {
        c.target = null;
        ai.aiming = false;
        rider.gunArm.visible = false;
        rider.armR.visible = true;
        c.cd = Math.max(c.cd, 1.5);
        continue;
      }
      if (!c.target && c.cd <= 0) {
        let best = null, bestDp = 60;
        // package mode: the carrier is the priority target for everyone —
        // one stun makes the package drop
        if (this.mode === 'package' && this.pkg && this.pkg.holder !== null &&
            this.pkg.holder !== i) {
          const carr = this.pkg.holder === 'player'
            ? racers.find((r) => r.isPlayer)
            : racers.find((r) => r.ref === this.ais[this.pkg.holder]);
          if (carr && Math.abs(carr.progress - ai.progress) < 65) best = carr;
        }
        if (!best) for (const r of racers) {
          if (r.ref === ai) continue;
          if (r.isPlayer && (this.playerImmunT > 0 || this.player.crashed || this.player.stunTimer > 0)) continue;
          if (!r.isPlayer && r.ref.stunTimer > 0) continue;
          const dp = r.progress - ai.progress;
          if (dp > 3 && dp < bestDp) { best = r; bestDp = dp; }
        }
        if (best) {
          c.target = best;
          c.aimT = 0.7; // draw + raise + settle before the shot
          ai.aiming = true;
          rider.gunArm.visible = true;
          rider.armR.visible = false;
        }
      }
      if (c.target) {
        const tp = c.target.isPlayer
          ? { x: this.player.x, y: this.player.y + 0.8, z: this.player.z }
          : (() => { const p = c.target.ref.pose(); return { x: p.x, y: p.y + 0.8, z: p.z }; })();
        const mp = this.aiMeshes[i].group.position;
        const dist = Math.hypot(tp.x - mp.x, tp.y - mp.y, tp.z - mp.z);
        if (dist > 80 || (c.target.isPlayer && this.playerImmunT > 0)) {
          c.target = null;
          ai.aiming = false;
          c.hideT = 0.3;
          continue;
        }
        rider.gunArm.lookAt(tp.x, tp.y, tp.z);
        // arm sweeps up from the holster over the first ~0.3 s of the aim
        const raise = clamp((0.7 - c.aimT) / 0.3, 0, 1);
        if (raise < 1) rider.gunArm.rotateX((1 - raise) * 1.2);
        c.aimT -= dt;
        if (c.aimT <= 0) this.aiFire(i, c, tp, dist);
      }
    }
  }

  aiFire(i, c, tp, dist) {
    const mesh = this.aiMeshes[i];
    mesh.group.updateWorldMatrix(true, true);
    const muzzle = new THREE.Vector3();
    mesh.rider.muzzle.getWorldPosition(muzzle);
    const hit = Math.random() < 0.6 * clamp(1.25 - dist / 75, 0.25, 1);
    const end = new THREE.Vector3(tp.x, tp.y, tp.z);
    if (!hit) {
      end.x += (Math.random() - 0.5) * 6;
      end.y += Math.random() * 1.5;
      end.z += (Math.random() - 0.5) * 6;
    }
    this.spawnTracer(muzzle, end);
    // positional: the panner gives AI gunfire stereo direction + distance
    this.audio.gunshot(0.9, muzzle);
    if (hit) {
      this.impactFlash.position.copy(end);
      this.impactFlash.scale.setScalar(0.8 + Math.random() * 0.6);
      this.impactFlash.visible = true;
      this.impactT = 0.12;
      // where did it land? ~40% rider (stun), else the machine (sparks only)
      const riderHit = Math.random() < 0.42;
      if (!riderHit) {
        this.sparks.burst(end, 12, 6);
        if (c.target.isPlayer) this.audio.beep(760, 0.06);
      } else if (c.target.isPlayer) {
        this.damagePlayer(14, 1.15 * this.armourScale * this.selfStunMul);
        this.playerImmunT = this.immunTime; // no chain-stuns
        this.sparks.burst(end, 16, 6);
        this.shake = Math.max(this.shake, 0.55);
        this.flash('SHOT!');
        this.audio.thud();
      } else {
        if (this.aiHit(c.target.ref, 25, 1.2) !== 'armor') {
          c.target.ref.speed *= 0.8;
          this.audio.hitRider(end);
        } else {
          this.audio.hitBike(end);
        }
        this.sparks.burst(end, 16, 6);
        c.target.ref.hitReactT = 0.9;
      }
    } else {
      this.sparks.burst(end, 5, 4);
    }
    const ai = this.ais[i];
    ai.aiming = false;
    c.target = null;
    c.cd = 3 + Math.random() * 3.5;
    c.hideT = 0.35;
  }

  pushApart(dt) {
    // soft anti-overlap between player and AI bikes (same road level only —
    // riders on a flyover don't shoulder riders passing underneath)
    for (const ai of this.ais) {
      const p = ai.pose();
      if (Math.abs(this.player.y - p.y) > 3.5) continue;
      const dx = this.player.x - p.x, dz = this.player.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 4 && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        this.player.x += (dx / d) * 4 * dt;
        this.player.z += (dz / d) * 4 * dt;
        ai.lateral -= ((dx * -Math.sin(p.heading + Math.PI / 2)) > 0 ? 1 : -1) * 2 * dt;
        // a real BUMP, not just spacing: trade momentum, jolt the bars,
        // and thud when it's more than a graze
        const dv = this.player.speed - ai.speed;
        const x = clamp(dv, -8, 8);
        this.player.speed -= x * 1.6 * dt;
        ai.speed += x * 1.4 * dt;
        const side = Math.sign((this.player.info.lateral || 0) - ai.lateral) || 1;
        this.player.lean = clamp(this.player.lean + side * 2.2 * dt, -1, 1);
        ai.lean = clamp(ai.lean - side * 2.6 * dt, -1, 1);
        ai.latVel -= side * 3.5 * dt; // shoved off their line, banked
        if (d < 1.5 && this.raceT > (this._bumpT || -99) + 0.45) {
          this._bumpT = this.raceT;
          this.audio.thud();
          this.shake = Math.max(this.shake, 0.28);
          this.sparks.burst({ x: (this.player.x + p.x) / 2, y: p.y + 0.7, z: (this.player.z + p.z) / 2 }, 8, 4);
        }
      }
    }
    // and between AI riders — with 12 on the same racing line they'd stack
    const L = this.track.length;
    for (let i = 0; i < this.ais.length; i++) {
      for (let j = i + 1; j < this.ais.length; j++) {
        const a = this.ais[i], b = this.ais[j];
        const ds = a.s - b.s;
        if (Math.abs(ds) < 3.5 && Math.abs(a.lateral - b.lateral) < 1.4) {
          const dir = a.lateral >= b.lateral ? 1 : -1;
          a.lateral += dir * 2.5 * dt;
          b.lateral -= dir * 2.5 * dt;
        }
      }
    }
  }

  updateVisuals(dt) {
    const P = this.player;
    const m = this.playerMesh;
    m.position.set(P.x, P.y, P.z);
    // rider ragdoll: thrown on crash, tumbling and flailing until respawn
    if (P.crashed && !this.ragdoll) this.startRagdoll();
    else if (!P.crashed && this.ragdoll) this.endRagdoll();
    if (this.ragdoll) this.updateRagdoll(dt);
    if (P.crashed) {
      const t = 1 - Math.max(0, P.crashTimer / 1.7);
      m.rotation.y += dt * 6 * (1 - t);
      m.rotation.z = -Math.PI / 2 * Math.min(1, t * 3);
      m.rotation.x = 0;
    } else {
      m.rotation.y = P.heading;
      m.rotation.x = P.pitch;
      m.rotation.z = -P.visLean;
    }
    const spin = (P.speed / 0.32) * dt;
    this.playerWheels[0].rotation.x += spin;
    this.playerWheels[1].rotation.x += spin;
    if (!this.ragdoll) this.posePlayerRider(dt);

    // taillight streak (flares under braking)
    if (!P.crashed && Math.abs(P.speed) > 8) {
      m.updateMatrixWorld();
      _tail.copy(this.playerTailOff).applyMatrix4(m.matrixWorld);
      const braking = this.input.state.brake > 0.3;
      this.playerTrail.push(_tail.x, _tail.y, _tail.z, this.trailClock,
        this.trailBoost * (0.5 + 0.5 * clamp(Math.abs(P.speed) / P.spec.topSpeed, 0, 1)) *
        (braking ? 1.7 : 1));
    }
    this.playerTrail.update(this.trailClock);

    // gun arm: swap with the resting arm and track the mouse
    const rider = this.playerRider;
    const showGun = this.gunOut && !P.crashed;
    rider.armR.visible = !showGun;
    rider.gunArm.visible = showGun;
    if (showGun) {
      const { origin, dir } = this.aimRay();
      rider.gunArm.lookAt(
        origin.x + dir.x * 50, origin.y + dir.y * 50, origin.z + dir.z * 50);
      // arm sweeps up from the holster while drawing — can't fire until set
      if (this.drawT > 0) rider.gunArm.rotateX((this.drawT / 0.35) * 1.2);
    }
    for (const tr of this.tracers) {
      if (tr.t > 0) {
        tr.t -= dt;
        tr.mesh.material.opacity = Math.max(0, tr.t / 0.09);
        if (tr.t <= 0) tr.mesh.visible = false;
      }
    }
    if (this.muzzleT > 0) {
      this.muzzleT -= dt;
      this.muzzleFlash.material.opacity = Math.max(0, this.muzzleT / 0.06);
      if (this.muzzleT <= 0) this.muzzleFlash.visible = false;
    }
    if (this.impactT > 0) {
      this.impactT -= dt;
      this.impactFlash.material.opacity = Math.max(0, this.impactT / 0.12);
      this.impactFlash.scale.multiplyScalar(1 + dt * 10); // bloom outward
      if (this.impactT <= 0) this.impactFlash.visible = false;
    }
    this.sparks.update(dt);

    this.playerShadow.position.set(P.x, this.groundYAt(P) + 0.03, P.z);
    this.playerShadow.rotation.z = P.heading;
    const air = clamp((P.y - this.groundYAt(P)) / 4, 0, 1);
    this.playerShadow.scale.setScalar(1 - air * 0.5);
    this.playerShadow.material.opacity = 1 - air * 0.6;

    const dirt = this.trackDef.surface === 'dirt';
    for (let i = 0; i < this.ais.length; i++) {
      const p = this.ais[i].pose();
      const g = this.aiMeshes[i].group;
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.heading;
      g.rotation.z = -p.lean;
      const ws = (this.ais[i].speed / 0.32) * dt;
      this.aiMeshes[i].wheels[0].rotation.x += ws;
      this.aiMeshes[i].wheels[1].rotation.x += ws;
      if (this.ais[i].speed > 8) {
        g.updateMatrixWorld();
        _tail.set(0, 0.92, -0.88).applyMatrix4(g.matrixWorld);
        this.aiTrails[i].push(_tail.x, _tail.y, _tail.z, this.trailClock,
          this.trailBoost * (0.4 + 0.6 * clamp(this.ais[i].speed / this.ais[i].vmax, 0, 1)));
      }
      this.aiTrails[i].update(this.trailClock);
      const aiLegDown = 1 - clamp((this.ais[i].speed - 1.2) / 2.2, 0, 1);
      let aiPose;
      if (dirt) {
        aiPose = {
          roll: 0.5 * p.lean, offX: 0, offY: 0, headRoll: 0, stand: 0.2, tuck: 0,
          legL: p.lean > 0.3 ? 1 : 0, legR: p.lean < -0.3 ? 1 : 0, kneeL: 0, kneeR: 0,
          legDown: aiLegDown,
        };
      } else {
        const ln = clamp(Math.abs(p.lean) / 0.85, 0, 1);
        const deep = ln * ln;
        aiPose = {
          roll: -p.lean * (0.1 + 0.08 * ln),
          offX: 0.22 * Math.sign(p.lean) * Math.pow(ln, 1.4),
          offY: 0.045 * deep,
          headRoll: 0.24 * p.lean,
          stand: 0, tuck: 0.4 * (1 - ln), legL: 0, legR: 0,
          kneeL: p.lean > 0.25 ? deep : 0,
          kneeR: p.lean < -0.25 ? deep : 0,
          legDown: aiLegDown,
        };
      }
      this.applyRiderPose(this.aiMeshes[i].rider, aiPose, dt);
      // shot reaction: applied DIRECTLY to the bones after the smoothed
      // pose pass (the channel filter would eat it) — a violent torso
      // twist, thrown-back recoil, and a hard head shake for ~0.6 s
      const hr = this.ais[i].hitReactT || 0;
      const rr = this.aiMeshes[i].rider;
      if (hr > 0) {
        this.ais[i].hitReactT = hr - dt;
        const k = Math.min(1, hr / 0.9);
        const w1 = Math.sin(hr * 7);
        const w2 = Math.sin(hr * 10 + 1.7);
        rr.upper.rotation.y = w1 * 1.0 * k;              // torso TWIST
        rr.upper.rotation.x += (-0.55 + w2 * 0.35) * k;  // thrown back, shuddering
        rr.upper.rotation.z += w1 * 0.4 * k;
        if (rr.head) {
          rr.head.rotation.y = w2 * 0.9 * k;             // head whips side to side
          rr.head.rotation.z = w1 * 0.55 * k;
        }
      } else if (rr.upper.rotation.y !== 0) {
        rr.upper.rotation.y = 0;
        if (rr.head) { rr.head.rotation.y = 0; rr.head.rotation.z = 0; }
      }
    }

    // skid marks: powerslides and hard braking lay rubber from the rear
    // wheel; the stripe breaks when the slide ends
    const skidding = !P.crashed && !P.airborne && P.info.onRoad &&
      Math.abs(P.speed) > 12 &&
      (P.info.sliding > 0.3 || this.input.state.brake > 0.75);
    if (skidding) {
      const strength = Math.max(P.info.sliding, this.input.state.brake * 0.6);
      this.skids.addPoint(
        P.x - Math.sin(P.heading) * 0.75,
        this.groundYAt(P),
        P.z - Math.cos(P.heading) * 0.75,
        clamp(strength, 0, 1));
    } else {
      this.skids.breakStripe();
    }

    // dust: sliding, offroad, or dirt surface at speed
    const info = P.info;
    const dusty = !P.crashed && !P.airborne &&
      (info.sliding > 0.25 || !info.onRoad || (this.trackDef.surface === 'dirt' && Math.abs(P.speed) > 18));
    if (dusty && Math.abs(P.speed) > 4) {
      const back = { x: P.x - Math.sin(P.heading) * 0.8, y: P.y + 0.15, z: P.z - Math.cos(P.heading) * 0.8 };
      this.dust.spawn(back, Math.max(info.sliding, info.onRoad ? 0.3 : 0.7));
    }
    this.dust.update(dt);

    // dip the lights while the player is inside a tunnel
    const inTunnel = this.track.isInTunnel(P.info.s) ? 1 : 0;
    if (this._tunnelDim === undefined) this._tunnelDim = 0;
    this._tunnelDim += (inTunnel - this._tunnelDim) * Math.min(1, dt * 5);
    this.track.setLightDim(this._tunnelDim);

    this.updateCamera(dt);
  }

  groundYAt(P) {
    return this.track.samples[P.hintIdx ?? 0].y;
  }

  // Rider body language — the Moto Racer touch. Asphalt: hang off the inside
  // of the corner and tuck on the straights. Dirt: stay upright while the
  // bike leans (leg out toward the apex) and stand on the pegs over
  // whoops and jumps.
  // --- arcade ragdoll: on crash the rider detaches from the bike and is
  // thrown along the crash velocity, tumbling, limbs flailing, bouncing
  // and sliding out on the tarmac until the respawn re-seats them.
  startRagdoll() {
    const r = this.playerRider;
    const g = r.group;
    this._ragSaved = {
      pos: g.position.clone(),
      quat: g.quaternion.clone(),
      scale: g.scale.clone(),
    };
    this.playerMesh.updateWorldMatrix(true, true); // don't detach off a stale matrix
    this.scene.attach(g); // keep world transform, leave the bike
    const P = this.player;
    const v0 = P.crashSpeed || P.speed; // crash() zeroes speed — use the impact speed
    this.ragdoll = {
      vel: new THREE.Vector3(
        Math.sin(P.heading) * v0 * 0.8 + (Math.random() - 0.5) * 4,
        4.5 + Math.random() * 3,
        Math.cos(P.heading) * v0 * 0.8 + (Math.random() - 0.5) * 4),
      angVel: new THREE.Vector3(
        (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 16),
      grounded: false,
      flailT: 0,
      joints: [r.armL, r.armR, r.elbowL, r.elbowR, r.legL, r.legR, r.shinL, r.shinR]
        .filter(Boolean),
      targets: [],
      hint: null,
    };
  }

  updateRagdoll(dt) {
    const rd = this.ragdoll;
    const g = this.playerRider.group;
    rd.vel.y -= 22 * dt;
    g.position.addScaledVector(rd.vel, dt);
    const q = this.track.nearest(g.position.x, g.position.z, rd.hint);
    rd.hint = q.index;
    const gy = (q.sample ? q.sample.y : 0) + 0.35;
    if (g.position.y <= gy) {
      g.position.y = gy;
      if (rd.vel.y < -3) {
        rd.vel.y = -rd.vel.y * 0.3; // hard bounce
        this.dust.spawn({ x: g.position.x, y: gy, z: g.position.z }, 3);
      } else {
        rd.vel.y = 0;
        rd.grounded = true;
      }
      // sliding friction + spin bleeding off
      const fr = Math.pow(0.12, dt);
      rd.vel.x *= fr; rd.vel.z *= fr;
      rd.angVel.multiplyScalar(Math.pow(0.06, dt));
    }
    g.rotation.x += rd.angVel.x * dt;
    g.rotation.y += rd.angVel.y * dt;
    g.rotation.z += rd.angVel.z * dt;
    // limb flail: joints chase fresh random targets every ~0.15 s while
    // airborne, then settle limp once sliding
    rd.flailT -= dt;
    if (rd.flailT <= 0) {
      rd.flailT = 0.1 + Math.random() * 0.12;
      rd.targets = rd.joints.map(() => rd.grounded
        ? { x: (Math.random() - 0.5) * 0.5, z: (Math.random() - 0.5) * 0.4 }
        : { x: (Math.random() - 0.5) * 2.4, z: (Math.random() - 0.5) * 2.0 });
    }
    const k = Math.min(1, dt * (rd.grounded ? 4 : 11));
    rd.joints.forEach((j, i) => {
      const tgt = rd.targets[i] || { x: 0, z: 0 };
      j.rotation.x += (tgt.x - j.rotation.x) * k;
      j.rotation.z += (tgt.z - j.rotation.z) * k;
    });
  }

  endRagdoll() {
    const g = this.playerRider.group;
    this.playerMesh.add(g); // re-seat on the bike
    g.position.copy(this._ragSaved.pos);
    g.quaternion.copy(this._ragSaved.quat);
    g.scale.copy(this._ragSaved.scale);
    for (const j of this.ragdoll.joints) j.rotation.set(0, 0, 0);
    this.ragdoll = null;
  }

  posePlayerRider(dt) {
    const P = this.player;
    const dirt = this.trackDef.surface === 'dirt';
    const lean = P.visLean;
    // below walking pace the left foot comes down for balance; it lifts
    // back to the peg once there's enough speed to stay upright
    const legDown = !P.airborne && !P.crashed
      ? 1 - clamp((Math.abs(P.speed) - 1.2) / 2.2, 0, 1)
      : 0;
    let t;
    if (dirt) {
      t = {
        roll: 0.5 * lean, // counter-lean: rider stays more upright than the bike
        offX: 0.05 * clamp(lean / 0.8, -1, 1),
        offY: 0,
        headRoll: 0,
        stand: P.airborne ? 1 : Math.abs(P.vy) > 0.7 ? 0.55 : 0.15,
        tuck: 0,
        legL: lean > 0.28 ? 1 : 0, // inside leg out, motocross style
        legR: lean < -0.28 ? 1 : 0,
        kneeL: 0,
        kneeR: 0,
        legDown,
      };
    } else {
      // road-race hang-off, Moto Racer style: the commitment grows
      // nonlinearly with lean — at full angle the rider is off the seat,
      // dropped beside the tank, inside knee out, head held level-ish
      const ln = clamp(Math.abs(lean) / 0.85, 0, 1);
      const deep = ln * ln;
      t = {
        roll: -lean * (0.1 + 0.08 * ln),
        offX: 0.24 * Math.sign(lean) * Math.pow(ln, 1.4), // a real slide off the seat
        offY: 0.045 * deep, // cheek lifts off the seat edge — NOT a drop:
        // any downward pelvis shift at 53° of lean puts the hip in the road
        headRoll: 0.24 * lean, // head counters the roll to stay level
        stand: P.airborne ? 0.35 : 0,
        tuck: clamp(Math.abs(P.speed) / P.spec.topSpeed, 0, 1) * (1 - ln),
        legL: 0,
        legR: 0,
        kneeL: lean > 0.25 ? deep : 0, // knee-down on the inside
        kneeR: lean < -0.25 ? deep : 0,
        legDown,
      };
    }
    if (P.crashed) {
      t.roll = 0; t.offX = 0; t.offY = 0; t.headRoll = 0;
      t.stand = 0; t.legL = 0; t.legR = 0; t.kneeL = 0; t.kneeR = 0;
      t.legDown = 0;
    }
    this.applyRiderPose(this.playerRider, t, dt);
  }

  applyRiderPose(rider, targets, dt) {
    const p = rider.pose;
    // per-channel response: the big mass shifts (roll, slide across the
    // seat) lag the bike — that lag is what reads as body WEIGHT
    for (const key in targets) {
      const rate = POSE_RATES[key] || 6;
      p[key] += (targets[key] - p[key]) * (1 - Math.exp(-dt * rate));
    }
    const baseY = rider.baseY ?? 0.8;
    rider.group.rotation.z = p.roll;
    // planting the foot pulls the body over it and dips it off the seat —
    // that dip is also what lets the boot actually reach the tarmac
    rider.group.position.x = p.offX + p.legDown * 0.08;
    rider.group.position.y = baseY + p.stand * 0.14 + p.offY - p.legDown * 0.12;
    rider.upper.rotation.x = p.tuck * 0.18 - p.stand * 0.5;
    rider.upper.rotation.z = p.headRoll;
    // legs: two-bone IK with the feet PINNED to the pegs. Standing, hanging
    // off, knee-down, foot-down-at-rest — the articulation emerges from the
    // constraint instead of baked angles, so nothing can clip the road.
    const bikeQ = rider.group.parent.quaternion;
    this.solveLegIK(rider, 1, p.legL, p.kneeL, bikeQ, p.legDown);
    this.solveLegIK(rider, -1, p.legR, p.kneeR, bikeQ, 0);
    // arms: same treatment — gloves pinned to the handlebar grips
    this.solveArmIK(rider, 1);
    this.solveArmIK(rider, -1);
  }

  // Two-bone arm IK: the shoulder anchor rides the torso's rotations, the
  // glove is pinned to the grip, the elbow hangs out-and-down. However far
  // the body hangs off, the hands stay on the bars.
  solveArmIK(rider, side) {
    const arm = side === 1 ? rider.armL : rider.armR;
    const elbow = side === 1 ? rider.elbowL : rider.elbowR;
    if (!arm || !elbow) return;
    const L1 = rider.armL1, L2 = rider.armL2;
    // shoulder anchor in rider space, following tuck/stand/head-counter
    _ikHip.copy(side === 1 ? rider.shoulderL : rider.shoulderR)
      .applyQuaternion(rider.upper.quaternion);
    arm.position.copy(_ikHip);
    // grip target: bike space → rider-local (undo hang-off slide/roll)
    _ikF.copy(side === 1 ? rider.gripL : rider.gripR);
    _ikQi.copy(rider.group.quaternion).invert();
    _ikF.sub(rider.group.position).applyQuaternion(_ikQi);
    // elbows point outward, down and slightly back
    _ikPole.set(side * 0.9, -0.45, -0.2);
    this.ikSolve(_ikHip, _ikF, _ikPole, L1, L2, _ikKnee, _ikF2);
    _ikTmp.subVectors(_ikKnee, _ikHip).normalize();
    arm.quaternion.setFromUnitVectors(_DOWN, _ikTmp);
    _ikTmp.subVectors(_ikF2, _ikKnee).normalize();
    _ikQi.copy(arm.quaternion).invert();
    _ikTmp.applyQuaternion(_ikQi);
    elbow.quaternion.setFromUnitVectors(_DOWN, _ikTmp);
  }

  // MotoGP-style leg solve. `outAmt` throws the foot forward-out (MX
  // leg-out); `kneeAmt` swings the knee's pole vector outward (knee-down).
  // The pole backs off automatically if the knee would touch the road.
  solveLegIK(rider, side, outAmt, kneeAmt, bikeQ, downAmt = 0) {
    const leg = side === 1 ? rider.legL : rider.legR;
    const shin = side === 1 ? rider.shinL : rider.shinR;
    if (!shin) return;
    const L1 = 0.3, L2 = 0.3;

    // foot target in bike space
    _ikF.copy(side === 1 ? rider.footL : rider.footR);
    if (outAmt > 0.01) _ikF.lerp(_ikTmp.set(0.5 * side, 0.45, 0.55), outAmt);
    // stopped: the left boot reaches down to the tarmac for balance
    if (downAmt > 0.01) _ikF.lerp(rider.footDownL, downAmt);
    // hard rule: the foot never dips into the road (a deliberately planted
    // foot is allowed right down to the tarmac)
    const floorY = 0.07 - downAmt * 0.05;
    _ikTmp.copy(_ikF).applyQuaternion(bikeQ);
    if (_ikTmp.y < floorY) {
      const upY = Math.max(0.35, _ikTmp2.set(0, 1, 0).applyQuaternion(bikeQ).y);
      _ikF.y += (floorY - _ikTmp.y) / upY;
    }
    // into rider-local space (undo the hang-off roll/slide)
    _ikQi.copy(rider.group.quaternion).invert();
    _ikF.sub(rider.group.position).applyQuaternion(_ikQi);
    _ikHip.set(0.17 * side, -0.02, 0);

    // pole vector: knee forward at rest, swinging outward for knee-down;
    // retry with less swing while the knee would clip the ground
    let amt = kneeAmt;
    for (let iter = 0; iter < 4; iter++) {
      _ikPole.set(side * (0.15 + 0.9 * amt), 0.25 - 0.35 * amt, 1 - 0.8 * amt);
      this.ikSolve(_ikHip, _ikF, _ikPole, L1, L2, _ikKnee, _ikF2);
      _ikTmp.copy(_ikKnee).applyQuaternion(rider.group.quaternion)
        .add(rider.group.position).applyQuaternion(bikeQ);
      if (_ikTmp.y > 0.04 || amt < 0.03) break;
      amt *= 0.5;
    }

    // orient the bones (local -Y is the bone axis)
    _ikTmp.subVectors(_ikKnee, _ikHip).normalize();
    leg.quaternion.setFromUnitVectors(_DOWN, _ikTmp);
    _ikTmp.subVectors(_ikF2, _ikKnee).normalize();
    _ikQi.copy(leg.quaternion).invert();
    _ikTmp.applyQuaternion(_ikQi);
    shin.quaternion.setFromUnitVectors(_DOWN, _ikTmp);
  }

  // classic two-bone solve: knee on the reach circle, placed toward `pole`.
  // outFoot gets the (possibly clamped-to-reach) effective foot position.
  ikSolve(H, F, pole, L1, L2, outKnee, outFoot) {
    _ikD.subVectors(F, H);
    const dRaw = _ikD.length();
    const d = clamp(dRaw, 0.08, L1 + L2 - 0.015);
    _ikDir.copy(_ikD).normalize();
    outFoot.copy(H).addScaledVector(_ikDir, d);
    const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const a = Math.acos(cosA);
    _ikTmp2.copy(pole).addScaledVector(_ikDir, -pole.dot(_ikDir));
    if (_ikTmp2.lengthSq() < 1e-5) _ikTmp2.set(0, 0, 1);
    _ikTmp2.normalize();
    outKnee.copy(H).addScaledVector(_ikDir, Math.cos(a) * L1)
      .addScaledVector(_ikTmp2, Math.sin(a) * L1);
  }

  snapCamera() {
    const P = this.player;
    this.camera.position.set(
      P.x - Math.sin(P.heading) * 8, P.y + 3.4, P.z - Math.cos(P.heading) * 8);
    this.camera.lookAt(P.x, P.y + 1.2, P.z);
  }

  updateCamera(dt) {
    const P = this.player;

    // bullet time: camera whips round to the front, facing back down the road
    if (this.btActive) {
      const tx = P.x + Math.sin(P.heading) * 6.0;
      const tz = P.z + Math.cos(P.heading) * 6.0;
      const ty = P.y + 2.3;
      const k = 1 - Math.exp(-dt * 26); // dt is slowed — snap around fast
      this.camera.position.x += (tx - this.camera.position.x) * k;
      this.camera.position.z += (tz - this.camera.position.z) * k;
      this.camera.position.y += (ty - this.camera.position.y) * k;
      this.camera.lookAt(P.x - Math.sin(P.heading) * 8, P.y + 1.0, P.z - Math.cos(P.heading) * 8);
      if (Math.abs(this.camera.fov - 58) > 0.2) {
        this.camera.fov = 58;
        this.camera.updateProjectionMatrix();
      }
      return;
    }

    // low and close, pulling back and widening with speed — this is where
    // most of the sensation of speed comes from
    const frac = clamp(Math.abs(P.speed) / this.player.spec.topSpeed, 0, 1);
    const dist = 6.4 + 1.4 * frac;
    const height = 2.45 + 0.5 * frac;
    const tx = P.x - Math.sin(P.heading) * dist;
    const tz = P.z - Math.cos(P.heading) * dist;
    const ty = P.y + height;
    const k = 1 - Math.exp(-dt * 6);
    this.camera.position.x += (tx - this.camera.position.x) * k;
    this.camera.position.z += (tz - this.camera.position.z) * k;
    this.camera.position.y += (ty - this.camera.position.y) * (1 - Math.exp(-dt * 4));
    this.camera.lookAt(
      P.x + Math.sin(P.heading) * 9,
      P.y + 1.0 + P.vy * 0.05,
      P.z + Math.cos(P.heading) * 9);
    this.camera.rotation.z += P.visLean * 0.12; // subtle roll with the bike
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.2);
      this.camera.rotation.z += (Math.random() - 0.5) * this.shake * 0.12;
      this.camera.rotation.x += (Math.random() - 0.5) * this.shake * 0.05;
    }
    // continuous vibration: creeps in past ~70% of top speed (the bars are
    // ALIVE up there) and rumbles hard off-road — pure sense-of-speed
    const vib = Math.max(0, frac - 0.68) * 0.9 +
      (!P.info.onRoad && Math.abs(P.speed) > 8 && !P.airborne ? 0.22 : 0);
    if (vib > 0 && !P.crashed) {
      this.camera.rotation.z += (Math.random() - 0.5) * vib * 0.02;
      this.camera.rotation.x += (Math.random() - 0.5) * vib * 0.012;
      this.camera.position.y += (Math.random() - 0.5) * vib * 0.05;
    }
    // FOV: widens with speed, plus a kick under hard acceleration (the
    // world stretches when the bike lunges) that eases back at cruise
    this._prevSpd = this._prevSpd ?? P.speed;
    const accel = (P.speed - this._prevSpd) / Math.max(dt, 0.001);
    this._prevSpd = P.speed;
    this._accelSm = (this._accelSm ?? 0) + (accel - (this._accelSm ?? 0)) * Math.min(1, dt * 2.5);
    const fov = 60 + 26 * frac + clamp(this._accelSm * 0.5, -3, 6);
    if (Math.abs(fov - this.camera.fov) > 0.2) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  updateHud(dt) {
    const h = this.hud;
    const P = this.player;
    if (this.raceT < 0) {
      h.mode = 'countdown';
      const c = Math.ceil(-this.raceT);
      h.countdown = c;
      if (c < this.lastBeep && c > 0) { this.audio.beep(440); this.lastBeep = c; }
    } else if (!h.finished) {
      if (h.mode === 'countdown') { this.audio.beep(880, 0.3); }
      h.mode = 'race';
      h.time = this.raceT;
    }
    h.speedKmh = Math.round(Math.abs(P.speed) * 3.6);
    h.gear = P.info.gear;
    h.rpm = P.info.rpm;
    h.distKm = Math.min(this.playerProgress, this.track.finishS) / 1000;
    h.remainKm = Math.max(0, this.track.finishS - this.playerProgress) / 1000;
    h.airborne = P.airborne;
    h.wheelie = P.wheelie;

    let pos = 1;
    let remaining = 1;
    for (const ai of this.ais) {
      if (ai.eliminated) continue;
      remaining++;
      if (ai.progress > this.playerProgress) pos++;
    }
    h.position = pos;
    if (h.knockout) {
      h.knockout.nextIn = Math.max(0, Math.ceil(this.elimT));
      h.knockout.remaining = remaining;
      h.racers = remaining;
    }

    if (P.info.crashedNow) { this.flash('CRASHED!'); this.audio.thud(); }
    else if (P.info.landed > 7) { this.flash('HARD LANDING'); this.audio.thud(); }
    if (h.messageT > 0) {
      h.messageT -= dt;
      if (h.messageT <= 0) h.message = '';
    }
    h.gunOut = this.gunOut;
    h.mouseX = this.input.mouse.x;
    h.mouseY = this.input.mouse.y;
    if (h.hitT > 0) h.hitT -= dt;
    if (h.gunshipInfo && h.gunshipInfo.t > 0) {
      h.gunshipInfo.t -= dt;
      if (h.gunshipInfo.t <= 0) h.gunshipInfo = null;
    }
    if (h.launcherInfo && h.launcherInfo.t > 0) {
      h.launcherInfo.t -= dt;
      if (h.launcherInfo.t <= 0) h.launcherInfo = null;
    }
    h.stunT = this.player.stunTimer;
    h.bt = this.btActive;
    h.btMeter = this.btMeter;

    h.mini.player[0] = P.x; h.mini.player[1] = P.z;
    if (this.mode === 'package' && this.pkg) {
      h.mini.pkg = [this.pkgMesh.position.x, this.pkgMesh.position.z];
    }
    for (let i = 0; i < this.ais.length; i++) {
      const p = this.ais[i].pose();
      h.mini.ais[i][0] = p.x; h.mini.ais[i][1] = p.z;
    }
  }

  flash(msg) {
    this.hud.message = msg;
    this.hud.messageT = 2.2;
  }

  updateAudio() {
    const P = this.player;
    // quickshifter blip on upshifts under power
    if (P.info.gear > this._lastGear && this.input.state.throttle > 0.5 && !P.crashed) {
      this.audio.shiftCut();
    }
    this._lastGear = P.info.gear;
    this.audio.setEngine(P.info.rpm, this.input.state.throttle, P.info.gear,
      Math.min(1, Math.abs(P.speed) / 75));
    this.audio.setWind(Math.min(1, Math.abs(P.speed) / 78), this.player.draft || 0);

    // spatial: listener rides the camera; every AI bike is a positional drone
    this.camera.getWorldDirection(_fwd);
    this.audio.updateListener(this.camera.position, _fwd);
    this.audio.ensureAIEngines(this.ais.length);
    for (let i = 0; i < this.ais.length; i++) {
      const p = this.ais[i].pose();
      const d = Math.hypot(p.x - this.player.x, p.z - this.player.z);
      this.audio.setAIEngine(
        i, p.x, p.y, p.z,
        clamp(this.ais[i].speed / this.ais[i].vmax, 0, 1),
        d < 180);
    }
    const slide = P.crashed ? 0 : Math.max(P.info.sliding, P.info.onRoad || P.airborne ? 0 : 0.6);
    this.audio.setSlide(Math.abs(P.speed) > 3 ? slide : 0);
  }

  computeMiniPath() {
    const pts = [];
    const step = Math.max(3, Math.round(this.track.N / 360));
    for (let i = 0; i < this.track.N; i += step) {
      pts.push([this.track.samples[i].x, this.track.samples[i].z]);
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const span = Math.max(maxX - minX, maxZ - minZ);
    const scale = 92 / span;
    const ox = (100 - (maxX - minX) * scale) / 2 - minX * scale;
    const oz = (100 - (maxZ - minZ) * scale) / 2 - minZ * scale;
    this.miniTransform = ([x, z]) => [x * scale + ox, z * scale + oz];
    return pts.map(this.miniTransform);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.input.detach();
    this.audio.dispose();
    window.removeEventListener('resize', this._resize);
    window.removeEventListener('keydown', this._keydown);
    window.removeEventListener('keydown', this._gesture);
    window.removeEventListener('pointerdown', this._gesture);
    this.track.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); }
      }
    });
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}

// -------------------------------------------------------------- light trails

// Akira streak: a ribbon of recent taillight positions, additive-blended,
// fading by age via vertex COLOR (darker = more transparent under additive
// blending, so no shader needed). Runs on game-time, so bullet time leaves
// the streaks hanging in the air.
class LightTrail {
  constructor(scene, color, life) {
    this.life = life;
    this.max = 26;
    this.pts = [];
    this.color = new THREE.Color(color);
    this.posArr = new Float32Array(this.max * 6);
    this.colArr = new Float32Array(this.max * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colArr, 3));
    const idx = [];
    for (let i = 0; i < this.max - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  clear() {
    this.pts.length = 0;
    this.geo.setDrawRange(0, 0);
  }

  push(x, y, z, t, intensity) {
    this.pts.push({ x, y, z, t, i: intensity });
    if (this.pts.length > this.max) this.pts.shift();
  }

  update(now) {
    while (this.pts.length && now - this.pts[0].t > this.life) this.pts.shift();
    const n = this.pts.length;
    if (n < 2) { this.geo.setDrawRange(0, 0); return; }
    for (let k = 0; k < n; k++) {
      const p = this.pts[k];
      const fade = Math.pow(Math.max(0, 1 - (now - p.t) / this.life), 1.6) * p.i;
      const o = k * 6;
      this.posArr[o] = p.x; this.posArr[o + 1] = p.y + 0.09; this.posArr[o + 2] = p.z;
      this.posArr[o + 3] = p.x; this.posArr[o + 4] = p.y - 0.09; this.posArr[o + 5] = p.z;
      const r = this.color.r * fade, g = this.color.g * fade, b = this.color.b * fade;
      this.colArr[o] = r; this.colArr[o + 1] = g; this.colArr[o + 2] = b;
      this.colArr[o + 3] = r; this.colArr[o + 4] = g; this.colArr[o + 5] = b;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
  }
}

// -------------------------------------------------------------- dust

class DustParticles {
  constructor(scene, color, opts = {}) {
    this.count = opts.count || 180;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.count * 3);
    this.vel = new Float32Array(this.count * 3);
    this.life = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) this.pos[i * 3 + 1] = -999;
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      color, size: opts.size || 0.55, transparent: true,
      opacity: opts.opacity || 0.55, depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      map: opts.map || softDotTexture(), // soft puffs unless told otherwise
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.next = 0;
    this.burstLife = opts.burstLife || 0.45; // ± ~35%
    this.gravity = opts.gravity ?? 2.5;      // negative = buoyant (smoke)
    this.burstScale = opts.burstScale || 1;  // quantity multiplier for burst()
  }

  // radial explosion (bullet impacts): particles fly out in a sphere
  burst(at, n, speed) {
    n = Math.round(n * this.burstScale);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.count;
      this.pos[i * 3] = at.x;
      this.pos[i * 3 + 1] = at.y;
      this.pos[i * 3 + 2] = at.z;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const v = speed * (0.4 + Math.random() * 0.6);
      this.vel[i * 3] = Math.sin(ph) * Math.cos(th) * v;
      this.vel[i * 3 + 1] = Math.abs(Math.cos(ph)) * v;
      this.vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * v;
      this.life[i] = this.burstLife * (0.65 + Math.random() * 0.7);
    }
  }

  spawn(at, intensity) {
    const n = Math.ceil(intensity * 3);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.count;
      this.pos[i * 3] = at.x + (Math.random() - 0.5) * 0.5;
      this.pos[i * 3 + 1] = at.y;
      this.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * 0.5;
      this.vel[i * 3] = (Math.random() - 0.5) * 2.5;
      this.vel[i * 3 + 1] = 1.2 + Math.random() * 2;
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * 2.5;
      this.life[i] = 0.7 + Math.random() * 0.5;
    }
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -999; continue; }
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= this.gravity * dt;
    }
    this.geo.attributes.position.needsUpdate = true;
  }
}

export function formatTime(t) {
  if (t == null) return '—';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}'${s.toFixed(2).padStart(5, '0')}"`;
}
