import React, { useMemo, useState } from 'react';
import * as THREE from 'three';
import { BIKES } from '../game/bikes.js';
import { TRACKS } from '../game/tracks.js';
import { loadCareer } from '../game/career.js';
import { loadSettings, saveSettings, LEVELS } from '../game/settings.js';

function TrackPreview({ def }) {
  const path = useMemo(() => {
    const pts = def.points.map((p) => new THREE.Vector3(p[0], 0, p[2]));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const sampled = curve.getSpacedPoints(140);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of sampled) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const span = Math.max(maxX - minX, maxZ - minZ);
    const sc = 84 / span;
    const ox = (100 - (maxX - minX) * sc) / 2;
    const oz = (100 - (maxZ - minZ) * sc) / 2;
    return sampled
      .map((p, i) => `${i ? 'L' : 'M'}${((p.x - minX) * sc + ox).toFixed(1)},${((p.z - minZ) * sc + oz).toFixed(1)}`)
      .join(' ');
  }, [def]);
  return (
    <svg viewBox="0 0 100 100" className="track-preview">
      <path d={path} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="9" strokeLinejoin="round" />
      <path d={path} fill="none" stroke="#ffd23c" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}

function StatBar({ label, value }) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      <div className="stat-track">
        <div className="stat-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

// one difficulty dial: OFF / LOW / NORMAL / HIGH
function DialRow({ label, value, onPick }) {
  return (
    <div className="stat-row" style={{ alignItems: 'center', gap: 10 }}>
      <span style={{ minWidth: 170, textAlign: 'left' }}>{label}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        {LEVELS.map((lv) => (
          <button
            key={lv}
            className={`card ${value === lv ? 'selected' : ''}`}
            style={{ padding: '6px 12px', fontSize: 12, letterSpacing: 1 }}
            onClick={() => onPick(lv)}
            data-testid={`dial-${label.replace(/\s/g, '')}-${lv}`}
          >
            {lv.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function MainMenu({ bikeId, trackId, onBike, onTrack, onStart, onTournament, onKnockout, onPackage, onGarage, onHub, onWorld }) {
  const pts = loadCareer().points;
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(loadSettings);
  const pick = (key) => (lv) => {
    const next = { ...settings, [key]: lv };
    setSettings(next);
    saveSettings(next);
  };
  return (
    <div className="menu">
      <h1 className="logo">
        MOTO<span>MAD</span>
      </h1>
      <p className="tagline">an arcade racing tribute — 1997 vibes, 2026 pixels</p>
      <div className="pts-badge">{pts} PTS</div>

      <div className="menu-section">
        <h2>RIDER'S CHOICE</h2>
        <div className="card-row">
          {BIKES.map((b) => (
            <button
              key={b.id}
              className={`card bike-card ${bikeId === b.id ? 'selected' : ''}`}
              onClick={() => onBike(b.id)}
              data-testid={`bike-${b.id}`}
            >
              <div className="card-title" style={{ color: `#${b.colors.body.toString(16).padStart(6, '0')}` }}>
                {b.name}
              </div>
              <div className="card-sub">{b.tagline}</div>
              <StatBar label="SPEED" value={b.stats.speed} />
              <StatBar label="ACCEL" value={b.stats.accel} />
              <StatBar label="GRIP" value={b.stats.handling} />
              <StatBar label="DIRT" value={b.stats.offroad} />
            </button>
          ))}
        </div>
      </div>

      <div className="menu-section">
        <h2>CIRCUIT</h2>
        <div className="card-row">
          {TRACKS.map((t) => (
            <button
              key={t.id}
              className={`card track-card ${trackId === t.id ? 'selected' : ''}`}
              onClick={() => onTrack(t.id)}
              data-testid={`track-${t.id}`}
            >
              <TrackPreview def={t} />
              <div className="card-title">{t.name}</div>
              <div className="card-sub">{t.subtitle}</div>
              <div className="card-surface">{t.surface.toUpperCase()}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="mode-row">
        <button className="start-btn" onClick={onStart} data-testid="start-race">
          START RACE
        </button>
        <button className="start-btn tournament-btn" onClick={onTournament} data-testid="start-tournament">
          TOURNAMENT
        </button>
        <button className="start-btn knockout-btn" onClick={onKnockout} data-testid="start-knockout">
          KNOCKOUT
        </button>
        <button className="start-btn" onClick={onPackage} data-testid="start-package">
          PACKAGE RUN
        </button>
        <button className="start-btn" onClick={onWorld} data-testid="start-world">
          WASTELAND
        </button>
        <button className="start-btn garage-btn" onClick={onGarage} data-testid="open-garage">
          GARAGE
        </button>
        <button className="start-btn" onClick={() => setShowSettings(true)} data-testid="open-settings">
          SETTINGS
        </button>
      </div>

      {showSettings && (
        <div className="overlay" onClick={() => setShowSettings(false)}>
          <div className="panel results" onClick={(e) => e.stopPropagation()}>
            <h2>DIFFICULTY</h2>
            <DialRow label="MISSILE FIRE RATE" value={settings.missiles} onPick={pick('missiles')} />
            <DialRow label="OPPONENT GUNFIRE" value={settings.aggression} onPick={pick('aggression')} />
            <p style={{ fontSize: 12, opacity: 0.7, marginTop: 10 }}>
              OFF disables that hazard entirely. Applies from the next race.
            </p>
            <button onClick={() => setShowSettings(false)} data-testid="close-settings">DONE</button>
          </div>
        </div>
      )}

      <div className="controls-hint">
        <b>↑/W</b> throttle · <b>↓/S</b> brake · <b>←→/AD</b> lean · <b>SPACE</b> rear brake (slide) ·{' '}
        <b>R</b> reset · <b>M</b> mute · <b>ESC</b> pause
        <br />
        <b>RIGHT CLICK</b> draw/holster pistol · <b>MOUSE</b> aim · <b>LEFT CLICK</b> shoot ·{' '}
        <b>SHIFT</b> (gun out) bullet time: look back &amp; shoot behind — hit the RIDER to scramble
        their steering, hitting the bike just sparks. One-handed riding limits your lean, and
        watch it: every opponent is armed too
      </div>
    </div>
  );
}
