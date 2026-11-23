import React, { useEffect, useRef, useState } from 'react';
import { formatTime } from '../game/Game.js';

// The HUD polls the game's mutable hud object once per animation frame.
export default function HUD({ gameRef, onRestart, onExit, tournament }) {
  const [hud, setHud] = useState(null);
  const [mini, setMini] = useState(null);

  useEffect(() => {
    let raf;
    const tick = () => {
      const g = gameRef.current;
      if (g) {
        setHud({ ...g.hud, lapTimes: [...g.hud.lapTimes] });
        setMini({
          path: g.miniPath,
          player: g.miniTransform(g.hud.mini.player),
          ais: g.hud.mini.ais.map(g.miniTransform),
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gameRef]);

  if (!hud) return null;

  return (
    <div className="hud">
      {/* top-left: position + distance to the finish */}
      <div className="hud-topleft">
        <div className="hud-pos">
          P<span>{hud.position}</span>/{hud.racers}
        </div>
        <div className="hud-lap">
          {(hud.remainKm ?? 0).toFixed(1)} KM TO GO
        </div>
      </div>

      {/* top-right: stage clock */}
      <div className="hud-topright">
        <div className="hud-time">{formatTime(hud.mode === 'countdown' ? 0 : hud.time)}</div>
        <div className="hud-subtime">
          STAGE {(hud.totalKm ?? 0).toFixed(1)} KM
        </div>
      </div>

      {/* bottom-left: speedo */}
      <div className="hud-speedo">
        {(hud.draft ?? 0) > 0.4 && (
          <div style={{
            color: '#7fe0ff', fontSize: 13, letterSpacing: 2, fontWeight: 700,
            textShadow: '0 0 8px rgba(90,200,255,0.8)',
            opacity: 0.5 + hud.draft * 0.5,
          }}>
            ⇢ SLIPSTREAM
          </div>
        )}
        <div className="hud-speed">{hud.speedKmh}</div>
        <div className="hud-kmh">km/h</div>
        <div className="stat-bars">
          <div className="sbar">
            <span>LIFE</span>
            <div className="sbar-track">
              <div className="sbar-fill life"
                style={{ width: `${Math.round(100 * (hud.hp ?? 0) / (hud.hpMax || 1))}%` }}
              />
            </div>
          </div>
          <div className="sbar">
            <span>ARM</span>
            <div className="sbar-track">
              <div
                className={`sbar-fill arm ${(hud.armor ?? 1) <= 0 ? 'down' : ''}`}
                style={{ width: `${Math.round(100 * (hud.armor ?? 0) / (hud.armorMax || 1))}%` }}
              />
            </div>
          </div>
          <div className="sbar">
            <span>CHG</span>
            <div className="sbar-track">
              <div className="sbar-fill chg"
                style={{ width: `${Math.round(100 * (hud.ammo ?? 0) / (hud.ammoMax || 1))}%` }}
              />
            </div>
          </div>
        </div>
        <div className="hud-gear">
          <div className="rpm-track">
            <div className="rpm-fill" style={{ width: `${Math.round(hud.rpm * 100)}%` }} />
          </div>
          GEAR {hud.gear}
        </div>
      </div>

      {/* bottom-right: minimap */}
      {mini && (
        <svg className="hud-minimap" viewBox="-4 -4 108 108">
          <path
            d={mini.path.map(([x, z], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${z.toFixed(1)}`).join(' ')}
            fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="4" strokeLinejoin="round"
          />
          {mini.ais.map(([x, z], i) => (
            <circle key={i} cx={x} cy={z} r="2.1" fill={hud.aiColors?.[i] || '#8888aa'} />
          ))}
          {hud.hunt && !hud.hunt.down && !hud.hunt.failed && mini.ais[hud.hunt.idx] && (
            <circle
              cx={mini.ais[hud.hunt.idx][0]} cy={mini.ais[hud.hunt.idx][1]}
              r="4" fill="none" stroke="#ff4030" strokeWidth="1.3">
              <animate attributeName="r" values="3;5;3" dur="1.2s" repeatCount="indefinite" />
            </circle>
          )}
          {hud.package && hud.mini.pkg && (() => {
            const [px, pz] = window.__game ? window.__game.miniTransform(hud.mini.pkg) : [0, 0];
            return <rect x={px - 2.6} y={pz - 2.6} width="5.2" height="5.2"
              fill="#ffb020" stroke="#000" strokeWidth="0.7"
              transform={`rotate(45 ${px} ${pz})`} />;
          })()}
          <circle cx={mini.player[0]} cy={mini.player[1]} r="3.4" fill="#ffd23c" stroke="#000" strokeWidth="0.8" />
        </svg>
      )}

      {/* you've been shot: red vignette while the steering is scrambled */}
      {hud.stunT > 0 && (
        <div className="stun-vignette" style={{ opacity: Math.min(1, hud.stunT * 1.2) }} />
      )}

      {/* bullet time: cool tint + rear-view label */}
      {hud.bt && (
        <>
          <div className="bt-vignette" />
          <div className="bt-label">◀ REAR VIEW — BULLET TIME</div>
        </>
      )}

      {/* pistol reticle */}
      {hud.gunOut && (
        <>
          <div
            className={`reticle ${hud.hitT > 0 ? 'hit' : ''}`}
            style={{ left: hud.mouseX, top: hud.mouseY }}
          />
          {/* readiness ring: fills toward the next shot; amber = generator
              still charging, green = ready to fire */}
          <svg className="reticle-ring" width="52" height="52"
            style={{ left: hud.mouseX, top: hud.mouseY }} viewBox="0 0 52 52">
            <circle cx="26" cy="26" r="20" fill="none"
              stroke="rgba(255,255,255,0.15)" strokeWidth="3" />
            <circle cx="26" cy="26" r="20" fill="none"
              stroke={(hud.shotFrac ?? 1) >= 1 ? 'rgba(140,255,150,0.85)'
                : hud.chargeGated ? '#e8b23c' : 'rgba(220,220,220,0.7)'}
              strokeWidth="3" strokeLinecap="round"
              strokeDasharray={`${(hud.shotFrac ?? 1) * 125.7} 125.7`}
              transform="rotate(-90 26 26)" />
          </svg>
          {hud.targetInfo && (
            <div className="target-chip" style={{ left: hud.mouseX, top: hud.mouseY + 30 }}>
              <div className="tc-name"
                style={hud.hunt && hud.targetInfo.name === hud.hunt.name
                  ? { color: '#ff5040' } : undefined}>
                {hud.hunt && hud.targetInfo.name === hud.hunt.name ? '☠ ' : ''}
                {hud.targetInfo.name}
              </div>
              <div className="tc-bar">
                <div className="tc-fill arm"
                  style={{ width: `${Math.round(100 * hud.targetInfo.armor / hud.targetInfo.armorMax)}%` }} />
              </div>
              <div className="tc-bar">
                <div className="tc-fill hp"
                  style={{ width: `${Math.round(100 * hud.targetInfo.hp / hud.targetInfo.hpMax)}%` }} />
              </div>
            </div>
          )}
          {hud.gunshipInfo && (
            <div className="truck-hp" style={{ left: hud.mouseX, top: hud.mouseY + 26 }}>
              GUNSHIP {hud.gunshipInfo.hp}/{hud.gunshipInfo.max}
            </div>
          )}
          {hud.launcherInfo && !hud.gunshipInfo && (
            <div className="truck-hp" style={{ left: hud.mouseX, top: hud.mouseY + 26 }}>
              LAUNCHER {hud.launcherInfo.hp}/{hud.launcherInfo.max}
            </div>
          )}
          <div className="gun-hint">
            <b style={{ color: '#ffd23c', letterSpacing: 1 }}>{hud.weaponName}</b>
            {' — '}HOLD TO FIRE · 1-5 SWAP GUN
            <div className="focus-track">
              <div className="focus-fill" style={{ width: `${Math.round((hud.btMeter ?? 1) * 100)}%` }} />
            </div>
            <span className="focus-label">SHIFT — BULLET TIME</span>
          </div>
        </>
      )}

      {/* capture the package: who holds it, where it is */}
      {hud.package && hud.mode === 'race' && (
        <div className={`ko-banner ${hud.package.carrier === 'YOU' ? '' : 'urgent'}`}>
          {hud.package.carrier === null
            ? `📦 PACKAGE AHEAD — ${hud.package.distM} m`
            : hud.package.carrier === 'YOU'
              ? '📦 YOU HAVE THE PACKAGE — DELIVER IT!'
              : `📦 ${hud.package.carrier} HAS THE PACKAGE — STUN THEM!`}
        </div>
      )}

      {/* counter contracts: towers, birds, escort position — live progress.
          'hits' is half a relic delivery: green only once the win is also in
          hand, and it drops a row when the package banner holds the top slot */}
      {hud.objective && hud.mode === 'race' && (
        <div className={`ko-banner ${hud.package ? 'ko-second' : ''} ${
          hud.objective.done && !(hud.objective.kind === 'hits' && hud.position !== 1)
            ? '' : 'urgent'}`}>
          {hud.objective.kind === 'milkrun'
            ? `CONTRACT: ${hud.objective.label} — NOW P${hud.objective.have}`
            : hud.objective.kind === 'hits' && hud.objective.done
              ? `BLOOD PAID ${hud.objective.need}/${hud.objective.need} — ${
                hud.position === 1 ? 'BRING IT HOME' : 'NOW WIN THE RUN'}`
              : hud.objective.done
                ? `CONTRACT FILLED — ${hud.objective.label} ${hud.objective.need}/${hud.objective.need}`
                : `CONTRACT: ${hud.objective.label} ${hud.objective.have}/${hud.objective.need}`}
        </div>
      )}

      {/* assassination contract: the mark, and how it went. Relic jobs keep
          the banner amber after the kill until the top-3 clause is safe */}
      {hud.hunt && hud.mode === 'race' && (
        <div className={`ko-banner ${
          hud.hunt.down && !(hud.hunt.needPos && hud.position > hud.hunt.needPos)
            ? '' : 'urgent'}`}>
          {hud.hunt.down
            ? hud.hunt.needPos
              ? `${hud.hunt.name} IS DOWN — ${hud.position <= hud.hunt.needPos
                ? `HOLD TOP ${hud.hunt.needPos}` : `FINISH TOP ${hud.hunt.needPos} (NOW P${hud.position})`}`
              : `CONTRACT FILLED — ${hud.hunt.name} IS DOWN`
            : hud.hunt.failed
              ? `CONTRACT FAILED — ${hud.hunt.name} FINISHED`
              : `☠ ELIMINATE ${hud.hunt.name}${hud.hunt.dist != null
                ? ` — ${Math.abs(hud.hunt.dist)} m ${hud.hunt.dist >= 0 ? 'AHEAD' : 'BEHIND'}`
                : ''}`}
        </div>
      )}

      {/* knockout: the clock everyone is racing against */}
      {hud.knockout && hud.mode === 'race' && (
        <div className={`ko-banner ${hud.knockout.nextIn <= 5 ? 'urgent' : ''}`}>
          ELIMINATION IN {hud.knockout.nextIn}s — {hud.knockout.remaining} RIDERS
        </div>
      )}

      {/* centre messages */}
      {hud.mode === 'countdown' && (
        <div className="hud-center hud-countdown">{hud.countdown}</div>
      )}
      {hud.mode === 'race' && hud.time < 1 && <div className="hud-center hud-go">GO!</div>}
      {hud.message && hud.mode !== 'finished' && (
        <div className="hud-center hud-flash">{hud.message}</div>
      )}

      {/* results */}
      {hud.finished && hud.results && (
        <div className="overlay">
          <div className="panel results">
            <h2>{hud.results.find((r) => r.isPlayer)?.pos === 1 ? 'VICTORY!' : 'RACE OVER'}</h2>
            <table>
              <tbody>
                {hud.results.map((r) => (
                  <tr key={r.name} className={r.isPlayer ? 'me' : ''}>
                    <td>{r.pos}</td>
                    <td>{r.name}</td>
                    <td>{r.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hud.lapTimes.length > 0 && (
              <div className="lap-times">
                {hud.lapTimes.map((t, i) => (
                  <div key={i}>
                    LAP {i + 1} — {formatTime(t)}
                    {hud.bestLap === t ? ' ★' : ''}
                  </div>
                ))}
              </div>
            )}
            {hud.earned && (() => {
              const e = hud.earned;
              const rows = [
                ['STAGE PURSE', null, null, e.purse],
                ['RIDER HITS', e.hits, 15, e.hits * 15],
                ['BIKE HITS', e.bikeHits, 5, e.bikeHits * 5],
                ['TANKERS', e.tankers, 40, e.tankers * 40],
                ['GUNSHIPS', e.gunships, 120, e.gunships * 120],
                ['LAUNCHERS', e.launchers, 30, e.launchers * 30],
                ['BARRELS', e.barrels, 8, (e.barrels || 0) * 8],
                ['RIDERS DOWNED', e.kills, 60, (e.kills || 0) * 60],
                ['ROCKETS INTERCEPTED', e.intercepts, 12, (e.intercepts || 0) * 12],
                ['DRONES DOWNED', e.drones, 45, (e.drones || 0) * 45],
              ].filter(([, n]) => n === null || n > 0);
              return (
                <div className="earned">
                  <table className="payout">
                    <tbody>
                      {rows.map(([label, n, rate, sum]) => (
                        <tr key={label}>
                          <td>{label}</td>
                          <td className="calc">{n !== null ? `${n} × ${rate}` : ''}</td>
                          <td className="sum">{sum}</td>
                        </tr>
                      ))}
                      <tr className="total">
                        <td>TOTAL</td>
                        <td className="calc" />
                        <td className="sum">+{e.total}</td>
                      </tr>
                      <tr className="bank">
                        <td>BANK</td>
                        <td className="calc" />
                        <td className="sum">{e.balance} PTS</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })()}
            {tournament && (
              <div className="standings">
                <div className="standings-title">
                  CHAMPIONSHIP — RACE {tournament.raceIdx + 1}/{tournament.total}
                </div>
                {Object.entries(tournament.standings)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(([name, pts], i) => (
                    <div key={name} className={name === 'YOU' ? 'me' : ''}>
                      {i + 1}. {name} — {pts}
                    </div>
                  ))}
              </div>
            )}
            {tournament ? (
              <button onClick={tournament.onNext}>
                {tournament.raceIdx + 1 >= tournament.total ? 'FINAL STANDINGS' : 'NEXT RACE'}
              </button>
            ) : (
              <button onClick={onRestart}>RACE AGAIN</button>
            )}
            <button onClick={onExit}>BACK TO MENU</button>
          </div>
        </div>
      )}
    </div>
  );
}
