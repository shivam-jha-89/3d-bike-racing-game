import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { loadCareer, buyUpgrade, UPGRADES } from '../game/career.js';
import {
  WEAPONS, UNIQUES, DAMAGE_TYPES, weaponBase,
  loadArsenal, buyOrUpgrade, equipWeapon, upgradeCost,
} from '../game/weapons.js';
import { createBikeMesh, applyGearVisuals } from '../game/bikeMesh.js';
import { getBike } from '../game/bikes.js';
import { SWATCHES, loadStyle, saveStyle, styledColors } from '../game/style.js';
import { SETTLEMENTS } from '../game/rpg.js';
import { variantThumb } from './thumbs.js';

// turntable viewer: your bike, your paint, your bolted-on gear — live
function BikeViewer({ bikeId, career, arsenal, style }) {
  const mountRef = useRef(null);
  useEffect(() => {
    const mount = mountRef.current;
    const W = mount.clientWidth || 360, H = 300;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(38, W / H, 0.1, 30);
    cam.position.set(0, 1.4, 4.2);
    cam.lookAt(0, 0.75, 0);
    scene.add(new THREE.HemisphereLight(0xcfd6e0, 0x33302a, 1.1));
    const key = new THREE.DirectionalLight(0xfff0da, 1.6);
    key.position.set(3, 4, 2.5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8ab0ff, 0.7);
    rim.position.set(-3, 2, -3);
    scene.add(rim);
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.7, 0.08, 40),
      new THREE.MeshLambertMaterial({ color: 0x24262c }));
    disc.position.y = -0.05;
    scene.add(disc);

    const bike = getBike(bikeId);
    const pm = createBikeMesh(styledColors(bike.colors), bike.style || bike.type, 7);
    applyGearVisuals(pm, {
      weaponId: weaponBase(arsenal.owned[arsenal.equipped] ? arsenal.equipped : 'pistol'),
      armourLvl: career.upgrades.armour,
      engineLvl: career.upgrades.engine,
    });
    if (pm.rider.gunArm) pm.rider.gunArm.visible = true; // show the hardware
    scene.add(pm.group);

    let raf, alive = true;
    const tick = () => {
      if (!alive) return;
      pm.group.rotation.y += 0.008;
      renderer.render(scene, cam);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      renderer.dispose();
      // dispose() alone never frees the context slot (r166); without this,
      // paint-swatch clicks rebuild viewers until the browser's live-context
      // cap evicts the shared thumbnail renderer
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode) mount.removeChild(renderer.domElement);
    };
  }, [bikeId, career, arsenal, style]);
  return <div className="bike-viewer" ref={mountRef} />;
}

// arrow-browsable per-tier preview: every MK is visible, locked ones greyed,
// so you can window-shop the whole ladder before spending a single point
function VariantBrowser({ kind, max, ownedLvl, info }) {
  const [view, setView] = useState(Math.min(max, Math.max(1, ownedLvl || 1)));
  const locked = view > ownedLvl;
  const step = (d) => setView((v) => ((v - 1 + d + max) % max) + 1);
  return (
    <div className="variant-box">
      <button className="v-arrow" onClick={() => step(-1)} aria-label="previous tier">‹</button>
      <div className={`v-thumb ${locked ? 'locked' : ''}`}>
        <img src={variantThumb(kind, view, 0.45 + view * 0.3)} alt="" draggable={false} />
        <div className="v-tag">
          <b>MK{view}</b>
          <span className={locked ? 'v-lock' : 'v-have'}>
            {locked ? 'LOCKED' : view === ownedLvl ? 'FITTED' : 'OWNED'}
          </span>
        </div>
        {info && <div className="v-info">{info(view)}</div>}
      </div>
      <button className="v-arrow" onClick={() => step(1)} aria-label="next tier">›</button>
    </div>
  );
}

// stat one-liner for a weapon level, shared by armory cards and relics
function weaponStatLine(s) {
  return `DMG ${s.dmg} · ${(1 / s.cd).toFixed(1)}/s · ${s.cost} CHG`
    + (s.pellets > 1 ? ` · x${s.pellets}` : '') + (s.boom ? ' · BOOM' : '');
}

// Spend race earnings on the machine, the leathers and the hardware.
export default function Garage({ onBack, bikeId = 'gp500' }) {
  const [career, setCareer] = useState(loadCareer());
  const [arsenal, setArsenal] = useState(loadArsenal());
  const [style, setStyle] = useState(loadStyle());

  const paint = (slot, hex) => {
    const st = { ...style, [slot]: style[slot] === hex ? null : hex };
    saveStyle(st);
    setStyle(st);
  };

  const buy = (key) => {
    const updated = buyUpgrade(key);
    if (updated) setCareer(updated);
  };
  const buyWeapon = (id) => {
    const r = buyOrUpgrade(id);
    if (r) { setArsenal(r.arsenal); setCareer(r.career); }
  };
  const equip = (id) => {
    const a = equipWeapon(id);
    if (a) setArsenal({ ...a });
  };

  return (
    <div className="menu">
      <h1 className="logo">
        GA<span>RAGE</span>
      </h1>
      <div className="pts-badge">{career.points} PTS</div>

      <div className="garage-top">
        <BikeViewer bikeId={bikeId} career={career} arsenal={arsenal} style={style} />
        <div className="paint-booth">
          <h2>PAINT BOOTH</h2>
          {['body', 'accent', 'helmet', 'rider'].map((slot) => (
            <div key={slot} className="paint-row">
              <span>{slot.toUpperCase()}</span>
              <div className="swatches">
                {SWATCHES[slot].map((hex) => (
                  <button
                    key={hex}
                    className={`swatch ${style[slot] === hex ? 'on' : ''}`}
                    style={{ background: '#' + hex.toString(16).padStart(6, '0') }}
                    onClick={() => paint(slot, hex)}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="paint-hint">click again to return to stock paint</div>
        </div>
      </div>

      <div className="menu-section">
        <div className="card-row">
          {Object.entries(UPGRADES).map(([key, def]) => {
            const lvl = career.upgrades[key] || 0;
            const maxed = lvl >= def.costs.length;
            const cost = maxed ? null : def.costs[lvl];
            const affordable = !maxed && career.points >= cost;
            return (
              <div key={key} className="card upgrade-card">
                <div className="card-title">{def.name}</div>
                <div className="card-sub">{def.desc}</div>
                <VariantBrowser kind={key} max={def.costs.length} ownedLvl={lvl}
                  info={(v) => (v > lvl ? `${def.costs[v - 1]} PTS` : ' ')} />
                <div className="pips">
                  {def.costs.map((_, i) => (
                    <span key={i} className={`pip ${i < lvl ? 'on' : ''}`} />
                  ))}
                </div>
                <button
                  className={`buy-btn ${affordable ? '' : 'disabled'}`}
                  disabled={!affordable}
                  onClick={() => buy(key)}
                  data-testid={`buy-${key}`}
                >
                  {maxed ? 'MAXED OUT' : `UPGRADE — ${cost} PTS`}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="menu-section">
        <h2 style={{ color: '#ffd23c', letterSpacing: 3, margin: '18px 0 10px' }}>ARMORY</h2>
        <div className="card-row">
          {Object.entries(WEAPONS).map(([id, def]) => {
            const lvl = arsenal.owned[id] || 0;
            const owned = lvl > 0;
            const maxed = lvl >= def.levels.length;
            const cost = !owned ? def.price : maxed ? null : upgradeCost(id, lvl);
            const affordable = cost != null && career.points >= cost;
            const equipped = arsenal.equipped === id && owned;
            return (
              <div key={id} className="card upgrade-card"
                style={equipped ? { outline: '2px solid #ffd23c' } : undefined}>
                <div className="card-title">{def.name}</div>
                <div className="card-sub">{def.blurb}</div>
                <VariantBrowser kind={`w:${id}`} max={def.levels.length} ownedLvl={lvl}
                  info={(v) => weaponStatLine(def.levels[v - 1])} />
                <div className="pips">
                  {def.levels.map((_, i) => (
                    <span key={i} className={`pip ${i < lvl ? 'on' : ''}`} />
                  ))}
                </div>
                <button
                  className={`buy-btn ${affordable ? '' : 'disabled'}`}
                  disabled={!affordable}
                  onClick={() => buyWeapon(id)}
                  data-testid={`weapon-${id}`}
                >
                  {maxed ? 'MAXED OUT'
                    : owned ? `POWER UP — ${cost} PTS`
                      : `BUY — ${cost} PTS`}
                </button>
                {owned && !equipped && (
                  <button className="buy-btn" onClick={() => equip(id)}>EQUIP</button>
                )}
                {equipped && (
                  <div style={{ color: '#ffd23c', fontSize: 12, letterSpacing: 2, marginTop: 6 }}>
                    EQUIPPED
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="menu-section">
        <h2 style={{ color: '#ffd23c', letterSpacing: 3, margin: '18px 0 4px' }}>RELICS</h2>
        <div className="relic-hint">
          Never sold. Certain contracts pay in iron — ride where the rumors point.
        </div>
        <div className="card-row">
          {Object.entries(UNIQUES).map(([id, u]) => {
            const owned = !!arsenal.owned[id];
            const equipped = arsenal.equipped === id && owned;
            const dt = DAMAGE_TYPES[u.damageType];
            if (!owned) {
              return (
                <div key={id} className="card upgrade-card relic-card unknown">
                  <div className="card-title">???</div>
                  <div className="relic-type" style={{ color: dt.color }}>{dt.name}</div>
                  <div className="card-sub">
                    A {WEAPONS[u.base].name.toLowerCase()} that never came off a line.
                    Rumored around {SETTLEMENTS[u.home].name}.
                  </div>
                </div>
              );
            }
            return (
              <div key={id} className="card upgrade-card relic-card"
                style={equipped ? { outline: `2px solid ${dt.color}` } : undefined}>
                <div className="card-title" style={{ color: dt.color }}>{u.name}</div>
                <div className="relic-type" style={{ color: dt.color }}>{dt.name}</div>
                <div className="v-thumb" style={{ margin: '8px 0 4px' }}>
                  <img src={variantThumb(`w:${u.base}`, 3, 1.15)} alt="" draggable={false} />
                  <div className="v-info">{weaponStatLine(u.stats)}</div>
                </div>
                <div className="card-sub">{u.blurb}</div>
                {!equipped && (
                  <button className="buy-btn" onClick={() => equip(id)}>EQUIP</button>
                )}
                {equipped && (
                  <div style={{ color: dt.color, fontSize: 12, letterSpacing: 2, marginTop: 6 }}>
                    EQUIPPED
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <button className="start-btn" onClick={onBack}>
        BACK
      </button>
    </div>
  );
}
