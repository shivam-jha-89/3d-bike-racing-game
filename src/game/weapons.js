import { loadCareer, saveCareer } from './career.js';

// ---------------------------------------------------------------------------
// The Tyrian layer, part 1: a front-weapon slot with buyable archetypes and
// power levels. Credits (career PTS) buy the gun in the ARMORY, then buy it
// again to push its power level — exactly the between-level shop loop.
// Stats per level: cd (s between shots), pellets/spread (cone), dmg (hit
// points chipped off vehicles), stun (multiplier on the base stun you
// inflict), and for the Thumper an explosive payload (boom scale + blast
// radius in metres).
// ---------------------------------------------------------------------------

export const WEAPONS = {
  pistol: {
    name: 'SERVICE PISTOL', price: 0,
    blurb: 'The courier standard. Slow, honest, always loaded.',
    levels: [
      { cd: 0.35, pellets: 1, spread: 0, dmg: 1, stun: 1, cost: 6 },
      { cd: 0.3, pellets: 1, spread: 0, dmg: 1.3, stun: 1.15, cost: 6 },
      { cd: 0.26, pellets: 1, spread: 0, dmg: 1.6, stun: 1.3, cost: 6 },
    ],
  },
  smg: {
    name: 'CHATTERBOX SMG', price: 260,
    blurb: 'Hold the trigger, hose the road. Each round stings, the stream drowns.',
    levels: [
      { cd: 0.12, pellets: 1, spread: 0.028, dmg: 0.4, stun: 0.35, cost: 2.8 },
      { cd: 0.1, pellets: 1, spread: 0.024, dmg: 0.5, stun: 0.4, cost: 2.6 },
      { cd: 0.085, pellets: 1, spread: 0.02, dmg: 0.6, stun: 0.45, cost: 2.4 },
    ],
  },
  scatter: {
    name: 'GATEBREAKER SCATTER', price: 340,
    blurb: 'A fistful of pellets. Devastating beside a bike, polite at range.',
    levels: [
      { cd: 0.85, pellets: 5, spread: 0.075, dmg: 0.5, stun: 0.55, range: 80, cost: 15 },
      { cd: 0.75, pellets: 6, spread: 0.07, dmg: 0.55, stun: 0.6, range: 90, cost: 14 },
      { cd: 0.68, pellets: 8, spread: 0.065, dmg: 0.6, stun: 0.65, range: 100, cost: 13 },
    ],
  },
  rail: {
    name: 'PROPHET RAIL', price: 520,
    blurb: 'Rust Prophet relic. Long wind-up, and something downrange stops existing.',
    levels: [
      { cd: 1.15, pellets: 1, spread: 0, dmg: 3, stun: 1.9, cost: 24 },
      { cd: 1.0, pellets: 1, spread: 0, dmg: 4, stun: 2.1, cost: 23 },
      { cd: 0.85, pellets: 1, spread: 0, dmg: 5, stun: 2.4, cost: 22 },
    ],
  },
  thumper: {
    name: 'GUILD THUMPER', price: 700,
    blurb: 'Fires a fused slug that detonates on arrival. The road remembers.',
    levels: [
      { cd: 1.5, pellets: 1, spread: 0.012, dmg: 2, stun: 1.2, boom: 0.55, blast: 6, cost: 32 },
      { cd: 1.3, pellets: 1, spread: 0.01, dmg: 2.5, stun: 1.3, boom: 0.7, blast: 7, cost: 30 },
      { cd: 1.15, pellets: 1, spread: 0.008, dmg: 3, stun: 1.4, boom: 0.85, blast: 8, cost: 28 },
    ],
  },
};

// ---------------------------------------------------------------------------
// The Tyrian layer, part 2: elemental damage types and named unique weapons.
// Uniques are never sold — the wasteland pays them out as "PAYMENT IN IRON"
// relic contracts, one homed to each settlement. They live in the same
// arsenal.owned map as the factory guns, at a single fixed power level.
// ---------------------------------------------------------------------------

export const DAMAGE_TYPES = {
  kinetic: { name: 'KINETIC', color: '#d8d8d8' },
  incendiary: { name: 'INCENDIARY', color: '#ff7a2f' },
  shock: { name: 'SHOCK', color: '#5fd7ff' },
  corrosive: { name: 'CORROSIVE', color: '#a8e63c' },
  cryo: { name: 'CRYO', color: '#b9c8ff' },
};

export const UNIQUES = {
  matchstick: {
    base: 'pistol', name: 'MATCHSTICK', damageType: 'incendiary', home: 'gorge',
    blurb: 'Standard rounds dipped in something the miners will not name. Warranty void.',
    stats: { cd: 0.26, pellets: 1, spread: 0, dmg: 1.6, stun: 1.17, cost: 6.9 },
  },
  whitenoise: {
    base: 'smg', name: 'WHITE NOISE', damageType: 'shock', home: 'neon',
    blurb: 'Tuned to the old city’s hum. Targets stop arguing mid-sentence.',
    stats: { cd: 0.085, pellets: 1, spread: 0.016, dmg: 0.6, stun: 0.45, cost: 2.64 },
  },
  brinedog: {
    base: 'scatter', name: 'BRINE DOG', damageType: 'corrosive', home: 'brine',
    blurb: 'Loaded with evaporator salt. Plate rusts faster than reputations.',
    stats: { cd: 0.75, pellets: 8, spread: 0.075, dmg: 0.6, stun: 0.65, range: 110, cost: 13 },
  },
  thelull: {
    base: 'rail', name: 'THE LULL', damageType: 'cryo', home: 'highcliff',
    blurb: 'Cliff wind in a barrel. Whatever it touches slows down to reconsider.',
    stats: { cd: 0.81, pellets: 1, spread: 0, dmg: 5, stun: 2.04, cost: 23.1 },
  },
  hearthbreaker: {
    base: 'thumper', name: 'HEARTHBREAKER', damageType: 'incendiary', home: 'pinehollow',
    blurb: 'Pine Hollow banned it after one demonstration. The stump is still warm.',
    stats: { cd: 1.27, pellets: 1, spread: 0.008, dmg: 2.7, stun: 1.4, boom: 0.95, blast: 9, cost: 30.8 },
  },
  thetaxman: {
    base: 'pistol', name: 'THE TAXMAN', damageType: 'kinetic', home: 'kampong',
    special: 'killRefund', // eliminations feed 8 charge back to the generator
    blurb: 'Collects on every hit. Remits nothing.',
    stats: { cd: 0.29, pellets: 1, spread: 0, dmg: 2, stun: 1.43, cost: 6.9 },
  },
  peckingorder: {
    base: 'smg', name: 'PECKING ORDER', damageType: 'corrosive', home: 'gullport',
    blurb: 'Spits like a gull defending the one working pier. Paint first, plate second.',
    stats: { cd: 0.085, pellets: 1, spread: 0.02, dmg: 0.54, stun: 0.45, cost: 2.76 },
  },
  thunderhead: {
    base: 'rail', name: 'THUNDERHEAD', damageType: 'shock', home: 'verde',
    blurb: 'Jungle storm, bottled. The parrots learned to duck.',
    stats: { cd: 0.98, pellets: 1, spread: 0, dmg: 5, stun: 2.4, cost: 24.2 },
  },
};

// gear visuals and slot keys care about the frame, not the name on it
export function weaponBase(id) {
  return UNIQUES[id] ? UNIQUES[id].base : id;
}

export function upgradeCost(id, lvl) {
  // lvl is the CURRENT level (1-based); cost to reach lvl+1
  const base = Math.max(150, WEAPONS[id].price);
  return Math.round(base * (0.55 + 0.35 * lvl));
}

const KEY = 'motomad-arsenal';

const DEFAULTS = { owned: { pistol: 1 }, equipped: 'pistol' };

export function loadArsenal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const a = JSON.parse(raw);
      return { ...DEFAULTS, ...a, owned: { ...DEFAULTS.owned, ...(a.owned || {}) } };
    }
  } catch { /* fresh rider */ }
  return { ...DEFAULTS, owned: { ...DEFAULTS.owned } };
}

export function saveArsenal(a) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch { /* private mode */ }
}

// buy a weapon (level 1) or raise its power level; spends career points.
// Returns { arsenal, career } on success, null if unaffordable/invalid.
export function buyOrUpgrade(id) {
  const a = loadArsenal();
  const c = loadCareer();
  const lvl = a.owned[id] || 0;
  if (lvl >= WEAPONS[id].levels.length) return null;
  const cost = lvl === 0 ? WEAPONS[id].price : upgradeCost(id, lvl);
  if (c.points < cost) return null;
  c.points -= cost;
  a.owned[id] = lvl + 1;
  if (lvl === 0) a.equipped = id; // buying a gun holsters it ready
  saveCareer(c);
  saveArsenal(a);
  return { arsenal: a, career: c };
}

export function equipWeapon(id) {
  const a = loadArsenal();
  if (!a.owned[id]) return null;
  a.equipped = id;
  saveArsenal(a);
  return a;
}

// resolved stats for the equipped weapon (what Game consumes)
export function getEquippedWeapon() {
  const a = loadArsenal();
  const id = a.owned[a.equipped] ? a.equipped : 'pistol';
  const u = UNIQUES[id];
  if (u) {
    return {
      id, lvl: 1, unique: true, base: u.base, name: u.name,
      damageType: u.damageType, special: u.special || null, ...u.stats,
    };
  }
  const lvl = Math.min(a.owned[id] || 1, WEAPONS[id].levels.length);
  return {
    id, lvl, base: id, name: WEAPONS[id].name, damageType: 'kinetic',
    special: null, ...WEAPONS[id].levels[lvl - 1],
  };
}
