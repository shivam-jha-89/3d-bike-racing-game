// Rider style: custom paint for the player's bike, leathers and helmet.
// null slots fall back to the bike's stock colours.

const KEY = 'motomad-style';

export const SWATCHES = {
  body: [0xd41f2c, 0xf2c000, 0x1c3fb0, 0x1a8a3c, 0xe86a10, 0x8a24b0, 0x14151a, 0xd8d8d8],
  accent: [0xffffff, 0x14151a, 0xffd23c, 0x38f0ff, 0xd41f2c, 0x1a8a3c, 0xe86a10, 0x8a8f96],
  helmet: [0xd41f2c, 0xeeeeee, 0x14151a, 0xf2c000, 0x38f0ff, 0x8a24b0, 0x1a8a3c, 0xe86a10],
  rider: [0x22222a, 0x3a2a20, 0x2a3a2a, 0x40222a, 0x2a2a44, 0x111111],
};

export function loadStyle() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* stock paint */ }
  return {};
}

export function saveStyle(style) {
  try {
    localStorage.setItem(KEY, JSON.stringify(style));
  } catch { /* private mode */ }
}

// stock colours + whatever the rider has re-sprayed
export function styledColors(stockColors) {
  const st = loadStyle();
  const out = { ...stockColors };
  for (const k of ['body', 'accent', 'helmet', 'rider']) {
    if (st[k] != null) out[k] = st[k];
  }
  return out;
}
