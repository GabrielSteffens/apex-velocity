/**
 * Scripted driving scenarios on the real track, measuring what "feels" bad:
 * jolts on curbs, violent rotation on wall contact, spins, getting stuck.
 * Run: npx tsx tools/drive-test.ts
 */
import * as THREE from 'three';
import { loadRapier, PhysicsWorld } from '../src/physics/PhysicsWorld';
import { TrackGeometry } from '../src/track/TrackGeometry';
import { Terrain } from '../src/track/Terrain';
import { TrackLayout } from '../src/track/TrackLayout';
import { createTrackColliders } from '../src/physics/TrackColliders';
import { CarPhysics } from '../src/car/CarPhysics';
import { getTrack } from '../src/data/tracks';
import { getCar } from '../src/data/cars';

const R = await loadRapier();
const physics = new PhysicsWorld(R);
const track = new TrackGeometry(getTrack('sunset-circuit'));
const terrain = new Terrain(track);
const layout = new TrackLayout(track, terrain);
createTrackColliders(physics, track, terrain, layout);
const def = getCar('falcon-r');
const dt = physics.fixedDt;
const car = new CarPhysics(physics, def, new THREE.Vector3(0, 50, 0), new THREE.Vector3(0, 0, 1));

function place(s: number, lateral: number, headingOffset = 0, speed = 0): void {
  const p = track.offsetPoint(s, lateral, new THREE.Vector3());
  p.y = track.project(p.x, p.z).height + CarPhysics.restHeight(def) + 0.02;
  const h = track.tangentAt(s, new THREE.Vector3()).applyAxisAngle(new THREE.Vector3(0, 1, 0), headingOffset);
  car.reset(p, h);
  car.body.setLinvel({ x: h.x * speed, y: 0, z: h.z * speed }, true);
  car.gear = 4;
  for (let i = 0; i < 30; i++) {
    car.input.throttle = speed > 0 ? 0.3 : 0;
    car.step(dt);
    physics.step();
  }
}

interface Metrics {
  maxYawRate: number;
  maxRollPitchRate: number;
  maxVy: number;
  maxHeadingChange: number;
  endSpeed: number;
  airTime: number;
}

function run(secs: number, drive: (t: number) => void): Metrics {
  const m: Metrics = { maxYawRate: 0, maxRollPitchRate: 0, maxVy: 0, maxHeadingChange: 0, endSpeed: 0, airTime: 0 };
  const h0 = Math.atan2(car.forward.x, car.forward.z);
  for (let k = 0; k < secs * 120; k++) {
    car.input.throttle = 0;
    car.input.brake = 0;
    car.input.steer = 0;
    car.input.handbrake = false;
    drive(k / 120);
    car.step(dt);
    physics.step();
    car.syncState();
    const w = car.body.angvel();
    const up = car.up;
    const yawRate = w.x * up.x + w.y * up.y + w.z * up.z;
    m.maxYawRate = Math.max(m.maxYawRate, Math.abs(yawRate));
    m.maxRollPitchRate = Math.max(m.maxRollPitchRate, Math.hypot(w.x - up.x * yawRate, w.y - up.y * yawRate, w.z - up.z * yawRate));
    m.maxVy = Math.max(m.maxVy, Math.abs(car.velocity.y));
    let dh = Math.atan2(car.forward.x, car.forward.z) - h0;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    m.maxHeadingChange = Math.max(m.maxHeadingChange, Math.abs(dh) * 57.3);
    if (car.groundedWheels === 0) m.airTime += dt;
  }
  m.endSpeed = car.speed;
  return m;
}

const fmt = (name: string, m: Metrics) =>
  `${name.padEnd(36)} yawRate ${m.maxYawRate.toFixed(2).padStart(5)}  roll/pitchRate ${m.maxRollPitchRate.toFixed(2).padStart(5)}  |vy| ${m.maxVy.toFixed(2).padStart(5)}  heading± ${m.maxHeadingChange.toFixed(0).padStart(4)}°  air ${m.airTime.toFixed(2)}s  end ${(m.endSpeed * 3.6).toFixed(0)} km/h`;

// Find a curb zone on a reasonably fast corner.
const zone = layout.curbs.find((z) => z.side === 1 && Math.abs(track.curvature[z.startIndex]) < 1 / 60) ?? layout.curbs[0];
const curbS = zone.startIndex * track.spacing;
const curbLat = zone.side * (track.halfWidth + 0.4);

// 1. Riding the curb at speed
place(curbS - 30, curbLat, 0, 30);
console.log(fmt('curb ride @108 km/h', run(2.5, () => {
  const p = track.project(car.position.x, car.position.z);
  car.input.throttle = 0.5;
  car.input.steer = Math.max(-1, Math.min(1, (curbLat - p.lateral) * 0.25 - 0));
})));

// 2. Wall scrape: straight armco section, 10 degrees into the wall
const straightS = 60;
place(straightS, 11, -0.17, 35);
console.log(fmt('wall scrape 10° @126 km/h', run(3, () => (car.input.throttle = 0.6))));

// 3. Hard impact: 40 degrees into the wall
place(straightS + 150, 8, -0.7, 30);
console.log(fmt('wall impact 40° @108 km/h', run(3, () => (car.input.throttle = 0.3))));

// 4. Recovery after the impact: can we drive away? (reverse then forward)
const beforeRec = car.speed;
const rec = run(4, (t) => {
  if (t < 1.5) car.input.brake = 1;
  else {
    const p = track.project(car.position.x, car.position.z);
    car.input.throttle = 0.7;
    car.input.steer = Math.max(-1, Math.min(1, -p.lateral * 0.15));
  }
});
console.log(fmt(`recover (from ${(beforeRec * 3.6).toFixed(0)} km/h)`, rec));

// 5. Off the edge onto grass and back at speed
place(straightS + 350, 5, -0.12, 40);
console.log(fmt('road edge -> grass -> back @144 km/h', run(3, (t) => {
  car.input.throttle = 0.6;
  const p = track.project(car.position.x, car.position.z);
  car.input.steer = t > 1.2 ? Math.max(-1, Math.min(1, -p.lateral * 0.12)) : 0;
})));

// 6. Grinding: slow, full throttle, angled into the wall (the classic "car climbs the wall" case)
for (const [lat, ang, v] of [[13.5, -0.35, 8], [14, -0.2, 14], [13, -0.5, 5]] as const) {
  place(170, lat, ang, v);
  let minUpY = 1;
  let maxLat = 0;
  const m = run(4, () => {
    car.input.throttle = 1;
    minUpY = Math.min(minUpY, car.up.y);
    maxLat = Math.max(maxLat, track.project(car.position.x, car.position.z).lateral);
  });
  console.log(fmt(`grind ${v} m/s ${Math.round(-ang * 57.3)}° (min up.y ${minUpY.toFixed(2)}, max lat ${maxLat.toFixed(1)})`, m));
}
