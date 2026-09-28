/**
 * Frame-rate consistency test: runs the same race segment through the game's real loop
 * structure (fixed-step accumulator + interpolation + chase camera) at 30/60/120/144/240 FPS
 * with irregular frame times, and reports:
 *  - where the car ends up (physics must not depend on FPS)
 *  - camera jitter: frame-to-frame variation of the camera-to-car distance
 *  - camera lag: average camera-to-car distance
 * Run: npx tsx tools/fps-consistency.ts
 */
import * as THREE from 'three';
import { loadRapier, PhysicsWorld } from '../src/physics/PhysicsWorld';
import { TrackGeometry } from '../src/track/TrackGeometry';
import { Terrain } from '../src/track/Terrain';
import { TrackLayout } from '../src/track/TrackLayout';
import { createTrackColliders } from '../src/physics/TrackColliders';
import { RaceManager } from '../src/game/RaceManager';
import { AIController } from '../src/ai/AIController';
import { ChaseCamera } from '../src/camera/ChaseCamera';
import { getTrack } from '../src/data/tracks';
import { getAIProfile } from '../src/data/aiProfiles';
import { createQuickRace } from '../src/data/races';
import { Random } from '../src/core/math';

const R = await loadRapier();
const track = new TrackGeometry(getTrack('sunset-circuit'));
const terrain = new Terrain(track);
const layout = new TrackLayout(track, terrain);

async function runAt(fps: number, jitter: number) {
  const physics = new PhysicsWorld(R);
  createTrackColliders(physics, track, terrain, layout);
  const rm = new RaceManager(physics, track, layout, createQuickRace({ trackId: 'sunset-circuit', playerCarId: 'falcon-r', laps: 1, opponents: 3 }));
  const player = rm.player!;
  const ctx = (rm.cars.find((c) => c.controller instanceof AIController)!.controller as AIController).ctx;
  player.controller = new AIController(player, { ...getAIProfile('vega'), mistakeRate: 0 }, ctx, 1);
  rm.startCountdown();
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 9000);
  const chase = new ChaseCamera(cam, physics, terrain);
  const rnd = new Random(fps);
  const fixed = physics.fixedDt;
  let acc = 0;
  let t = 0;
  const dists: number[] = [];
  const dDist: number[] = [];
  let prevDist = NaN;
  const _p = new THREE.Vector3();
  // Countdown + 30 s of racing, sampled after the start.
  while (t < 34) {
    const frame = (1 / fps) * (1 + (rnd.next() * 2 - 1) * jitter);
    const dt = Math.min(0.1, frame);
    t += dt;
    acc += dt;
    let steps = 0;
    while (acc >= fixed && steps < 12) {
      rm.step(fixed);
      physics.step();
      rm.postStep(fixed);
      acc -= fixed;
      steps++;
    }
    if (steps === 12) acc = Math.min(acc, fixed);
    const alpha = acc / fixed;
    chase.update(dt, player, alpha);
    if (t > 8) {
      _p.copy(player.prevPosition).lerp(player.physics.position, alpha);
      const d = cam.position.distanceTo(_p);
      dists.push(d);
      if (isFinite(prevDist)) dDist.push(Math.abs(d - prevDist) / dt); // m/s of distance change
      prevDist = d;
    }
  }
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
  const jitterRms = Math.sqrt(dDist.reduce((a, b) => a + b * b, 0) / dDist.length);
  const pos = player.physics.position;
  physics.free();
  return { fps, s: player.progress.proj.s, pos: `${pos.x.toFixed(2)},${pos.z.toFixed(2)}`, mean, jitterRms };
}

for (const fps of [30, 60, 120, 144, 240]) {
  const r = await runAt(fps, 0.25);
  console.log(`${String(fps).padStart(3)} FPS: car s=${r.s.toFixed(1)} pos=(${r.pos})  cam dist avg ${r.mean.toFixed(2)} m  distance jitter ${r.jitterRms.toFixed(2)} m/s`);
}
