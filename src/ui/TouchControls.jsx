import React, { useEffect, useRef } from 'react';
import { WEAPONS, UNIQUES, weaponBase, loadArsenal } from '../game/weapons.js';

// Twin-stick touch layer. Left stick rides (x steer, up throttle, down
// brake). The right stick IS the mouse: touching it draws the gun, its
// deflection aims, pushing past 40% throw fires, releasing holsters.
// FOCUS holds bullet time, GUN cycles frames, II pauses.

export const isTouchDevice = () =>
  ('ontouchstart' in window) || navigator.maxTouchPoints > 0 ||
  localStorage.getItem('motomad-touch') === '1';

export default function TouchControls({ gameRef }) {
  const leftPad = useRef(null), leftKnob = useRef(null);
  const rightPad = useRef(null), rightKnob = useRef(null);

  useEffect(() => {
    const R = 62; // pad radius in px — knob throw and normalization
    const bind = (pad, knob, onVec, onEnd, onStart) => {
      let pid = null, cx = 0, cy = 0;
      const move = (e) => {
        if (e.pointerId !== pid) return;
        let dx = e.clientX - cx, dy = e.clientY - cy;
        const m = Math.hypot(dx, dy);
        if (m > R) { dx *= R / m; dy *= R / m; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        onVec(dx / R, dy / R);
      };
      const down = (e) => {
        if (pid !== null) return;
        e.preventDefault(); // no synthesized mouse events (they'd fire the gun)
        pid = e.pointerId;
        // a finger that lifts in the same tick throws NotFoundError here
        try { pad.setPointerCapture(pid); } catch { /* keep the stick alive */ }
        const r = pad.getBoundingClientRect();
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
        if (onStart) onStart();
        move(e);
      };
      const up = (e) => {
        if (e.pointerId !== pid) return;
        pid = null;
        knob.style.transform = 'translate(0, 0)';
        if (onEnd) onEnd();
      };
      pad.addEventListener('pointerdown', down);
      pad.addEventListener('pointermove', move);
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointercancel', up);
      return () => {
        pad.removeEventListener('pointerdown', down);
        pad.removeEventListener('pointermove', move);
        pad.removeEventListener('pointerup', up);
        pad.removeEventListener('pointercancel', up);
      };
    };

    const offL = bind(leftPad.current, leftKnob.current,
      (nx, ny) => {
        const g = gameRef.current;
        if (!g) return;
        const t = g.input.touch;
        t.steer = -nx; // +1 is LEFT in the physics convention
        t.throttle = Math.max(0, -ny);
        t.brake = Math.max(0, ny);
      },
      () => {
        const g = gameRef.current;
        if (g) Object.assign(g.input.touch, { steer: 0, throttle: 0, brake: 0 });
      });

    const offR = bind(rightPad.current, rightKnob.current,
      (nx, ny) => {
        const g = gameRef.current;
        if (!g) return;
        // deflection maps to the same screen-space cursor the mouse would set
        g.input.mouse.x = window.innerWidth / 2 + nx * window.innerWidth * 0.33;
        g.input.mouse.y = window.innerHeight / 2 + ny * window.innerHeight * 0.33;
        const firing = Math.hypot(nx, ny) > 0.4;
        g.input.fireHeld = firing;
        rightKnob.current.classList.toggle('firing', firing);
      },
      () => {
        const g = gameRef.current;
        if (!g) return;
        g.input.fireHeld = false;
        rightKnob.current.classList.remove('firing');
        if (g.gunOut) g.input.onRightClick(); // holster
        g.input.mouse.x = window.innerWidth / 2;
        g.input.mouse.y = window.innerHeight / 2;
      },
      () => {
        const g = gameRef.current;
        if (g && !g.gunOut) g.input.onRightClick(); // draw
      });

    return () => { offL(); offR(); };
  }, [gameRef]);

  const focusDown = (e) => {
    e.preventDefault();
    const g = gameRef.current;
    if (g) g.input.touch.focus = true;
  };
  const focusUp = () => {
    const g = gameRef.current;
    if (g) g.input.touch.focus = false;
  };
  // next frame with anything owned on it; the Game's key handler picks
  // relics first within the frame, exactly like pressing 1-5
  const swap = (e) => {
    e.preventDefault();
    const g = gameRef.current;
    if (!g) return;
    const frames = Object.keys(WEAPONS);
    const a = loadArsenal();
    const cur = frames.indexOf(weaponBase(g.weapon.id));
    for (let k = 1; k <= frames.length; k++) {
      const idx = (cur + k) % frames.length;
      const owned = a.owned[frames[idx]] ||
        Object.keys(UNIQUES).some((u) => UNIQUES[u].base === frames[idx] && a.owned[u]);
      if (owned) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: String(idx + 1) }));
        return;
      }
    }
  };
  const pause = (e) => {
    e.preventDefault();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  };

  return (
    <div className="touch-layer">
      <button className="tbtn tswap" onPointerDown={swap}>GUN</button>
      <button className="tbtn tfocus" onPointerDown={focusDown}
        onPointerUp={focusUp} onPointerLeave={focusUp}>FOCUS</button>
      <button className="tbtn tpause" onPointerDown={pause}>II</button>
      <div className="tpad tleft" ref={leftPad}><div className="tknob" ref={leftKnob} /></div>
      <div className="tpad tright" ref={rightPad}><div className="tknob" ref={rightKnob} /></div>
    </div>
  );
}
