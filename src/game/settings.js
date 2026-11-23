// Difficulty settings, persisted to localStorage. Each dial maps to a
// rate multiplier the game consumes: 0 disables the hazard entirely.

const KEY = 'motomad-settings';

export const LEVELS = ['off', 'low', 'normal', 'high'];

// how fast launcher towers + gunships cycle their rockets
export const MISSILE_MULT = { off: 0, low: 0.45, normal: 1, high: 1.8 };
// how eagerly AI riders draw and shoot their pistols
export const AGGRO_MULT = { off: 0, low: 0.5, normal: 1, high: 1.7 };

export function loadSettings() {
  try {
    return {
      missiles: 'normal',
      aggression: 'normal',
      ...JSON.parse(localStorage.getItem(KEY) || '{}'),
    };
  } catch {
    return { missiles: 'normal', aggression: 'normal' };
  }
}

export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
