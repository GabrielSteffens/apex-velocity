/**
 * Headless race simulation: runs a complete race with real physics and AI, no rendering.
 * Validates that cars can lap the track, checkpoints/laps/positions work, and nothing flips
 * or gets stuck forever. Run with `npm run sim`.
 */
import { loadRapier, PhysicsWorld } from '../src/physics/PhysicsWorld';
import { TrackGeometry } from '../src/track/TrackGeometry';
import { Terrain } from '../src/track/Terrain';
import { TrackLayout } from '../src/track/TrackLayout';
import { createTrackColliders } from '../src/physics/TrackColliders';
import { RaceManager } from '../src/game/RaceManager';
import { AIController } from '../src/ai/AIController';
import { getTrack } from '../src/data/tracks';
import { getAIProfile } from '../src/data/aiProfiles';
import { createQuickRace } from '../src/data/races';

const laps = Number(process.argv[2] ?? 3);
const opponents = Number(process.argv[3] ?? 5);
const R = await loadRapier();
const physics = new PhysicsWorld(R);
const track = new TrackGeometry(getTrack('sunset-circuit'));
const terrain = new Terrain(track);
const layout = new TrackLayout(track, terrain);
const colliders = createTrackColliders(physics, track, terrain, layout);
const race = createQuickRace({ trackId: 'sunset-circuit', playerCarId: 'falcon-r', laps, opponents });
const rm = new RaceManager(physics, track, layout, race);
// Autopilot for the "player" in the headless test.
const player = rm.player!;
player.controller = new AIController(player, getAIProfile('silva'), (rm.cars.find(c => c.controller instanceof AIController)!.controller as AIController).ctx, 99);

let carHits = 0, wallHits = 0;
const wallLog = new Map<string, number>();
const carColliders = new Map(rm.cars.map(c => [c.physics.collider.handle, c]));
physics.onContactForce((e) => {
  const a = carColliders.get(e.colliderA), b = carColliders.get(e.colliderB);
  if (a && b) carHits++;
  else if (colliders.barrierHandles.has(e.colliderA) || colliders.barrierHandles.has(e.colliderB)) {
    wallHits++;
    const c = a ?? b!;
    const key = `${c.name}@s${Math.round(c.progress.proj.s / 20) * 20}`;
    wallLog.set(key, (wallLog.get(key) ?? 0) + 1);
  }
});
const resets = new Map<string, number>();
let complete = false;
rm.events = {
  countdown: (v) => console.log('countdown', v),
  go: () => console.log('GO!'),
  lap: (car, t, best) => console.log(`[${rm.raceTime.toFixed(1)}] ${car.name.padEnd(13)} lap ${car.progress.lapsCompleted} ${t.toFixed(2)}s ${best ? '(best)' : ''} pos ${car.position}`),
  finalLap: (car) => car.isPlayer && console.log('FINAL LAP (player)'),
  finish: (car, pos) => console.log(`[${rm.raceTime.toFixed(1)}] FINISH ${car.name} P${pos} laps=${car.progress.lapTimes.map(x => x.toFixed(1)).join(',')}`),
  complete: () => { complete = true; },
  reset: (car) => { resets.set(car.name, (resets.get(car.name) ?? 0) + 1); console.log(`[${rm.raceTime.toFixed(1)}] reset ${car.name} s=${car.progress.proj.s.toFixed(0)}`); },
};
rm.startCountdown();
const dt = physics.fixedDt;
const wall0 = performance.now();
let steps = 0, maxUpsideDown = 0, lastReport = 0;
const posChanges: string[] = [];
let prevOrder = rm.standings.map(c => c.name).join(',');
while (!complete && rm.raceTime < 60 * laps + 120) {
  rm.step(dt); physics.step(); rm.postStep(dt); steps++;
  for (const c of rm.cars) {
    maxUpsideDown = Math.max(maxUpsideDown, c.physics.upsideDownTime);
    if (process.env.DEBUG_SLOW && rm.raceTime > 6 && c.physics.speed < 5 && steps % 60 === 0)
      console.log(`  slow: ${c.name} t=${rm.raceTime.toFixed(1)} s=${c.progress.proj.s.toFixed(0)} lat=${c.progress.proj.lateral.toFixed(1)} v=${c.physics.forwardSpeed.toFixed(1)} upY=${c.physics.up.y.toFixed(2)} thr=${c.physics.input.throttle.toFixed(2)} br=${c.physics.input.brake.toFixed(2)} st=${c.physics.input.steer.toFixed(2)} wrong=${c.progress.wrongWay}`);
  }
  const order = rm.standings.map(c => c.name).join(',');
  if (order !== prevOrder && rm.phase !== 'countdown') { posChanges.push(`${rm.raceTime.toFixed(1)}`); prevOrder = order; }
  if (rm.raceTime - lastReport > 20) { lastReport = rm.raceTime;
    console.log(`  t=${rm.raceTime.toFixed(0)} standings: ` + rm.standings.map(c => `${c.position}.${c.name}(L${c.progress.lapsCompleted} cp${c.progress.nextCheckpoint} ${(c.physics.speed*3.6).toFixed(0)}kmh off${c.progress.proj.lateral.toFixed(1)})`).join(' '));
  }
}
const wall = performance.now() - wall0;
console.log(`\nsimulated ${(steps * dt).toFixed(1)}s in ${(wall / 1000).toFixed(2)}s (${(wall / steps).toFixed(3)} ms/step for ${rm.cars.length} cars)`);
console.log('complete:', complete, 'car-car contacts:', carHits, 'wall contacts:', wallHits, 'maxUpsideDown:', maxUpsideDown.toFixed(2), 'position changes:', posChanges.length);
console.log('wall hits by car@s:', [...wallLog.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([k,v])=>`${k}:${v}`).join(' '));
console.log('resets:', Object.fromEntries(resets));
console.log('final:', rm.standings.map(c => `${c.position}.${c.name} ${c.progress.finished ? c.progress.finishTime.toFixed(1) : 'DNF'} best=${c.progress.bestLapTime.toFixed(2)}`).join(' | '));
