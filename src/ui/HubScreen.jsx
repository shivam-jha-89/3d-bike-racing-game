import React, { useEffect, useRef, useState } from 'react';
import { HubWorld } from '../game/hub.js';

// Placeholder dialogue trees — Fallout-style: terse, dry, a stat check the
// player can't pass yet (the RIDER sheet lands in a later phase).
const DIALOGUE = {
  harrow: {
    start: 'a',
    nodes: {
      a: {
        text: 'You rode in on the old Riviera road. The road eats riders, stranger. It is still hungry.',
        options: [
          { label: 'Who runs this place?', to: 'b' },
          { label: 'Any work for a courier?', to: 'c' },
          { label: '[Leave] Just passing through.', end: true },
        ],
      },
      b: {
        text: 'Nobody runs Ember Flat. The Freight Guild taxes the asphalt, the Rust Prophets tax the Guild, and we bury whoever stops paying either.',
        options: [
          { label: 'Cheerful. Any work?', to: 'c' },
          { label: '[Leave] I have heard enough.', end: true },
        ],
      },
      c: {
        text: 'Talk to Moth by the tarps. And if your bike coughs, Wrench owes me a favour. Tell her the elder sent you.',
        options: [
          { label: 'Appreciated.', end: true },
        ],
      },
    },
  },
  wrench: {
    start: 'a',
    nodes: {
      a: {
        text: 'Chain is sanded to hell and your back tyre is more patch than tyre. You want it fixed, or you want it pretty?',
        options: [
          { label: 'What would fixing cost me?', to: 'b' },
          { label: '[ENGINEERING 6] Hand me the wrench, I will do it myself.', check: true },
          { label: '[Leave] Later.', end: true },
        ],
      },
      b: {
        text: 'Forty scrap. Thirty if the elder vouches for you. Fuel is extra — fuel is always extra.',
        options: [
          { label: 'I will come back with the scrap.', end: true },
        ],
      },
    },
  },
  moth: {
    start: 'a',
    nodes: {
      a: {
        text: 'A rider with a working trigger finger. Good. I have a crate that needs to be in Red Gorge before the Prophets notice it is gone.',
        options: [
          { label: 'What is in the crate?', to: 'b' },
          { label: 'What is the pay?', to: 'c' },
          { label: '[Leave] Not interested.', end: true },
        ],
      },
      b: {
        text: 'Medicine, if anyone asks. Do not ask. The road tax on honesty is steep out here.',
        options: [
          { label: 'And the pay?', to: 'c' },
          { label: '[Leave] Forget it.', end: true },
        ],
      },
      c: {
        text: 'Ninety scrap on delivery, and the Guild forgets your name on two toll roads. Contracts land in the next supply drop — check back soon, courier.',
        options: [
          { label: 'I will be there when it does.', end: true },
        ],
      },
    },
  },
};

export default function HubScreen({ onExit, name = 'EMBER FLAT', subtitle = 'pop. 34 — Freight Guild territory' }) {
  const mountRef = useRef(null);
  const hubRef = useRef(null);
  const [near, setNear] = useState(null);
  const [talk, setTalk] = useState(null); // { id, name, role, node }

  useEffect(() => {
    const hub = new HubWorld(mountRef.current);
    hubRef.current = hub;
    window.__hub = hub;
    let raf;
    const poll = () => {
      setNear(hub.state.near);
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(raf);
      hub.dispose();
      if (window.__hub === hub) window.__hub = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const hub = hubRef.current;
      if (!hub) return;
      if (e.key === 'Escape') {
        if (hub.locked) {
          hub.locked = false;
          setTalk(null);
        } else {
          onExit();
        }
      }
      if ((e.key === 'e' || e.key === 'E') && !hub.locked && hub.state.near) {
        const n = hub.state.near;
        hub.locked = true;
        setTalk({ ...n, node: DIALOGUE[n.id].start });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const choose = (opt) => {
    if (opt.check) return; // stat checks unlock with the RIDER sheet
    if (opt.end) {
      hubRef.current.locked = false;
      setTalk(null);
    } else {
      setTalk((t) => ({ ...t, node: opt.to }));
    }
  };

  const tree = talk ? DIALOGUE[talk.id] : null;
  const node = tree ? tree.nodes[talk.node] : null;

  return (
    <div className="hub-screen">
      <div className="hub-mount" ref={mountRef} />
      <div className="crt" />

      <div className="hub-banner">
        {name} <span>{subtitle}</span>
      </div>

      {!talk && (
        <div className="hub-hint">
          {near
            ? <>E — talk to <b>{near.name}</b> <i>({near.role})</i></>
            : 'WASD — walk · E — talk · ESC — ride out'}
        </div>
      )}

      {talk && node && (
        <div className="dlg">
          <div className="dlg-head">
            <span className="dlg-name">{talk.name}</span>
            <span className="dlg-role">{talk.role}</span>
          </div>
          <div className="dlg-text">{node.text}</div>
          <div className="dlg-opts">
            {node.options.map((o, i) => (
              <button
                key={i}
                className={o.check ? 'dlg-opt locked' : 'dlg-opt'}
                onClick={() => choose(o)}
              >
                {i + 1}. {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
