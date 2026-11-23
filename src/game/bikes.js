// The two machines. Stats are in SI units: m/s, m/s^2, radians.
// `grip` is a friction multiplier (1.0 ~ street tyre on asphalt).
// `type` selects the per-track surface modifiers in tracks.js.

export const BIKES = [
  {
    id: 'gp500',
    name: 'FALCON GP500',
    tagline: 'Factory superbike. Brutal top end, needs asphalt.',
    type: 'sport',
    topSpeed: 78, // ~280 km/h
    accel: 13.5,
    brake: 24,
    grip: 1.22,
    maxLean: 0.96, // ~55 deg
    leanSpeed: 2.7,
    colors: { body: 0xd41f2c, accent: 0xffffff, rider: 0x22222a, helmet: 0xd41f2c },
    stats: { speed: 0.98, accel: 0.8, handling: 0.62, offroad: 0.3 },
  },
  {
    id: 'mx250',
    name: 'VIPERA MX250',
    tagline: 'Two-stroke motocrosser. Flickable, eats dirt for breakfast.',
    type: 'cross',
    topSpeed: 54, // ~195 km/h
    accel: 12.5,
    brake: 19,
    grip: 1.12,
    maxLean: 0.84, // ~48 deg
    leanSpeed: 3.5,
    colors: { body: 0xf2c000, accent: 0x1c3fb0, rider: 0x2a2a30, helmet: 0xf2c000 },
    stats: { speed: 0.62, accel: 0.75, handling: 0.9, offroad: 0.95 },
  },
];

// The third machine: a low-slung Neo-City prototype. Uses sport-tyre
// surface modifiers but its own mesh style, riding posture and sound.
BIKES.push({
  id: 'akira',
  name: 'CYCLONE 2019',
  tagline: 'Two-wheel-drive prototype. The red legend of Neo-City.',
  type: 'sport',
  style: 'akira',
  topSpeed: 82, // ~295 km/h
  accel: 14.5,
  brake: 26,
  grip: 1.18,
  maxLean: 0.88, // long and heavy — leans a little less...
  leanSpeed: 2.1, // ...and takes its time getting there
  colors: { body: 0xd8101e, accent: 0xf2f2f2, rider: 0x9a1622, helmet: 0xd8101e },
  stats: { speed: 1.0, accel: 0.88, handling: 0.45, offroad: 0.15 },
});

export function getBike(id) {
  return BIKES.find((b) => b.id === id) || BIKES[0];
}
