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

  snap(): void {
    this.initialized = false;
  }

  update(dt: number, car: Car, alpha = 1): void {
    this.time += dt;
    const ph = car.physics;
    const carPos = _tmp.copy(car.prevPosition).lerp(ph.position, alpha);
    const speed = ph.speed;
    const speedT = clamp(speed / 70, 0, 1);

    const fwd = ph.forward;
    const carYaw = Math.atan2(fwd.x, fwd.z);
    // Blend toward the velocity direction when moving so the camera looks where the car goes.
    let targetYaw = carYaw;
    if (speed > 4 && ph.forwardSpeed > 0) {
      const vYaw = Math.atan2(ph.velocity.x, ph.velocity.z);
      targetYaw = carYaw + wrapAngle(vYaw - carYaw) * 0.45;
    }
    if (ph.forwardSpeed < -2) targetYaw = carYaw; // reversing: stay behind

    if (!this.initialized) {
      this.yaw = targetYaw;
      this.initialized = true;
      this.pos.set(carPos.x - Math.sin(this.yaw) * 7, carPos.y + 2.5, carPos.z - Math.cos(this.yaw) * 7);
      this.lookTarget.copy(carPos);
    }
    this.yaw += wrapAngle(targetYaw - this.yaw) * (1 - Math.exp(-(this.mode === 'far' ? 3.2 : 4.2) * dt));

    if (this.mode === 'hood') {
      _desired.set(0, 0.52, 0.55).applyQuaternion(ph.quaternion).add(carPos);
      this.pos.copy(_desired);
      _look.copy(fwd).multiplyScalar(20).add(_desired);
      _look.y -= 0.6;
      this.lookTarget.copy(_look);
      this.fov = damp(this.fov, 70 + speedT * 12, 4, dt);
    } else {
      const far = this.mode === 'far';
      const targetDist = (far ? 8.8 : 5.9) + speedT * (far ? 2.0 : 1.6);
      this.distance = damp(this.distance, targetDist, 2.5, dt);
      const height = (far ? 3.0 : 1.95) + speedT * 0.35;
      _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      _desired.copy(carPos).addScaledVector(_dir, -this.distance);
      _desired.y = carPos.y + height;

      // Anti-clipping: pull the camera in front of walls / terrain.
      const pivot = _look.copy(carPos);
      pivot.y += 1.1;
      this.avoidClipping(pivot, _desired);
      if (this.terrain) {
        const gy = this.terrain.heightAt(_desired.x, _desired.z) + 0.6;
        if (_desired.y < gy) _desired.y = gy;
      }

      // Position lag: tighter laterally, softer vertically for a smooth ride.
      const k = 1 - Math.exp(-14 * dt);
      this.pos.x += (_desired.x - this.pos.x) * k;
      this.pos.z += (_desired.z - this.pos.z) * k;
      this.pos.y += (_desired.y - this.pos.y) * (1 - Math.exp(-7 * dt));

      _look.copy(carPos).addScaledVector(_dir, 2.2 + speedT * 3);
      _look.y += 0.85;
      this.lookTarget.lerp(_look, 1 - Math.exp(-18 * dt));
      this.fov = damp(this.fov, 60 + speedT * 16, 3, dt);
    }

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.lookTarget);

    // Shake: trauma^2 scaled Perlin offsets + slight roll; plus tiny high-speed vibration.
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const s = this.trauma * this.trauma;
    const vib = speedT * speedT * 0.012 * (this.mode === 'hood' ? 1.5 : 1);
    const t = this.time * 22;
    this.camera.position.x += this.noise.get(t, 0.3) * (s * 0.35 + vib);
    this.camera.position.y += this.noise.get(t, 7.1) * (s * 0.28 + vib);
    this.camera.position.z += this.noise.get(t, 13.7) * (s * 0.35 + vib);
    this.camera.rotateZ(this.noise.get(t * 0.8, 21.3) * s * 0.05);

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
    this.ray.origin = { x: from.x, y: from.y, z: from.z };
    this.ray.dir = { x: dx / len, y: dy / len, z: dz / len };
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
  }
}
