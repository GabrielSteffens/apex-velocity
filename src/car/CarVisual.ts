import * as THREE from 'three';
import type { Car } from './Car';
import { buildCarModel, type CarModelParts } from './CarModel';
import { CarPhysics } from './CarPhysics';
import * as tex from '../render/textures';

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Critically-damped-ish spring integrated with sub-steps: frame-rate independent. */
class Spring {
  value = 0;
  velocity = 0;
  constructor(
    private stiffness: number,
    private damping: number,
  ) {}
  update(target: number, dt: number): number {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = (target - this.value) * this.stiffness - this.velocity * this.damping;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** Renders a Car: interpolates the physics transform and animates wheels and lights. */
export class CarVisual {
  readonly parts: CarModelParts;
  private brakeGlow = 0;
  // Visual-only body motion (the physics body stays stable; this sells weight transfer).
  private roll = new Spring(90, 11);
  private pitch = new Spring(80, 10);
  private heave = new Spring(120, 14);
  private lastVel = new THREE.Vector3();
  private accelLong = 0;
  private accelLat = 0;
  private hasLast = false;
  private bodyBaseY = 0;
  private beam: THREE.Mesh | null = null;
  private spot: THREE.SpotLight | null = null;
  private tailBase = 1.2;

  constructor(
    readonly car: Car,
    readonly scene: THREE.Object3D,
    number: number,
  ) {
    this.parts = buildCarModel(car.def, car.color, number);
    this.bodyBaseY = this.parts.body.position.y;
    scene.add(this.parts.root);
    car.visual = this;
    this.sync(1);
  }

  /**
   * Night driving: brighter lamps, a light pool on the road ahead of every car, and a real
   * spotlight for the player's car only (one extra light keeps shading cheap).
   */
  setNight(on: boolean, realLight: boolean): void {
    const p = this.parts;
    p.headLightMat.emissiveIntensity = on ? 7 : 2.2;
    this.tailBase = on ? 5 : 1.2;
    if (on && !this.beam) {
      const G = -CarPhysics.restHeight(this.car.def);
      const geo = new THREE.PlaneGeometry(9, 26).rotateX(-Math.PI / 2);
      geo.translate(0, G + 0.06, this.car.def.dimensions.length / 2 + 12);
      this.beam = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          map: tex.radialGradient('rgba(255,244,225,0.9)', 'rgba(255,244,225,0)'),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          opacity: 0.55,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        }),
      );
      this.beam.renderOrder = 4;
      p.root.add(this.beam);
    }
    if (this.beam) this.beam.visible = on;
    if (on && realLight && !this.spot) {
      const spot = new THREE.SpotLight(0xfff2de, 90, 90, 0.42, 0.55, 1.3);
      spot.position.set(0, 0.1, this.car.def.dimensions.length / 2);
      spot.target.position.set(0, -1.2, 30);
      p.root.add(spot, spot.target);
      this.spot = spot;
    }
    if (this.spot) this.spot.visible = on && realLight;
  }

  get root(): THREE.Group {
    return this.parts.root;
  }

  /**
   * @param alpha interpolation factor between the last two physics steps
   * @param dt    render frame time (for the visual springs)
   */
  sync(alpha: number, dt = 1 / 60): void {
    const car = this.car;
    const ph = car.physics;
    const root = this.parts.root;
    _p.copy(car.prevPosition).lerp(ph.position, alpha);
    _q.copy(car.prevQuaternion).slerp(ph.quaternion, alpha);
    root.position.copy(_p);
    root.quaternion.copy(_q);

    // Wheels: interpolate suspension travel, spin and steering too, so they move as
    // smoothly as the body at any refresh rate.
    const steer = car.prevSteer + (ph.steerAngle - car.prevSteer) * alpha;
    for (let i = 0; i < 4; i++) {
      const w = ph.wheels[i];
      const pivot = this.parts.wheelPivots[i];
      const susp = car.prevSuspension[i] + (w.suspension - car.prevSuspension[i]) * alpha;
      pivot.position.y = w.mount.y - susp;
      if (w.front) pivot.rotation.y = -steer;
      this.parts.wheelSpinners[i].rotation.x = car.prevSpin[i] + (w.spinAngle - car.prevSpin[i]) * alpha;
    }

    // Body roll / pitch / heave from the car's accelerations in its own frame.
    if (dt > 0) {
      _v.copy(car.prevVelocity).lerp(ph.velocity, alpha);
      if (this.hasLast) {
        _qi.copy(_q).invert();
        const acc = this.lastVel.sub(_v).multiplyScalar(-1 / dt).applyQuaternion(_qi); // local accel
        // Smooth the raw accelerations (collisions produce single-frame spikes).
        const k = 1 - Math.exp(-10 * dt);
        this.accelLong += (acc.z - this.accelLong) * k;
        this.accelLat += (acc.x - this.accelLat) * k;
      }
      this.lastVel.copy(_v);
      this.hasLast = true;
      const grounded = ph.groundedWheels > 0;
      // Local +X is the car's left: accelerating to the left (right turn) rolls the body right.
      const rollTarget = grounded ? Math.max(-0.045, Math.min(0.045, this.accelLat * 0.0028)) : 0;
      const pitchTarget = grounded ? Math.max(-0.035, Math.min(0.035, -this.accelLong * 0.0024)) : 0;
      let comp = 0;
      for (const w of ph.wheels) comp += w.compression;
      const heaveTarget = grounded ? Math.max(-0.05, Math.min(0.03, -(comp / 4 - 0.07) * 0.35)) : 0;
      const body = this.parts.body;
      body.rotation.z = this.roll.update(rollTarget, dt);
      body.rotation.x = this.pitch.update(pitchTarget, dt);
      body.position.y = this.bodyBaseY + this.heave.update(heaveTarget, dt);
    }

    const braking = ph.braking || (ph.input.handbrake && ph.enabled && ph.speed > 1);
    // Frame-rate independent fade (~70 ms rise).
    this.brakeGlow += ((braking ? 1 : 0) - this.brakeGlow) * (1 - Math.exp(-dt * 14));
    this.parts.brakeLightMat.emissiveIntensity = this.tailBase + this.brakeGlow * 7;
    this.parts.reverseLightMat.emissiveIntensity = ph.reversing ? 3 : 0;
    // Contact shadow fades when airborne.
    (this.parts.shadow.material as THREE.MeshBasicMaterial).opacity = ph.groundedWheels > 0 ? 0.75 : 0.25;
  }

  dispose(): void {
    this.spot?.dispose();
    this.scene.remove(this.parts.root);
    this.parts.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
      }
    });
  }
}
