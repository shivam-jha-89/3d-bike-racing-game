// Point-to-point stages (A -> B), each roughly the length of three laps of
// the old circuits. Routes are authored with a tiny turtle builder: straights
// and arcs in real metres, elevation via dy, and named marks that become the
// exact fraction anchors for tunnels, bridges and jumps.

function makeRoute(cmds) {
  let x = 0, z = 0, h = 0, y = 0, dist = 0;
  const pts = [[0, 0, 0]];
  const marks = {};
  const SEG = 85; // control-point spacing on straights
  for (const c of cmds) {
    if (c.mark) {
      marks[c.mark] = dist;
      continue;
    }
    if (c.s != null) {
      const n = Math.max(1, Math.round(c.s / SEG));
      const step = c.s / n, dy = (c.dy || 0) / n;
      for (let i = 0; i < n; i++) {
        x += Math.sin(h) * step;
        z += Math.cos(h) * step;
        y += dy;
        dist += step;
        pts.push([+x.toFixed(1), +y.toFixed(2), +z.toFixed(1)]);
      }
    } else if (c.a != null) {
      // arc: a = degrees (positive = left), r = radius
      const ang = (c.a * Math.PI) / 180;
      const len = Math.abs(ang) * c.r;
      const n = Math.max(2, Math.round(len / 70));
      const dh = ang / n, step = len / n, dy = (c.dy || 0) / n;
      for (let i = 0; i < n; i++) {
        h += dh;
        x += Math.sin(h) * step;
        z += Math.cos(h) * step;
        y += dy;
        dist += step;
        pts.push([+x.toFixed(1), +y.toFixed(2), +z.toFixed(1)]);
      }
    }
  }
  return {
    points: pts,
    length: dist,
    frac: (m) => (marks[m] ?? 0) / dist,
  };
}

// ------------------------------------------------------------- the stages

// coastal hill climb: cove bridge, then a ladder of climbing switchbacks
// through two villages to the summit, and a fast tunnel descent home
const corniche = [
  { s: 380, dy: 2 },
  { a: -45, r: 210 },
  { mark: 'vilA1' }, { s: 300, dy: 4 }, { mark: 'vilA2' },
  { a: 60, r: 160, dy: 3 },
  { mark: 'brA' }, { s: 170 }, { mark: 'brB' },
  { s: 260, dy: 6 },
  { a: -168, r: 82, dy: 6 },
  { s: 300, dy: 9 },
  { a: 165, r: 76, dy: 6 },
  { s: 320, dy: 9 },
  { a: -170, r: 86, dy: 6 },
  { s: 300, dy: 8 },
  { a: 160, r: 72, dy: 5 },
  { s: 280, dy: 7 },
  { mark: 'vilB1' }, { s: 320, dy: 2 }, { mark: 'vilB2' },
  { a: -70, r: 180, dy: -2 },
  { s: 340, dy: -8 },
  { a: 55, r: 200, dy: -6 },
  { mark: 'tunA' }, { s: 230, dy: -5 }, { mark: 'tunB' },
  { s: 320, dy: -9 },
  { a: -60, r: 170, dy: -6 },
  { s: 400, dy: -8 },
  { a: 40, r: 240, dy: -4 },
  { s: 430, dy: -3 },
];
const cornicheRoute = makeRoute(corniche);

// canyon run: sweeping red-rock walls, a gorge bridge over the river, a
// tunnel bored through a spur, and long dusty drags between the bends
const canyonRoute = makeRoute([
  { s: 520, dy: 2 },
  { a: -60, r: 240 },
  { s: 380, dy: 4 },
  { a: 85, r: 150, dy: 2 },
  { s: 300, dy: 1 },
  { a: -45, r: 280 },
  { mark: 'brA' }, { s: 200 }, { mark: 'brB' },
  { s: 340, dy: -5 },
  { a: 95, r: 175 },
  { s: 460, dy: -3 },
  { a: -70, r: 190, dy: 4 },
  { s: 300 },
  { mark: 'tunA' }, { s: 260, dy: 3 }, { mark: 'tunB' },
  { s: 380, dy: -5 },
  { a: 55, r: 220 },
  { s: 520, dy: 3 },
  { a: -85, r: 180, dy: -4 },
  { s: 320 },
  { a: 40, r: 300 },
  { s: 560, dy: -1 },
]);

// jungle village trail: dense canopy pressing in, three stilt villages,
// two river bridges, tight and twisty all the way
const kampongRoute = makeRoute([
  { s: 360, dy: 2 },
  { a: 50, r: 170 },
  { mark: 'vilA1' }, { s: 280 }, { mark: 'vilA2' },
  { a: -70, r: 140, dy: 3 },
  { s: 300, dy: 4 },
  { mark: 'brA' }, { s: 150 }, { mark: 'brB' },
  { a: 60, r: 160, dy: -2 },
  { s: 340, dy: 5 },
  { a: -95, r: 120 },
  { mark: 'vilB1' }, { s: 320, dy: -3 }, { mark: 'vilB2' },
  { a: 75, r: 150, dy: 2 },
  { s: 300, dy: 6 },
  { a: -55, r: 190, dy: -4 },
  { mark: 'brC' }, { s: 140 }, { mark: 'brD' },
  { s: 320, dy: -4 },
  { a: 100, r: 115 },
  { s: 280, dy: 3 },
  { a: -60, r: 170 },
  { mark: 'vilC1' }, { s: 300, dy: -2 }, { mark: 'vilC2' },
  { a: 45, r: 220 },
  { s: 420, dy: -3 },
]);

const riviera = makeRoute([
  { s: 480 },
  { a: -65, r: 220 },
  { s: 300, dy: 5 },
  { a: 55, r: 190 },
  { s: 260 },
  { a: -100, r: 130 },
  { s: 420, dy: 4 },
  { mark: 'tunA' }, { s: 90 }, { a: 40, r: 260 }, { s: 120 }, { mark: 'tunB' },
  { s: 220, dy: -4 },
  { a: -20, r: 240 },
  { s: 300 },
  { mark: 'brA' }, { s: 150, dy: 1 }, { a: 25, r: 300 }, { s: 100 }, { mark: 'brB' },
  { s: 260, dy: -3 },
  { a: 90, r: 120 },
  { s: 300, dy: 4 },
  { a: -50, r: 260 },
  { s: 420, dy: -5 },
  { a: 60, r: 170 },
  { s: 320 },
  { a: -60, r: 170 },
  { s: 430 },
  { a: 25, r: 240 },
  { s: 480 },
]);

const valley = makeRoute([
  { s: 600 },
  { a: 35, r: 380 },
  { s: 500, dy: 6 },
  { a: -45, r: 320 },
  { s: 420 },
  { mark: 'tunA' }, { s: 300, dy: 4 }, { mark: 'tunB' },
  { s: 260 },
  { a: 60, r: 260 },
  { s: 550, dy: 5 },
  { a: -35, r: 400 },
  { s: 400 },
  { mark: 'brA' }, { s: 260 }, { mark: 'brB' },
  { s: 300, dy: -6 },
  { a: 70, r: 240 },
  { s: 620, dy: -5 },
  { a: -60, r: 280 },
  { s: 480 },
  { a: 40, r: 350 },
  { s: 640, dy: -4 },
]);

const cliffs = makeRoute([
  { s: 380, dy: 6 },
  { a: -55, r: 200, dy: 6 },
  { s: 300, dy: -8 },
  { a: 65, r: 170, dy: 4 },
  { s: 340, dy: 10 },
  { a: -40, r: 260, dy: -6 },
  { s: 300, dy: -8 },
  { mark: 'brA' }, { s: 240 }, { mark: 'brB' },
  { s: 260, dy: 8 },
  { a: 95, r: 140, dy: 4 },
  { s: 380, dy: -10 },
  { a: -75, r: 170, dy: 6 },
  { s: 300, dy: 8 },
  { mark: 'tunA' }, { s: 260 }, { mark: 'tunB' },
  { s: 320, dy: -12 },
  { a: 60, r: 200, dy: 4 },
  { s: 420, dy: 9 },
  { a: -90, r: 150, dy: -6 },
  { s: 340, dy: -9 },
  { a: 45, r: 240, dy: 5 },
  { s: 460, dy: -6 },
]);

const isla = makeRoute([
  { s: 420, dy: 2 },
  { a: -60, r: 210 },
  { s: 380, dy: 6 },
  { a: 80, r: 160, dy: 4 },
  { s: 300, dy: 6 },
  { mark: 'tunA' }, { s: 320 }, { mark: 'tunB' },
  { s: 280, dy: 4 },
  { a: -95, r: 150 },
  { s: 420, dy: -4 },
  { a: 50, r: 260 },
  { mark: 'brA' }, { s: 260 }, { mark: 'brB' },
  { s: 300, dy: 2 },
  { a: -45, r: 240 },
  { s: 460, dy: 3 },
  { mark: 'jump' },
  { s: 240, dy: -5 },
  { a: 70, r: 190, dy: -4 },
  { s: 420, dy: -3 },
  { a: -80, r: 170 },
  { s: 340 },
  { a: 60, r: 220, dy: -3 },
  { s: 560 },
  { a: -35, r: 300 },
  { s: 620, dy: -3 },
]);

const neo = makeRoute([
  { s: 850 },
  { mark: 'tunA' }, { s: 520 }, { mark: 'tunB' },
  { s: 420 },
  { a: -80, r: 200 },
  { s: 700 },
  { a: 90, r: 170 },
  { s: 900 },
  { mark: 'tunC' }, { s: 620 }, { mark: 'tunD' },
  { s: 380 },
  { a: -95, r: 180 },
  { s: 760 },
  { a: 60, r: 240 },
  { s: 520 },
  { a: -45, r: 280 },
  { s: 880 },
  { a: 85, r: 190 },
  { s: 640 },
]);

const mojave = makeRoute([
  { s: 340 },
  { a: 70, r: 130 },
  { s: 260, dy: 4 },
  { a: -90, r: 110 },
  { s: 300, dy: 3 },
  { mark: 'jumpA' },
  { s: 220, dy: -3 },
  { a: 55, r: 150 },
  { s: 340, dy: 4 },
  { a: -120, r: 100 },
  { s: 280, dy: -4 },
  { a: 80, r: 120 },
  { s: 360 },
  { mark: 'jumpB' },
  { s: 240, dy: 2 },
  { a: -60, r: 140 },
  { s: 300, dy: -3 },
  { mark: 'brA' }, { s: 180 }, { mark: 'brB' },
  { s: 260 },
  { a: 100, r: 110 },
  { s: 320, dy: 3 },
  { a: -70, r: 130 },
  { s: 400, dy: -3 },
  { a: 45, r: 180 },
  { s: 420 },
]);

// firebreak: a dirt fire-road out of the logging town Pine Hollow, climbing
// through half-burned highland pines to the fire-watch mast, threading a rock
// cutting and two big burn scars before dropping to Highcliff above the sea
const firebreak = [
  { s: 320, dy: 2 },
  { mark: 'vilA1' }, { s: 280, dy: 2 }, { mark: 'vilA2' },
  { a: -55, r: 180, dy: 4 },
  { s: 260, dy: 7 },
  { a: 70, r: 135, dy: 4 },
  { s: 240, dy: 5 },
  { a: -85, r: 115, dy: -3 },
  { s: 200, dy: -5 },
  { mark: 'brA' }, { s: 160 }, { mark: 'brB' },
  { s: 200, dy: 4 },
  { a: 60, r: 150, dy: 5 },
  { s: 260, dy: 8 },
  { a: -100, r: 110, dy: 2 },
  { s: 240, dy: -4 },
  { a: 45, r: 190, dy: -3 },
  { s: 240, dy: -5 },
  { mark: 'jump' },
  { s: 220, dy: 4 },
  { a: -70, r: 140, dy: 3 },
  { s: 260, dy: 6 },
  { a: 90, r: 115, dy: -4 },
  { s: 260, dy: -6 },
  { a: -45, r: 215, dy: -3 },
  { mark: 'vilB1' }, { s: 280, dy: -4 }, { mark: 'vilB2' },
  { a: 35, r: 245, dy: -2 },
  { s: 380, dy: -3 },
];
const firebreakRoute = makeRoute(firebreak);

// salt-flat rally sprint: flat-out across the blinding pans from Gullport
// to Ember Flat — long drags, sweeping bends, a causeway over the brine
const saltpanRoute = makeRoute([
  { s: 500 },
  { a: -40, r: 280 },
  { s: 420, dy: 2 },
  { a: 65, r: 240 },
  { s: 380 },
  { a: -55, r: 260 },
  { mark: 'brA' }, { s: 160 }, { mark: 'brB' },
  { s: 300, dy: 1 },
  { a: 80, r: 210 },
  { s: 450, dy: -1 },
  { a: -70, r: 230 },
  { s: 380, dy: 2 },
  { a: 45, r: 300 },
  { s: 420, dy: -2 },
  { a: -90, r: 200 },
  { s: 350, dy: 1 },
  { a: 60, r: 250 },
  { s: 520 },
]);

// swamp causeway: a low dirt bund winding through drowned jungle between
// Isla Verde and Kampong — two channel bridges, flooded flats either side,
// and one stilt village strung along the middle of the crossing
const mangrove = [
  { s: 320, dy: 2 },
  { a: 55, r: 160, dy: 1 },
  { s: 320 },
  { a: -75, r: 130 },
  { s: 260, dy: 1 },
  { mark: 'brA' }, { s: 170 }, { mark: 'brB' },
  { s: 240, dy: -1 },
  { a: 60, r: 150 },
  { s: 360, dy: 1 },
  { a: -95, r: 120 },
  { s: 260, dy: -1 },
  { a: 70, r: 140 },
  { mark: 'vilA1' }, { s: 320 }, { mark: 'vilA2' },
  { a: -60, r: 160 },
  { s: 320, dy: 1 },
  { a: 85, r: 125 },
  { s: 260, dy: -1 },
  { a: -50, r: 170 },
  { s: 260, dy: 1 },
  { mark: 'brC' }, { s: 200 }, { mark: 'brD' },
  { s: 240, dy: -1 },
  { a: 65, r: 145 },
  { s: 340, dy: 1 },
  { a: -110, r: 115 },
  { s: 300, dy: -1 },
  { a: 45, r: 170 },
  { s: 380, dy: 1 },
  { a: -70, r: 150 },
  { s: 460, dy: -1 },
];
const mangroveRoute = makeRoute(mangrove);

// quarry haul-road: dusty drag out of Gorge Camp, a loading-ramp tabletop,
// then a switchback ladder up the blasted pit benches (~+45), a rim-road
// crest and a long braking descent onto the barren flats toward Kampong
const quarry = [
  { s: 380, dy: 2 },
  { a: -50, r: 230 },
  { s: 320, dy: 3 },
  { a: 70, r: 150, dy: 2 },
  { s: 300, dy: 3 },
  { mark: 'jump' },
  { s: 260, dy: 2 },
  { a: -168, r: 84, dy: 5 },
  { s: 300, dy: 6 },
  { a: 166, r: 82, dy: 5 },
  { s: 320, dy: 6 },
  { a: -164, r: 86, dy: 5 },
  { s: 300, dy: 6 },
  { a: 60, r: 185, dy: 1 },
  { s: 320, dy: 1 },
  { a: -55, r: 210, dy: -3 },
  { s: 340, dy: -7 },
  { a: 45, r: 250, dy: -5 },
  { s: 360, dy: -7 },
  { a: -70, r: 170, dy: -4 },
  { s: 320, dy: -4 },
  { a: 35, r: 280, dy: -2 },
  { s: 300, dy: -2 },
  { a: -25, r: 300, dy: -1 },
  { s: 430, dy: -1 },
];
const quarryRoute = makeRoute(quarry);

// storm-beach dune road down the west coast: out of Highcliff past the
// grazing edge, one huddled coast village, then two long dune fields split
// by a shingle flat, and a windswept run-in to Gullport
const dunecoastRoute = makeRoute([
  { s: 340, dy: 1 },
  { a: -40, r: 240 },
  { s: 320, dy: 2 },
  { a: 55, r: 180 },
  { mark: 'vilA1' }, { s: 300, dy: 1 }, { mark: 'vilA2' },
  { a: -60, r: 160, dy: 2 },
  { s: 400, dy: -2 },
  { a: 45, r: 220 },
  { s: 520, dy: 3 },
  { a: -75, r: 140, dy: -2 },
  { s: 340 },
  { a: 60, r: 170, dy: 2 },
  { s: 440, dy: -3 },
  { a: -50, r: 200 },
  { s: 380, dy: 2 },
  { a: 90, r: 130, dy: -1 },
  { s: 340 },
  { a: -45, r: 240, dy: 2 },
  { s: 540, dy: -2 },
  { a: 35, r: 260 },
  { s: 480, dy: -1 },
]);

export const TRACKS = [
  {
    id: 'riviera',
    zones: [{ from: 0.06, to: 0.18, kind: 'grove' }, { from: 0.21, to: 0.29, kind: 'town' }, { from: 0.4, to: 0.45, kind: 'orchard' }, { from: 0.55, to: 0.66, kind: 'fields' }, { from: 0.71, to: 0.82, kind: 'barren' }, { from: 0.86, to: 0.95, kind: 'burned' }],
    landmarks: ['billboards', 'wrecks', 'gasstation', 'turbines'],
    name: 'RIVIERA RUN',
    subtitle: `Coastal sprint A→B — ${(riviera.length / 1000).toFixed(1)} km`,
    surface: 'asphalt',
    width: 13,
    margin: 8,
    points: riviera.points,
    bumps: null,
    jumps: [],
    tunnels: [{ from: riviera.frac('tunA'), to: riviera.frac('tunB') }],
    bridges: [{ from: riviera.frac('brA'), to: riviera.frac('brB'), water: true }],
    offroad: { grip: 0.5, topSpeed: 0.5, drag: 0.055 },
    bikeMods: {
      sport: { grip: 1.0, topSpeed: 1.0, accel: 1.0 },
      cross: { grip: 0.92, topSpeed: 0.93, accel: 1.0 },
    },
    colors: {
      sky: 0x77b5e5, fog: 0xa8cbe8, ground: 0x4e8f3a,
      road: '#5a5a60', roadEdge: '#e8e8e8', shoulder: 0x447c33,
      wallA: '#d42b1e', wallB: '#f0f0f0',
    },
    fogDist: 900,
    scenery: 'pine',
  },
  {
    id: 'valley',
    zones: [{ from: 0.08, to: 0.2, kind: 'burned' }, { from: 0.38, to: 0.48, kind: 'cut' }, { from: 0.62, to: 0.72, kind: 'orchard' }, { from: 0.74, to: 0.84, kind: 'grove' }, { from: 0.87, to: 0.94, kind: 'barren' }],
    landmarks: ['pylons', 'wrecks', 'radiomast', 'ruins'],
    name: 'PINE VALLEY TT',
    subtitle: `Forest valley stage — tunnel & viaduct — ${(valley.length / 1000).toFixed(1)} km`,
    surface: 'asphalt',
    width: 13,
    margin: 8,
    points: valley.points,
    bumps: null,
    jumps: [],
    tunnels: [{ from: valley.frac('tunA'), to: valley.frac('tunB') }],
    bridges: [{ from: valley.frac('brA'), to: valley.frac('brB'), water: true }],
    offroad: { grip: 0.5, topSpeed: 0.5, drag: 0.055 },
    bikeMods: {
      sport: { grip: 1.0, topSpeed: 1.0, accel: 1.0 },
      cross: { grip: 0.92, topSpeed: 0.92, accel: 1.0 },
    },
    colors: {
      sky: 0x9fc0d4, fog: 0xaebfb9, ground: 0x3c6a2e,
      road: '#55575e', roadEdge: '#e6e6e6', shoulder: 0x33552a,
      wallA: '#5a6a74', wallB: '#e2e6ea',
    },
    fogDist: 480,
    scenery: 'pine',
    forest: {
      kind: 'sequoia', count: 1700, minDist: 2, spread: 70,
      minScale: 1.0, maxScale: 2.3, leafColor: 0x3c6b38, trunkColor: 0x7a4530,
    },
    valley: { color: 0x2e5226 },
  },
  {
    id: 'cliffs',
    zones: [{ from: 0.08, to: 0.19, kind: 'barren' }, { from: 0.22, to: 0.29, kind: 'town' }, { from: 0.42, to: 0.52, kind: 'grove' }, { from: 0.7, to: 0.82, kind: 'cut' }, { from: 0.86, to: 0.94, kind: 'fields' }],
    landmarks: ['turbines', 'wrecks', 'billboards', 'watertower'],
    name: 'AZURE CLIFFS',
    subtitle: `Hilly cliff-road stage above the sea — ${(cliffs.length / 1000).toFixed(1)} km`,
    surface: 'asphalt',
    width: 13,
    margin: 8,
    points: cliffs.points,
    bumps: null,
    jumps: [],
    tunnels: [{ from: cliffs.frac('tunA'), to: cliffs.frac('tunB') }],
    bridges: [{ from: cliffs.frac('brA'), to: cliffs.frac('brB'), water: true }],
    offroad: { grip: 0.5, topSpeed: 0.5, drag: 0.055 },
    bikeMods: {
      sport: { grip: 1.0, topSpeed: 1.0, accel: 1.0 },
      cross: { grip: 0.92, topSpeed: 0.92, accel: 1.0 },
    },
    colors: {
      sky: 0x8ec8ea, fog: 0xbcd8e8, ground: 0x7aa855,
      road: '#5c5c62', roadEdge: '#f0f0f0', shoulder: 0x6a9448,
      wallA: '#2277cc', wallB: '#f4f4f4',
    },
    fogDist: 820,
    scenery: 'palm',
    island: { margin: 140 },
  },
  {
    id: 'isla',
    zones: [{ from: 0.05, to: 0.16, kind: 'grove' }, { from: 0.28, to: 0.38, kind: 'lake' }, { from: 0.5, to: 0.6, kind: 'burned' }, { from: 0.66, to: 0.77, kind: 'barren' }, { from: 0.84, to: 0.94, kind: 'grove' }],
    landmarks: ['ruins', 'wrecks', 'radiomast'],
    name: 'ISLA VERDE',
    subtitle: `Jungle island stage — tunnel, gorge bridge & the jump — ${(isla.length / 1000).toFixed(1)} km`,
    surface: 'asphalt',
    width: 13,
    margin: 8,
    points: isla.points,
    bumps: null,
    jumps: [{ sFrac: isla.frac('jump'), height: 2.0, width: 18 }],
    tunnels: [{ from: isla.frac('tunA'), to: isla.frac('tunB') }],
    bridges: [{ from: isla.frac('brA'), to: isla.frac('brB'), water: true }],
    offroad: { grip: 0.5, topSpeed: 0.5, drag: 0.055 },
    bikeMods: {
      sport: { grip: 1.0, topSpeed: 1.0, accel: 1.0 },
      cross: { grip: 0.92, topSpeed: 0.92, accel: 1.0 },
    },
    colors: {
      sky: 0x8ecfe0, fog: 0xc2ded2, ground: 0x3f7a33,
      road: '#4e5054', roadEdge: '#e8e8e8', shoulder: 0x35682c,
      wallA: '#2c7a4c', wallB: '#f0f0f0',
    },
    fogDist: 750,
    scenery: 'pine',
    forest: {
      count: 950, minDist: 4, spread: 78, minScale: 1.0, maxScale: 2.3,
      leafColor: 0x1e5c2a, trunkColor: 0x6a4a2c,
    },
    island: { margin: 130 },
  },
  {
    id: 'corniche',
    zones: [{ from: 0.02, to: 0.07, kind: 'fields' }, { from: 0.25, to: 0.38, kind: 'cut' }, { from: 0.45, to: 0.54, kind: 'barren' }, { from: 0.63, to: 0.71, kind: 'orchard' }, { from: 0.8, to: 0.89, kind: 'burned' }],
    landmarks: ['turbines', 'billboards', 'wrecks', 'watertower'],
    name: 'CORNICHE HEIGHTS',
    subtitle: `Coastal switchback climb through hill villages — ${(cornicheRoute.length / 1000).toFixed(1)} km`,
    surface: 'asphalt',
    width: 12,
    margin: 7,
    points: cornicheRoute.points,
    bumps: null,
    jumps: [],
    tunnels: [{ from: cornicheRoute.frac('tunA'), to: cornicheRoute.frac('tunB') }],
    bridges: [{ from: cornicheRoute.frac('brA'), to: cornicheRoute.frac('brB'), water: true }],
    villages: [
      { from: cornicheRoute.frac('vilA1'), to: cornicheRoute.frac('vilA2'), style: 'coast' },
      { from: cornicheRoute.frac('vilB1'), to: cornicheRoute.frac('vilB2'), style: 'coast' },
    ],
    offroad: { grip: 0.5, topSpeed: 0.5, drag: 0.055 },
    bikeMods: {
      sport: { grip: 1.0, topSpeed: 0.97, accel: 1.0 },
      cross: { grip: 0.95, topSpeed: 0.9, accel: 1.02 },
    },
    colors: {
      sky: 0x86c4ea, fog: 0xc4dcea, ground: 0x74a04e,
      road: '#5c5c62', roadEdge: '#f0f0f0', shoulder: 0x648c44,
      wallA: '#cc8822', wallB: '#f4f4f4',
    },
    fogDist: 860,
    scenery: 'palm',
    apron: { width: 68 },
    island: { margin: 170 },
  },
  {
    id: 'canyon',
    zones: [{ from: 0.05, to: 0.16, kind: 'cut' }, { from: 0.19, to: 0.27, kind: 'dunes' }, { from: 0.36, to: 0.52, kind: 'spires' }, { from: 0.68, to: 0.79, kind: 'grove' }, { from: 0.84, to: 0.93, kind: 'burned' }],
    landmarks: ['plane', 'pylons', 'wrecks', 'gasstation'],
    name: 'RED GORGE',
    subtitle: `Canyon run between red-rock walls — ${(canyonRoute.length / 1000).toFixed(1)} km`,
    surface: 'asphalt',
    width: 12,
    margin: 7,
    points: canyonRoute.points,
    bumps: null,
    jumps: [],
    tunnels: [{ from: canyonRoute.frac('tunA'), to: canyonRoute.frac('tunB') }],
    bridges: [{ from: canyonRoute.frac('brA'), to: canyonRoute.frac('brB'), water: true }],
    offroad: { grip: 0.45, topSpeed: 0.45, drag: 0.06 },
    bikeMods: {
      sport: { grip: 0.98, topSpeed: 1.0, accel: 1.0 },
      cross: { grip: 0.96, topSpeed: 0.92, accel: 1.02 },
    },
    colors: {
      sky: 0xc6a67a, fog: 0xd6b48a, ground: 0xb07848,
      road: '#5e5852', roadEdge: '#e8e0d0', shoulder: 0x9a6840,
      wallA: '#8a4a30', wallB: '#d8c0a0',
    },
    fogDist: 620,
    scenery: 'desert',
    valley: { color: 0x9a5236 },
  },
  {
    id: 'kampong',
    zones: [{ from: 0.17, to: 0.24, kind: 'grove' }, { from: 0.3, to: 0.39, kind: 'burned' }, { from: 0.51, to: 0.6, kind: 'lake' }, { from: 0.66, to: 0.8, kind: 'grove' }],
    landmarks: ['ruins', 'wrecks', 'radiomast'],
    name: 'KAMPONG TRAIL',
    subtitle: `Jungle track through stilt villages — ${(kampongRoute.length / 1000).toFixed(1)} km`,
    surface: 'asphalt',
    width: 11,
    margin: 6,
    points: kampongRoute.points,
    bumps: null,
    jumps: [],
    tunnels: [],
    bridges: [
      { from: kampongRoute.frac('brA'), to: kampongRoute.frac('brB'), water: true },
      { from: kampongRoute.frac('brC'), to: kampongRoute.frac('brD'), water: true },
    ],
    villages: [
      { from: kampongRoute.frac('vilA1'), to: kampongRoute.frac('vilA2'), style: 'stilt' },
      { from: kampongRoute.frac('vilB1'), to: kampongRoute.frac('vilB2'), style: 'stilt' },
      { from: kampongRoute.frac('vilC1'), to: kampongRoute.frac('vilC2'), style: 'stilt' },
    ],
    offroad: { grip: 0.42, topSpeed: 0.45, drag: 0.065 },
    bikeMods: {
      sport: { grip: 0.96, topSpeed: 0.95, accel: 1.0 },
      cross: { grip: 0.98, topSpeed: 0.94, accel: 1.03 },
    },
    colors: {
      sky: 0x9ed3d8, fog: 0xb8d6c0, ground: 0x39702f,
      road: '#4c4e50', roadEdge: '#ded8c8', shoulder: 0x2f5e28,
      wallA: '#3a7a4a', wallB: '#e0d8b8',
    },
    fogDist: 420,
    scenery: 'pine',
    forest: {
      count: 2800, minDist: 3, spread: 60, minScale: 1.1, maxScale: 2.4,
      leafColor: 0x246430, trunkColor: 0x5f4630,
    },
  },
  {
    id: 'neo',
    zones: [{ from: 0.2, to: 0.31, kind: 'barren' }, { from: 0.35, to: 0.43, kind: 'town' }, { from: 0.56, to: 0.68, kind: 'cut' }, { from: 0.74, to: 0.86, kind: 'burned' }],
    landmarks: ['pylons', 'wrecks', 'billboards'],
    name: 'NEO-CITY RUN',
    subtitle: `Night expressway sprint — long tunnels, neon — ${(neo.length / 1000).toFixed(1)} km`,
    surface: 'asphalt',
    width: 16,
    margin: 6,
    points: neo.points,
    bumps: null,
    jumps: [],
    tunnels: [
      { from: neo.frac('tunA'), to: neo.frac('tunB') },
      { from: neo.frac('tunC'), to: neo.frac('tunD') },
    ],
    bridges: [],
    offroad: { grip: 0.5, topSpeed: 0.5, drag: 0.055 },
    bikeMods: {
      sport: { grip: 1.0, topSpeed: 1.0, accel: 1.0 },
      cross: { grip: 0.92, topSpeed: 0.92, accel: 1.0 },
    },
    colors: {
      sky: 0x0a0d1c, fog: 0x131a33, ground: 0x101018,
      road: '#34343c', roadEdge: '#8fd8ff', shoulder: 0x16161e,
      wallA: '#2a2f42', wallB: '#8899bb',
    },
    fogDist: 760,
    scenery: 'city',
    night: { hemi: 0.5, sun: 0.3, sunColor: 0x8899dd },
    neon: true,
    city: { towers: 400, neons: 170, billboards: 28 },
  },
  {
    id: 'mojave',
    zones: [{ from: 0.06, to: 0.18, kind: 'cut' }, { from: 0.28, to: 0.44, kind: 'dunes' }, { from: 0.5, to: 0.6, kind: 'spires' }, { from: 0.74, to: 0.88, kind: 'fields' }],
    landmarks: ['plane', 'watertower', 'wrecks', 'gasstation', 'ruins'],
    name: 'MOJAVE CROSS',
    subtitle: `Desert rally stage — whoops & tabletops — ${(mojave.length / 1000).toFixed(1)} km`,
    surface: 'dirt',
    width: 16,
    margin: 10,
    points: mojave.points,
    bumps: { amp: 0.7, wavelength: 64 },
    jumps: [
      { sFrac: mojave.frac('jumpA'), height: 2.4, width: 16 },
      { sFrac: mojave.frac('jumpB'), height: 1.7, width: 13 },
    ],
    tunnels: [],
    bridges: [{ from: mojave.frac('brA'), to: mojave.frac('brB'), water: false }],
    offroad: { grip: 0.42, topSpeed: 0.5, drag: 0.06 },
    bikeMods: {
      sport: { grip: 0.72, topSpeed: 0.8, accel: 0.85 },
      cross: { grip: 0.95, topSpeed: 1.0, accel: 1.0 },
    },
    colors: {
      sky: 0xf2b96e, fog: 0xe8c491, ground: 0xc49a58,
      road: '#8a6a42', roadEdge: '#c9a86a', shoulder: 0xb08a4e,
      wallA: '#8a5a2a', wallB: '#d8c090',
    },
    fogDist: 750,
    scenery: 'desert',
  },
  {
    id: 'firebreak',
    zones: [{ from: 0.15, to: 0.22, kind: 'grove' }, { from: 0.24, to: 0.29, kind: 'burned' }, { from: 0.42, to: 0.5, kind: 'cut' }, { from: 0.55, to: 0.64, kind: 'grove' }, { from: 0.68, to: 0.8, kind: 'burned' }],
    landmarks: ['radiomast', 'wrecks', 'pylons'],
    name: 'FIREBREAK',
    subtitle: `Fire-road through the burned highlands — Pine Hollow to Highcliff — ${(firebreakRoute.length / 1000).toFixed(1)} km`,
    surface: 'dirt',
    width: 12,
    margin: 7,
    points: firebreakRoute.points,
    bumps: { amp: 0.32, wavelength: 64 },
    jumps: [{ sFrac: firebreakRoute.frac('jump'), height: 2.0, width: 18 }],
    tunnels: [],
    bridges: [{ from: firebreakRoute.frac('brA'), to: firebreakRoute.frac('brB'), water: false }],
    villages: [
      { from: firebreakRoute.frac('vilA1'), to: firebreakRoute.frac('vilA2'), style: 'stilt' },
      { from: firebreakRoute.frac('vilB1'), to: firebreakRoute.frac('vilB2'), style: 'coast' },
    ],
    offroad: { grip: 0.6, topSpeed: 0.62, drag: 0.045 },
    bikeMods: {
      sport: { grip: 0.88, topSpeed: 0.85, accel: 0.95 },
      cross: { grip: 1.0, topSpeed: 0.97, accel: 1.03 },
    },
    colors: {
      sky: 0x9a8474, fog: 0xb39479, ground: 0x33482a,
      road: '#71604a', roadEdge: '#8f7d5e', shoulder: 0x2a3c24,
      wallA: '#4c4340', wallB: '#c8b49c',
    },
    fogDist: 450,
    scenery: 'pine',
    forest: {
      kind: 'sequoia', count: 1600, minDist: 3, spread: 68,
      minScale: 1.0, maxScale: 2.5, leafColor: 0x2d5226, trunkColor: 0x4a3a30,
    },
  },
  {
    id: 'saltpan',
    zones: [{ from: 0.05, to: 0.18, kind: 'barren' }, { from: 0.2, to: 0.3, kind: 'lake' }, { from: 0.42, to: 0.56, kind: 'barren' }, { from: 0.62, to: 0.7, kind: 'fields' }, { from: 0.76, to: 0.92, kind: 'barren' }],
    landmarks: ['plane', 'billboards', 'watertower'],
    name: 'SALTPAN RALLY',
    subtitle: `Gullport → Ember Flat — flat-out across the blinding pans — ${(saltpanRoute.length / 1000).toFixed(1)} km`,
    surface: 'dirt',
    width: 12,
    margin: 7,
    points: saltpanRoute.points,
    bumps: { amp: 0.25, wavelength: 64 },
    jumps: [],
    tunnels: [],
    bridges: [{ from: saltpanRoute.frac('brA'), to: saltpanRoute.frac('brB'), water: false }],
    offroad: { grip: 0.6, topSpeed: 0.62, drag: 0.045 },
    bikeMods: {
      sport: { grip: 0.88, topSpeed: 0.85, accel: 0.95 },
      cross: { grip: 1.0, topSpeed: 0.97, accel: 1.03 },
    },
    colors: {
      sky: 0xe4ecf2, fog: 0xf0ece0, ground: 0xd8d2c4,
      road: '#a4937a', roadEdge: '#cfc3a8', shoulder: 0xcac0ac,
      wallA: '#b06a48', wallB: '#efe9db',
    },
    fogDist: 900,
    scenery: 'desert',
  },
  {
    id: 'mangrove',
    zones: [{ from: 0.04, to: 0.135, kind: 'grove' }, { from: 0.23, to: 0.35, kind: 'lake' }, { from: 0.47, to: 0.59, kind: 'grove' }, { from: 0.69, to: 0.78, kind: 'lake' }, { from: 0.82, to: 0.93, kind: 'grove' }],
    landmarks: ['ruins', 'radiomast', 'wrecks'],
    name: 'MANGROVE RUN',
    subtitle: `Swamp causeway across drowned jungle — ${(mangroveRoute.length / 1000).toFixed(1)} km`,
    surface: 'dirt',
    width: 12,
    margin: 7,
    points: mangroveRoute.points,
    bumps: { amp: 0.3, wavelength: 64 },
    jumps: [],
    tunnels: [],
    bridges: [
      { from: mangroveRoute.frac('brA'), to: mangroveRoute.frac('brB'), water: true },
      { from: mangroveRoute.frac('brC'), to: mangroveRoute.frac('brD'), water: true },
    ],
    villages: [
      { from: mangroveRoute.frac('vilA1'), to: mangroveRoute.frac('vilA2'), style: 'stilt' },
    ],
    offroad: { grip: 0.6, topSpeed: 0.62, drag: 0.045 },
    bikeMods: {
      sport: { grip: 0.88, topSpeed: 0.85, accel: 0.95 },
      cross: { grip: 1.0, topSpeed: 0.97, accel: 1.03 },
    },
    colors: {
      sky: 0x8fae9d, fog: 0xa2b8a6, ground: 0x2f5a2c,
      road: '#6e6047', roadEdge: '#8c7f5e', shoulder: 0x2a5026,
      wallA: '#3f6b4a', wallB: '#cdd6bc',
    },
    fogDist: 400,
    scenery: 'pine',
    forest: {
      count: 2400, minDist: 3, spread: 58, minScale: 1.1, maxScale: 2.4,
      leafColor: 0x1e5228, trunkColor: 0x4e4030,
    },
  },
  {
    id: 'quarry',
    zones: [{ from: 0.07, to: 0.18, kind: 'cut' }, { from: 0.3, to: 0.42, kind: 'spires' }, { from: 0.52, to: 0.62, kind: 'cut' }, { from: 0.72, to: 0.86, kind: 'barren' }],
    landmarks: ['pylons', 'watertower', 'gasstation', 'ruins'],
    name: 'QUARRY CLIMB',
    subtitle: `Haul-road ladder over the pit benches — ${(quarryRoute.length / 1000).toFixed(1)} km`,
    surface: 'dirt',
    width: 12,
    margin: 7,
    points: quarryRoute.points,
    bumps: { amp: 0.5, wavelength: 64 },
    jumps: [{ sFrac: quarryRoute.frac('jump'), height: 2.0, width: 18 }],
    tunnels: [],
    bridges: [],
    offroad: { grip: 0.6, topSpeed: 0.62, drag: 0.045 },
    bikeMods: {
      sport: { grip: 0.88, topSpeed: 0.85, accel: 0.95 },
      cross: { grip: 1.0, topSpeed: 0.97, accel: 1.03 },
    },
    colors: {
      sky: 0xd9a266, fog: 0xd8b088, ground: 0x9a7040,
      road: '#7a6448', roadEdge: '#a58a5c', shoulder: 0x8a6238,
      wallA: '#8a4a26', wallB: '#c9a878',
    },
    fogDist: 550,
    scenery: 'desert',
    apron: { width: 68 },
  },
  {
    id: 'dunecoast',
    zones: [{ from: 0.04, to: 0.1, kind: 'fields' }, { from: 0.26, to: 0.42, kind: 'dunes' }, { from: 0.47, to: 0.57, kind: 'barren' }, { from: 0.62, to: 0.8, kind: 'dunes' }],
    landmarks: ['turbines', 'wrecks', 'billboards'],
    name: 'DUNE COAST',
    subtitle: `Storm-beach dune road Highcliff→Gullport — ${(dunecoastRoute.length / 1000).toFixed(1)} km`,
    surface: 'dirt',
    width: 12,
    margin: 7,
    points: dunecoastRoute.points,
    bumps: { amp: 0.75, wavelength: 64 },
    jumps: [],
    tunnels: [],
    bridges: [],
    villages: [
      { from: dunecoastRoute.frac('vilA1'), to: dunecoastRoute.frac('vilA2'), style: 'coast' },
    ],
    offroad: { grip: 0.6, topSpeed: 0.62, drag: 0.045 },
    bikeMods: {
      sport: { grip: 0.88, topSpeed: 0.85, accel: 0.95 },
      cross: { grip: 1.0, topSpeed: 0.97, accel: 1.03 },
    },
    colors: {
      sky: 0x7e93a6, fog: 0x9fb0bc, ground: 0xc3b795,
      road: '#8d7f66', roadEdge: '#af9f7f', shoulder: 0xb0a37f,
      wallA: '#5f6f7c', wallB: '#d9d4c8',
    },
    fogDist: 600,
    scenery: 'palm',
    island: { margin: 165 },
  },
];

export function getTrack(id) {
  return TRACKS.find((t) => t.id === id) || TRACKS[0];
}

// Ride a stage B -> A: reverse the control points and mirror every
// length-fraction feature (a range [from,to] becomes [1-to, 1-from]).
// bumps configs are procedural in s and stay as they are.
export function reverseTrack(def) {
  const flip = (r) => ({ ...r, from: 1 - r.to, to: 1 - r.from });
  return {
    ...def,
    points: [...def.points].reverse(),
    tunnels: (def.tunnels || []).map(flip),
    bridges: (def.bridges || []).map(flip),
    villages: def.villages ? def.villages.map(flip) : def.villages,
    jumps: (def.jumps || []).map((j) => ({ ...j, sFrac: 1 - j.sFrac })),
  };
}
