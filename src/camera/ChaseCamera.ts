import * as THREE from 'three';
import type { Car } from '../car/Car';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { GROUP, groups } from '../physics/PhysicsWorld';
import type { Terrain } from '../track/Terrain';
import { clamp, damp, Noise2D, wrapAngle } from '../core/math';

export type CameraMode = 'chase' | 'far' | 'hood';
const MODES: CameraMode[] = ['chase', 'far', 'hood'];

const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _vel = new THREE.Vector3();

/**
 * Third-person chase camera with heading lag (so the car visibly rotates in slides),
 * speed-dependent distance and FOV, collision shake and anti-clipping.
 */
export class ChaseCamera {
  mode: CameraMode = 'chase';
  private yaw = 0;
  private pos = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private fov = 62;
  private trauma = 0;
  private time = 0;
  private noise = new Noise2D(5);
  private initialized = false;
  private distance = 6;
  private orbitAngle = 0;
  private offset = new THREE.Vector3(0, 2, -6);
  private camY = NaN;
  private accel = 0;
  private yawRate = 0;
  private lastFwdSpeed = 0;
  private lastYaw = 0;
  private surge = 0;
  private roll = 0;
  private blendIn = 1;
  private boostKick = 0;
  shakeEnabled = true;
  private ray: import('@dimforge/rapier3d-compat').Ray | null = null;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly physics: PhysicsWorld | null,
    private readonly terrain: Terrain | null,
  ) {}

  cycleMode(): void {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
  }

  /** Adds camera shake (0..1). */
  shake(amount: number): void {
    if (!this.shakeEnabled) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Re-acquire the car smoothly (glides from the current camera position; never cuts). */
  snap(): void {
    this.initialized = false;
    this.camY = NaN;
  }

  update(dt: number, car: Car, alpha = 1): void {
    if (dt <= 0) return;
    this.time += dt;
    const ph = car.physics;
    // Everything the camera reads is interpolated between the last two physics steps,
    // otherwise it moves in 120 Hz bursts that don't line up with the display refresh.
    const carPos = _tmp.copy(car.prevPosition).lerp(ph.position, alpha);
    const q = _q.copy(car.prevQuaternion).slerp(ph.quaternion, alpha);
    const fwd = _fwd.set(0, 0, 1).applyQuaternion(q);
    const vel = _vel.copy(car.prevVelocity).lerp(ph.velocity, alpha);
    const speed = vel.length();
    const fwdSpeed = vel.dot(fwd);
    const speedT = clamp(speed / 70, 0, 1);
    // Boost: FOV punch and the camera drops back a touch (sells the acceleration).
    this.boostKick = damp(this.boostKick, ph.boostTime > 0 ? 1 : ph.overdriveTime > 0 ? 0.6 : 0, ph.boostTime > 0 ? 6 : 2.5, dt);

    const carYaw = Math.atan2(fwd.x, fwd.z);
    // Blend toward the velocity direction when moving so the camera looks where the car goes.
    let targetYaw = carYaw;
    if (speed > 4 && fwdSpeed > 0) {
      const vYaw = Math.atan2(vel.x, vel.z);
      targetYaw = carYaw + wrapAngle(vYaw - carYaw) * 0.45;
    }
    if (fwdSpeed < -2) targetYaw = carYaw; // reversing: stay behind

    // Longitudinal acceleration and yaw rate, smoothed (drive the subtle accel/brake and roll motion).
    if (this.initialized) {
      const acc = (fwdSpeed - this.lastFwdSpeed) / dt;
      this.accel += (clamp(acc, -40, 40) - this.accel) * (1 - Math.exp(-6 * dt));
      const yawRate = wrapAngle(carYaw - this.lastYaw) / dt;
      this.yawRate += (clamp(yawRate, -3, 3) - this.yawRate) * (1 - Math.exp(-8 * dt));
    }
    this.lastFwdSpeed = fwdSpeed;
    this.lastYaw = carYaw;

    if (!this.initialized) {
      // Never cut: start from wherever the camera currently is (e.g. the menu orbit) and
      // glide in behind the car.
      this.yaw = targetYaw;
      this.initialized = true;
      this.offset.copy(this.camera.position).sub(carPos);
      this.lookTarget.copy(carPos);
      this.blendIn = 0;
      this.accel = 0;
      this.yawRate = 0;
    }
    this.blendIn = Math.min(1, this.blendIn + dt / 1.2);
    const settle = 0.25 + 0.75 * this.blendIn * this.blendIn; // slow start, then normal response

    this.yaw += wrapAngle(targetYaw - this.yaw) * (1 - Math.exp(-(this.mode === 'far' ? 3.2 : 4.4) * settle * dt));

    if (this.mode === 'hood') {
      _desired.set(0, 0.52, 0.55).applyQuaternion(q).add(carPos);
      this.pos.copy(_desired);
      this.offset.copy(_desired).sub(carPos);
      _look.copy(fwd).multiplyScalar(20).add(_desired);
      _look.y -= 0.6;
      this.lookTarget.copy(_look);
      this.fov = damp(this.fov, 70 + speedT * 12 + this.boostKick * 8, 4, dt);
    } else {
      const far = this.mode === 'far';
      const targetDist = (far ? 8.8 : 5.9) + speedT * (far ? 2.0 : 1.6) + this.boostKick * 0.9;
      this.distance = damp(this.distance, targetDist, 2.5, dt);
      // Accelerating pulls the camera back a touch, braking lets it close in.
      const surge = clamp(this.accel * 0.03, -0.55, 0.45);
      this.surge = damp(this.surge, surge, 5, dt);
      const height = (far ? 3.0 : 1.95) + speedT * 0.35 - this.surge * 0.25;
      _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

      // Smooth the camera's OFFSET from the car, not its world position: world-space
      // smoothing of a 70 m/s target lags by v/k and that lag varies with frame time,
      // which shows up as jitter at speed.
      _desired.copy(_dir).multiplyScalar(-(this.distance + this.surge));
      _desired.y = height;
      this.offset.lerp(_desired, 1 - Math.exp(-10 * settle * dt));
      _desired.copy(carPos).add(this.offset);
      // Vertical position filtered separately so bumps don't bounce the view.
      if (!isFinite(this.camY)) this.camY = _desired.y;
      this.camY += (_desired.y - this.camY) * (1 - Math.exp(-9 * dt));
      _desired.y = this.camY;

      // Anti-clipping: pull the camera in front of walls / terrain.
      const pivot = _look.copy(carPos);
      pivot.y += 1.1;
      this.avoidClipping(pivot, _desired);
      if (this.terrain) {
        const gy = this.terrain.heightAt(_desired.x, _desired.z) + 0.6;
        if (_desired.y < gy) _desired.y = gy;
      }
      this.pos.copy(_desired);

      _look.copy(carPos).addScaledVector(_dir, 2.2 + speedT * 3);
      _look.y += 0.85 - this.surge * 0.15;
      this.lookTarget.lerp(_look, 1 - Math.exp(-25 * settle * dt));
      this.fov = damp(this.fov, 60 + speedT * 16 + clamp(this.accel * 0.08, -1.5, 2) + this.boostKick * 9, 3, dt);
    }

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.lookTarget);

    // Subtle roll into hard corners (none at low speed, max ~2.3 deg).
    const rollTarget = this.mode === 'hood' ? 0 : clamp(-this.yawRate * speedT * 0.035, -0.04, 0.04);
    this.roll = damp(this.roll, rollTarget, 4, dt);

    // Impact shake only (trauma^2 scaled Perlin offsets + slight roll).
    this.trauma = Math.max(0, this.trauma - dt * 2.2);
    const sh = this.trauma * this.trauma;
    const t = this.time * 18;
    if (sh > 0.0001) {
      this.camera.position.x += this.noise.get(t, 0.3) * sh * 0.2;
      this.camera.position.y += this.noise.get(t, 7.1) * sh * 0.15;
      this.camera.position.z += this.noise.get(t, 13.7) * sh * 0.2;
    }
    this.camera.rotateZ(this.roll + this.noise.get(t * 0.8, 21.3) * sh * 0.03);

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private avoidClipping(from: THREE.Vector3, to: THREE.Vector3): void {
    if (!this.physics) return;
    const R = this.physics.R;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return;
    if (!this.ray) this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const o = this.ray.origin;
    o.x = from.x;
    o.y = from.y;
    o.z = from.z;
    const d = this.ray.dir;
    d.x = dx / len;
    d.y = dy / len;
    d.z = dz / len;
    const hit = this.physics.world.castRay(this.ray, len, true, undefined, groups(GROUP.PROP, GROUP.GROUND | GROUP.BARRIER));
    if (hit) {
      const d = Math.max(1.2, hit.timeOfImpact - 0.35);
      to.set(from.x + (dx / len) * d, from.y + (dy / len) * d, from.z + (dz / len) * d);
    }
  }

  /** Slow cinematic orbit used behind the main menu. */
  orbit(dt: number, center: THREE.Vector3, radius = 11, height = 3.2): void {
    this.orbitAngle += dt * 0.12;
    const x = center.x + Math.cos(this.orbitAngle) * radius;
    const z = center.z + Math.sin(this.orbitAngle) * radius;
    let y = center.y + height;
    if (this.terrain) y = Math.max(y, this.terrain.heightAt(x, z) + 0.8);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(center.x, center.y + 0.6, center.z);
    this.fov = 50;
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
    this.initialized = false;
    this.camY = NaN;
  }
}
