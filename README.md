# MOTOMAD

An arcade motorcycle racing game in the spirit of **Moto Racer** (Delphine
Software / Microids, 1997) — both of its disciplines in one package: superbike
speed on asphalt and motocross hang-time on dirt.

Built with **Three.js** (rendering), **React** (menus/HUD), and a hand-rolled
arcade physics model. No physics engine, no 3D assets — tracks, bikes, and
textures are all generated procedurally at runtime (`textures.js`: gradient
sky domes with clouds or stars+moon, tiled ground noise, tunnel concrete,
race-number liveries, rider leathers, helmet stripes, tyre tread).

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

## Controls

| Key | Action |
| --- | --- |
| ↑ / W | Throttle |
| ↓ / S | Front brake (hold at standstill to reverse-crawl) |
| ← → / A D | Lean |
| Space | Rear brake — powerslide when combined with steering |
| R | Reset to track |
| M | Mute |
| Esc | Pause |
| Right click | Draw / holster the pistol |
| Mouse | Aim (reticle) |
| Left click | Shoot |

**The pistol — and everyone has one.** Right-click pulls a sidearm: the
rider's arm sweeps up from the holster (~0.35 s before you can fire) and
then tracks the mouse reticle. Two hit zones: tag the RIDER and their
steering scrambles behind a red haze; hit the MACHINE and it's just sparks
and a ping. The AI wants the win just as badly, clean or dirty — every rider
periodically draws on whoever is directly ahead (you included), visibly
raises the arm, and fires with distance-based accuracy, paying the same
one-handed cornering penalty you do. Hold SHIFT with the gun out for
**bullet time**: the world slows to a third, the camera whips round, and you
shoot at whoever is lining you up from behind — rationed by a focus meter.
All engines and AI gunfire are positional stereo (WebAudio panners riding
the camera). Hitting an opponent costs them 30% of
their speed and scrambles their steering for ~2 seconds — they wobble,
drift to the outside of the corner, and grind speed off against the barrier.
The price: riding one-handed cuts your maximum lean roughly in half, so you
can't aim and corner hard at the same time. Shots are hitscan with a short
cooldown, muzzle flash, tracer, impact sparks, a red damage flash on the
victim, and a recoil kick on the camera.

## Content

All six tracks are **point-to-point stages** (A → B, 5.7–8.8 km — about
three old laps each), authored with a turtle route builder in `tracks.js`
(straights/arcs in metres, named marks anchor tunnels, bridges and jumps).
Performance on long stages: the camera far plane hugs each track's fog
distance, road/wall geometry is built in ~450 m chunks for per-chunk
frustum culling, and forests/cities/posts are instanced — mid-stage the
whole scene draws in a few hundred calls.

- **Bikes** — `FALCON GP500` (superbike: 280 km/h, needs grip),
  `VIPERA MX250` (motocrosser: slower, agile, barely loses pace on dirt)
  and `CYCLONE 2019` (a low-slung Neo-City prototype: 295 km/h, huge front
  cowl, shrouded wheels, bulbous rear cowl, feet-forward reclined riding
  position, and a turbine-whine engine instead of a firing pulse — born for
  the night highway). Per-track surface modifiers make each bike king of
  its home discipline.
- **Stages** — `RIVIERA GP` (6.6 km asphalt coastal sprint with a cliff
  tunnel — lit, dimmed interior — and a sea bridge over open water), `PINE VALLEY TT`
  (fast flowing valley speedway: gradients under ~2.5%, dense instanced
  pine forest, rising valley walls both sides + close fog so the horizon
  almost never shows, a tunnel and a 12 m viaduct over the valley lake),
  `AZURE CLIFFS` (hilly cliff road on a sea-bound headland: elevation
  swings 2→18 m with grades to ~7% and constant gradient reversals,
  palms and rocks, blue/white seaside walls, a high bridge over a cove and
  a headland tunnel — the land ends just past the barriers and it's ocean
  to the horizon), `NEO-CITY RUN` (an 8.8 km night expressway sprint through
  a neon metropolis: two enormous near-straights each swallowed by a
  500 m+ tunnel, a couple of hard interchange corners, instanced
  lit-window skyscrapers, neon signs and glyph billboards, glowing
  cyan/pink lane delineators), `ISLA VERDE` (a 7.3 km island run —
  cliff coast, jungle canopy, a mountain tunnel, a girder bridge over a
  gorge, and a crest that genuinely launches you: the terrain-following
  physics lets go when the ground drops away faster than gravity) and
  `MOJAVE CROSS` (dirt, whoop rollers, two tabletop jumps, a dry-gulch
  trestle bridge).
- **Taillight streaks** — every bike drags an additive red light trail
  (long and bright at night, subtle by day, flaring under braking). In
  bullet time the streaks hang in the air.
- **Career** — every race pays PTS (position purse + 15/rider hit +
  5/machine hit + 40/tanker + 30/launcher + 120/gunship), banked to
  localStorage. Spend them in the
  GARAGE on six upgrade lines: engine, tyres, brakes, armour, pistol,
  focus (three levels each).
- **Tournament** — a five-race championship across every circuit with
  15-12-10-… points, standings between races and a champion screen.
- **Package Run** — capture the package: a glowing crate (with a sky
  beam) waits 500 m up the road. First rider to touch it carries it. A
  stunned carrier KEEPS it clutched — but while they're scrambled, any
  rider within ~3 m can snatch it out of their hands (so the play is:
  shoot the carrier, then close in for the steal). Every AI prioritises
  shooting whoever holds it. Deliver it across the finish to win. The HUD
  tracks the carrier and the minimap marks the crate.
- **Settings** — difficulty dials (main menu): missile fire rate and
  opponent gunfire, each OFF / LOW / NORMAL / HIGH, saved to localStorage.
- **Knockout** — elimination race on the selected track: every 15 seconds
  the last-placed rider is out (they pull over, park and put a foot down).
  Survive all twelve cuts to win — or simply reach B before the axe
  reaches you.
- **Fuel tankers** — cisterns roll down every stage as moving hazards
  (respawning ahead of you as the race strings out).
  Three pistol hits and they explode: riders within 6 m crash, within 14 m
  get blast-stunned; the charred wreck stays as an obstacle before
  respawning up the road. Ram one and you're down. Worth 40 PTS if you
  time it as your rivals pass.
- **Rocket launchers** — twin-tube turrets on ~5 m lattice towers behind
  the barriers every ~750 m (never in tunnels or on bridges), each with a
  blinking red beacon so you spot them hundreds of metres out. They only
  fire from LONG range (100–250 m — inside that they hold fire), so every
  rocket spends 3+ seconds in the air. They shoot in BURSTS: three rockets
  0.3 s apart, then a 3 s pause. Each rocket launches at your lead-aimed
  intercept point at ~113 km/h behind a "ROCKET! TURN!" warning, then
  LAZILY homes on the nearest bike (0.6 rad/s — a ~52 m turning circle,
  and it never loops back once it overshoots), so a committed swerve
  still beats it; the blast is tight (crash inside 1.4 m, blast-stun
  inside 3 m — a dodged rocket is a dodged rocket, though one landing in
  the pack still stings the AI). The oversized
  turret head is the target: the pistol reaches it out to 320 m — well
  before the tower can shoot back — and two hits destroy it for the rest
  of the stage (30 PTS), leaving the wreck burning on its tower.
- **Gunships** — two attack helicopters hunt each race from the air,
  rubber-banding up to ~260 km/h and holding station AHEAD of you at
  their own firing distance (60 and 95 m up the road), strafing across
  the lanes and lobbing THE SAME slow rockets as the launcher towers back
  at the oncoming pack from a 45–130 m band (inside 45 m the turret
  tracks but holds fire — every rocket gets 1.4+ s of flight, so you can
  always swerve on the warning). The play: stay under
  one and put TWELVE rounds into it — the HUD counts its armour down — and
  it plummets out of the sky, detonating on impact for the biggest blast
  in the game and a 120 PTS bounty. Clear the wreckage before the
  explosion, and mind the one that hunts you from behind (bullet time).
  Tunnels and bridges are anchored to named route marks in `tracks.js`
  (resolved to fractions of the stage); the builder generates the shells, portals, ceiling lights,
  parapets, girders, piers and water, and the barrier corridor physically
  narrows through them.
- 12 AI opponents with corner-speed lookahead, paced off a simulated ideal
  run: at race start the game runs the AI model at full commitment to find
  the theoretical best stage time, then assigns each grid slot a target
  from ~2% off ideal (the leader) to ~21% off (backmarkers). You start last —
  the first passes come easy, the podium doesn't. Stage clock, minimap,
  synthesized engine audio.

## The physics model (`src/game/physics.js`)

The bike is a point with a scalar speed, a heading, and a **slip angle**
between the two. The interesting parts:

- **Lean-based steering.** Input sets a target lean angle (authority grows
  with speed); yaw rate falls out of real coordinated-turn dynamics,
  `yaw = g·tan(lean) / v`, blended with kinematic steering below ~30 km/h.
  Usable lean is capped near the grip limit of the current surface, so on
  asphalt full lock means cornering AT the limit (~2° slip — planted), while
  dirt's cap sits above its grip and the rear naturally works loose.
- **Traction circle.** Tyres supply at most `grip · g` of lateral
  acceleration. Demand more and the surplus becomes understeer, a growing
  slip angle (a couple of degrees on asphalt, a drift on dirt), and speed
  scrub.
- **Powerslides.** Rear brake + steering over-rotates the bike and forces
  ~19° of slip — the only way to get a big slide on asphalt, and it snaps
  straight within half a second of release.
- **Physically derived visual lean.** The rendered roll is
  `atan(v·yaw_actual / g)` — the angle that balances the real cornering
  force — so understeer visibly stands the bike up and dirt oversteer lays
  it into the drift.
- **Rider body language** (`Game.posePlayerRider` + `solveLegIK`). On
  asphalt the rider hangs off the inside of the corner and tucks on
  straights; on dirt he counter-leans with the inside leg out and stands
  on the pegs over whoops. The legs are solved with two-bone IK: feet are
  PINNED to the footpegs, the knee lands wherever thigh+shin can reach —
  aimed outward by a pole vector for knee-down, backing off automatically
  if the knee would touch the road. Standing, hang-off and knee-down all
  articulate correctly from the constraint, and nothing can clip the road.
- **Wheelies & stoppies.** Hard launch at low speed lifts the front (and
  dulls the steering); hard braking dips the nose.
- **Jumps.** Grounded, the bike's vertical velocity follows the terrain
  slope; when the ground falls away faster than gravity pulls (whoop or
  tabletop crest), it simply becomes airborne — no special "jump" code.
  Hard landings scrub speed; brutal ones crash.
- **Surfaces.** On-road vs off-road grip/top-speed/drag per track, plus
  per-bike-type modifiers (slicks suffer on dirt, knobbies on tarmac).
- **Barriers.** Shallow contact glances off with a speed penalty; a hard
  grounded hit is a crash and a 1.7 s respawn. Mid-air clips are glances.

Track geometry (`src/game/track.js`) is an open A→B Catmull-Rom spline sampled
every ~3 m into a lookup table shared by physics, AI, rendering, and the
minimap. Elevation is spline height + procedural whoops/tabletops, sampled
continuously (interpolated — the physics divides height deltas by dt, so
stair-stepped heights would explode).

## Structure

```
src/
  App.jsx            screen flow (menu ⇄ race)
  ui/                MainMenu, RaceScreen, HUD (React, polls game state per frame)
  game/
    Game.js          orchestrator: loop, camera, stage progress, standings, HUD state
    physics.js       the arcade bike model (see above)
    track.js         spline sampling, queries, procedural track/scenery meshes
    ai.js            kinematic opponents with curvature lookahead + rubber band
    bikes.js/tracks.js  bikes as data / turtle-built A→B routes as data
    bikeMesh.js      procedural bikes (sport/cross variants) + articulated rider + pistol
    input.js         keyboard → analog-ish inputs
    audio.js         WebAudio engine/slide/beep synth
```

Adding a stage is another entry in `tracks.js` — a turtle route (straights,
arcs, marks), width, colors, surface params, and features hung off marks.
