import * as THREE from 'three';
import { loadRapier, PhysicsWorld, GROUP, groups } from '../src/physics/PhysicsWorld';
import { CarPhysics } from '../src/car/CarPhysics';
import { getCar } from '../src/data/cars';

const R = await loadRapier();
const def = getCar('falcon-r');
const mode = process.argv[2] ?? 'circle';
function makeWorld() {
  const physics = new PhysicsWorld(R);
  const ground = physics.world.createRigidBody(R.RigidBodyDesc.fixed());
  physics.world.createCollider(R.ColliderDesc.cuboid(5000, 1, 5000).setTranslation(0, -1, 0).setCollisionGroups(groups(GROUP.GROUND, GROUP.CAR)), ground);
  const car = new CarPhysics(physics, def, new THREE.Vector3(0, CarPhysics.restHeight(def), 0), new THREE.Vector3(0, 0, 1));
  return { physics, car };
}
if (mode === 'circle') {
  for (const target of [12, 20, 30, 40, 55]) {
    for (const steer of [0.5, 1]) {
      const { physics, car } = makeWorld();
      const dt = physics.fixedDt;
      let yaw = 0, lat = 0, slip = 0, n = 0;
      for (let k = 0; k < 120 * 16; k++) {
        const sp = car.forwardSpeed;
        const turning = k > 120 * 8;
        car.input.throttle = sp < target ? (turning ? 0.6 : 1) : 0; car.input.brake = 0;
        car.input.steer = turning ? steer : 0;
        car.step(dt); physics.step();
        if (k > 120 * 13) { const y = car.body.angvel().y; yaw += y; lat += Math.abs(y * car.speed); n++;
          const v = car.velocity; const f = car.forward; slip += Math.acos(Math.min(1, Math.abs((v.x*f.x+v.z*f.z)/Math.max(0.1,Math.hypot(v.x,v.z))))); }
      }
      yaw /= n; lat /= n; slip /= n;
      console.log(`target ${target} steerIn ${steer}: v=${car.speed.toFixed(1)} steer=${car.steerAngle.toFixed(3)} yaw=${yaw.toFixed(3)} latAcc=${lat.toFixed(1)} (${(lat/9.81).toFixed(2)}g) R=${(car.speed/Math.abs(yaw)).toFixed(1)} bodySlip=${(slip*57.3).toFixed(1)}deg roll(up.y)=${car.up.y.toFixed(4)}`);
    }
  }
}
if (mode === 'drift') {
  const { physics, car } = makeWorld();
  const dt = physics.fixedDt;
  for (let k = 0; k < 120 * 12; k++) {
    const t = k / 120;
    car.input.throttle = t < 5 ? 1 : 0.8; car.input.steer = t > 5 && t < 8 ? 1 : 0; car.input.handbrake = t > 5 && t < 5.8;
    car.step(dt); physics.step();
    if (k % 30 === 0 && t > 4.5) { const v = car.velocity; const f = car.forward; const ang = Math.atan2(v.x, v.z) - Math.atan2(f.x, f.z);
      console.log(`t=${t.toFixed(2)} v=${(car.speed*3.6).toFixed(0)} yaw=${car.body.angvel().y.toFixed(2)} slipAngle=${(((ang+Math.PI*3)%(Math.PI*2)-Math.PI)*57.3).toFixed(0)} hb=${car.input.handbrake}`); }
  }
}
if (mode === 'stability') {
  // Keyboard-style (all-or-nothing) inputs that tend to spin cars: slalom, power-on exit, lift-off.
  const bodySlip = (car: CarPhysics) => {
    const v = car.velocity; const f = car.forward;
    if (Math.hypot(v.x, v.z) < 3 || car.forwardSpeed < 3) return 0; // stopped / reversing isn't a spin
    let a = Math.atan2(v.x, v.z) - Math.atan2(f.x, f.z);
    while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2;
    return Math.abs(a) * 57.3;
  };
  const tests: [string, number, (t: number, c: CarPhysics) => void][] = [
    ['slalom 35m/s', 35, (t, c) => { c.input.throttle = 0.7; c.input.steer = Math.sin(t * Math.PI / 0.8) > 0 ? 1 : -1; }],
    ['slalom 25m/s', 25, (t, c) => { c.input.throttle = 0.7; c.input.steer = Math.sin(t * Math.PI / 0.7) > 0 ? 1 : -1; }],
    ['full lock + full throttle 15m/s', 15, (_t, c) => { c.input.throttle = 1; c.input.steer = 1; }],
    ['full lock + full throttle 25m/s', 25, (_t, c) => { c.input.throttle = 1; c.input.steer = 1; }],
    ['lift-off mid corner 40m/s', 40, (t, c) => { c.input.throttle = t < 1.5 ? 0.8 : 0; c.input.steer = 1; }],
    ['brake mid corner 40m/s', 40, (t, c) => { c.input.throttle = 0; c.input.brake = t > 1 ? 1 : 0; c.input.steer = 1; }],
  ];
  for (const [name, v0, drive] of tests) {
    const { physics, car } = makeWorld();
    const dt = physics.fixedDt;
    // Get up to speed in a straight line
    for (let k = 0; k < 120 * 20 && car.forwardSpeed < v0; k++) { car.input.throttle = 1; car.step(dt); physics.step(); }
    let maxSlip = 0; let spun = false; let latSum = 0; let n = 0;
    for (let k = 0; k < 120 * 5; k++) {
      car.input.brake = 0; drive(k / 120, car);
      car.step(dt); physics.step();
      const s = bodySlip(car); maxSlip = Math.max(maxSlip, s); if (s > 60) spun = true;
      latSum += Math.abs(car.body.angvel().y * car.speed); n++;
    }
    console.log(`${name.padEnd(34)} maxBodySlip ${maxSlip.toFixed(1).padStart(5)}°  ${spun ? 'SPUN' : 'ok  '}  avgLat ${(latSum / n / 9.81).toFixed(2)}g  endSpeed ${car.speed.toFixed(1)}`);
  }
}
if (mode === 'arcade') {
  // Arcade drift: hold drift + steer at speed, then release -> mini-turbo.
  for (const steerIn of [1, 0, -1]) {
    const { physics, car } = makeWorld();
    const dt = physics.fixedDt;
    let released = '';
    for (let k = 0; k < 120 * 11; k++) {
      const t = k / 120;
      car.input.throttle = 1;
      const drifting = t > 5 && t < 9;
      car.input.drift = drifting;
      car.input.handbrake = drifting;
      car.input.steer = t > 5 && t < 5.3 ? 1 : drifting ? steerIn : 0;
      car.step(dt); physics.step();
      if (car.driftReleased) { released = `released L${car.driftReleased.level} after ${car.driftReleased.time.toFixed(2)}s boost=${car.boostTime.toFixed(2)}`; car.driftReleased = null; }
      if (k % 60 === 0 && t > 4.5) console.log(`steer ${steerIn} t=${t.toFixed(1)} v=${(car.speed*3.6).toFixed(0)} yaw=${car.body.angvel().y.toFixed(2)} slip=${(car.bodySlip*57.3).toFixed(0)} drift=${car.drifting} charge=${car.driftCharge.toFixed(2)} L${car.driftLevel} up.y=${car.up.y.toFixed(3)}`);
    }
    console.log(released);
  }
}
