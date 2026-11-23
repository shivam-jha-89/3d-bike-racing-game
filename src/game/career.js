// Persistent career: PTS wallet + upgrade levels, stored in localStorage.
// PTS come from race finishes and gunplay; they buy upgrades in the Garage.

const KEY = 'motomad-career';

export const UPGRADES = {
  engine: { name: 'ENGINE', desc: '+6% top speed, +8% acceleration per level', costs: [400, 800, 1400] },
  tires: { name: 'TYRES', desc: '+5% grip, quicker lean per level', costs: [300, 600, 1000] },
  brakes: { name: 'BRAKES', desc: '+10% braking power per level', costs: [200, 400, 700] },
  armour: { name: 'ARMOUR', desc: 'shorter stuns, longer immunity per level', costs: [300, 600, 1000] },
  gun: { name: 'PISTOL', desc: 'faster fire, harder-hitting rounds per level', costs: [350, 700, 1200] },
  focus: { name: 'FOCUS', desc: 'longer, faster-recharging bullet time per level', costs: [300, 600, 1000] },
};

// championship points by finishing position (13 riders)
export const RACE_POINTS = [15, 12, 10, 8, 6, 5, 4, 3, 2, 1, 0, 0, 0];

// PTS payout by finishing position
export function racePayout(pos) {
  return Math.max(20, 280 - 30 * (pos - 1));
}

function defaults() {
  return {
    points: 0,
    upgrades: { engine: 0, tires: 0, brakes: 0, armour: 0, gun: 0, focus: 0 },
  };
}

export function loadCareer() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const c = JSON.parse(raw);
    return { ...defaults(), ...c, upgrades: { ...defaults().upgrades, ...(c.upgrades || {}) } };
  } catch {
    return defaults();
  }
}

export function saveCareer(c) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode etc — career just won't persist */
  }
}

export function addPoints(n) {
  const c = loadCareer();
  c.points += n;
  saveCareer(c);
  return c;
}

// returns the updated career, or null if unaffordable / maxed
export function buyUpgrade(key) {
  const c = loadCareer();
  const def = UPGRADES[key];
  const lvl = c.upgrades[key] || 0;
  if (!def || lvl >= def.costs.length) return null;
  const cost = def.costs[lvl];
  if (c.points < cost) return null;
  c.points -= cost;
  c.upgrades[key] = lvl + 1;
  saveCareer(c);
  return c;
}

// player's bike spec with upgrade multipliers applied
export function applyUpgrades(bike, up) {
  return {
    ...bike,
    topSpeed: bike.topSpeed * (1 + 0.06 * up.engine),
    accel: bike.accel * (1 + 0.08 * up.engine),
    grip: bike.grip * (1 + 0.05 * up.tires),
    leanSpeed: bike.leanSpeed * (1 + 0.06 * up.tires),
    brake: bike.brake * (1 + 0.1 * up.brakes),
  };
}
