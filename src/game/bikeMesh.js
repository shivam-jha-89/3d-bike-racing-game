import * as THREE from 'three';
import { makeLivery, makeSuit, makeHelmet, makeTire } from './textures.js';

// Procedural motorcycle + rider, still asset-free but with real silhouettes:
// torus tyres with hubs/discs/spokes, raked forks, fenders, fairing or MX
// plastics depending on `style`, a segmented rider (helmet+visor, two-piece
// arms, thigh/shin/boot legs), and a proper pistol for the gun arm.
//
// Built facing +Z, pivot at the ground contact point. Interface used by
// Game: { group, wheels[front,rear], rider: { group, upper, legL, legR,
// shinL, shinR, armR, gunArm, muzzle, pose } }.

function makeMaterials(colors, number = 0) {
  return {
    paint: new THREE.MeshPhongMaterial({ color: colors.body, shininess: 70, specular: 0x666666 }),
    // race-number livery: goes on the tank/tail (road), shrouds/plate (MX),
    // rear cowl (akira)
    livery: new THREE.MeshPhongMaterial({
      map: makeLivery(colors.body, colors.accent, number),
      shininess: 70, specular: 0x666666,
    }),
    accent: new THREE.MeshPhongMaterial({ color: colors.accent, shininess: 50, specular: 0x444444 }),
    metal: new THREE.MeshPhongMaterial({ color: 0x8a8f98, shininess: 90, specular: 0x888888 }),
    chrome: new THREE.MeshPhongMaterial({ color: 0xcfd4dc, shininess: 130, specular: 0xaaaaaa }),
    dark: new THREE.MeshLambertMaterial({ color: 0x1a1a1e }),
    tire: new THREE.MeshLambertMaterial({ map: makeTire() }),
    seat: new THREE.MeshLambertMaterial({ color: 0x15151a }),
    suit: new THREE.MeshLambertMaterial({ map: makeSuit(colors.rider) }),
    suitDark: new THREE.MeshLambertMaterial({ color: 0x0e0e12 }),
    helmet: new THREE.MeshPhongMaterial({
      map: makeHelmet(colors.helmet, colors.accent),
      shininess: 100, specular: 0x999999,
    }),
    visor: new THREE.MeshPhongMaterial({ color: 0x1a2a3a, shininess: 150, specular: 0xbbbbbb }),
    glass: new THREE.MeshPhongMaterial({
      color: 0x88aacc, shininess: 150, specular: 0xffffff,
      transparent: true, opacity: 0.45,
    }),
  };
}

// wheel: tyre torus + hub + brake disc + three spoke bars (they spin too)
function makeWheel(M, { r = 0.32, tube = 0.07, disc = true }) {
  const w = new THREE.Group();
  const tyreGeo = new THREE.TorusGeometry(r - tube * 0.7, tube, 8, 18);
  tyreGeo.rotateY(Math.PI / 2); // axle along X
  w.add(new THREE.Mesh(tyreGeo, M.tire));
  const hubGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.14, 10);
  hubGeo.rotateZ(Math.PI / 2);
  w.add(new THREE.Mesh(hubGeo, M.metal));
  if (disc) {
    const discGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.015, 16);
    discGeo.rotateZ(Math.PI / 2);
    const d = new THREE.Mesh(discGeo, M.chrome);
    d.position.x = 0.055;
    w.add(d);
  }
  const spokeGeo = new THREE.BoxGeometry(0.025, (r - tube * 0.6) * 2, 0.045);
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(spokeGeo, M.dark);
    s.rotation.x = (i * Math.PI) / 3;
    w.add(s);
  }
  return w;
}

// fender: torus arc hugging the wheel
function makeFender(M, { r, tube = 0.045, arc = Math.PI * 0.55, start = Math.PI * 0.25 }, mat) {
  const geo = new THREE.TorusGeometry(r, tube, 6, 10, arc);
  geo.rotateZ(start);
  geo.rotateY(Math.PI / 2);
  return new THREE.Mesh(geo, mat || M.paint);
}

function buildSportBody(grp, M) {
  // raked front forks + triple clamp — tubes run from the steering head
  // DOWN AND FORWARD to the front axle (top back, bottom front: caster)
  const forkGeo = new THREE.CylinderGeometry(0.032, 0.036, 0.72, 8);
  for (const side of [1, -1]) {
    const fork = new THREE.Mesh(forkGeo, M.chrome);
    fork.position.set(0.085 * side, 0.63, 0.58); // midpoint clamp->axle
    fork.rotation.x = -0.425;
    grp.add(fork);
  }
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1, 0.14), M.dark);
  clamp.position.set(0, 0.945, 0.435);
  clamp.rotation.x = -0.425;
  grp.add(clamp);

  // front fender
  const fFender = makeFender(M, { r: 0.4, arc: Math.PI * 0.6, start: Math.PI * 0.2 });
  fFender.position.set(0, 0.32, 0.72);
  grp.add(fFender);

  // fairing nose + headlight + windscreen
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.55), M.paint);
  nose.position.set(0, 0.74, 0.42);
  nose.rotation.x = -0.28;
  grp.add(nose);
  const light = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.09, 0.03), M.accent);
  light.position.set(0, 0.72, 0.7);
  light.rotation.x = -0.28;
  grp.add(light);
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.02), M.glass);
  screen.position.set(0, 0.97, 0.38);
  screen.rotation.x = -0.62;
  grp.add(screen);

  // side fairings (taper the body)
  for (const side of [1, -1]) {
    const fair = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.72), M.paint);
    fair.position.set(0.155 * side, 0.52, 0.12);
    fair.rotation.z = -0.12 * side;
    grp.add(fair);
  }

  // tank + seat + tail unit
  const tank = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.48), M.livery);
  tank.position.set(0, 0.86, 0.02);
  tank.rotation.x = 0.12;
  grp.add(tank);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.42), M.seat);
  seat.position.set(0, 0.84, -0.42);
  grp.add(seat);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.4), M.livery);
  tail.position.set(0, 0.9, -0.72);
  tail.rotation.x = 0.32;
  grp.add(tail);
  const tailLight = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.02), new THREE.MeshBasicMaterial({ color: 0xdd2222 }));
  tailLight.position.set(0, 0.95, -0.9);
  grp.add(tailLight);

  // engine + radiator
  const engine = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.44), M.dark);
  engine.position.set(0, 0.42, 0.02);
  grp.add(engine);
  const caseGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.3, 10);
  caseGeo.rotateZ(Math.PI / 2);
  const cases = new THREE.Mesh(caseGeo, M.metal);
  cases.position.set(0, 0.34, -0.08);
  grp.add(cases);
  const radiator = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.04), M.dark);
  radiator.position.set(0, 0.52, 0.34);
  radiator.rotation.x = -0.2;
  grp.add(radiator);

  // swingarm + chain side
  for (const side of [1, -1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.07, 0.5), M.metal);
    arm.position.set(0.09 * side, 0.32, -0.45);
    grp.add(arm);
  }

  // upswept exhaust
  const pipeGeo = new THREE.CylinderGeometry(0.035, 0.045, 0.55, 8);
  pipeGeo.rotateX(Math.PI / 2);
  const pipe = new THREE.Mesh(pipeGeo, M.chrome);
  pipe.position.set(0.13, 0.32, 0.02);
  grp.add(pipe);
  const mufGeo = new THREE.CylinderGeometry(0.055, 0.07, 0.42, 9);
  mufGeo.rotateX(Math.PI / 2);
  const muffler = new THREE.Mesh(mufGeo, M.chrome);
  muffler.position.set(0.16, 0.5, -0.55);
  muffler.rotation.x = -0.35;
  grp.add(muffler);

  // clip-on bars
  const barGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.5, 6);
  barGeo.rotateZ(Math.PI / 2);
  const bar = new THREE.Mesh(barGeo, M.dark);
  bar.position.set(0, 1.0, 0.42);
  grp.add(bar);
  // rearset footpegs (the IK feet pin here)
  for (const side of [1, -1]) {
    const peg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.025, 0.12), M.dark);
    peg.position.set(0.21 * side, 0.39, -0.18);
    grp.add(peg);
  }
}

function buildCrossBody(grp, M) {
  // long exposed forks: steering head (0,1.02,0.42) down to the axle at
  // (0,0.32,0.72), tops poking past the clamps the MX way
  const forkGeo = new THREE.CylinderGeometry(0.034, 0.038, 0.95, 8);
  for (const side of [1, -1]) {
    const fork = new THREE.Mesh(forkGeo, M.chrome);
    fork.position.set(0.085 * side, 0.67, 0.57); // midpoint head->axle
    fork.rotation.x = -0.405;
    grp.add(fork);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 0.08), M.accent);
    guard.position.set(0.085 * side, 0.72, 0.585); // upper tube cover
    guard.rotation.x = -0.405;
    grp.add(guard);
  }

  // high MX front fender + number plate
  const fFender = makeFender(M, { r: 0.42, arc: Math.PI * 0.5, start: Math.PI * 0.28 });
  fFender.position.set(0, 0.62, 0.62);
  fFender.scale.set(1, 1, 1.25);
  grp.add(fFender);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.02), M.livery);
  plate.position.set(0, 0.98, 0.62);
  plate.rotation.x = 0.35;
  grp.add(plate);

  // small tank + long flat seat rising over the rear fender
  const tank = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.32), M.paint);
  tank.position.set(0, 0.86, 0.14);
  tank.rotation.x = 0.15;
  grp.add(tank);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.07, 0.8), M.seat);
  seat.position.set(0, 0.87, -0.32);
  seat.rotation.x = 0.08;
  grp.add(seat);
  const rFender = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.45), M.paint);
  rFender.position.set(0, 0.93, -0.78);
  rFender.rotation.x = 0.25;
  grp.add(rFender);

  // shrouds (radiator plastics)
  for (const side of [1, -1]) {
    const shroud = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.34), M.livery);
    shroud.position.set(0.15 * side, 0.72, 0.22);
    shroud.rotation.z = -0.22 * side;
    shroud.rotation.y = 0.18 * side;
    grp.add(shroud);
  }

  // compact engine + skid plate
  const engine = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.3, 0.36), M.dark);
  engine.position.set(0, 0.42, 0.0);
  grp.add(engine);
  const skid = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.5), M.metal);
  skid.position.set(0, 0.24, 0.02);
  grp.add(skid);

  // swingarm
  for (const side of [1, -1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.08, 0.5), M.metal);
    arm.position.set(0.08 * side, 0.33, -0.42);
    grp.add(arm);
  }

  // two-stroke expansion chamber + stubby silencer
  const chamber1 = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.1, 0.32, 8), M.metal);
  chamber1.position.set(0.14, 0.56, 0.22);
  chamber1.rotation.x = 1.35;
  grp.add(chamber1);
  const chamber2 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.05, 0.3, 8), M.metal);
  chamber2.position.set(0.15, 0.6, -0.08);
  chamber2.rotation.x = 1.72;
  grp.add(chamber2);
  const silencer = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 8), M.chrome);
  silencer.position.set(0.14, 0.72, -0.5);
  silencer.rotation.x = 1.62;
  grp.add(silencer);

  // MX footpegs (the IK feet pin here)
  for (const side of [1, -1]) {
    const peg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.025, 0.12), M.dark);
    peg.position.set(0.22 * side, 0.37, -0.08);
    grp.add(peg);
  }
  // wide MX bars with crossbrace
  const barGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.62, 6);
  barGeo.rotateZ(Math.PI / 2);
  const bar = new THREE.Mesh(barGeo, M.dark);
  bar.position.set(0, 1.06, 0.4);
  grp.add(bar);
  const braceGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.3, 5);
  braceGeo.rotateZ(Math.PI / 2);
  const brace = new THREE.Mesh(braceGeo, M.accent);
  brace.position.set(0, 1.11, 0.42);
  grp.add(brace);
}

function buildRider(M, style) {
  const akira = style === 'akira';
  const riderGroup = new THREE.Group();
  // akira: low seat, further back, reclined against the rear cowl
  riderGroup.position.set(0, akira ? 0.62 : 0.8, akira ? -0.36 : -0.3);

  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.26), M.suit);
  pelvis.position.set(0, 0.02, 0);
  riderGroup.add(pelvis);

  // --- upper body (pivots at the hips for tuck / standing)
  const torsoTilt = akira ? 0.32 : 0.8; // Kaneda sits UP, racers lie down
  const upper = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.46, 0.22), M.suit);
  torso.position.set(0, akira ? 0.36 : 0.32, akira ? 0.05 : 0.12);
  torso.rotation.x = torsoTilt;
  upper.add(torso);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.26, 0.06), M.suitDark);
  chest.position.set(0, akira ? 0.37 : 0.33, akira ? 0.17 : 0.26);
  chest.rotation.x = torsoTilt;
  upper.add(chest);
  for (const side of [1, -1]) {
    const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.14), M.suitDark);
    shoulder.position.set(0.2 * side, akira ? 0.5 : 0.44, akira ? 0.1 : 0.26);
    upper.add(shoulder);
  }
  if (style === 'sport') {
    // aero hump on the back
    const hump = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), M.suit);
    hump.scale.set(1, 0.8, 1.3);
    hump.position.set(0, 0.42, -0.02);
    upper.add(hump);
  }
  // helmet + visor (+ peak for MX); upright akira posture carries it higher
  const helmetGrp = new THREE.Group();
  helmetGrp.position.set(0, akira ? 0.68 : 0.54, akira ? 0.18 : 0.48);
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 9), M.helmet);
  shell.scale.set(0.95, 1, 1.05);
  helmetGrp.add(shell);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.08, 0.05), M.visor);
  visor.position.set(0, 0.02, 0.15);
  helmetGrp.add(visor);
  if (style === 'cross') {
    const peak = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.14), M.helmet);
    peak.position.set(0, 0.12, 0.15);
    peak.rotation.x = -0.35;
    helmetGrp.add(peak);
    const chin = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.07, 0.1), M.helmet);
    chin.position.set(0, -0.08, 0.13);
    helmetGrp.add(chin);
  }
  upper.add(helmetGrp);
  riderGroup.add(upper);

  // --- legs: clean two-bone chains for IK (hip pivot > thigh 0.3 m >
  // knee pivot > shin 0.3 m + boot at the bone end). Game.solveLegIK pins
  // the boot to the footpeg every frame — the pose emerges from physics,
  // not baked angles.
  const legs = {};
  for (const side of [1, -1]) {
    const leg = new THREE.Group();
    leg.position.set(0.17 * side, -0.02, 0);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.32, 0.15), M.suit);
    thigh.position.set(0, -0.15, 0);
    leg.add(thigh);
    const shin = new THREE.Group();
    shin.position.set(0, -0.3, 0); // the knee
    const shinMesh = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.28, 0.12), M.suit);
    shinMesh.position.set(0, -0.14, 0);
    shin.add(shinMesh);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.24), M.suitDark);
    boot.position.set(0, -0.29, 0.06);
    shin.add(boot);
    leg.add(shin);
    riderGroup.add(leg);
    if (side === 1) { legs.legL = leg; legs.shinL = shin; }
    else { legs.legR = leg; legs.shinR = shin; }
  }
  // where the feet live, in BIKE space (rearsets / MX pegs / feet-forward)
  const footY = akira ? 0.32 : style === 'cross' ? 0.4 : 0.42;
  const footZ = akira ? 0.05 : style === 'cross' ? -0.08 : -0.18;
  const footX = akira ? 0.26 : style === 'cross' ? 0.21 : 0.2;

  // --- arms: two-bone chains for IK (shoulder pivot > upper arm > elbow
  // pivot > forearm + glove). Game.solveArmIK pins the glove to the grip
  // every frame, so the hands never leave the bars however far the body
  // hangs off.
  const armL1 = akira ? 0.3 : 0.26;
  const armL2 = akira ? 0.34 : 0.3;
  let armL = null, armR = null, elbowL = null, elbowR = null;
  for (const side of [1, -1]) {
    const arm = new THREE.Group(); // shoulder pivot; positioned by the IK
    arm.position.set(0.19 * side, 0.42, 0.15);
    const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.09, armL1, 0.09), M.suit);
    upperArm.position.set(0, -armL1 / 2, 0);
    arm.add(upperArm);
    const elbow = new THREE.Group();
    elbow.position.set(0, -armL1, 0);
    const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.08, armL2, 0.08), M.suit);
    forearm.position.set(0, -armL2 / 2, 0);
    elbow.add(forearm);
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 0.11), M.suitDark);
    glove.position.set(0, -armL2, 0.02);
    elbow.add(glove);
    arm.add(elbow);
    riderGroup.add(arm);
    if (side === -1) { armR = arm; elbowR = elbow; }
    else { armL = arm; elbowL = elbow; }
  }
  // grip targets in BIKE space, matching each style's handlebar build
  const gripX = akira ? 0.26 : style === 'cross' ? 0.29 : 0.24;
  const gripY = akira ? 0.75 : style === 'cross' ? 1.06 : 1.0;
  const gripZ = akira ? 0.34 : style === 'cross' ? 0.4 : 0.42;
  // shoulder anchors in UPPER-BODY space (they ride the torso's rotations)
  const shX = 0.19, shY = akira ? 0.5 : 0.44, shZ = akira ? 0.1 : 0.24;

  // --- gun arm, built along +Z so lookAt aims it
  const gunArm = new THREE.Group();
  gunArm.position.set(-0.19, akira ? 0.48 : 0.42, akira ? 0.12 : 0.28);
  const gUpper = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.28), M.suit);
  gUpper.position.set(0, 0, 0.14);
  gunArm.add(gUpper);
  const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.055, 7, 6), M.suitDark);
  elbow.position.set(0, 0, 0.28);
  gunArm.add(elbow);
  const gFore = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.3), M.suit);
  gFore.position.set(0, 0, 0.43);
  gunArm.add(gFore);
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.1, 0.09), M.suitDark);
  hand.position.set(0, -0.01, 0.58);
  gunArm.add(hand);
  // the pistol: frame + slide + grip
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.06, 0.17), M.dark);
  frame.position.set(0, 0.035, 0.66);
  gunArm.add(frame);
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.045, 0.2), M.metal);
  slide.position.set(0, 0.085, 0.65);
  gunArm.add(slide);
  const gripBox = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.1, 0.05), M.dark);
  gripBox.position.set(0, -0.02, 0.6);
  gripBox.rotation.x = 0.25;
  gunArm.add(gripBox);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.075, 0.76);
  gunArm.add(muzzle);
  gunArm.visible = false;
  riderGroup.add(gunArm);

  return {
    group: riderGroup,
    upper,
    head: helmetGrp,
    legL: legs.legL,
    legR: legs.legR,
    shinL: legs.shinL,
    shinR: legs.shinR,
    armR,
    gunArm,
    muzzle,
    // per-style pose baselines consumed by Game.applyRiderPose
    baseY: akira ? 0.62 : 0.8,
    footL: new THREE.Vector3(footX, footY, footZ),
    footR: new THREE.Vector3(-footX, footY, footZ),
    armL, elbowL, elbowR,
    armL1, armL2,
    gripL: new THREE.Vector3(gripX, gripY, gripZ),
    gripR: new THREE.Vector3(-gripX, gripY, gripZ),
    shoulderL: new THREE.Vector3(shX, shY, shZ),
    shoulderR: new THREE.Vector3(-shX, shY, shZ),
    // where the left boot plants on the ground when stopped (bike space)
    footDownL: new THREE.Vector3(akira ? 0.28 : 0.25, 0.04, akira ? -0.3 : -0.28),
    pose: {
      roll: 0, offX: 0, offY: 0, headRoll: 0,
      stand: 0, tuck: 0, legL: 0, legR: 0, kneeL: 0, kneeR: 0, legDown: 0,
    },
  };
}

export function createBikeMesh(colors, style = 'sport', number = 0) {
  const grp = new THREE.Group();
  grp.rotation.order = 'YXZ'; // yaw, then pitch (wheelie), then roll (lean)
  const M = makeMaterials(colors, number);

  let frontWheel, rearWheel, tailOffset;
  if (style === 'akira') {
    // long, low, wheels shrouded in full disc covers
    frontWheel = makeWheel(M, { r: 0.3, tube: 0.07, disc: false });
    const fCoverGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.02, 14);
    fCoverGeo.rotateZ(Math.PI / 2);
    for (const side of [1, -1]) {
      const c = new THREE.Mesh(fCoverGeo, M.accent);
      c.position.x = 0.08 * side;
      frontWheel.add(c);
    }
    frontWheel.position.set(0, 0.3, 0.95);
    rearWheel = makeWheel(M, { r: 0.34, tube: 0.1, disc: false });
    const rCoverGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.02, 14);
    rCoverGeo.rotateZ(Math.PI / 2);
    for (const side of [1, -1]) {
      const c = new THREE.Mesh(rCoverGeo, M.accent);
      c.position.x = 0.13 * side;
      rearWheel.add(c);
    }
    rearWheel.position.set(0, 0.34, -0.95);
    grp.add(frontWheel, rearWheel);
    buildAkiraBody(grp, M);
    tailOffset = new THREE.Vector3(0, 0.6, -1.2);
  } else {
    const knobby = style === 'cross';
    frontWheel = makeWheel(M, { r: 0.32, tube: knobby ? 0.08 : 0.065 });
    frontWheel.position.set(0, 0.32, 0.72);
    rearWheel = makeWheel(M, { r: 0.32, tube: knobby ? 0.09 : 0.075, disc: false });
    rearWheel.position.set(0, 0.32, -0.68);
    grp.add(frontWheel, rearWheel);

    // main frame spine, shared
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.85), M.metal);
    spine.position.set(0, 0.66, -0.1);
    spine.rotation.x = 0.1;
    grp.add(spine);

    if (style === 'cross') buildCrossBody(grp, M);
    else buildSportBody(grp, M);
    tailOffset = new THREE.Vector3(0, 0.92, -0.88);
  }

  const rider = buildRider(M, style);
  grp.add(rider.group);

  return { group: grp, wheels: [frontWheel, rearWheel], rider, tailOffset };
}

// Kaneda-class prototype: enormous sloping front cowl over the wheel, low
// flat footwell deck, laid-back seat against a bulbous rear cowl.
function buildAkiraBody(grp, M) {
  // front cowl: big wedge sweeping up from the wheel toward the bars
  const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.85), M.paint);
  cowl.position.set(0, 0.56, 0.6);
  cowl.rotation.x = -0.38;
  grp.add(cowl);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.24, 0.5), M.paint);
  nose.position.set(0, 0.36, 0.92);
  nose.rotation.x = -0.12;
  grp.add(nose);
  const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.09, 0.04),
    new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
  headlight.position.set(0, 0.47, 1.08);
  headlight.rotation.x = -0.35;
  grp.add(headlight);
  // laid-back tinted screen
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.2, 0.02), M.glass);
  screen.position.set(0, 0.76, 0.42);
  screen.rotation.x = -0.95;
  grp.add(screen);
  // wide low bars
  const barGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.58, 6);
  barGeo.rotateZ(Math.PI / 2);
  const bar = new THREE.Mesh(barGeo, M.dark);
  bar.position.set(0, 0.74, 0.4);
  grp.add(bar);

  // long low deck with footwells
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 1.15), M.paint);
  deck.position.set(0, 0.33, -0.05);
  grp.add(deck);
  for (const side of [1, -1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.9), M.accent);
    skirt.position.set(0.225 * side, 0.3, -0.02);
    grp.add(skirt);
    const peg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.16), M.dark);
    peg.position.set(0.26 * side, 0.28, 0.05); // feet-forward, under the shins
    grp.add(peg);
    // the iconic little decals on the cowl flanks
    const decal = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, 0.16), M.accent);
    decal.position.set(0.25 * side, 0.55, 0.55);
    decal.rotation.x = -0.38;
    grp.add(decal);
  }

  // low seat + the big rounded rear cowl the rider reclines against
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 0.55), M.seat);
  seat.position.set(0, 0.5, -0.32);
  grp.add(seat);
  const hump = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 9), M.livery);
  hump.scale.set(0.56, 0.52, 1.05);
  hump.position.set(0, 0.55, -0.85);
  grp.add(hump);
  const humpStripe = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.05, 0.5), M.accent);
  humpStripe.position.set(0, 0.62, -0.85);
  grp.add(humpStripe);
  for (const side of [1, -1]) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.24), M.dark);
    vent.position.set(0.22 * side, 0.66, -0.75);
    grp.add(vent);
  }
  // taillight bar across the back of the cowl
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.02),
    new THREE.MeshBasicMaterial({ color: 0xff2222 }));
  tail.position.set(0, 0.58, -1.28);
  grp.add(tail);
  // twin low exhausts
  const exGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.32, 8);
  exGeo.rotateX(Math.PI / 2);
  for (const side of [1, -1]) {
    const ex = new THREE.Mesh(exGeo, M.chrome);
    ex.position.set(0.15 * side, 0.28, -1.1);
    grp.add(ex);
  }
}

export function createBlobShadow() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(0,0,0,0.42)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.3), mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

// ---------------------------------------------------------------------------
// applyGearVisuals — the loadout you bought is the loadout you SEE. Bolts
// weapon furniture onto the gun arm, armour plate onto the rider, and
// exhaust hardware onto the bike by career engine level. Idempotent: strips
// its previous additions first, so weapon hot-swaps in-race re-dress cleanly.
// Shared by the race (player mesh) and the garage viewer.
// ---------------------------------------------------------------------------

export function applyGearVisuals(pm, {
  weaponId = 'pistol', armourLvl = 0, engineLvl = 0, rank = 0,
} = {}) {
  const mat = (c, emissive = 0) => new THREE.MeshLambertMaterial(
    emissive ? { color: c, emissive, emissiveIntensity: 0.8 } : { color: c });
  const strip = (host, key) => {
    if (host.userData[key]) {
      host.remove(host.userData[key]);
      host.userData[key] = null;
    }
    const g = new THREE.Group();
    host.userData[key] = g;
    host.add(g);
    return g;
  };
  const box = (parent, w, h, d, m, x, y, z, rx = 0) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    if (rx) b.rotation.x = rx;
    parent.add(b);
    return b;
  };

  // ---- weapon furniture on the gun arm (stock pistol stays underneath) --
  const gunArm = pm.rider.gunArm;
  if (gunArm) {
    const g = strip(gunArm, 'gearGun');
    const dark = mat(0x22252a), olive = mat(0x4a5238), bronze = mat(0x6a4f30);
    if (weaponId === 'smg') {
      box(g, 0.05, 0.05, 0.3, dark, 0, 0.085, 0.72);        // long barrel shroud
      box(g, 0.035, 0.16, 0.06, dark, 0, -0.06, 0.68, 0.15); // stick magazine
      box(g, 0.04, 0.05, 0.08, dark, 0, 0.0, 0.75);          // foregrip
    } else if (weaponId === 'scatter') {
      const tube = new THREE.CylinderGeometry(0.022, 0.022, 0.34, 7);
      tube.rotateX(Math.PI / 2);
      for (const dy of [0.1, 0.055]) {
        const t = new THREE.Mesh(tube, bronze);
        t.position.set(0, dy, 0.78);
        g.add(t);
      }
      box(g, 0.045, 0.06, 0.14, mat(0x54401f), 0, 0.02, 0.72); // pump slide
    } else if (weaponId === 'rail') {
      const rod = new THREE.CylinderGeometry(0.018, 0.018, 0.52, 7);
      rod.rotateX(Math.PI / 2);
      const r = new THREE.Mesh(rod, mat(0x3a4048));
      r.position.set(0, 0.085, 0.88);
      g.add(r);
      const ring = new THREE.TorusGeometry(0.045, 0.012, 6, 12);
      for (const dz of [0.72, 0.84, 0.96]) {
        const rr = new THREE.Mesh(ring, mat(0x224448, 0x38f0ff));
        rr.position.set(0, 0.085, dz);
        g.add(rr);
      }
    } else if (weaponId === 'thumper') {
      const fat = new THREE.CylinderGeometry(0.05, 0.055, 0.3, 9);
      fat.rotateX(Math.PI / 2);
      const t = new THREE.Mesh(fat, olive);
      t.position.set(0, 0.075, 0.78);
      g.add(t);
      const drum = new THREE.CylinderGeometry(0.06, 0.06, 0.07, 10);
      const dr = new THREE.Mesh(drum, olive);
      dr.rotation.x = Math.PI / 2;
      dr.position.set(0, -0.02, 0.68);
      g.add(dr);
    }
  }

  // ---- armour plate on the rider, one tier at a time --------------------
  const upper = pm.rider.upper;
  if (upper) {
    const g = strip(upper, 'gearArmor');
    const steel = mat(0x646c74), steelDark = mat(0x474e55);
    if (armourLvl >= 1) { // shoulder pauldrons
      for (const side of [1, -1]) {
        box(g, 0.17, 0.07, 0.16, steel, side * 0.19, 0.42, 0.12);
        box(g, 0.15, 0.05, 0.14, steelDark, side * 0.2, 0.47, 0.12);
      }
    }
    if (armourLvl >= 2) { // chest + back slab
      box(g, 0.3, 0.3, 0.05, steel, 0, 0.2, 0.28);
      box(g, 0.3, 0.34, 0.05, steelDark, 0, 0.2, -0.1);
    }
    if (armourLvl >= 3) { // spine ridge + collar
      box(g, 0.08, 0.3, 0.07, steelDark, 0, 0.28, -0.16);
      box(g, 0.24, 0.07, 0.2, steel, 0, 0.42, 0.02);
    }
    // rank chevrons: steel on dark leather is hard to read from a chase
    // camera, so the pack wears its plate count in amber you can COUNT at
    // 30 m. Bare back = nothing to chew through but flesh.
    const amber = mat(0xffb020, 0x4a2a00);
    for (let k = 0; k < rank; k++) {
      const y = 0.34 - k * 0.075;
      for (const side of [1, -1]) {
        const v = box(g, 0.09, 0.022, 0.02, amber, side * 0.035, y, -0.185);
        v.rotation.z = side * 0.55;
      }
    }
  }

  // ---- engine hardware by level -----------------------------------------
  const g = strip(pm.group, 'gearEngine');
  const chrome = mat(0xb8bcc2), darkm = mat(0x33363a);
  const pipe = new THREE.CylinderGeometry(0.03, 0.04, 0.5, 8);
  pipe.rotateX(Math.PI / 2);
  const muf = new THREE.CylinderGeometry(0.05, 0.062, 0.38, 9);
  muf.rotateX(Math.PI / 2);
  if (engineLvl >= 1) { // second pipe, left side
    const p = new THREE.Mesh(pipe, chrome);
    p.position.set(-0.13, 0.32, 0.02);
    g.add(p);
    const m = new THREE.Mesh(muf, chrome);
    m.position.set(-0.16, 0.5, -0.55);
    m.rotation.x = -0.35;
    g.add(m);
  }
  if (engineLvl >= 2) { // oil cooler + braided line
    box(g, 0.26, 0.12, 0.05, darkm, 0, 0.72, 0.42);
    box(g, 0.03, 0.03, 0.34, chrome, 0.1, 0.62, 0.28, 0.5);
  }
  if (engineLvl >= 3) { // twin upswept stack tips, race-red cam accent
    for (const side of [1, -1]) {
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.045, 0.2, 8), darkm);
      tip.geometry.rotateX(Math.PI / 2);
      tip.position.set(side * 0.16, 0.6, -0.72);
      tip.rotation.x = -0.5;
      g.add(tip);
    }
    box(g, 0.18, 0.05, 0.14, mat(0x8a2018), 0, 0.56, 0.3);
  }
}

// ---------------------------------------------------------------------------
// markBounty — the Guild has a price on this rider. Hazard-striped tail plate,
// a blood-red X across their back, and a warpaint helmet, so the mark reads
// from behind at speed even before the skull pin swims into view.
// ---------------------------------------------------------------------------

export function markBounty(pm) {
  if (pm.group.userData.bountyMark) return; // once per mesh
  const g = new THREE.Group();
  pm.group.userData.bountyMark = g;
  pm.group.add(g);

  const red = new THREE.MeshLambertMaterial({ color: 0xc21f1f, emissive: 0x3a0000, emissiveIntensity: 0.7 });
  const black = new THREE.MeshLambertMaterial({ color: 0x141414 });

  // hazard-striped plate bolted over the tail
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.19),
      i % 2 ? black : red);
    s.position.set(-0.1 + i * 0.05, 0.66, -0.66);
    s.rotation.y = 0.5;
    g.add(s);
  }

  // red X across the rider's back — the part you stare at while chasing
  const upper = pm.rider.upper;
  if (upper) {
    const x = new THREE.Group();
    upper.userData.bountyX = x;
    upper.add(x);
    for (const rot of [0.72, -0.72]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.42, 0.02), red);
      bar.position.set(0, 0.2, -0.15);
      bar.rotation.z = rot;
      x.add(bar);
    }
  }
  // warpaint stripe over the helmet
  const head = pm.rider.head;
  if (head) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 0.2), red);
    stripe.position.set(0, 0.11, 0);
    head.add(stripe);
  }
}

// ---------------------------------------------------------------------------
// makeVariantModel — garage upgrade-preview turntable models. One little
// display piece per (kind, lvl), primitives only, centred on the origin and
// sized for the ~200x140 thumbnail camera (z≈2.2, y≈0.55, fov 32). Levels
// escalate visibly: more hardware at 2, glow accents at 3. Palettes rhyme
// with applyGearVisuals so the preview matches the in-race furniture.
// ---------------------------------------------------------------------------

function vmMat(c, emissive = 0) {
  return new THREE.MeshLambertMaterial(
    emissive ? { color: c, emissive, emissiveIntensity: 0.8 } : { color: c });
}

function vmBox(parent, w, h, d, m, x = 0, y = 0, z = 0, rx = 0, rz = 0) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  b.position.set(x, y, z);
  b.rotation.x = rx;
  b.rotation.z = rz;
  parent.add(b);
  return b;
}

function vmCyl(parent, rTop, rBot, len, m, x = 0, y = 0, z = 0, axis = 'y', seg = 10) {
  const geo = new THREE.CylinderGeometry(rTop, rBot, len, seg);
  if (axis === 'x') geo.rotateZ(Math.PI / 2);
  else if (axis === 'z') geo.rotateX(Math.PI / 2);
  const c = new THREE.Mesh(geo, m);
  c.position.set(x, y, z);
  parent.add(c);
  return c;
}

// ring in the XY plane (normal +Z, i.e. facing the thumbnail camera)
function vmRing(parent, r, tube, m, x = 0, y = 0, z = 0, seg = 16) {
  const t = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 7, seg), m);
  t.position.set(x, y, z);
  parent.add(t);
  return t;
}

// engine block + exhaust hardware: 1 pipe -> twins + oil cooler -> quad
// stack tips, race-red cam cover and a hint of header heat
function vmEngine(g, lvl) {
  const chrome = vmMat(0xb8bcc2);
  vmBox(g, 0.48, 0.38, 0.4, vmMat(0x33363a), 0, -0.1, 0);            // crankcase
  vmBox(g, 0.46, 0.03, 0.42, vmMat(0x474e55), 0, 0.1, 0);            // cooling fin
  vmBox(g, 0.4, 0.12, 0.34, vmMat(0x646c74), 0, 0.17, 0);            // cylinder head
  vmCyl(g, 0.11, 0.11, 0.5, vmMat(0x8a8f98), 0, -0.2, 0.12, 'x');    // clutch cases
  for (const s of lvl >= 2 ? [1, -1] : [1]) {
    vmCyl(g, 0.035, 0.045, 0.55, chrome, s * 0.22, -0.14, -0.12, 'z')
      .rotation.x = -0.22;                                           // header pipe
    if (lvl < 3) vmCyl(g, 0.06, 0.075, 0.3, chrome, s * 0.24, 0, -0.44, 'z')
      .rotation.x = -0.3;                                            // muffler can
  }
  if (lvl >= 2) {
    vmBox(g, 0.3, 0.14, 0.06, vmMat(0x22252a), 0, 0, 0.27, -0.12);   // oil cooler
    if (lvl === 2) vmCyl(g, 0.015, 0.015, 0.3, chrome, 0.14, 0.1, 0.16, 'y')
      .rotation.x = 0.6;                                             // braided line
  }
  if (lvl >= 3) {
    for (let i = 0; i < 4; i++) vmCyl(g, 0.048, 0.036, 0.22,          // quad stack
      vmMat(0x33363a), -0.18 + i * 0.12, 0.14, -0.38, 'z').rotation.x = -0.55;
    vmBox(g, 0.34, 0.07, 0.3, vmMat(0x8a2018), 0, 0.27, 0);          // race cam cover
    vmBox(g, 0.36, 0.05, 0.04, vmMat(0x551505, 0xff5a22), 0, -0.02, 0.23); // heat glow
  }
}

// single wheel: street -> wider sport w/ blue sidewall -> widest slick w/
// red sidewall and a hot brake-disc glow in the hub
function vmTires(g, lvl) {
  const width = lvl === 1 ? 1 : lvl === 2 ? 1.3 : 1.6;
  const tube = lvl === 1 ? 0.12 : lvl === 2 ? 0.13 : 0.14;
  const R = 0.36;
  vmRing(g, R, tube, vmMat(0x1a1a1e), 0, 0, 0, 20).scale.z = width;  // tyre
  const hubLen = 0.12 + 0.14 * width;
  vmCyl(g, 0.085, 0.085, hubLen, vmMat(0x8a8f98), 0, 0, 0, 'z');     // hub
  const spokeM = vmMat(0x22252a);
  for (let i = 0; i < 3; i++)
    vmBox(g, 0.05, (R - tube * 0.5) * 2, 0.055, spokeM, 0, 0, 0, 0, i * Math.PI / 3);
  if (lvl >= 2) {
    const bandM = vmMat(lvl === 3 ? 0xbb2418 : 0x2b5fc2);            // sidewall band
    for (const s of [1, -1]) vmRing(g, R, 0.03, bandM, 0, 0, s * (tube * width - 0.01), 18);
  }
  if (lvl >= 3) for (const s of [1, -1]) vmCyl(g, 0.19, 0.19, 0.02,  // disc glow
    vmMat(0x552200, 0xff6a22), 0, 0, s * (hubLen / 2 + 0.012), 'z', 18);
  else if (lvl === 2) for (const s of [1, -1]) vmCyl(g, 0.15, 0.15, 0.015,
    vmMat(0xb8bcc2), 0, 0, s * (hubLen / 2 + 0.01), 'z', 16);        // sport rotor
}

// brake disc + caliper on a hub: small steel -> big drilled + red caliper
// -> twin discs, gold calipers, faintly hot rim
function vmBrakes(g, lvl) {
  const discR = lvl === 1 ? 0.3 : 0.42;
  vmCyl(g, 0.08, 0.08, 0.22, vmMat(0x8a8f98), 0, 0, 0, 'z');         // hub
  const discM = vmMat(lvl === 1 ? 0x9aa0a8 : 0xb8bcc2);
  for (const z of lvl >= 3 ? [0.06, -0.06] : [0]) {
    vmCyl(g, discR, discR, 0.025, discM, 0, 0, z, 'z', 24);          // rotor
    if (lvl >= 2) vmCyl(g, discR * 0.72, discR * 0.72, 0.034,        // drilled band
      vmMat(0x474e55), 0, 0, z, 'z', 22);
  }
  const calM = vmMat(lvl >= 3 ? 0xc9a227 : lvl === 2 ? 0xbb2418 : 0x474e55);
  for (const s of lvl >= 3 ? [1, -1] : [1])
    vmBox(g, 0.14, 0.16, lvl >= 3 ? 0.26 : 0.16, calM, 0, s * (discR - 0.03), 0);
  if (lvl >= 3) vmRing(g, discR + 0.015, 0.014, vmMat(0x552200, 0xff6a22), 0, 0, 0, 26);
}

// torso bust wearing the tier — applyGearVisuals steel palette: pauldrons
// -> chest/back slabs -> spine ridge + collar + status lamp
function vmArmour(g, lvl) {
  const steel = vmMat(0x646c74), steelDark = vmMat(0x474e55);
  vmBox(g, 0.4, 0.52, 0.24, vmMat(0x2a2d33), 0, -0.14, 0);           // bust
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), vmMat(0x16161a));
  head.position.set(0, 0.3, 0);
  g.add(head);
  for (const s of [1, -1]) {                                         // pauldrons
    vmBox(g, 0.17, 0.07, 0.2, steel, s * 0.26, 0.1, 0);
    vmBox(g, 0.15, 0.05, 0.18, steelDark, s * 0.28, 0.15, 0);
  }
  if (lvl >= 2) {
    vmBox(g, 0.32, 0.3, 0.05, steel, 0, -0.1, 0.15);                 // chest slab
    vmBox(g, 0.32, 0.34, 0.05, steelDark, 0, -0.1, -0.15);           // back slab
  }
  if (lvl >= 3) {
    vmBox(g, 0.08, 0.34, 0.06, steelDark, 0, -0.04, -0.2);           // spine ridge
    vmBox(g, 0.28, 0.07, 0.26, steel, 0, 0.14, 0);                   // collar
    vmBox(g, 0.05, 0.05, 0.02, vmMat(0x0b3a42, 0x38f0ff), 0.09, -0.02, 0.18); // lamp
  }
}

// the career service pistol: stock -> long slide + compensator -> reflex
// sight + extended mag
function vmGun(g, lvl) {
  const dark = vmMat(0x22252a), metal = vmMat(0x8a8f98);
  const slideLen = lvl >= 2 ? 0.6 : 0.48;
  const slideZ = lvl >= 2 ? 0.06 : 0;
  vmBox(g, 0.11, 0.14, 0.44, dark, 0, -0.02, 0);                     // frame
  vmBox(g, 0.12, 0.12, slideLen, metal, 0, 0.11, slideZ);            // slide
  vmBox(g, 0.03, 0.04, 0.05, metal, 0, 0.19, slideZ + slideLen / 2 - 0.04); // sight
  vmBox(g, 0.1, 0.3, 0.15, dark, 0, -0.24, -0.14, 0.22);             // grip
  vmBox(g, 0.03, 0.03, 0.14, dark, 0, -0.12, 0.1);                   // trigger guard
  if (lvl >= 2)
    vmBox(g, 0.13, 0.14, 0.14, vmMat(0xb8bcc2), 0, 0.11, slideZ + slideLen / 2 + 0.07);
  if (lvl >= 3) {
    vmBox(g, 0.09, 0.08, 0.13, dark, 0, 0.22, -0.12);                // reflex body
    vmBox(g, 0.06, 0.05, 0.015, vmMat(0x0b3a42, 0x38f0ff), 0, 0.23, -0.05); // lens
    vmBox(g, 0.08, 0.14, 0.12, metal, 0, -0.42, -0.22, 0.22);        // extended mag
  }
}

// rider helmet with a HUD visor: plain -> side pod -> glowing strip + aerial
function vmFocus(g, lvl) {
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 9), vmMat(0x474e55));
  shell.scale.set(0.95, 1, 1.05);
  g.add(shell);
  vmBox(g, 0.32, 0.14, 0.18, vmMat(0x33363a), 0, -0.24, 0.24);       // chin bar
  vmBox(g, 0.38, 0.16, 0.08, vmMat(0x14202c), 0, 0.02, 0.34);        // visor
  if (lvl >= 2) {
    vmBox(g, 0.08, 0.13, 0.2, vmMat(0x22252a), 0.36, -0.04, 0.1);    // HUD side pod
    vmBox(g, 0.02, 0.05, 0.05, vmMat(0xb8bcc2), 0.41, 0, 0.16);      // pod lens
  }
  if (lvl >= 3) {
    vmBox(g, 0.4, 0.045, 0.02, vmMat(0x0b3a42, 0x38f0ff), 0, 0.07, 0.39); // HUD strip
    vmCyl(g, 0.012, 0.012, 0.3, vmMat(0x22252a), 0.36, 0.14, 0.04, 'y', 6); // antenna
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 5), vmMat(0x0b3a42, 0x38f0ff));
    tip.position.set(0.36, 0.3, 0.04);
    g.add(tip);
  }
}

// ---- armory weapons, standalone and bigger than the on-arm furniture ----

// slab-sided sidearm, bronze grip; MK2 suppressor, MK3 scope block
function vmWPistol(g, lvl) {
  const dark = vmMat(0x22252a), gun = vmMat(0x33363a);
  vmBox(g, 0.12, 0.13, 0.48, gun, 0, 0.1, 0);                        // slide
  vmBox(g, 0.11, 0.13, 0.42, dark, 0, -0.03, 0);                     // frame
  vmCyl(g, 0.04, 0.04, 0.18, dark, 0, 0.1, 0.3, 'z');                // barrel
  vmBox(g, 0.1, 0.28, 0.15, vmMat(0x6a4f30), 0, -0.24, -0.13, 0.2);  // bronze grip
  vmBox(g, 0.03, 0.03, 0.14, dark, 0, -0.13, 0.08);                  // trigger guard
  if (lvl >= 2) vmCyl(g, 0.06, 0.06, 0.3, dark, 0, 0.1, 0.5, 'z');   // suppressor
  if (lvl >= 3) {
    vmBox(g, 0.09, 0.1, 0.18, gun, 0, 0.23, -0.08);                  // scope block
    vmBox(g, 0.05, 0.05, 0.015, vmMat(0x0b3a42, 0x38f0ff), 0, 0.24, 0.02); // lens
  }
}

// stick-mag machine pistol; MK2 extended stick, MK3 drum + muzzle brake
function vmWSmg(g, lvl) {
  const dark = vmMat(0x22252a), gun = vmMat(0x33363a);
  vmBox(g, 0.13, 0.15, 0.55, dark, 0, 0.05, -0.02);                  // receiver
  vmCyl(g, 0.05, 0.05, 0.32, gun, 0, 0.07, 0.4, 'z');                // barrel shroud
  vmBox(g, 0.09, 0.2, 0.12, dark, 0, -0.13, -0.2, 0.15);             // pistol grip
  vmBox(g, 0.1, 0.05, 0.24, gun, 0, 0.05, -0.4);                     // wire stock
  if (lvl < 3) {
    const magLen = lvl === 2 ? 0.4 : 0.26;                           // stick magazine
    vmBox(g, 0.05, magLen, 0.09, dark, 0, -0.05 - magLen / 2, 0.1, 0.12);
  } else {
    vmCyl(g, 0.13, 0.13, 0.08, dark, 0, -0.14, 0.1, 'x');            // drum mag
    vmBox(g, 0.07, 0.06, 0.1, vmMat(0xb8bcc2), 0, 0.07, 0.6);        // muzzle brake
    vmBox(g, 0.04, 0.04, 0.02, vmMat(0x0b3a42, 0x38f0ff), 0, 0.16, -0.15); // hot sight
  }
}

// twin bronze tubes + pump; MK2 one barrel band, MK3 three
function vmWScatter(g, lvl) {
  const wood = vmMat(0x54401f), band = vmMat(0x33363a);
  const bronze = vmMat(0x6a4f30);
  for (const s of [1, -1]) vmCyl(g, 0.05, 0.05, 0.72, bronze, 0, 0.05 + s * 0.055, 0.08, 'z');
  vmBox(g, 0.13, 0.19, 0.28, vmMat(0x22252a), 0, 0.03, -0.3);        // receiver
  vmBox(g, 0.1, 0.2, 0.16, wood, 0, -0.15, -0.44, 0.35);             // grip stock
  vmBox(g, 0.12, 0.09, 0.2, wood, 0, -0.07, 0.12);                   // pump slide
  vmBox(g, 0.03, 0.04, 0.03, lvl >= 3 ? vmMat(0x553311, 0xffaa33) : vmMat(0xb8bcc2),
    0, 0.17, 0.42);                                                  // bead sight
  if (lvl >= 2) vmBox(g, 0.13, 0.24, 0.06, band, 0, 0.05, 0.24);     // barrel band
  if (lvl >= 3) {
    vmBox(g, 0.13, 0.24, 0.06, band, 0, 0.05, 0.02);                 // second band
    vmBox(g, 0.13, 0.24, 0.06, band, 0, 0.05, 0.4);                  // muzzle band
  }
}

// long rod with cyan coils; MK2 an extra coil, MK3 a glowing capacitor
function vmWRail(g, lvl) {
  const dark = vmMat(0x22252a), rodM = vmMat(0x3a4048);
  vmBox(g, 0.14, 0.17, 0.4, dark, 0, 0.02, -0.3);                    // receiver
  vmBox(g, 0.08, 0.19, 0.11, dark, 0, -0.15, -0.38, 0.15);           // grip
  vmCyl(g, 0.024, 0.024, 0.68, rodM, 0, 0.06, 0.24, 'z');            // rail rod
  vmCyl(g, 0.035, 0.02, 0.09, rodM, 0, 0.06, 0.6, 'z');              // emitter tip
  const coilM = vmMat(0x224448, 0x38f0ff);
  for (let i = 0; i < (lvl === 1 ? 2 : 3); i++)
    vmRing(g, 0.07, 0.018, coilM, 0, 0.06, 0.02 + i * 0.18, 12);     // coil rings
  if (lvl >= 3) vmCyl(g, 0.055, 0.055, 0.16, vmMat(0x0b3a42, 0x38f0ff),
    0, 0.15, -0.2, 'z');                                             // capacitor
}

// fat olive tube + drum; MK2 bigger drum, MK3 shoulder stock + hot sight
function vmWThumper(g, lvl) {
  const olive = vmMat(0x4a5238), oliveD = vmMat(0x3a4030), dark = vmMat(0x22252a);
  vmCyl(g, 0.105, 0.105, 0.55, olive, 0, 0.05, 0.1, 'z');            // launch tube
  vmCyl(g, 0.115, 0.115, 0.07, dark, 0, 0.05, 0.36, 'z');            // muzzle collar
  vmBox(g, 0.13, 0.16, 0.24, oliveD, 0, 0.03, -0.3);                 // receiver
  const drumR = lvl >= 2 ? 0.17 : 0.13;
  vmCyl(g, drumR, drumR, lvl >= 2 ? 0.11 : 0.09, oliveD, 0, -0.08, -0.05, 'x'); // drum
  vmBox(g, 0.09, 0.19, 0.11, dark, 0, -0.14, -0.34, 0.15);           // grip
  vmBox(g, 0.07, 0.13, 0.09, dark, 0, -0.09, 0.22);                  // foregrip
  if (lvl >= 3) {
    vmBox(g, 0.09, 0.12, 0.28, dark, 0, 0.03, -0.54);                // shoulder stock
    vmBox(g, 0.11, 0.17, 0.05, oliveD, 0, 0.03, -0.7);               // butt pad
    vmBox(g, 0.04, 0.04, 0.02, vmMat(0x553311, 0xffaa33), 0, 0.17, 0.3); // hot sight
  }
}

export function makeVariantModel(kind, lvl) {
  const L = Math.max(1, Math.min(3, Math.round(lvl) || 1));
  const g = new THREE.Group();
  const build = {
    engine: vmEngine, tires: vmTires, brakes: vmBrakes, armour: vmArmour,
    gun: vmGun, focus: vmFocus,
    'w:pistol': vmWPistol, 'w:smg': vmWSmg, 'w:scatter': vmWScatter,
    'w:rail': vmWRail, 'w:thumper': vmWThumper,
  }[kind];
  if (build) build(g, L);
  else vmBox(g, 0.4, 0.4, 0.4, vmMat(0x22252a));                     // unknown: crate
  // centre on the origin, cap the footprint for the turntable camera
  const bb = new THREE.Box3().setFromObject(g);
  const c = bb.getCenter(new THREE.Vector3());
  const size = bb.getSize(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z);
  const root = new THREE.Group();
  g.position.set(-c.x, -c.y, -c.z);
  root.add(g);
  if (d > 1.05) root.scale.setScalar(1.05 / d);
  return root;
}