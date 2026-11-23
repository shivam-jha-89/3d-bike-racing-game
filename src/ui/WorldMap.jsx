import React, { useMemo, useState } from 'react';
import {
  SETTLEMENTS, ROADS, roadsFrom, fuelCost, contractsAt,
  PERKS, perkOffer, levelFromXp, xpForLevel, saveRpg,
} from '../game/rpg.js';
import { TRACKS } from '../game/tracks.js';

// Phase-1 overworld: settlements as nodes on a green-phosphor survey map,
// the nine stages as the roads between them. Travel IS the race stage.
export default function WorldMap({ rpg, setRpg, lastLeg, onRide, onVisit, onExit }) {
  const [sel, setSel] = useState(null); // selected road (from roadsFrom)
  const loc = SETTLEMENTS[rpg.location];
  const roads = roadsFrom(rpg.location);
  const contracts = useMemo(() => contractsAt(rpg.location, rpg), [rpg.location, rpg.legsRidden]);
  const level = levelFromXp(rpg.xp);
  const xpFloor = xpForLevel(level);
  const xpNext = xpForLevel(level + 1);
  const xpFrac = (rpg.xp - xpFloor) / (xpNext - xpFloor);

  const trackName = (id) => TRACKS.find((t) => t.id === id)?.name || id;
  const canRide = (road) => rpg.fuel >= fuelCost(road, rpg);

  const refuel = () => {
    if (rpg.scrap < 5 || rpg.fuel >= rpg.fuelMax) return;
    const s = { ...rpg, scrap: rpg.scrap - 5, fuel: Math.min(rpg.fuelMax, rpg.fuel + 10) };
    saveRpg(s); setRpg(s);
  };
  const work = () => {
    const s = { ...rpg, scrap: rpg.scrap + 12 };
    saveRpg(s); setRpg(s);
  };
  const pickPerk = (id) => {
    const s = { ...rpg, perks: [...rpg.perks, id], pendingPerks: rpg.pendingPerks - 1 };
    saveRpg(s); setRpg(s);
  };

  // perk chooser modal takes over when a level-up is pending
  if (rpg.pendingPerks > 0) {
    const offer = perkOffer(level + rpg.perks.length, rpg.perks);
    return (
      <div className="worldmap">
        <div className="crt" />
        <div className="perk-modal">
          <h2>LEVEL {level} — CHOOSE A PERK</h2>
          <div className="perk-cards">
            {offer.map((id) => (
              <button key={id} className="perk-card" onClick={() => pickPerk(id)}>
                <div className="perk-name">{PERKS[id].name}</div>
                <div className="perk-desc">{PERKS[id].desc}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="worldmap">
      <div className="crt" />

      <div className="wm-title">THE ASH BELT <span>rider's survey map</span></div>

      <svg className="wm-map" viewBox="0 0 100 100" preserveAspectRatio="none">
        {ROADS.map((r) => {
          const A = SETTLEMENTS[r.a], B = SETTLEMENTS[r.b];
          const here = r.a === rpg.location || r.b === rpg.location;
          const active = sel && sel.trackId === r.trackId;
          return (
            <line key={r.trackId}
              x1={A.x} y1={A.y} x2={B.x} y2={B.y}
              className={active ? 'wm-road active' : here ? 'wm-road here' : 'wm-road'}
            />
          );
        })}
        {Object.entries(SETTLEMENTS).map(([id, s]) => {
          const isHere = id === rpg.location;
          const reachable = roads.some((r) => r.dest === id);
          return (
            <g key={id}
              className={isHere ? 'wm-node here' : reachable ? 'wm-node reach' : 'wm-node'}
              onClick={() => {
                const road = roads.find((r) => r.dest === id);
                if (road) setSel(road);
              }}>
              <circle cx={s.x} cy={s.y} r={isHere ? 2.4 : 1.7} />
              <text x={s.x} y={s.y - 3.4}>{s.name}</text>
            </g>
          );
        })}
      </svg>

      <div className="wm-side">
        <div className="wm-panel">
          <div className="wm-h">RIDER</div>
          <div className="wm-row"><span>LEVEL {level}</span>
            <div className="wm-bar"><div style={{ width: `${Math.round(xpFrac * 100)}%` }} /></div>
          </div>
          <div className="wm-row"><span>SCRAP</span><b>{rpg.scrap}</b></div>
          <div className="wm-row"><span>FUEL</span>
            <div className="wm-bar fuel"><div style={{ width: `${Math.round(100 * rpg.fuel / rpg.fuelMax)}%` }} /></div>
            <b>{rpg.fuel}/{rpg.fuelMax}</b>
          </div>
          {rpg.perks.length > 0 && (
            <div className="wm-perks">
              {rpg.perks.map((id) => <span key={id} title={PERKS[id].desc}>{PERKS[id].name}</span>)}
            </div>
          )}
        </div>

        <div className="wm-panel">
          <div className="wm-h">{loc.name} <i>pop. {loc.pop}</i></div>
          <div className="wm-blurb">{loc.blurb}</div>
          {lastLeg && (
            <div className="wm-last">
              Last leg: P{lastLeg.pos} into {lastLeg.dest} · +{lastLeg.scrap} scrap · +{lastLeg.xp} xp
              {lastLeg.contractOk === true && ' · CONTRACT PAID'}
              {lastLeg.contractOk === false && ' · contract failed'}
              {lastLeg.relicWon && (
                <b style={{ color: '#ffd23c' }}> · {lastLeg.relicWon} IS YOURS</b>
              )}
            </div>
          )}
          <div className="wm-actions">
            <button onClick={refuel} disabled={rpg.scrap < 5 || rpg.fuel >= rpg.fuelMax}>
              REFUEL +10 (5 scrap)
            </button>
            <button onClick={work}>WORK THE STILL (+12 scrap)</button>
            <button onClick={() => onVisit(rpg.location)}>WALK THE TOWN</button>
          </div>
        </div>

        <div className="wm-panel">
          <div className="wm-h">CONTRACTS</div>
          {contracts.map((c, i) => (
            <button key={i} className={`wm-contract ${c.relicId ? 'relic' : ''}`}
              disabled={!canRide(c.road)}
              onClick={() => onRide(c.road, c)}>
              <div className="wm-ct">
                {c.relicId && <span className="wm-relic-tag">PAYMENT IN IRON</span>}
                {c.title}
              </div>
              <div className="wm-cd">{c.desc}</div>
              <div className="wm-cg">{c.goal} ·{' '}
                {c.relicId
                  ? <b style={{ color: c.relicColor }}>{c.relicName}</b>
                  : `${c.reward} scrap`}
                {c.relicId ? ` + ${Math.round(c.reward * 0.5)} scrap` : ''}
                {' '}· via {trackName(c.road.trackId)}
                {c.road.reversed ? ' (return leg)' : ''} · {fuelCost(c.road, rpg)} fuel</div>
            </button>
          ))}
        </div>

        {sel && (
          <div className="wm-panel">
            <div className="wm-h">RIDE TO {SETTLEMENTS[sel.dest].name}</div>
            <div className="wm-blurb">
              via {trackName(sel.trackId)}{sel.reversed ? ' — return leg, ridden in reverse' : ''}
              {' '}— {sel.km.toFixed(1)} km · {fuelCost(sel, rpg)} fuel
            </div>
            <div className="wm-actions">
              <button disabled={!canRide(sel)} onClick={() => onRide(sel, null)}>
                {canRide(sel) ? 'RIDE OUT' : 'NOT ENOUGH FUEL'}
              </button>
            </div>
          </div>
        )}

        <button className="wm-exit" onClick={onExit}>BACK TO ARCADE MENU</button>
      </div>
    </div>
  );
}
