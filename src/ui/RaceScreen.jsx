import React, { useEffect, useRef, useState } from 'react';
import { Game } from '../game/Game.js';
import HUD from './HUD.jsx';
import TouchControls, { isTouchDevice } from './TouchControls.jsx';

export default function RaceScreen({ bikeId, trackId, mode = 'race', tournament, rpgMods, reverse = false, banners = null, hunt = null, contract = null, onFinished, onExit }) {
  const mountRef = useRef(null);
  const gameRef = useRef(null);
  const reportedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);

  // report tournament results exactly once when the race ends
  useEffect(() => {
    if (!tournament) return;
    const iv = setInterval(() => {
      const g = gameRef.current;
      if (g && g.hud.finished && g.hud.results && !reportedRef.current) {
        reportedRef.current = true;
        tournament.onResults(g.hud.results);
      }
    }, 400);
    return () => clearInterval(iv);
  }, [tournament]);

  // RPG legs: report the final standings + earnings exactly once
  const rpgReportedRef = useRef(false);
  useEffect(() => {
    if (!onFinished) return;
    const iv = setInterval(() => {
      const g = gameRef.current;
      if (g && g.hud.finished && g.hud.results && !rpgReportedRef.current) {
        rpgReportedRef.current = true;
        onFinished(g.hud.results, g.hud.earned);
      }
    }, 400);
    return () => clearInterval(iv);
  }, [onFinished]);

  useEffect(() => {
    const game = new Game(mountRef.current, { bikeId, trackId, mode, rpgMods, reverse, banners, hunt, contract });
    gameRef.current = game;
    window.__game = game; // debugging handle
    setReady(true);
    return () => {
      game.dispose();
      gameRef.current = null;
      if (window.__game === game) window.__game = null;
    };
  }, [bikeId, trackId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && gameRef.current && !gameRef.current.hud.finished) {
        setPaused((p) => {
          gameRef.current.paused = !p;
          return !p;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const resume = () => {
    gameRef.current.paused = false;
    setPaused(false);
  };
  const restart = () => {
    gameRef.current.restart();
    setPaused(false);
  };

  return (
    <div className={`race-screen${isTouchDevice() ? ' touch' : ''}`}>
      <div className="canvas-mount" ref={mountRef} />
      {ready && <HUD gameRef={gameRef} onRestart={restart} onExit={onExit} tournament={tournament} />}
      {ready && isTouchDevice() && <TouchControls gameRef={gameRef} />}
      {paused && (
        <div className="overlay">
          <div className="panel">
            <h2>PAUSED</h2>
            <button onClick={resume}>RESUME</button>
            <button onClick={restart}>RESTART RACE</button>
            <button onClick={onExit}>QUIT TO MENU</button>
          </div>
        </div>
      )}
    </div>
  );
}
