// ---------------------------------------------------------------------------
// The RPG spine (Phase 1): persistent rider state — scrap, fuel, XP, perks,
// current settlement — plus the wasteland graph (settlements as nodes, the
// nine race tracks as the roads between them) and the contract generator
// that parameterizes existing race modes into quests.
// ---------------------------------------------------------------------------

import { AI_NAMES } from './Game.js';
import { UNIQUES, DAMAGE_TYPES, loadArsenal, saveArsenal } from './weapons.js';

const KEY = 'motomad-rpg';

export const SETTLEMENTS = {
  ember: {
    name: 'EMBER FLAT', pop: 34, x: 44, y: 46,
    blurb: 'A crossroads town living off road tolls and burned coffee.',
  },
  brine: {
    name: 'BRINEWORKS', pop: 61, x: 18, y: 38,
    blurb: 'Salt evaporators and boat wrecks. Smells like rust and dinner.',
  },
  pinehollow: {
    name: 'PINE HOLLOW', pop: 27, x: 38, y: 14,
    blurb: 'Loggers under the big trees. They do not like helicopters.',
  },
  highcliff: {
    name: 'HIGHCLIFF', pop: 38, x: 8, y: 12,
    blurb: 'A village stacked up a sea hill. The climb kills more than the raiders.',
  },
  gullport: {
    name: 'GULLPORT', pop: 19, x: 10, y: 66,
    blurb: 'Three piers, one working. Gulls own the other two.',
  },
  verde: {
    name: 'ISLA VERDE', pop: 12, x: 26, y: 88,
    blurb: 'Jungle ruin. Twelve people, four hundred parrots, one runway.',
  },
  neon: {
    name: 'NEO-CITY', pop: 208, x: 78, y: 40,
    blurb: 'The old city still hums at night. Nobody asks what powers it.',
  },
  gorge: {
    name: 'GORGE CAMP', pop: 22, x: 68, y: 12,
    blurb: 'Miners squatting in the red rocks. Paid in dust, twice on Fridays.',
  },
  kampong: {
    name: 'KAMPONG', pop: 45, x: 88, y: 74,
    blurb: 'Stilt houses over brown water. Best fish and worst roads in the belt.',
  },
};

// roads: the nine stages, each connecting two settlements
export const ROADS = [
  { trackId: 'riviera', a: 'ember', b: 'brine', km: 6.6 },
  { trackId: 'valley', a: 'ember', b: 'pinehollow', km: 7.2 },
  { trackId: 'canyon', a: 'ember', b: 'gorge', km: 6.3 },
  { trackId: 'neo', a: 'ember', b: 'neon', km: 8.8 },
  { trackId: 'corniche', a: 'brine', b: 'highcliff', km: 6.4 },
  { trackId: 'cliffs', a: 'brine', b: 'gullport', km: 6.0 },
  { trackId: 'isla', a: 'gullport', b: 'verde', km: 7.3 },
  { trackId: 'mojave', a: 'gorge', b: 'neon', km: 5.7 },
  { trackId: 'kampong', a: 'neon', b: 'kampong', km: 5.1 },
  // the dirt web: five rough roads knitting the belt together
  { trackId: 'firebreak', a: 'pinehollow', b: 'highcliff', km: 5.5 },
  { trackId: 'saltpan', a: 'gullport', b: 'ember', km: 6.0 },
  { trackId: 'mangrove', a: 'verde', b: 'kampong', km: 7.1 },
  { trackId: 'quarry', a: 'gorge', b: 'kampong', km: 6.5 },
  { trackId: 'dunecoast', a: 'highcliff', b: 'gullport', km: 6.2 },
];

export function roadsFrom(loc) {
  // riding b -> a runs the stage reversed: same road, opposite direction
  return ROADS.filter((r) => r.a === loc || r.b === loc)
    .map((r) => ({ ...r, dest: r.a === loc ? r.b : r.a, reversed: r.a !== loc }));
}

export function fuelCost(road, state) {
  const mul = state.perks.includes('wastelander') ? 0.75 : 1;
  return Math.round(road.km * 2 * mul);
}

// --------------------------------------------------------------------- perks
export const PERKS = {
  tailgater: {
    name: 'TAILGATER', mods: { draft: 1.45 },
    desc: 'You live in other people’s wake. Slipstream pulls 45% harder.',
  },
  deadeye: {
    name: 'DEADEYE', mods: { gunCd: 0.78 },
    desc: 'The pistol comes up before you decide to draw it. Fire 22% faster.',
  },
  ironhide: {
    name: 'IRONHIDE', mods: { armour: 0.82 },
    desc: 'Scar tissue counts as armour out here. Hits rattle you 18% less.',
  },
  deadmans: {
    name: 'DEAD MAN’S THROTTLE', mods: { selfStun: 0.6 },
    desc: 'You have crashed enough to stop caring. Your stuns last 40% shorter.',
  },
  scraprat: {
    name: 'SCRAP RAT', mods: {},
    desc: 'You can smell solder through a wall. Earn 30% more scrap.',
  },
  coldfocus: {
    name: 'COLD FOCUS', mods: { focus: 1.35 },
    desc: 'The world slows down easier for you. 35% more bullet time.',
  },
  leadwrist: {
    name: 'LEAD WRIST', mods: { gunStun: 1.25 },
    desc: 'You hit like a dropped engine block. Your stuns last 25% longer.',
  },
  wastelander: {
    name: 'WASTELANDER', mods: {},
    desc: 'You know which ruts hold a straight line. Legs cost 25% less fuel.',
  },
};

// multiplies applied inside Game from the owned perk set
export function perkMods(perks) {
  const m = { draft: 1, gunCd: 1, armour: 1, selfStun: 1, focus: 1, gunStun: 1 };
  for (const id of perks) {
    const p = PERKS[id];
    if (!p) continue;
    for (const k in p.mods) m[k] *= p.mods[k];
  }
  return m;
}

// ------------------------------------------------------------------ levelling
export function xpForLevel(level) {
  // total xp needed to REACH this level: 0, 150, 400, 750, 1200 ...
  return 25 * (level - 1) * (level + 4);
}

export function levelFromXp(xp) {
  let lv = 1;
  while (xpForLevel(lv + 1) <= xp) lv++;
  return lv;
}

// deterministic 3-perk offer for a given level-up (unowned first)
export function perkOffer(level, owned) {
  const pool = Object.keys(PERKS).filter((id) => !owned.includes(id));
  const out = [];
  let seed = level * 2654435761 >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  while (out.length < Math.min(3, pool.length)) {
    const pick = pool[Math.floor(rnd() * pool.length)];
    if (!out.includes(pick)) out.push(pick);
  }
  return out;
}

// ------------------------------------------------------------------ contracts
// PAYMENT IN IRON: each unique weapon has a home settlement. Once the rider
// is level 3+, a contract heading there has a chance to harden into a relic
// job — tougher goal, half the scrap, and the gun itself as payment.
const RELIC_HOME = {};
for (const [uid, u] of Object.entries(UNIQUES)) RELIC_HOME[u.home] = uid;

function relicify(c, relicId, rnd) {
  const u = UNIQUES[relicId];
  // milkrun is too easy to gate a unique behind — promote it to a delivery
  if (c.type === 'milkrun') {
    c.type = 'delivery';
    c.title = c.title.replace('ESCORT SEAT TO', 'RUN A CRATE TO');
    c.goal = 'Win the package run';
    delete c.pos;
  }
  if (c.type === 'delivery') {
    c.needHits = 5;
    c.goal = 'Win the run AND land 5 hits on riders';
  } else if (c.type === 'gunships') {
    c.n = 2;
    c.goal = 'Down 2 gunships on the leg';
    c.title = c.title.replace('THE BIRD', 'BOTH BIRDS');
  } else if (c.type === 'launchers') {
    c.n = 3;
    c.goal = 'Destroy 3 launchers on the leg';
  } else if (c.type === 'assassin') {
    c.goal = `Eliminate ${c.targetName} AND finish top 3`;
    c.title += ' — AND PLACE';
  }
  c.relicId = relicId;
  c.relicName = u.name;
  c.relicColor = DAMAGE_TYPES[u.damageType].color;
  c.xp = Math.round(c.xp * 1.4);
  c.desc += ` They are not paying scrap this time. They are paying iron: ${u.name}. ${u.blurb}`;
  return c;
}

// quests are parameterized race modes on a specific road out of town
export function contractsAt(loc, state) {
  const roads = roadsFrom(loc);
  const out = [];
  let seed = (loc.charCodeAt(0) * 31 + state.legsRidden * 7 + 13) >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const types = ['delivery', 'gunships', 'launchers', 'milkrun', 'assassin'];
  for (let i = 0; i < Math.min(2, roads.length); i++) {
    const road = roads[Math.floor(rnd() * roads.length)];
    const type = types[Math.floor(rnd() * types.length)];
    const destName = SETTLEMENTS[road.dest].name;
    if (type === 'delivery') {
      out.push({
        type, road, reward: 90, xp: 120,
        title: `RUN A CRATE TO ${destName}`,
        desc: 'Medicine, if anyone asks. Grab the package on the road and be first through the gate.',
        goal: 'Win the package run',
      });
    } else if (type === 'gunships') {
      out.push({
        type, road, n: 1, reward: 120, xp: 150,
        title: `BRING DOWN THE BIRD OVER ${destName} ROAD`,
        desc: 'A gunship has been taxing the convoys with rockets. The Guild pays for wreckage.',
        goal: 'Down 1 gunship on the leg',
      });
    } else if (type === 'launchers') {
      out.push({
        type, road, n: 2, reward: 100, xp: 130,
        title: `CLEAR THE BATTERIES ON ${destName} ROAD`,
        desc: 'Rocket towers went up overnight. Two pistol hits each and they stay down.',
        goal: 'Destroy 2 launchers on the leg',
      });
    } else if (type === 'assassin') {
      const targetIdx = 1 + Math.floor(rnd() * 4); // one of the front-runners
      const targetName = AI_NAMES[targetIdx];
      out.push({
        type, road, targetIdx, targetName, reward: 150, xp: 180,
        title: `PUT ${targetName} IN THE DIRT`,
        desc: 'The Guild wants this rider gone before the next toll audit. How is your business — just make sure they never see the finish arch.',
        goal: `Eliminate ${targetName} before they cross the line`,
      });
    } else {
      out.push({
        type, road, pos: 5, reward: 55, xp: 80,
        title: `ESCORT SEAT TO ${destName}`,
        desc: 'A trader wants a fast wheel beside the convoy. Keep pace, get paid.',
        goal: 'Finish the leg top 5',
      });
    }
    // relic roll: seasoned riders heading to a unique's home settlement
    // may find the job pays in iron instead of scrap
    const relicId = RELIC_HOME[road.dest];
    if (relicId && !loadArsenal().owned[relicId]
        && levelFromXp(state.xp) >= 3 && rnd() < 0.15) {
      relicify(out[out.length - 1], relicId, rnd);
    }
  }
  // dedupe same road+type rolls — but a successful relic roll always wins
  // the slot, so PAYMENT IN IRON is never silently swallowed by a plain twin
  const slots = new Map();
  for (const c of out) {
    const k = `${c.type}:${c.road.trackId}`;
    const prev = slots.get(k);
    if (!prev || (c.relicId && !prev.relicId)) slots.set(k, c);
  }
  return [...slots.values()];
}

// did the finished leg satisfy the contract?
export function contractDone(contract, results, earned) {
  const me = results.find((r) => r.isPlayer);
  if (!me) return false;
  if (contract.type === 'delivery') {
    if (contract.needHits && (earned?.hits || 0) < contract.needHits) return false;
    return me.pos === 1;
  }
  if (contract.type === 'assassin') {
    const t = results.find((r) => r.name === contract.targetName);
    if (contract.relicId && me.pos > 3) return false; // relic jobs want style
    return !!(t && t.out); // gone before the line — however it happened
  }
  if (contract.type === 'gunships') return (earned?.gunships || 0) >= contract.n;
  if (contract.type === 'launchers') return (earned?.launchers || 0) >= contract.n;
  if (contract.type === 'milkrun') return me.pos <= contract.pos;
  return false;
}

// ------------------------------------------------------------------ save file
const DEFAULTS = {
  scrap: 60, fuel: 34, fuelMax: 44,
  xp: 0, perks: [], pendingPerks: 0,
  location: 'ember', legsRidden: 0,
};

export function loadRpg() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) { /* fresh rider */ }
  return { ...DEFAULTS };
}

export function saveRpg(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) { /* private mode etc. */ }
}

// apply a finished leg: travel, fuel, scrap/xp rewards, level-ups.
// Returns { state, summary } — summary feeds the map's "last ride" readout.
export function applyLegResult(state, { road, contract }, results, earned) {
  const s = { ...state, perks: [...state.perks] };
  const me = results.find((r) => r.isPlayer);
  const pos = me ? me.pos : 13;
  s.location = road.dest;
  s.legsRidden += 1;
  s.fuel = Math.max(0, s.fuel - fuelCost(road, s));

  const scrapMul = s.perks.includes('scraprat') ? 1.3 : 1;
  let scrap = Math.round((22 + Math.max(0, 14 - pos) * 6
    + (earned?.gunships || 0) * 35 + (earned?.launchers || 0) * 12
    + (earned?.hits || 0) * 2) * scrapMul);
  let xp = 40 + Math.max(0, 14 - pos) * 12
    + (earned?.gunships || 0) * 60 + (earned?.launchers || 0) * 25;

  let contractOk = null;
  let relicWon = null;
  if (contract) {
    contractOk = contractDone(contract, results, earned);
    if (contractOk) {
      if (contract.relicId) {
        // payment in iron: the gun changes hands, scrap is a courtesy
        const a = loadArsenal();
        if (!a.owned[contract.relicId]) {
          a.owned[contract.relicId] = 1;
          a.equipped = contract.relicId;
          saveArsenal(a);
        }
        relicWon = contract.relicName;
        scrap += Math.round(contract.reward * 0.5 * scrapMul);
      } else {
        scrap += Math.round(contract.reward * scrapMul);
      }
      xp += contract.xp;
    }
  }
  s.scrap += scrap;
  const before = levelFromXp(s.xp);
  s.xp += xp;
  const after = levelFromXp(s.xp);
  if (after > before) s.pendingPerks += after - before;

  saveRpg(s);
  return {
    state: s,
    summary: {
      pos, scrap, xp, contractOk, relicWon,
      dest: SETTLEMENTS[road.dest].name, levelUp: after > before,
    },
  };
}
