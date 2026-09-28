# Apex Velocity

A browser-based 3D arcade circuit racer built with **TypeScript, Three.js, Rapier (WASM physics) and Vite**.
No backend and no binary assets: every texture, model and sound is generated procedurally at load time.

## Run

```bash
npm install
npm run dev        # open http://localhost:5173
```

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm run build` | Type-check + production build into `dist/` |
| `npm run typecheck` | Type-check game and tools |
| `npm run sim` | Headless full race (real physics + AI, no rendering): `npm run sim -- <laps> <opponents>` |
| `npm run track-check` | Prints track length, corner radii and minimum section separation |
| `npm run skidpad` | Steady-state cornering / drift test for tuning car physics |

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Accelerate | W / ↑ | RT |
| Brake / reverse | S / ↓ | LT |
| Steer | A D / ← → | Left stick |
| Handbrake | Space | X / LB |
| Reset car to track | R | Y |
| Change camera (chase / far / hood) | C | RB |
| Pause | Esc / P | Start |
| Menu navigation | ↑ ↓ Enter | D-pad, A, B |

## Architecture

```
src/
  main.ts                 entry point
  core/                   Input (keyboard+gamepad), Settings (localStorage), math/noise/RNG
  data/                   DATA-DRIVEN DEFINITIONS
    types.ts              CarDefinition, TrackDefinition, AIProfile, RaceDefinition, TournamentDefinition
    cars.ts tracks.ts aiProfiles.ts tournaments.ts races.ts
  game/
    Game.ts               renderer, fixed-timestep loop (120 Hz physics + interpolation), screens
    GameState.ts          MENU / COUNTDOWN / RACING / PAUSED / FINISHED state machine
    TrackScene.ts         loads a TrackDefinition: geometry, terrain, colliders, visuals
    RaceSession.ts        one race: wires race events to visuals, particles, audio, camera, UI
    RaceManager.ts        race rules: grid, countdown, standings, finish, auto-recovery (render-free)
    RaceProgress.ts       per-car ordered checkpoints, laps, lap times, wrong-way detection
  car/
    CarPhysics.ts         raycast-suspension vehicle on a Rapier rigid body
    Car.ts                participant = physics + controller + progress (+ visual)
    CarController.ts      controller interface; PlayerController.ts maps input
    CarModel.ts           procedural car model; CarVisual.ts animates it
  ai/
    RacingLine.ts         minimum-curvature racing line + braking-aware speed profile
    AIController.ts       pure-pursuit driver: overtaking, avoidance, mistakes, recovery
  track/
    TrackGeometry.ts      spline sampling + spatial queries (projection, distance)
    Terrain.ts            heightfield blended into the road corridor
    TrackLayout.ts        barriers (armco / concrete / tyre walls), curbs, grid slots
    TrackMeshData.ts      ribbon sweeps shared by visuals and colliders
    TrackBuilder.ts       road, markings, curbs, barriers, terrain meshes
    TrackScenery.ts       trees, rocks, pit building, grandstand, gantry, bridge, signs
  physics/                Rapier world wrapper, collision groups, surfaces, track colliders
  camera/ChaseCamera.ts   lagged chase cam, speed FOV, shake, anti-clipping
  render/                 Renderer (post FX), Environment (sky/sun/fog/IBL), procedural textures, mesh merging
  effects/                pooled particles (smoke, dust, sparks, exhaust), skid marks
  audio/AudioManager.ts   synthesized engine, tyres, wind, impacts, UI sounds
  ui/                     main menu, HUD (tacho, minimap, standings), pause, settings, results
tools/                    headless simulation and tuning scripts
```

Key design points:

- **Simulation is independent of rendering.** `RaceManager`, `CarPhysics`, `AIController` and the track
  math run headlessly (see `tools/sim-test.ts`), which is how AI and physics were tuned and regression-tested.
- **Collisions are real physics.** Cars are Rapier rigid bodies; barriers, road, curbs and terrain are
  colliders. Contact-force events drive sparks, camera shake and impact sounds.
- **Positions** are ranked by laps completed → validated checkpoint progress → distance along the lap.
  A lap only counts if every sector checkpoint was passed in order; reversing over the line undoes it.
- **Performance:** fixed 120 Hz physics with interpolation, instanced + chunked vegetation, props merged
  into one draw call per material, pooled particles, texel-snapped shadow frustum following the player,
  quality presets (Low / Medium / High) in Settings, FPS/draw-call overlay in Settings.

## What is implemented

- Sunset Circuit (2.46 km): long pit straight, esses, crest, chicane, hairpin, elevation changes,
  curbs, runoff, barriers, grid, start/finish gantry with countdown lights, grandstand, pits, signs.
- Falcon R with working suspension, speed-sensitive smoothed steering (front wheels visibly steer),
  automatic gearbox, braking, reverse, handbrake drifting, slipstream, grass/curb surfaces, air control.
- 5 AI opponents (1–7 configurable) with individual skill, aggression, consistency and mistake rates.
- 3-2-1-GO countdown, laps, lap/best times, live standings, mini-map, tachometer, wrong-way warning,
  finish, results table, restart, pause, settings (graphics, difficulty, laps, opponents, volume…).
- Procedural audio, tyre smoke, dust, sparks, exhaust pops, skid marks, ambient motes, bloom, speed blur.

## Next steps: more cars, tracks and tournaments

1. **Cars** – add entries to `data/cars.ts` (physics numbers + style). `CarModel.ts` already reads
   dimensions, colours and spoiler type; add more style variants or load glTF models behind the same
   `buildCarModel` signature. Build the Garage screen on top of `cars` + `stats`.
2. **Tracks** – add a `TrackDefinition` in `data/tracks.ts` (control points, width, environment, scenery
   counts); `npm run track-check` validates corner radii and section separation. Track Select just
   disposes the current `TrackScene` and creates another (`Game.trackId`).
3. **Tournaments** – `data/tournaments.ts` already defines events and points tables. Add a
   `TournamentManager` that iterates `events`, creates each race with `createQuickRace`, accumulates
   points from `RaceManager.finishOrder`, and shows standings between rounds.
4. Further ideas: ghost/replay (record `CarInput` per step — the controller interface makes this easy),
   per-car AI setups, weather/time-of-day presets through `TrackDefinition.environment`, split-time sectors
   (checkpoints already exist), and recorded audio samples layered into `AudioManager`.
