import React, { useState } from 'react';
import MainMenu from './ui/MainMenu.jsx';
import RaceScreen from './ui/RaceScreen.jsx';
import Garage from './ui/Garage.jsx';
import HubScreen from './ui/HubScreen.jsx';
import WorldMap from './ui/WorldMap.jsx';
import { loadRpg, applyLegResult, perkMods, SETTLEMENTS } from './game/rpg.js';
import { RACE_POINTS } from './game/career.js';

const TOURNAMENT_TRACKS = ['riviera', 'valley', 'cliffs', 'neo', 'mojave'];

export default function App() {
  const [screen, setScreen] = useState('menu');
  const [bikeId, setBikeId] = useState('gp500');
  const [trackId, setTrackId] = useState('riviera');
  const [tourney, setTourney] = useState(null); // { raceIdx, standings: {name: pts} }
  const [champion, setChampion] = useState(null);
  const [raceMode, setRaceMode] = useState('race'); // 'race' | 'knockout' | 'package'
  // RPG layer: persistent rider + the leg currently being ridden
  const [rpg, setRpg] = useState(loadRpg);
  const [rpgLeg, setRpgLeg] = useState(null); // { road, contract }
  const [lastLeg, setLastLeg] = useState(null);

  const startSingle = () => {
    setTourney(null);
    setRpgLeg(null);
    setRaceMode('race');
    setScreen('race');
  };

  // wasteland travel: the leg IS the stage; delivery contracts ride package mode
  const startLeg = (road, contract) => {
    setTourney(null);
    // capture the origin now — rpg.location moves as soon as the leg is
    // applied, but the banners and remount key must stay stable
    setRpgLeg({ road, contract, from: rpg.location, seq: Date.now() });
    setRaceMode(contract && contract.type === 'delivery' ? 'package' : 'race');
    setScreen('race');
  };

  const finishLeg = (results, earned) => {
    if (!rpgLeg) return;
    const { state, summary } = applyLegResult(rpg, rpgLeg, results, earned);
    setRpg(state);
    setLastLeg(summary);
  };

  const startKnockout = () => {
    setTourney(null);
    setRaceMode('knockout');
    setScreen('race');
  };

  const startPackage = () => {
    setTourney(null);
    setRaceMode('package');
    setScreen('race');
  };

  const startTournament = () => {
    setTourney({ raceIdx: 0, standings: {} });
    setRaceMode('race');
    setScreen('race');
  };

  // called once per finished tournament race with the ordered results
  const handleResults = (results) => {
    setTourney((t) => {
      if (!t) return t;
      const standings = { ...t.standings };
      for (const r of results) {
        standings[r.name] = (standings[r.name] || 0) + (RACE_POINTS[r.pos - 1] || 0);
      }
      return { ...t, standings };
    });
  };

  const nextRace = () => {
    setTourney((t) => {
      const idx = t.raceIdx + 1;
      if (idx >= TOURNAMENT_TRACKS.length) {
        const list = Object.entries(t.standings)
          .sort((a, b) => b[1] - a[1])
          .map(([name, pts]) => ({ name, pts }));
        setChampion(list);
        setScreen('champion');
        return null;
      }
      return { ...t, raceIdx: idx };
    });
  };

  const activeTrack = tourney ? TOURNAMENT_TRACKS[tourney.raceIdx] : trackId;

  if (screen === 'garage') {
    return <Garage bikeId={bikeId} onBack={() => setScreen('menu')} />;
  }

  if (screen === 'hub') {
    return <HubScreen onExit={() => setScreen('menu')} />;
  }

  if (screen === 'world') {
    return (
      <WorldMap
        rpg={rpg}
        setRpg={setRpg}
        lastLeg={lastLeg}
        onRide={startLeg}
        onVisit={() => setScreen('townvisit')}
        onExit={() => { if (rpgLeg) { setRpgLeg(null); setScreen('world'); } else setScreen('menu'); }}
      />
    );
  }

  if (screen === 'townvisit') {
    const s0 = SETTLEMENTS[rpg.location];
    return <HubScreen name={s0.name} subtitle={`pop. ${s0.pop}`} onExit={() => setScreen('world')} />;
  }

  if (screen === 'champion' && champion) {
    return (
      <div className="menu">
        <h1 className="logo">
          CHAMPION<span>SHIP</span>
        </h1>
        <div className="panel results" style={{ marginTop: 24 }}>
          <h2>{champion[0].name === 'YOU' ? 'YOU ARE THE CHAMPION!' : `${champion[0].name} TAKES THE TITLE`}</h2>
          <table>
            <tbody>
              {champion.map((r, i) => (
                <tr key={r.name} className={r.name === 'YOU' ? 'me' : ''}>
                  <td>{i + 1}</td>
                  <td>{r.name}</td>
                  <td>{r.pts} pts</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => { setChampion(null); setScreen('menu'); }}>BACK TO MENU</button>
        </div>
      </div>
    );
  }

  return screen === 'menu' ? (
    <MainMenu
      bikeId={bikeId}
      trackId={trackId}
      onBike={setBikeId}
      onTrack={setTrackId}
      onStart={startSingle}
      onTournament={startTournament}
      onKnockout={startKnockout}
      onPackage={startPackage}
      onGarage={() => setScreen('garage')}
      onHub={() => setScreen('hub')}
      onWorld={() => setScreen('world')}
    />
  ) : (
    <RaceScreen
      key={`${bikeId}-${activeTrack}-${raceMode}-${tourney ? tourney.raceIdx : 'single'}-${rpgLeg ? rpgLeg.seq : 'arc'}`}
      bikeId={bikeId}
      trackId={rpgLeg ? rpgLeg.road.trackId : activeTrack}
      mode={raceMode}
      rpgMods={rpgLeg ? perkMods(rpg.perks) : null}
      reverse={rpgLeg ? !!rpgLeg.road.reversed : false}
      banners={rpgLeg ? {
        start: SETTLEMENTS[rpgLeg.from].name,
        finish: SETTLEMENTS[rpgLeg.road.dest].name,
      } : null}
      hunt={rpgLeg?.contract?.type === 'assassin'
        ? {
          idx: rpgLeg.contract.targetIdx, name: rpgLeg.contract.targetName,
          needPos: rpgLeg.contract.relicId ? 3 : null,
        }
        : null}
      contract={rpgLeg?.contract
        ? {
          type: rpgLeg.contract.type, n: rpgLeg.contract.n,
          pos: rpgLeg.contract.pos, needHits: rpgLeg.contract.needHits,
        }
        : null}
      onFinished={rpgLeg ? finishLeg : null}
      tournament={tourney ? {
        raceIdx: tourney.raceIdx,
        total: TOURNAMENT_TRACKS.length,
        standings: tourney.standings,
        onResults: handleResults,
        onNext: nextRace,
      } : null}
      onExit={() => { setTourney(null); setScreen('menu'); }}
    />
  );
}
