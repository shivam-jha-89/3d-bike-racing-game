// WebAudio engine synth — no samples, but a lot more engine-shaped than a
// bare oscillator:
//
//   3 oscillators (fundamental saw + half-speed sub square + bright 2nd
//   harmonic) -> soft-clip waveshaper (adds the harmonic spray of combustion)
//   -> rpm-tracked lowpass -> output, with the whole thing amplitude-
//   modulated at the FIRING frequency (every other rev for the 4-stroke,
//   every rev for the 2-stroke — that's the idle "potato" vs the ring-ding).
//   A filtered-noise bed fakes intake/exhaust hiss and overrun burble, and a
//   little random pitch flutter keeps it from sounding like a test tone.
//   Upshifts get a momentary ignition cut like a quickshifter.
//
// Created lazily on first user gesture (browser autoplay policy).

const PROFILES = {
  // 4-cylinder four-stroke superbike: smooth, deep sub, fires at rpm/2
  sport: {
    idle: 68, top: 300, fire: 0.5,
    sub: 0.55, bright: 0.28, drive: 2.2,
    filterBase: 420, filterSpan: 2800, thump: 0.55,
  },
  // single-cylinder two-stroke: zingy, buzzy, fires every rev
  cross: {
    idle: 54, top: 250, fire: 1.0,
    sub: 0.32, bright: 0.6, drive: 3.4,
    filterBase: 520, filterSpan: 3400, thump: 0.75,
  },
  // hub-motor prototype: smooth rising turbine whine, barely any firing pulse
  akira: {
    idle: 85, top: 420, fire: 0.25,
    sub: 0.28, bright: 0.55, drive: 1.6,
    filterBase: 650, filterSpan: 3800, thump: 0.28,
  },
};

export class GameAudio {
  constructor(bikeType = 'sport') {
    this.profile = PROFILES[bikeType] || PROFILES.sport;
    this.ctx = null;
    this.muted = false;
    this.ready = false;
    this.lastVol = 0;
    this.cutUntil = 0;
  }

  ensure() {
    if (this.ready || typeof AudioContext === 'undefined') return;
    try {
      const ctx = (this.ctx = new AudioContext());
      const p = this.profile;
      this.master = ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(ctx.destination);

      // --- engine core: oscillators -> mix -> soft clip -> lowpass -> gain
      const mix = ctx.createGain();
      const mkOsc = (type, gainVal) => {
        const o = ctx.createOscillator();
        o.type = type;
        const g = ctx.createGain();
        g.gain.value = gainVal;
        o.connect(g);
        g.connect(mix);
        o.start();
        return o;
      };
      this.oscMain = mkOsc('sawtooth', 0.9);   // fundamental
      this.oscSub = mkOsc('square', p.sub);    // half-speed sub: big-bore thud
      this.oscBright = mkOsc('sawtooth', p.bright); // 2nd harmonic: rasp

      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(257);
      for (let i = 0; i < 257; i++) {
        const x = (i / 128) - 1;
        curve[i] = Math.tanh(p.drive * x) / Math.tanh(p.drive);
      }
      shaper.curve = curve;

      this.engineFilter = ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.value = p.filterBase;
      this.engineFilter.Q.value = 1.1; // slight resonance = exhaust body

      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      mix.connect(shaper);
      shaper.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);

      // firing-pulse AM: a sine at the firing rate wiggles the engine gain
      this.amOsc = ctx.createOscillator();
      this.amOsc.type = 'sine';
      this.amDepth = ctx.createGain();
      this.amDepth.gain.value = 0;
      this.amOsc.connect(this.amDepth);
      this.amDepth.connect(this.engineGain.gain);
      this.amOsc.start();

      // --- shared looped noise source, tapped twice
      const len = ctx.sampleRate;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      noise.loop = true;

      // intake/exhaust hiss + overrun burble
      this.noiseBP = ctx.createBiquadFilter();
      this.noiseBP.type = 'bandpass';
      this.noiseBP.frequency.value = 900;
      this.noiseBP.Q.value = 0.8;
      this.noiseGain = ctx.createGain();
      this.noiseGain.gain.value = 0;
      noise.connect(this.noiseBP);
      this.noiseBP.connect(this.noiseGain);
      this.noiseGain.connect(this.master);

      // tyre slide / gravel (driven by setSlide)
      const slideBP = ctx.createBiquadFilter();
      slideBP.type = 'bandpass';
      slideBP.frequency.value = 700;
      this.slideGain = ctx.createGain();
      this.slideGain.gain.value = 0;
      noise.connect(slideBP);
      slideBP.connect(this.slideGain);
      this.slideGain.connect(this.master);

      noise.start();

      // --- combat bus: everything percussive (shots, blasts) runs through
      // a soft clipper and two generated-impulse-response convolvers. The
      // dense early reflections + outdoor tail are what make a one-shot
      // read as RECORDED rather than synthesized — the world answering.
      this.combatIn = ctx.createGain();
      const clip = ctx.createWaveShaper();
      const ccv = new Float32Array(257);
      for (let i = 0; i < 257; i++) { const x = i / 128 - 1; ccv[i] = Math.tanh(1.9 * x); }
      clip.curve = ccv;
      this.combatIn.connect(clip);
      const dry = ctx.createGain(); dry.gain.value = 0.8;
      clip.connect(dry); dry.connect(this.master);
      const early = ctx.createConvolver();
      early.buffer = this._makeSparseIR(0.38, 14, 2.0); // open-country echoes
      const eg = ctx.createGain(); eg.gain.value = 0.4;
      clip.connect(early); early.connect(eg); eg.connect(this.master);
      const tailC = ctx.createConvolver();
      tailC.buffer = this._makeIR(1.7, 3.0, 0.12); // long dark outdoor tail
      const tg = ctx.createGain(); tg.gain.value = 0.32;
      clip.connect(tailC); tailC.connect(tg); tg.connect(this.master);

      this.nWaveBuf = this._makeNWave();

      // shared panner for positional SYNTH shots (through the combat reverb)
      this.shotPanner = this.makePanner(0, 0, 0);
      this.shotPanner.connect(this.combatIn);
      // separate DRY panner for the recorded sample — it already carries its
      // own echo, so we don't run it through the convolvers (that re-adds the
      // "tunnel"). A tiny send keeps it seated with the synth blasts.
      // gun bus: BOTH the player's own (centred) shots and positional AI
      // shots go through here, so one gain trims all gunfire relative to the
      // engine
      this.gunBus = ctx.createGain();
      this.gunBus.gain.value = 0.5;
      this.gunBus.connect(this.master);
      this.gunPanner = this.makePanner(0, 0, 0);
      this.gunPanner.connect(this.gunBus);
      // blast bus: one gain for all explosions. Its panner carries far.
      this.boomBus = ctx.createGain();
      this.boomBus.gain.value = 0.3;
      this.boomBus.connect(this.master);
      this.boomSamplePanner = this.makePanner(0, 0, 0);
      this.boomSamplePanner.refDistance = 26;
      this.boomSamplePanner.rolloffFactor = 0.8;
      this.boomSamplePanner.connect(this.boomBus);

      // load the recorded samples; until each decodes, that sound uses synth
      this.gunBuf = null;
      this.boomBuf = null;
      const load = (name, key) => {
        fetch((import.meta.env.BASE_URL || '/') + 'sfx/' + name)
          .then((r) => r.arrayBuffer())
          .then((ab) => ctx.decodeAudioData(ab))
          .then((b) => { this[key] = b; })
          .catch(() => { /* no sample — synth fallback stays */ });
      };
      load('gunshot.mp3', 'gunBuf');
      load('explosion.mp3', 'boomBuf');

      // engine: a SYNTHESIZED inline-four cycle — four exhaust pulses per
      // 720° ringing through pipe-resonance modes, built as a perfect loop
      // by construction. Recorded clips were never miked for looping; this
      // grain is engineered for it, and playback rate maps cleanly to RPM.
      // AAA-style RPM banking: two grains with different combustion
      // character, equal-power crossfaded by revs (the granular version of
      // the multi-recording crossfade Forza/GT use)
      this.engineLoopBuf = this._makeSuperbikeGrain({ // low bank: boomy, lazy
        modes: [[115, 0.026, 1.0], [250, 0.015, 0.6], [520, 0.008, 0.32], [950, 0.004, 0.14]],
        click: 0.3,
      });
      this.engineHighBuf = this._makeSuperbikeGrain({ // high bank: tight, angry
        modes: [[175, 0.015, 0.95], [390, 0.01, 0.7], [830, 0.006, 0.5], [1650, 0.0035, 0.3]],
        click: 0.6,
      });
      this._startPlayerEngineSample();

      this.ready = true;
    } catch {
      /* no audio — fine */
    }
  }

  // sparse outdoor impulse response: a handful of discrete echoes (ground
  // bounce, treeline, far hills) instead of dense room noise — dense+short
  // reads as a tunnel, sparse+spread reads as open country
  _makeSparseIR(dur, taps, decayPow) {
    const sr = this.ctx.sampleRate;
    const len = Math.max(64, Math.floor(dur * sr));
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      d[0] = 0.6; // direct
      for (let k = 0; k < taps; k++) {
        const pos = Math.floor(Math.pow(Math.random(), 1.4) * (len - 40));
        const amp = Math.pow(1 - pos / len, decayPow) * (0.35 + Math.random() * 0.65);
        for (let j = 0; j < 30; j++) {
          d[pos + j] += (Math.random() * 2 - 1) * amp * Math.pow(1 - j / 30, 2);
        }
      }
    }
    return buf;
  }

  // Friedlander blast wave: the real muzzle-blast pressure profile — a
  // near-instant spike, exponential decay through a negative phase, plus a
  // ground-reflection copy ~1.5 ms behind. This IS what a gunshot's first
  // milliseconds look like on a pressure trace; everything else is world.
  _makeNWave() {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(0.06 * sr);
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const tp = 0.0022 * sr; // positive-phase duration ~2.2 ms
    for (let i = 0; i < len; i++) {
      const tt = i / tp;
      d[i] = (1 - tt) * Math.exp(-tt);
    }
    const delay = Math.floor(0.0015 * sr); // ground bounce, inverted
    for (let i = len - 1; i >= delay; i--) d[i] -= 0.55 * d[i - delay];
    let y = 0; // one-pole highpass to strip DC
    for (let i = 0; i < len; i++) { y += 0.02 * (d[i] - y); d[i] -= y; }
    return buf;
  }

  // synthetic impulse response: exponentially decaying stereo noise,
  // optionally one-pole lowpassed for a dark outdoor tail
  _makeIR(dur, decayPow, lp) {
    const sr = this.ctx.sampleRate;
    const len = Math.max(64, Math.floor(dur * sr));
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        let x = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decayPow);
        if (lp > 0) { y += lp * (x - y); x = y; }
        d[i] = x;
      }
    }
    return buf;
  }

  makePanner(x, y, z) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 10;
    p.rolloffFactor = 1.3;
    this.setPannerPos(p, x, y, z, true);
    return p;
  }

  setPannerPos(p, x, y, z, snap = false) {
    const t = this.ctx.currentTime;
    if (p.positionX) {
      if (snap) {
        p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
      } else {
        p.positionX.setTargetAtTime(x, t, 0.05);
        p.positionY.setTargetAtTime(y, t, 0.05);
        p.positionZ.setTargetAtTime(z, t, 0.05);
      }
    } else {
      p.setPosition(x, y, z);
    }
  }

  // listener rides the camera — this is what makes everything stereo/directional
  updateListener(pos, fwd) {
    if (!this.ready) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.04);
      l.positionY.setTargetAtTime(pos.y, t, 0.04);
      l.positionZ.setTargetAtTime(pos.z, t, 0.04);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.04);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.04);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.04);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  // Synthesize one inline-four engine cycle (720°) from physics, not from
  // a recording: four exhaust pulses per cycle, each a pressure spike
  // ringing through the pipe's resonance modes, plus a deterministic valve
  // click. Three cycles are rendered and the MIDDLE one is cut, so every
  // pulse's tail wraps into the next cycle exactly — a seamless loop by
  // construction. Per-cylinder amps/timing are slightly uneven on purpose;
  // that asymmetry is what reads as an engine instead of a tone.
  _makeSuperbikeGrain(cfg = {}) {
    const sr = this.ctx.sampleRate;
    const cycle = Math.floor(sr * 0.032); // ~32 ms per 720° at rate 1
    const acc = new Float32Array(cycle * 3);
    const amps = [1.0, 0.88, 1.07, 0.84];
    const skew = [0, 0.0005, -0.0004, 0.0007]; // uneven header lengths
    // pipe modes: [freq Hz, decay s, gain] — a 4-into-1 exhaust's voice
    const modes = cfg.modes || [
      [150, 0.020, 1.0],
      [320, 0.012, 0.62],
      [660, 0.007, 0.38],
      [1250, 0.004, 0.2],
    ];
    const clickGain = cfg.click ?? 0.45;
    // deterministic click per cylinder (identical every cycle => periodic)
    const clickLen = Math.floor(sr * 0.0015);
    const clicks = amps.map((_, k) => {
      let seed = (k + 1) * 48271;
      const arr = new Float32Array(clickLen);
      for (let i = 0; i < clickLen; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        arr[i] = (seed / 2147483648 - 1) * (1 - i / clickLen);
      }
      return arr;
    });
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 4; k++) {
        const t0 = Math.floor((c + k / 4) * cycle + skew[k] * sr);
        const A = amps[k];
        for (const [f, dec, gm] of modes) {
          const w = (2 * Math.PI * f) / sr;
          const decay = 1 / (dec * sr);
          const n = Math.min(Math.floor(dec * sr * 6), acc.length - t0);
          for (let i = 0; i < n; i++) {
            acc[t0 + i] += A * gm * Math.exp(-i * decay) * Math.sin(w * i);
          }
        }
        const ck = clicks[k];
        for (let i = 0; i < clickLen && t0 + i < acc.length; i++) {
          acc[t0 + i] += A * clickGain * ck[i];
        }
      }
    }
    // combustion harmonics via soft clip
    for (let i = 0; i < acc.length; i++) acc[i] = Math.tanh(acc[i] * 1.8);
    const out = this.ctx.createBuffer(1, cycle, sr);
    const d = out.getChannelData(0);
    for (let i = 0; i < cycle; i++) d[i] = acc[cycle + i];
    let mean = 0;
    for (let i = 0; i < cycle; i++) mean += d[i];
    mean /= cycle;
    let peak = 0;
    for (let i = 0; i < cycle; i++) {
      d[i] -= mean;
      peak = Math.max(peak, Math.abs(d[i]));
    }
    for (let i = 0; i < cycle; i++) d[i] *= 0.9 / (peak || 1);
    return out;
  }

  // Build a SINGLE-CYCLE engine grain and loop that — the natural way to
  // synthesize an engine. Looping a long slice repeats many combustion
  // cycles (plus any RPM drift/seam in the window), which "breathes"
  // unnaturally. Instead we autocorrelate the steadiest part of the
  // recording to find one firing cycle's period, take TWO cycles (so a
  // V-twin's uneven beat survives), and crossfade the seam. Playback rate
  // then maps straight to RPM, exactly like a real engine's pitch.
  _makeEngineLoop(buf) {
    const sr = buf.sampleRate;
    const src = buf.getChannelData(0);
    const total = buf.length;
    // analysis window in the steady middle of the slice
    const w0 = Math.floor(total * 0.35);
    const wLen = Math.min(Math.floor(sr * 0.45), total - w0 - 1);
    // normalized autocorrelation over the FIRING-period range (~30..130 ms).
    // Capping at 130 ms keeps it locked to a combustion cycle rather than
    // the slow ~5 Hz "potato" beat envelope, so one cycle is a tight grain.
    const minP = Math.floor(sr * 0.03);
    const maxP = Math.min(Math.floor(sr * 0.13), Math.floor(wLen / 2));
    let bestP = minP, bestScore = -Infinity;
    for (let p = minP; p <= maxP; p++) {
      let sum = 0, na = 0, nb = 0;
      for (let i = 0; i < wLen - p; i += 2) {
        const a = src[w0 + i], b = src[w0 + i + p];
        sum += a * b; na += a * a; nb += b * b;
      }
      const score = sum / (Math.sqrt(na * nb) + 1e-9);
      if (score > bestScore) { bestScore = score; bestP = p; }
    }
    // one firing cycle — the tightest, most engine-like grain; find the
    // best start so the grain begins on a low-energy zero-ish crossing
    let L = bestP;
    let start = w0;
    let bestZero = Infinity;
    for (let i = 0; i < bestP; i++) {
      const e = Math.abs(src[w0 + i]) + Math.abs(src[w0 + i + 1]);
      if (e < bestZero) { bestZero = e; start = w0 + i; }
    }
    if (start + L + Math.floor(sr * 0.02) >= total) start = total - L - Math.floor(sr * 0.02) - 1;
    const xf = Math.min(Math.floor(sr * 0.012), Math.floor(L / 4));
    const out = this.ctx.createBuffer(1, L, sr);
    const d = out.getChannelData(0);
    for (let i = 0; i < L; i++) d[i] = src[start + i];
    for (let i = 0; i < xf; i++) {
      const wgt = i / xf;
      d[i] = src[start + i] * Math.sin(wgt * Math.PI / 2) +
             src[start + L + i] * Math.cos(wgt * Math.PI / 2);
    }
    // strip any DC so the grain doesn't thump on each loop
    let mean = 0;
    for (let i = 0; i < L; i++) mean += d[i];
    mean /= L;
    for (let i = 0; i < L; i++) d[i] -= mean;
    return out;
  }

  // The player engine is LAYERED like a real race bike: a big combustion
  // layer at crank speed, plus the same grain replayed at MULTIPLIED speeds
  // for the mechanisms bolted to the crank — valvetrain clatter (~2.7x,
  // high-passed) and straight-cut gear/cam whine (~5.4x, narrow band).
  // Every layer tracks RPM together, so the whole stack revs as one machine.
  _startPlayerEngineSample() {
    const ctx = this.ctx;
    const mkVoice = () => {
      const src = ctx.createBufferSource();
      src.buffer = this.engineLoopBuf;
      src.loop = true;
      src.start();
      return src;
    };
    // --- L1 combustion: lowpass (brightness) -> RPM-driven drive -> tanh
    // saturator (rasp under load) -> volume
    const src = mkVoice();
    const bankA = ctx.createGain(); bankA.gain.value = 1;
    const srcHigh = ctx.createBufferSource();
    srcHigh.buffer = this.engineHighBuf;
    srcHigh.loop = true;
    srcHigh.start();
    const bankB = ctx.createGain(); bankB.gain.value = 0;
    // FOUR cylinders: parallel copies of the grain at quarter-cycle phase
    // offsets (firing order), each a hair detuned so they breathe against
    // each other. All feed the same saturator and intermodulate like
    // cylinders sharing one exhaust — an inline-four snarl, not one thumper.
    const D = this.engineLoopBuf.duration;
    // each extra cylinder gets its OWN level and spectral tilt — identical
    // full-level copies comb-filter against each other, which reads as
    // "inside a tunnel". Decorrelated voices blend into one fat engine.
    const cyls = [];
    const CYL = [
      [0.5, 1.007, 0.5, 150],
    ];
    for (const [phase, det, lvl, hpHz] of CYL) {
      const c = ctx.createBufferSource();
      c.buffer = this.engineLoopBuf;
      c.loop = true;
      c.start(ctx.currentTime, D * phase);
      const chp = ctx.createBiquadFilter();
      chp.type = 'highpass';
      chp.frequency.value = hpHz;
      chp.Q.value = 0.6;
      const cg = ctx.createGain();
      cg.gain.value = lvl;
      c.connect(chp); chp.connect(cg);
      cyls.push({ src: c, det, out: cg });
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.9;               // gentle knee: muffled, not honky
    const drive = ctx.createGain();
    drive.gain.value = 1;
    const shaper = ctx.createWaveShaper();
    const cv = new Float32Array(257);
    for (let i = 0; i < 257; i++) { const x = i / 128 - 1; cv[i] = Math.tanh(1.4 * x); }
    shaper.curve = cv;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(bankA); bankA.connect(lp);
    srcHigh.connect(bankB); bankB.connect(lp);
    for (const c of cyls) c.out.connect(lp);
    lp.connect(drive); drive.connect(shaper);
    shaper.connect(g); g.connect(this.master);

    // --- L2 mechanism: the grain at ~2.7x — the fast metallic chatter of
    // cams/valves/chain, only its top end kept
    const mechSrc = mkVoice();
    const mechHp = ctx.createBiquadFilter();
    mechHp.type = 'highpass';
    mechHp.frequency.value = 1400;
    mechHp.Q.value = 0.7;
    const mechG = ctx.createGain();
    mechG.gain.value = 0;
    mechSrc.connect(mechHp); mechHp.connect(mechG); mechG.connect(this.master);

    // --- L3 whine: DOUBLED — two detuned voices through offset bands,
    // spread left/right. One narrow bandpass voice reads thin; the pair
    // chorus into a wide, fat gear scream.
    const whineSrc = mkVoice();
    const whineBp = ctx.createBiquadFilter();
    whineBp.type = 'bandpass';
    whineBp.frequency.value = 2200;
    whineBp.Q.value = 1.5;
    const whineSrc2 = mkVoice();
    const whineBp2 = ctx.createBiquadFilter();
    whineBp2.type = 'bandpass';
    whineBp2.frequency.value = 2600;
    whineBp2.Q.value = 1.5;
    const whineG = ctx.createGain();
    whineG.gain.value = 0;
    if (ctx.createStereoPanner) {
      const whinePanL = ctx.createStereoPanner();
      const whinePanR = ctx.createStereoPanner();
      whinePanL.pan.value = -0.45;
      whinePanR.pan.value = 0.45;
      whineSrc.connect(whineBp); whineBp.connect(whinePanL); whinePanL.connect(whineG);
      whineSrc2.connect(whineBp2); whineBp2.connect(whinePanR); whinePanR.connect(whineG);
    } else {
      whineSrc.connect(whineBp); whineBp.connect(whineG);
      whineSrc2.connect(whineBp2); whineBp2.connect(whineG);
    }
    whineG.connect(this.master);

    this.engSample = {
      src, srcHigh, bankA, bankB, cyls, lp, drive, g,
      mechSrc, mechHp, mechG,
      whineSrc, whineBp, whineSrc2, whineBp2, whineG,
    };
    // silence the synthesized oscillator engine — the sample takes over
    this.engineGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
  }

  // convert any oscillator-mode AI engines to the recorded loop (used when
  // the engine sample finishes decoding after the pack was already created)
  _upgradeAIEnginesToSample() {
    if (!this.aiEngines || !this.engineLoopBuf) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const e of this.aiEngines) {
      if (e.mode !== 'osc') continue;
      try { e.osc.stop(); e.osc.disconnect(); } catch { /* already gone */ }
      const src = ctx.createBufferSource();
      src.buffer = this.engineLoopBuf;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      src.connect(lp); lp.connect(e.gain);
      src.start(t, Math.random() * this.engineLoopBuf.duration);
      e.mode = 'sample'; e.src = src; e.lp = lp;
      delete e.osc;
    }
  }

  ensureAIEngines(n) {
    if (!this.ready || this.aiEngines) return;
    this.aiEngines = [];
    for (let i = 0; i < n; i++) {
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      const panner = this.makePanner(0, -999, 0);
      panner.refDistance = 16;   // other bikes carry — you HEAR the pack
      panner.rolloffFactor = 1.0;
      gain.connect(panner);
      panner.connect(this.master);
      if (this.engineLoopBuf) {
        // real engine loop, each bike started at a random phase so the pack
        // isn't in lockstep
        const src = this.ctx.createBufferSource();
        src.buffer = this.engineLoopBuf;
        src.loop = true;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1400;
        src.connect(lp); lp.connect(gain);
        src.start(this.ctx.currentTime, Math.random() * this.engineLoopBuf.duration);
        this.aiEngines.push({ mode: 'sample', src, lp, gain, panner });
      } else {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.connect(gain);
        osc.start();
        this.aiEngines.push({ mode: 'osc', osc, gain, panner });
      }
    }
  }

  setAIEngine(i, x, y, z, rpm, audible) {
    const e = this.aiEngines && this.aiEngines[i];
    if (!e) return;
    const t = this.ctx.currentTime;
    this.setPannerPos(e.panner, x, y + 0.5, z);
    if (e.mode === 'sample') {
      // pitched a touch above the player + per-bike offset so the pack reads
      // as many distinct engines, not one
      e.src.playbackRate.setTargetAtTime(0.4 + rpm * 0.98 + i * 0.008, t, 0.06);
      e.lp.frequency.setTargetAtTime(450 + rpm * 6200, t, 0.08);
      e.gain.gain.setTargetAtTime(this.muted || !audible ? 0 : 0.34, t, 0.12);
    } else {
      e.osc.frequency.setTargetAtTime(78 + rpm * 290 + i * 4, t, 0.06);
      e.gain.gain.setTargetAtTime(this.muted || !audible ? 0 : 0.115, t, 0.12);
    }
  }

  setEngine(rpm, throttle, gear, speed01 = 0) {
    if (!this.ready) return;
    const p = this.profile;
    const t = this.ctx.currentTime;

    // recorded engine loop: RPM drives its playback rate (pitch + speed).
    // The synth engine below is the fallback until the sample decodes.
    if (this.engSample) {
      // throttle with INERTIA: opens fast, but rolls off slowly (~0.5 s) —
      // chopping the gas glides the sound down instead of snapping it
      if (this._thrSm === undefined) this._thrSm = throttle;
      this._thrSm = throttle > this._thrSm
        ? this._thrSm + (throttle - this._thrSm) * 0.3
        : this._thrSm + (throttle - this._thrSm) * 0.045;
      const thr = this._thrSm;
      // pitch + a little flutter so the single-cycle grain isn't perfectly
      // periodic (that's what reads as "plastic") — lumpier at idle, tightens
      // up at high rpm like a real engine
      const base = 0.36 + rpm * 0.92;
      const flutter = (Math.random() - 0.5) * 0.05 * (1.15 - rpm);
      this.engSample.src.playbackRate.setTargetAtTime(base * (1 + flutter), t, 0.03);
      this.engSample.srcHigh.playbackRate.setTargetAtTime(base * 1.002 * (1 + flutter), t, 0.03);
      // equal-power crossfade between the low and high combustion banks
      const xf = Math.min(1, Math.max(0, (rpm - 0.18) / 0.6));
      this.engSample.bankA.gain.setTargetAtTime(Math.cos(xf * Math.PI / 2), t, 0.08);
      this.engSample.bankB.gain.setTargetAtTime(Math.sin(xf * Math.PI / 2), t, 0.08);
      // the detuned double runs a hair off — slow interweaving beats
      for (const c of this.engSample.cyls) {
        c.src.playbackRate.setTargetAtTime(base * c.det * (1 - flutter * 0.5), t, 0.03);
      }
      const vol = this.muted ? 0 : 0.27 + rpm * 0.31 + thr * 0.15;
      this.lastVol = vol;
      if (t >= this.cutUntil) this.engSample.g.gain.setTargetAtTime(vol * 0.65, t, 0.05);
      // brightness: muffled at idle, screaming bright wide-open — big sweep
      // so low and high rpm are clearly different in timbre
      this.engSample.lp.frequency.setTargetAtTime(300 + rpm * 3700 + thr * 1300, t, 0.08);
      // drive: clean idle -> hard, raspy, distorted top end (sharper)
      this.engSample.drive.gain.setTargetAtTime(1 + rpm * 1.7 + thr * 1.1, t, 0.08);
      // L2 mechanism layer: locked to 2.7x crank, barely there at idle,
      // chattering hard at speed
      this.engSample.mechSrc.playbackRate.setTargetAtTime(base * 2.7, t, 0.03);
      this.engSample.mechG.gain.setTargetAtTime(
        this.muted ? 0 : vol * (0.06 + rpm * 0.26), t, 0.06);
      // L3 gear/chain whine: locked to ROAD SPEED (final drive), not rpm —
      // it climbs continuously through the gears instead of sawing with
      // every shift. A whiff of rpm keeps it alive on the line.
      // TWO whines, two sources — like the real machine: the low register
      // is the gearbox/primary drive (spins with the ENGINE -> rpm), the
      // high register is the chain/final drive (spins with the WHEEL ->
      // road speed). On a downshift they split apart: revs jump the gear
      // whine while the chain whine keeps falling with speed.
      const gearRate = 0.32 + rpm * 1.35;
      const gearBand = 240 + rpm * 800;
      const chainRate = 0.42 + speed01 * 2.1;
      const chainBand = 320 + speed01 * 1250;
      this.engSample.whineSrc.playbackRate.setTargetAtTime(gearRate, t, 0.04);
      this.engSample.whineBp.frequency.setTargetAtTime(gearBand, t, 0.05);
      this.engSample.whineSrc2.playbackRate.setTargetAtTime(chainRate, t, 0.04);
      this.engSample.whineBp2.frequency.setTargetAtTime(chainBand, t, 0.05);
      this.engSample.whineG.gain.setTargetAtTime(
        this.muted ? 0 : vol * (0.1 + speed01 * 1.25 + rpm * 0.16 + thr * 0.14), t, 0.06);
      this.engineGain.gain.setTargetAtTime(0, t, 0.05); // keep synth path muted
      this.amDepth.gain.setTargetAtTime(0, t, 0.05);
      // overrun crackle: fires in the roll-off window (gas just chopped,
      // engine still hot) and while coasting at revs — loud enough to cut
      // through the mix, brighter band, occasional double-pop
      // real overrun crackle needs a HOT engine: only on throttle chop at
      // high revs, densest right after the chop, tapering as rpm falls —
      // and irregular, not machine-gun
      const rollingOff = throttle < 0.15 && rpm > 0.55 && thr > 0.04;
      // the GURGLE: a low rumble chopped by a random telegraph gate — the
      // throaty rolling burble underneath, with the bangs as punctuation
      if (!this.burble) {
        const bctx = this.ctx;
        const bn = bctx.createBufferSource();
        bn.buffer = this.noiseBuf;
        bn.loop = true;
        const blp = bctx.createBiquadFilter();
        blp.type = 'lowpass';
        blp.frequency.value = 260;
        blp.Q.value = 1.2;
        const gate = bctx.createGain();
        gate.gain.value = 0;
        const bg = bctx.createGain();
        bg.gain.value = 0;
        bn.connect(blp); blp.connect(gate); gate.connect(bg); bg.connect(this.master);
        bn.start();
        this.burble = { gate, g: bg };
      }
      if (rollingOff && !this.muted) {
        const duck = t < (this._burbleDuck || 0) ? 0.12 : 1;
        this.burble.g.gain.setTargetAtTime(
          (1.1 + rpm * 1.1) * Math.min(1, thr * 3) * duck, t, duck < 1 ? 0.008 : 0.03);
        // telegraph: random open/shut every frame = the gurgle texture
        this.burble.gate.gain.setTargetAtTime(
          Math.random() < 0.5 ? 0.25 + Math.random() * 0.75 : 0.03, t, 0.007);
      } else {
        this.burble.g.gain.setTargetAtTime(0, t, 0.09);
      }
      const popChance = (rpm - 0.5) * 0.45 + thr * 0.25;
      if (rollingOff && t > (this._popT || 0) && Math.random() < popChance) {
        this._popT = t + 0.14 + Math.random() * 0.5;
        this._burbleDuck = t + 0.14; // hole in the gurgle for the bang
        // an overrun pop IS a misfire: cut the engine for a beat and bang.
        // The dip is what makes the crackle read — it punches a hole in the
        // continuous engine bed that the bang then fills.
        const gg = this.engSample.g.gain;
        gg.setTargetAtTime(vol * 0.15, t, 0.006);
        gg.setTargetAtTime(vol, t + 0.055, 0.025);
        this.cutUntil = Math.max(this.cutUntil, t + 0.1); // let the dip live
        this._noiseHit(this.master, t + 0.01, {
          type: 'bandpass', freq: 200 + Math.random() * 260, q: 1.1,
          gain: 2.2 + Math.random() * 0.8, dur: 0.12 + Math.random() * 0.1,
          attack: 0.005,
        });
        this._noiseHit(this.master, t + 0.01, {
          freq: 900 + Math.random() * 900, q: 0.7,
          gain: 0.32 + Math.random() * 0.15, dur: 0.025,
        });
        if (Math.random() < 0.4) {
          this._noiseHit(this.master, t + 0.11 + Math.random() * 0.08, {
            type: 'bandpass', freq: 170 + Math.random() * 220, q: 1.1,
            gain: 1.4 + Math.random() * 0.6, dur: 0.09 + Math.random() * 0.08,
          });
        }
      }
      // light intake hiss over the loop
      const overrun = throttle < 0.1 && rpm > 0.25 ? 0.05 : 0;
      this.noiseBP.frequency.setTargetAtTime(700 + rpm * 2200, t, 0.06);
      const nv = this.muted ? 0 : 0.004 + throttle * 0.012 + rpm * 0.008 + overrun;
      this.noiseGain.gain.setTargetAtTime(nv, t, 0.07);
      return;
    }

    // fundamental + a touch of random flutter so it never sounds like a tone
    const flutter = (Math.random() - 0.5) * (3.5 - rpm * 2);
    const f = p.idle + rpm * (p.top - p.idle) + flutter;
    this.oscMain.frequency.setTargetAtTime(f, t, 0.02);
    this.oscSub.frequency.setTargetAtTime(f * 0.5 * 1.004, t, 0.02);
    this.oscBright.frequency.setTargetAtTime(f * 2.02, t, 0.02);
    this.amOsc.frequency.setTargetAtTime(f * p.fire, t, 0.02);

    // filter opens with rpm and throttle — closed throttle sounds muffled
    this.engineFilter.frequency.setTargetAtTime(
      p.filterBase + rpm * p.filterSpan + throttle * 500, t, 0.05);

    const vol = this.muted ? 0 : 0.05 + rpm * 0.05 + throttle * 0.035;
    this.lastVol = vol;
    if (t >= this.cutUntil) {
      this.engineGain.gain.setTargetAtTime(vol, t, 0.05);
    }
    // firing thump is strongest at low rpm (idle lope), fades as revs blur it
    this.amDepth.gain.setTargetAtTime(vol * p.thump * (1 - rpm * 0.65), t, 0.05);

    // hiss with rpm/throttle; overrun burble when coasting against the engine
    const overrun = throttle < 0.1 && rpm > 0.25 ? 0.05 : 0;
    this.noiseBP.frequency.setTargetAtTime(700 + rpm * 2200, t, 0.06);
    const nv = this.muted ? 0 : 0.007 + throttle * 0.02 + rpm * 0.012 + overrun;
    this.noiseGain.gain.setTargetAtTime(nv, t, 0.07);
  }

  // quickshifter-style ignition cut on upshifts
  shiftCut() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    this.cutUntil = t + 0.12;
    // dip whichever engine is live (recorded sample or synth)
    const eg = this.engSample ? this.engSample.g.gain : this.engineGain.gain;
    eg.cancelScheduledValues(t);
    eg.setTargetAtTime(this.lastVol * 0.12, t, 0.008);
    eg.setTargetAtTime(this.lastVol, t + 0.07, 0.03);
  }

  // short noise burst through a filter — the building block every layered
  // one-shot below is stacked from (sample-style sound design, no samples)
  _noiseHit(out, t, { type = 'highpass', freq = 1200, freqEnd = null, q = 0.8,
    gain = 0.5, dur = 0.2, attack = 0.002 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t, Math.random() * 0.6, dur + 0.05);
  }

  // slap-back echo bus: blasts and shots feed a little of themselves into a
  // dark delayed return — the "report off the hills" that sells the depth
  _echoBus() {
    if (this.echoIn) return this.echoIn;
    const ctx = this.ctx;
    this.echoIn = ctx.createGain();
    this.echoIn.gain.value = 0.4;
    const d = ctx.createDelay(1.0);
    d.delayTime.value = 0.23;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    this.echoIn.connect(d);
    d.connect(lp);
    lp.connect(fb);
    fb.connect(d);
    lp.connect(this.master);
    return this.echoIn;
  }

  // shot connected with a RIDER: a short pained grunt — "uh!". A voiced
  // burst with a falling pitch through two vowel formants.
  hitRider(pos = null) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const R = (x, y) => x + Math.random() * (y - x);
    if (!this.hitPanner) {
      this.hitPanner = this.makePanner(0, 0, 0);
      this.hitPanner.connect(this.master);
    }
    let out = this.master;
    if (pos) {
      this.setPannerPos(this.hitPanner, pos.x, pos.y, pos.z, true);
      out = this.hitPanner;
    }
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = R(135, 190);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + R(0.12, 0.2));
    // "uh" vowel: two formant bandpasses in parallel
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = R(550, 700); f1.Q.value = 4;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = R(1050, 1300); f2.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(R(0.7, 1.0), t + 0.015); // hard onset: "UH!"
    g.gain.exponentialRampToValueAtTime(0.001, t + R(0.16, 0.24));
    o.connect(f1); o.connect(f2);
    f1.connect(g); f2.connect(g);
    g.connect(out);
    o.start(t); o.stop(t + 0.3);
    // breath layer
    this._noiseHit(out, t, { type: 'bandpass', freq: R(800, 1200), q: 1.2,
      gain: R(0.1, 0.18), dur: R(0.08, 0.14) });
  }

  // shot connected with the MACHINE: struck-metal clank — inharmonic
  // partials of a hit plate ringing down, plus a bright tick
  hitBike(pos = null) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const R = (x, y) => x + Math.random() * (y - x);
    if (!this.hitPanner) {
      this.hitPanner = this.makePanner(0, 0, 0);
      this.hitPanner.connect(this.master);
    }
    let out = this.master;
    if (pos) {
      this.setPannerPos(this.hitPanner, pos.x, pos.y, pos.z, true);
      out = this.hitPanner;
    }
    const det = R(0.94, 1.08);
    for (const [f, gm, dur] of [[1620, 0.3, 0.16], [2380, 0.22, 0.12], [3960, 0.14, 0.08]]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f * det;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gm, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur * R(0.8, 1.3));
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.25);
    }
    this._noiseHit(out, t, { freq: R(3000, 5000), q: 0.6, gain: R(0.2, 0.3), dur: 0.02 });
  }

  // play the recorded gunshot with per-shot variation: varispeed (pitch +
  // timing, which also reshapes the baked echo), a random tone tilt, a tiny
  // attack trim, and a random level. Occasionally a low sub-thump adds punch.
  _sampleShot(vol = 1, pos = null) {
    const ctx = this.ctx, t = ctx.currentTime;
    const R = (a, b) => a + Math.random() * (b - a);
    const chance = (p) => Math.random() < p;
    const dryDest = pos ? this.gunPanner : this.gunBus;
    if (pos) this.setPannerPos(this.gunPanner, pos.x, pos.y, pos.z, true);

    // one filtered, optionally gritty voice of the sample
    const playVoice = (rate, level, detune, gateTail) => {
      const src = ctx.createBufferSource();
      src.buffer = this.gunBuf;
      src.playbackRate.value = rate;                 // wide pitch/speed swing
      if (src.detune) src.detune.value = detune;      // extra micro-detune
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = R(50, 260);
      // resonant peak at a random frequency — the strongest timbre changer
      const pk = ctx.createBiquadFilter();
      pk.type = 'peaking';
      pk.frequency.value = R(500, 3600);
      pk.Q.value = R(0.7, 3.2);
      pk.gain.value = R(-9, 11);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = R(4800, 20000); lp.Q.value = 0.5;
      const g = ctx.createGain();
      const base = level * vol;
      if (gateTail) {
        // cut the baked echo -> a dry, snappy report (very different feel)
        g.gain.setValueAtTime(base, t);
        g.gain.setTargetAtTime(0.0001, t + R(0.05, 0.18), R(0.03, 0.1));
      } else {
        g.gain.value = base;                          // let the echo ring out
      }
      src.connect(hp); hp.connect(pk); pk.connect(lp);
      let tail = lp;
      if (chance(0.5)) {                              // random grit/saturation
        const sh = ctx.createWaveShaper();
        const drive = R(1.5, 5.5);
        const cv = new Float32Array(257);
        for (let i = 0; i < 257; i++) { const x = i / 128 - 1; cv[i] = Math.tanh(drive * x); }
        sh.curve = cv;
        lp.connect(sh); tail = sh;
      }
      tail.connect(g);
      g.connect(dryDest);
      const send = ctx.createGain();
      send.gain.value = R(0.04, 0.13) * vol;
      g.connect(send); send.connect(this._echoBus());
      src.start(t, R(0, 0.006));                      // random attack trim
    };

    const rate = R(0.72, 1.42);                        // ~1 octave of swing
    const gate = chance(0.45);                         // snappy vs echoing
    playVoice(rate, R(0.8, 1.05), R(-25, 25), gate);
    // ~35%: a quieter detuned second voice -> thicker, flanged character
    if (chance(0.35)) {
      playVoice(rate * R(0.98, 1.02), R(0.35, 0.62), R(-45, 45), gate);
    }
    // ~50%: a synth crack layered on for extra snap variety
    if (chance(0.5)) {
      this._noiseHit(dryDest, t, {
        freq: R(1200, 3600), q: R(0.5, 1.3), gain: R(0.1, 0.3) * vol, dur: R(0.02, 0.06),
      });
    }
    // ~45%: an extra chest sub for weight, pitch varying each time
    if (chance(0.45)) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(R(90, 145), t);
      o.frequency.exponentialRampToValueAtTime(R(36, 54), t + 0.1);
      const og = ctx.createGain();
      og.gain.setValueAtTime(R(0.15, 0.32) * vol, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.connect(og); og.connect(dryDest);
      o.start(t); o.stop(t + 0.17);
    }
  }

  // pistol (synth fallback): randomized ka-POW — click, crack, a resonant
  // FORMANT sweep (the vocal "ow"), chest thump, whip tail, slap-back echo.
  // Every layer rolls its own frequencies/durations so no two sound alike.
  gunshot(vol = 1, pos = null) {
    if (!this.ready || this.muted) return;
    // real recorded shot once it's decoded — with per-shot variations so
    // no two are identical; falls back to the synth until then
    if (this.gunBuf) { this._sampleShot(vol, pos); return; }
    const ctx = this.ctx, t = ctx.currentTime;
    const R = (a, b) => a + Math.random() * (b - a);
    let out = this.combatIn;
    if (pos) {
      this.setPannerPos(this.shotPanner, pos.x, pos.y, pos.z, true);
      out = this.shotPanner;
    }
    // 0) mechanism ring: two detuned metallic partials, very quiet
    for (const fq of [R(2200, 2700), R(3400, 4100)]) {
      const mo = ctx.createOscillator();
      mo.type = 'triangle';
      mo.frequency.value = fq;
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(0.05 * vol, t);
      mg.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      mo.connect(mg); mg.connect(out);
      mo.start(t); mo.stop(t + 0.08);
    }
    // 1) "ka": the Friedlander blast wave itself — varispeed reshapes the
    // pressure pulse every shot (shorter = snappier, longer = boomier)
    const nw = ctx.createBufferSource();
    nw.buffer = this.nWaveBuf;
    nw.playbackRate.value = R(0.8, 1.35);
    const ng = ctx.createGain();
    ng.gain.value = R(0.85, 1.2) * vol;
    nw.connect(ng); ng.connect(out);
    nw.start(t);
    this._noiseHit(out, t, { freq: R(2600, 4200), q: 0.5, gain: R(0.3, 0.45) * vol, dur: 0.025 });
    this._noiseHit(out, t, { freq: R(1050, 1650), q: 0.7, gain: R(0.45, 0.65) * vol, dur: R(0.08, 0.15) });
    // 2) "POW": resonant formant sweeping down fast — the vowel of the shot
    this._noiseHit(out, t + 0.006, {
      type: 'bandpass', freq: R(750, 1050), freqEnd: R(150, 230),
      q: R(2.2, 3.6), gain: R(0.5, 0.75) * vol, dur: R(0.12, 0.2),
    });
    // 3) report body: broad band sweep under the formant
    this._noiseHit(out, t + 0.01, {
      type: 'bandpass', freq: R(360, 480), freqEnd: R(110, 170),
      q: 1.0, gain: R(0.4, 0.55) * vol, dur: R(0.22, 0.34),
    });
    // 4) chest thump, pitch different every time
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(R(128, 188), t);
    o.frequency.exponentialRampToValueAtTime(R(38, 56), t + R(0.11, 0.17));
    const og = ctx.createGain();
    og.gain.setValueAtTime(R(0.42, 0.58) * vol, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.19);
    o.connect(og); og.connect(out);
    o.start(t); o.stop(t + 0.2);
    // 5) whip tail: soft low hiss trailing off
    this._noiseHit(out, t + 0.03, {
      type: 'lowpass', freq: R(420, 620), freqEnd: R(120, 180),
      q: 0.6, gain: R(0.13, 0.24) * vol, dur: R(0.35, 0.6), attack: 0.01,
    });
    // 6) a taste into the echo bus
    const e = ctx.createGain();
    e.gain.value = R(0.35, 0.6) * vol;
    og.connect(e);
    e.connect(this._echoBus());
  }

  // play the recorded explosion with WIDE per-blast variance: big pitch
  // swing (deep vs sharp), random resonant EQ, tail-gating (a crisp crack
  // vs a long rumble), grit, an occasional detuned double-boom, plus synth
  // sub-drop and debris crackle layered on so no two blasts are alike.
  _sampleBoom(pos = null) {
    const ctx = this.ctx, t = ctx.currentTime;
    const R = (a, b) => a + Math.random() * (b - a);
    const chance = (p) => Math.random() < p;
    const dryDest = pos ? this.boomSamplePanner : this.boomBus;
    if (pos) this.setPannerPos(this.boomSamplePanner, pos.x, pos.y, pos.z, true);

    const playVoice = (rate, level, detune, gateTail, delay) => {
      const st = t + delay;
      const src = ctx.createBufferSource();
      src.buffer = this.boomBuf;
      src.playbackRate.value = rate;         // deep + slow  <->  sharp + fast
      if (src.detune) src.detune.value = detune;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = R(20, 90);
      const pk = ctx.createBiquadFilter();   // random resonant colour
      pk.type = 'peaking';
      pk.frequency.value = R(120, 1400);
      pk.Q.value = R(0.6, 2.6);
      pk.gain.value = R(-9, 10);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = R(2200, 14000); lp.Q.value = 0.5;
      const g = ctx.createGain();
      const base = level;
      if (gateTail) {                        // cut the rumble -> a sharp crack
        g.gain.setValueAtTime(base, st);
        g.gain.setTargetAtTime(0.0001, st + R(0.12, 0.4), R(0.08, 0.22));
      } else {
        g.gain.value = base;                 // let it rumble out full
      }
      src.connect(hp); hp.connect(pk); pk.connect(lp);
      let tail = lp;
      if (chance(0.6)) {                      // random saturation/grit
        const sh = ctx.createWaveShaper();
        const drive = R(1.6, 6);
        const cv = new Float32Array(257);
        for (let i = 0; i < 257; i++) { const x = i / 128 - 1; cv[i] = Math.tanh(drive * x); }
        sh.curve = cv;
        lp.connect(sh); tail = sh;
      }
      tail.connect(g);
      g.connect(dryDest);
      const send = ctx.createGain();
      send.gain.value = R(0.06, 0.16);
      g.connect(send); send.connect(this._echoBus());
      src.start(st, R(0, 0.01));
    };

    const rate = R(0.6, 1.35);                // huge swing: cavernous -> tight
    const gate = chance(0.35);
    playVoice(rate, R(0.9, 1.2), R(-30, 30), gate, 0);
    // ~40%: a lower, delayed second boom -> the "ka-BOOM" double concussion
    if (chance(0.4)) {
      playVoice(rate * R(0.55, 0.8), R(0.5, 0.85), R(-50, 50), false, R(0.06, 0.2));
    }
    // synth sub-drop under it for chest weight (varies pitch/length)
    const o = ctx.createOscillator();
    o.type = 'sine';
    const subDur = R(0.7, 1.4);
    o.frequency.setValueAtTime(R(48, 82), t);
    o.frequency.exponentialRampToValueAtTime(R(15, 22), t + subDur);
    const og = ctx.createGain();
    og.gain.setValueAtTime(R(0.4, 0.7), t);
    og.gain.exponentialRampToValueAtTime(0.001, t + subDur + 0.1);
    o.connect(og); og.connect(dryDest);
    o.start(t); o.stop(t + subDur + 0.15);
    // debris crackle: scattered pops as burning bits land
    const nPop = 2 + Math.floor(Math.random() * 6);
    for (let i = 0; i < nPop; i++) {
      this._noiseHit(dryDest, t + R(0.15, 1.3), {
        type: 'bandpass', freq: R(700, 2600), q: R(1.4, 3),
        gain: R(0.06, 0.17), dur: R(0.02, 0.05),
      });
    }
  }

  // explosion: five layers — sub drop, crack, gritty mid body, long rumble
  // tail, slap-back echo. Pass `pos` to place/attenuate it in the world.
  explosion(pos = null) {
    if (!this.ready || this.muted) return;
    // real recorded blast once decoded, with wide variance; synth until then
    if (this.boomBuf) { this._sampleBoom(pos); return; }
    const ctx = this.ctx, t = ctx.currentTime;
    let out = this.combatIn;
    if (pos) {
      if (!this.boomPanner) {
        this.boomPanner = this.makePanner(0, 0, 0);
        this.boomPanner.refDistance = 26; // blasts carry much further than shots
        this.boomPanner.rolloffFactor = 0.8;
        this.boomPanner.connect(this.combatIn);
      }
      this.setPannerPos(this.boomPanner, pos.x, pos.y, pos.z, true);
      out = this.boomPanner;
    }
    const R = (a, b) => a + Math.random() * (b - a);
    // 0) detonation front: the N-wave slowed 3-4x — a blast is a gunshot
    // pressure pulse at scale
    const nw = ctx.createBufferSource();
    nw.buffer = this.nWaveBuf;
    nw.playbackRate.value = R(0.24, 0.4);
    const ng = ctx.createGain();
    ng.gain.value = R(1.0, 1.3);
    nw.connect(ng); ng.connect(out);
    nw.start(t);
    // 1) sub drop: the pressure wave (through a soft clip for weight)
    const o = ctx.createOscillator();
    o.type = 'sine';
    const subDur = R(0.9, 1.4);
    o.frequency.setValueAtTime(R(50, 80), t);
    o.frequency.exponentialRampToValueAtTime(R(15, 20), t + subDur);
    const shp = ctx.createWaveShaper();
    const cv = new Float32Array(257);
    for (let i = 0; i < 257; i++) { const x = i / 128 - 1; cv[i] = Math.tanh(2.4 * x); }
    shp.curve = cv;
    const og = ctx.createGain();
    og.gain.setValueAtTime(R(0.8, 1.0), t);
    og.gain.exponentialRampToValueAtTime(0.001, t + subDur + 0.1);
    o.connect(shp); shp.connect(og); og.connect(out);
    o.start(t); o.stop(t + subDur + 0.15);
    // 1b) sometimes a second, lower thump right behind — the "ka-BOOM"
    if (Math.random() < 0.55) {
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      const t2 = t + R(0.09, 0.17);
      o2.frequency.setValueAtTime(R(38, 56), t2);
      o2.frequency.exponentialRampToValueAtTime(16, t2 + 0.7);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t2);
      g2.gain.exponentialRampToValueAtTime(R(0.4, 0.6), t2 + 0.015);
      g2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.8);
      o2.connect(shp); // share the clipper
      o2.start(t2); o2.stop(t2 + 0.85);
    }
    // 2) crack: the initial detonation snap
    this._noiseHit(out, t, { freq: R(700, 1300), q: 0.6, gain: R(0.5, 0.7), dur: R(0.06, 0.12) });
    // 3) gritty mid body sweeping down
    this._noiseHit(out, t + 0.01, {
      type: 'bandpass', freq: R(280, 430), freqEnd: R(55, 90),
      q: R(0.7, 1.3), gain: R(0.65, 0.9), dur: R(0.8, 1.3),
    });
    // 4) long low rumble tail, different length every time
    this._noiseHit(out, t + 0.05, {
      type: 'lowpass', freq: R(130, 200), freqEnd: R(45, 70),
      q: 0.7, gain: R(0.4, 0.6), dur: R(1.8, 3.0), attack: 0.03,
    });
    // 5) debris crackle: scattered pops as burning bits land
    const nPop = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < nPop; i++) {
      this._noiseHit(out, t + R(0.15, 1.1), {
        type: 'bandpass', freq: R(800, 2500), q: R(1.5, 3),
        gain: R(0.07, 0.18), dur: R(0.02, 0.05),
      });
    }
    // 6) echo report
    const e = ctx.createGain();
    e.gain.value = R(0.4, 0.7);
    og.connect(e);
    e.connect(this._echoBus());
  }

  // spatial whoosh pool for rockets in flight: each voice is filtered noise
  // riding a panner; Game hands us the live rocket list every frame
  updateRockets(rockets) {
    if (!this.ready) return;
    if (!this.rocketVoices) {
      this.rocketVoices = [];
      for (let i = 0; i < 5; i++) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        src.loop = true;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 700 + i * 90; // slight per-voice character
        bp.Q.value = 0.6;
        const g = this.ctx.createGain();
        g.gain.value = 0;
        const panner = this.makePanner(0, -999, 0);
        panner.refDistance = 7;      // audible when close, gone at range
        panner.rolloffFactor = 2.2;
        src.connect(bp); bp.connect(g); g.connect(panner);
        panner.connect(this.master);
        src.start();
        this.rocketVoices.push({ g, panner, bp });
      }
    }
    const t = this.ctx.currentTime;
    for (let i = 0; i < this.rocketVoices.length; i++) {
      const v = this.rocketVoices[i];
      const r = rockets[i];
      if (r && !this.muted) {
        // snap on activation (the voice was parked far away), glide after
        this.setPannerPos(v.panner, r.pos.x, r.pos.y, r.pos.z, !v.active);
        v.active = true;
        // brighter + louder while the motor burns hard (fresh rocket)
        v.g.gain.setTargetAtTime(0.55, t, 0.05);
        v.bp.frequency.setTargetAtTime(560 + Math.min(1, r.life / 6) * 480 + i * 60, t, 0.1);
      } else {
        v.active = false;
        v.g.gain.setTargetAtTime(0, t, 0.08);
      }
    }
  }

  // wind rush: rises with speed, roars louder and darker in the draft
  setWind(speed01, draft = 0) {
    if (!this.ready) return;
    if (!this.wind) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 700;
      bp.Q.value = 0.4;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(bp); bp.connect(g); g.connect(this.master);
      src.start();
      this.wind = { bp, g };
    }
    const t = this.ctx.currentTime;
    const vol = this.muted ? 0 : speed01 * speed01 * 0.2 + draft * 0.1;
    this.wind.g.gain.setTargetAtTime(vol, t, 0.1);
    this.wind.bp.frequency.setTargetAtTime(500 + speed01 * 1400 - draft * 250, t, 0.12);
  }

  setSlide(amount) {
    if (!this.ready) return;
    const vol = this.muted ? 0 : Math.min(0.14, amount * 0.14);
    this.slideGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.06);
  }

  beep(freq, dur = 0.14) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g);
    g.connect(this.master);
    o.start();
    o.stop(ctx.currentTime + dur);
  }

  thud() {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(35, ctx.currentTime + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.connect(g);
    g.connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 0.3);
  }

  dispose() {
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ready = false;
  }
}
