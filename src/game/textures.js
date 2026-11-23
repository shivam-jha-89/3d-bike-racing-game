import * as THREE from 'three';

// Procedural canvas textures — the whole game stays asset-free.
// Everything here is generated once at track/bike build time.

// deterministic tiny PRNG so textures don't reshuffle between mounts
function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shade(hex, f) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const t = f < 0 ? 0 : 255;
  const p = Math.abs(f);
  const c = (x) => Math.round(x + (t - x) * p);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

// generic ground/surface tile: base colour + speckle noise + faint patches
export function makeTile(baseHex, { density = 750, size = 2.4, contrast = 0.15 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const rng = lcg(baseHex ^ 0x9e3779b9);
  g.fillStyle = shade(baseHex, 0);
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < density; i++) {
    g.fillStyle = shade(baseHex, (rng() - 0.5) * 2 * contrast);
    const s = size * (0.5 + rng());
    g.fillRect(rng() * 128, rng() * 128, s, s);
  }
  // broad soft patches for large-scale variation
  for (let i = 0; i < 9; i++) {
    g.fillStyle = shade(baseHex, (rng() - 0.5) * 0.12);
    g.globalAlpha = 0.28;
    g.beginPath();
    g.arc(rng() * 128, rng() * 128, 12 + rng() * 22, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// tree foliage for crossed-billboard sprites: a transparent canvas with a
// clustered canopy of soft leaf blobs, ragged edges and see-through gaps.
// `kind` shapes the silhouette — 'pine' is a tiered spire, 'broad' a round
// crown. Tinted per-instance via instanceColor, so one texture serves all.
export function makeFoliage(kind = 'broad', seed = 1) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const rng = lcg(seed ^ 0x2545f491);
  // GRAYSCALE — hue comes from the material colour + per-instance tint. The
  // VALUE carries all the 3D shading (sun-lit top, self-shadowed underside),
  // so tinted the sprite still reads as a lit tree, not a flat cutout.
  const dot = (x, y, r, v, a) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${v},${v},${v},${a})`);
    grad.addColorStop(0.65, `rgba(${v},${v},${v},${a * 0.5})`);
    grad.addColorStop(1, `rgba(${v},${v},${v},0)`);
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  const needle = (x, y, len, ang, v, a) => {
    g.strokeStyle = `rgba(${v},${v},${v},${a})`;
    g.lineWidth = 1.1 + rng() * 1.3;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  };
  // vertical shade: 1 at top (lit) -> ~0.45 at the base (shadowed)
  const shadeAt = (y) => 0.45 + 0.55 * (1 - y / S);

  if (kind === 'sequoia') {
    // towering columnar crown: tiers of flat horizontal branch tufts up a
    // visible trunk line, denser and narrower toward the spire
    g.strokeStyle = 'rgba(120,120,120,0.9)';
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(S / 2, S * 0.06); g.lineTo(S / 2, S); g.stroke();
    const tiers = 12;
    for (let ti = 0; ti < tiers; ti++) {
      const frac = ti / (tiers - 1);
      const ty = S * (0.07 + 0.86 * frac);
      const halfW = S * (0.1 + 0.26 * Math.pow(frac, 0.7)) * (0.75 + rng() * 0.5);
      const sh = shadeAt(ty);
      const n = 7 + Math.floor(frac * 9);
      for (let i = 0; i < n; i++) {
        const fx = (rng() * 2 - 1);
        const x = S / 2 + fx * halfW;
        const y = ty + (rng() - 0.5) * S * 0.045;
        // flattened tufts: wider than tall
        const r = 6 + rng() * 8;
        const lit = fx < -0.15 && rng() < 0.45;
        g.save();
        g.translate(x, y);
        g.scale(1.6, 0.7);
        dot(0, 0, r, (lit ? 215 : 115) + sh * 55 + rng() * 30, 0.8);
        g.restore();
      }
    }
  } else if (kind === 'pine') {
    const apex = S * 0.05, base = S * 0.95, halfBase = S * 0.4;
    const tiers = 9;
    for (let t = 0; t < tiers; t++) {
      const frac = t / (tiers - 1);
      const ty = apex + (base - apex) * frac;
      const tw = halfBase * Math.pow(frac, 0.85) + 4; // tapered envelope
      const sh = shadeAt(ty);
      // soft density pad behind the needles so alpha isn't lacy
      const pads = 5 + t * 2;
      for (let i = 0; i < pads; i++) {
        const fx = (rng() - 0.5) * 2;
        const x = S / 2 + fx * tw;
        const y = ty + (rng() - 0.4) * 10;
        dot(x, y, 8 + rng() * 10, 90 + sh * 70 + rng() * 25, 0.5);
      }
      // drooping needle sprays across the tier, edges hang lower
      const n = 16 + t * 7;
      for (let i = 0; i < n; i++) {
        const fx = (i / (n - 1) - 0.5) * (0.9 + rng() * 0.2);
        const x = S / 2 + fx * tw * 2;
        const y = ty + Math.abs(fx) * tw * 0.7 + (rng() - 0.5) * 6;
        const droop = Math.PI / 2 + fx * 0.9;      // fan out & down
        const lit = fx < 0 && rng() < 0.4;          // sun on the left
        const v = (lit ? 210 : 110) + sh * 55 + rng() * 30;
        needle(x, y, 7 + rng() * 9, droop, v, 0.85);
      }
    }
    // a hint of trunk at the very base
    dot(S / 2, base + 4, 5, 70, 0.5);
  } else {
    // broadleaf: a rounded crown of dappled leaf clumps — bright sun-side
    // clusters against shadowed ones, bumpy silhouette
    const cx = S / 2, cy = S * 0.42, R = S * 0.4;
    // base shadow mass
    for (let i = 0; i < 40; i++) {
      const a = rng() * Math.PI * 2, rr = Math.pow(rng(), 0.5) * R;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.95;
      dot(x, y, 12 + rng() * 16, 70 + shadeAt(y) * 60, 0.55);
    }
    // dappled leaf clusters on top: some lit, some dark, for depth
    for (let i = 0; i < 120; i++) {
      const a = rng() * Math.PI * 2, rr = Math.pow(rng(), 0.6) * R;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.95;
      const sh = shadeAt(y);
      // sun-side (upper-left) clusters run bright, others stay dim
      const sun = x < cx && y < cy && rng() < 0.55;
      const v = (sun ? 225 : 120) + sh * 40 + rng() * 35;
      dot(x, y, 5 + rng() * 9, Math.min(255, v), 0.8);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

// gradient sky dome; night gets stars and a moon, day gets soft clouds.
// The texture wraps a full 360° dome, so it needs real resolution — at
// 256 px a 2 px star smears into a degrees-wide blob.
export function makeSky({ horizon, zenith, night = false }) {
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  const rng = lcg((horizon ^ zenith) + (night ? 7 : 0));
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, shade(zenith, 0));
  grad.addColorStop(0.72, shade(horizon, night ? 0.02 : 0.06));
  grad.addColorStop(1, shade(horizon, night ? 0.1 : 0.3)); // bright band at the horizon
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  if (night) {
    for (let i = 0; i < 420; i++) {
      const y = rng() * H * 0.7;
      g.globalAlpha = 0.25 + rng() * 0.75;
      g.fillStyle = rng() > 0.8 ? '#cfe0ff' : '#ffffff';
      const s = rng() > 0.92 ? 2 : 1;
      g.fillRect(rng() * W, y, s, s);
    }
    g.globalAlpha = 1;
    // the moon, with a soft halo
    const mx = W * 0.72, my = H * 0.26;
    const mg = g.createRadialGradient(mx, my, 6, mx, my, 52);
    mg.addColorStop(0, 'rgba(230,236,255,0.85)');
    mg.addColorStop(0.35, 'rgba(230,236,255,0.2)');
    mg.addColorStop(1, 'rgba(230,236,255,0)');
    g.fillStyle = mg;
    g.fillRect(mx - 60, my - 60, 120, 120);
    g.fillStyle = '#e6ecff';
    g.beginPath();
    g.arc(mx, my, 16, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(180,190,220,0.5)';
    g.beginPath();
    g.arc(mx - 5, my - 4, 4, 0, Math.PI * 2);
    g.arc(mx + 6, my + 6, 3, 0, Math.PI * 2);
    g.fill();
  } else {
    g.filter = 'blur(7px)';
    for (let i = 0; i < 16; i++) {
      g.globalAlpha = 0.1 + rng() * 0.14;
      g.fillStyle = '#ffffff';
      const y = H * 0.45 + rng() * H * 0.33;
      const w = 60 + rng() * 130;
      g.beginPath();
      g.ellipse(rng() * W, y, w, 10 + rng() * 16, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.filter = 'none';
    g.globalAlpha = 1;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping; // seamless around the dome
  tex.anisotropy = 4;
  return tex;
}

// tunnel / bridge concrete: noisy grey with panel joints
export function makeConcrete() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const rng = lcg(0xc0c0);
  const base = 0x40404a;
  g.fillStyle = shade(base, 0);
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 600; i++) {
    g.fillStyle = shade(base, (rng() - 0.5) * 0.2);
    g.fillRect(rng() * 128, rng() * 128, 2.5, 2.5);
  }
  g.fillStyle = shade(base, -0.35);
  for (let y = 20; y < 128; y += 42) g.fillRect(0, y, 128, 2);
  g.globalAlpha = 0.35;
  g.fillRect(63, 0, 1.5, 128);
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// bike livery: body colour, accent slash, white roundel with the race number
export function makeLivery(bodyHex, accentHex, number) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = shade(bodyHex, 0);
  g.fillRect(0, 0, 128, 128);
  g.save();
  g.translate(64, 64);
  g.rotate(-0.5);
  g.fillStyle = shade(accentHex, 0);
  g.fillRect(-110, 26, 220, 20);
  g.fillStyle = '#ffffff';
  g.fillRect(-110, 50, 220, 6);
  g.restore();
  g.fillStyle = '#f4f4f4';
  g.beginPath();
  g.arc(64, 52, 30, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#181820';
  g.font = 'bold 40px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(number), 64, 55);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

// rider leathers: base colour with darker panel seams and pad highlights
export function makeSuit(suitHex) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = shade(suitHex, 0);
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = shade(suitHex, 0.1);
  g.fillRect(8, 6, 48, 16);
  g.fillRect(8, 36, 48, 14);
  g.strokeStyle = shade(suitHex, -0.4);
  g.lineWidth = 2;
  for (const y of [4, 24, 34, 52]) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(64, y);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(32, 0);
  g.lineTo(32, 64);
  g.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// helmet: racing stripe over the top
export function makeHelmet(helmetHex, accentHex) {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = shade(helmetHex, 0);
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#ffffff';
  g.fillRect(52, 0, 4, 64);
  g.fillRect(72, 0, 4, 64);
  g.fillStyle = shade(accentHex, 0);
  g.fillRect(56, 0, 16, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

// tyre: dark rubber with tread grooves
export function makeTire() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const rng = lcg(0x71b3);
  g.fillStyle = '#17171b';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#212129';
  for (let y = 2; y < 64; y += 7) g.fillRect(0, y, 64, 2);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = rng() > 0.5 ? '#1c1c22' : '#101014';
    g.fillRect(rng() * 64, rng() * 64, 1.6, 1.6);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// radial glow disc — the visible sun: hot white core, warm falloff to nothing
export function makeGlow(coreHex = '#fffdf2', haloHex = '255, 235, 180') {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0.0, coreHex);
  g.addColorStop(0.16, coreHex);
  g.addColorStop(0.3, `rgba(${haloHex}, 0.55)`);
  g.addColorStop(0.6, `rgba(${haloHex}, 0.14)`);
  g.addColorStop(1.0, `rgba(${haloHex}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
