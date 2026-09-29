import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { CarDefinition } from '../data/types';
import { GROUP, groups, SURFACES, type PhysicsWorld, type SurfaceType } from '../physics/PhysicsWorld';
import { clamp, lerp, moveTowards } from '../core/math';

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export interface CarInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (also reverse when stopped)
  steer: number; // -1 (left) .. 1 (right)
  handbrake: boolean;
  /** Arcade drift button: at speed + steering, starts a controlled, boost-charging drift. */
  drift?: boolean;
  /** True when steer comes from an analog stick (already smooth: less filtering needed). */
  analog?: boolean;
}

export interface WheelState {
  /** Mount point in body-local space. */
  mount: THREE.Vector3;
  front: boolean;
  left: boolean;
  radius: number;
  grounded: boolean;
  /** Current suspension length (mount to wheel centre). */
  suspension: number;
  compression: number;
  prevCompression: number;
  load: number;
  contact: THREE.Vector3;
  normal: THREE.Vector3;
  surface: SurfaceType;
  /** Lateral sliding speed at the contact patch (m/s). */
  slipLateral: number;
  /** Slip angle relative to the tyre's peak (> 1 = sliding past the grip limit). */
  slipRatio: number;
  /** Longitudinal slip (wheelspin/lock), m/s. */
  slipLong: number;
  spinAngle: number;
  spinSpeed: number;
}

// Car-local axes. The car faces +Z; +X is the car's LEFT side (three.js convention).
const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);
const LOCAL_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_RIGHT = new THREE.Vector3(-1, 0, 0);
/** Height of the suspension top mounts in body space. */
const WHEEL_MOUNT_Y = 0.13;

const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _com = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _wFwd = new THREE.Vector3();
const _wSide = new THREE.Vector3();
const _r = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _f = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _axis = new THREE.Vector3();

/**
 * Arcade vehicle model: rigid body chassis + 4 raycast wheels with spring/damper suspension,
 * slip-angle based lateral grip, a power-limited engine with an automatic gearbox, aero
 * drag/downforce, handbrake drifting and airborne stabilisation.
 */
export class CarPhysics {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly wheels: WheelState[] = [];
  readonly input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

  /** Smoothed steering input, -1..1 */
  steerInput = 0;
  /** Front wheel steer angle in radians (positive = right). */
  steerAngle = 0;
  /** Signed forward speed (m/s). */
  forwardSpeed = 0;
  speed = 0;
  gear = 1;
  rpm = 0;
  groundedWheels = 0;
  airTime = 0;
  /** True while the car is below the track surface or upside down. */
  upsideDownTime = 0;
  engineLoad = 0;
  braking = false;
  reversing = false;
  shiftTimer = 0;
  /** Surface under the majority of wheels. */
  surface: SurfaceType = 'asphalt';
  /** When false, engine and steering inputs are ignored (countdown). */
  enabled = true;
  /** 0..1 aerodynamic tow from a car ahead (set by the race manager). */
  slipstream = 0;

  // ---------- Arcade layer ----------
  /** In a controlled (assisted) drift. */
  drifting = false;
  /** +1 drifting right, -1 left. */
  driftDir = 0;
  driftTime = 0;
  /** Seconds of good drifting accumulated; thresholds give levels 1..3. */
  driftCharge = 0;
  driftLevel = 0;
  /** Seconds left of the assisted straighten-up after a drift ends. */
  private driftRecover = 0;
  /** Set when a drift ends; consumed (and cleared) by the race session. */
  driftReleased: { level: number; time: number } | null = null;
  /** Signed body slip angle (radians; negative = nose right of travel). */
  bodySlip = 0;
  boostTime = 0;
  private boostAccel = 0;
  /** Overdrive item: more power and speed, less steering and grip. */
  overdriveTime = 0;
  /** Set on touchdown after a jump (seconds airborne); consumed by the race session. */
  landed = 0;
  /** Seconds since the last jump landing. */
  sinceLanding = 99;
  /** Spinning out after a hit (missile / oil / EMP): no control. */
  stunTime = 0;
  private stunSpin = 0;

  private readonly mass: number;
  private readonly springK: number;
  private readonly damperC: number;
  private readonly maxDriveForce: number;
  private readonly power: number;
  private readonly dragCoef: number;
  private readonly topSpeed: number;
  private readonly gearTop: number[] = [];
  private readonly rayGroups = groups(GROUP.CAR, GROUP.GROUND);
  private readonly comHeight: number;
  private rough = 0;
  private reverseHold = 0;
  private readonly rays: RAPIER.Ray[] = [];

  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly physics: PhysicsWorld,
    readonly def: CarDefinition,
    position: THREE.Vector3,
    heading: THREE.Vector3,
  ) {
    const R = physics.R;
    const d = def.dimensions;
    this.mass = def.mass;
    const w = (2 * Math.PI * def.suspension.frequency) ** 2;
    this.springK = (def.mass / 4) * w;
    this.damperC = 2 * def.suspension.damping * Math.sqrt(this.springK * (def.mass / 4));
    this.maxDriveForce = def.mass * def.acceleration;
    this.power = def.powerKW * 1000;
    this.topSpeed = def.topSpeed / 3.6;
    this.dragCoef = this.power / this.topSpeed ** 3;
    const ratios = [0.27, 0.42, 0.57, 0.72, 0.87, 1.02];
    for (let i = 0; i < def.gearCount; i++) this.gearTop.push(this.topSpeed * (ratios[i] ?? 1.02));

    const yaw = Math.atan2(heading.x, heading.z);
    // Centre of mass at the height of the chassis collider's centre: side impacts against
    // walls/cars then push through the COM instead of levering the car up onto the wall.
    // Rollover stability comes from applying tyre forces close to COM height (below).
    this.comHeight = 0.02;
    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setLinearDamping(0.02)
      .setAngularDamping(0.8)
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setAdditionalMassProperties(
        def.mass,
        { x: 0, y: this.comHeight, z: 0.05 },
        {
          // Pitch and roll inertia are raised well above a real car's: impacts and curbs then
          // nudge the body instead of flicking it. Visual body motion is added in CarVisual.
          x: (def.mass / 12) * (0.9 ** 2 + d.length ** 2) * 2.2,
          y: (def.mass / 12) * (d.width ** 2 + d.length ** 2),
          z: (def.mass / 12) * (d.width ** 2 + 0.9 ** 2) * 4,
        },
        { x: 0, y: 0, z: 0, w: 1 },
      );
    this.body = physics.world.createRigidBody(bodyDesc);
    const r = 0.12;
    this.collider = physics.world.createCollider(
      R.ColliderDesc.roundCuboid(d.width / 2 - r - 0.02, 0.4 - r, d.length / 2 - r - 0.05, r)
        .setTranslation(0, 0.08, 0)
        .setDensity(0)
        .setFriction(0.25)
        .setRestitution(0.15)
        .setCollisionGroups(groups(GROUP.CAR, GROUP.GROUND | GROUP.CAR | GROUP.BARRIER | GROUP.PROP))
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(def.mass * 6),
      this.body,
    );

    const hx = d.trackWidth / 2;
    const hz = d.wheelBase / 2;
    const mounts: [number, number, boolean, boolean][] = [
      [hx, hz, true, true],
      [-hx, hz, true, false],
      [hx, -hz, false, true],
      [-hx, -hz, false, false],
    ];
    for (const [x, z, front, left] of mounts) {
      this.wheels.push({
        mount: new THREE.Vector3(x, WHEEL_MOUNT_Y, z),
        front,
        left,
        radius: d.wheelRadius,
        grounded: false,
        suspension: def.suspension.restLength,
        compression: 0,
        prevCompression: 0,
        load: 0,
        contact: new THREE.Vector3(),
        normal: new THREE.Vector3(0, 1, 0),
        surface: 'asphalt',
        slipLateral: 0,
        slipRatio: 0,
        slipLong: 0,
        spinAngle: 0,
        spinSpeed: 0,
      });
    }
    for (let i = 0; i < 4; i++) this.rays.push(new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }));
    this.syncState();
  }

  static readonly DRIFT_LEVELS = [0.9, 2.0, 3.3];
  static readonly DRIFT_BOOST = [0, 0.8, 1.3, 2.0];

  /** Speed boost: `seconds` of extra thrust (stacks by taking the longer / stronger one). */
  boost(seconds: number, accel = 12): void {
    accel *= this.def.arcade?.boostPower ?? 1;
    this.boostTime = Math.max(this.boostTime, seconds);
    this.boostAccel = Math.max(this.boostTime > seconds ? this.boostAccel : 0, accel);
  }

  /** Spin out for `seconds` (hit by an item). */
  stun(seconds: number, dir = Math.random() < 0.5 ? -1 : 1): void {
    this.stunTime = Math.max(this.stunTime, seconds);
    this.stunSpin = dir * 7.5;
    this.boostTime = 0;
    this.overdriveTime = 0;
    this.endDrift(false);
  }

  /** Ends the current drift; charged drifts release a mini-turbo. */
  endDrift(reward = true): void {
    if (!this.drifting) return;
    this.drifting = false;
    this.driftRecover = 0.45;
    const level = reward && this.surface !== 'grass' ? this.driftLevel : 0;
    if (level > 0) this.boost(CarPhysics.DRIFT_BOOST[level], 11);
    this.driftReleased = { level, time: this.driftTime };
    this.driftCharge = 0;
    this.driftLevel = 0;
    this.driftTime = 0;
  }

  /** Height from the body origin to the ground when resting on its suspension. */
  static restHeight(def: CarDefinition): number {
    const w = (2 * Math.PI * def.suspension.frequency) ** 2;
    const staticComp = 9.81 / w;
    return -WHEEL_MOUNT_Y + def.suspension.restLength - staticComp + def.dimensions.wheelRadius;
  }

  syncState(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    const v = this.body.linvel();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.velocity.set(v.x, v.y, v.z);
    this.forward.copy(LOCAL_FORWARD).applyQuaternion(this.quaternion);
    this.up.copy(LOCAL_UP).applyQuaternion(this.quaternion);
  }

  /** Teleports the car (used for grid placement and resets). */
  reset(position: THREE.Vector3, heading: THREE.Vector3): void {
    const yaw = Math.atan2(heading.x, heading.z);
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerInput = 0;
    this.steerAngle = 0;
    this.gear = 1;
    this.upsideDownTime = 0;
    this.airTime = 0;
    this.drifting = false;
    this.driftRecover = 0;
    this.driftCharge = 0;
    this.driftLevel = 0;
    this.boostTime = 0;
    this.overdriveTime = 0;
    this.stunTime = 0;
    for (const w of this.wheels) {
      w.compression = w.prevCompression = 0;
      w.spinSpeed = 0;
    }
    this.syncState();
  }

  /**
   * Max steering angle for the current speed. Derived from the grip limit so that full lock
   * at speed lands near the tyres' peak slip angle instead of scrubbing the front end.
   */
  maxSteerAngle(speed: number): number {
    const h = this.def.handling;
    const lowSpeedLock = lerp(0.5, 0.6, h);
    const v = Math.max(Math.abs(speed), 1);
    const gripLimited = (this.def.dimensions.wheelBase * this.def.grip * 9.81) / (v * v) + lerp(0.1, 0.14, h);
    return Math.min(lowSpeedLock, gripLimited * 1.1) * (this.overdriveTime > 0 ? 0.62 : 1);
  }

  step(dt: number): void {
    const world = this.physics.world;
    const body = this.body;
    const def = this.def;
    this.syncState();

    // syncState() already read translation/rotation/linvel from Rapier; reuse them
    // (each Rapier getter allocates a fresh object).
    _q.copy(this.quaternion);
    _pos.copy(this.position);
    _fwd.copy(this.forward);
    _up.copy(this.up);
    _right.copy(LOCAL_RIGHT).applyQuaternion(_q);
    const av = body.angvel();
    _v.copy(this.velocity);
    _w.set(av.x, av.y, av.z);
    const wc = body.worldCom();
    _com.set(wc.x, wc.y, wc.z);

    const fwdSpeed = _v.dot(_fwd);
    this.forwardSpeed = fwdSpeed;
    this.speed = _v.length();

    // ---------- Inputs ----------
    const inp = this.input;
    this.sinceLanding += dt;
    this.boostTime = Math.max(0, this.boostTime - dt);
    this.overdriveTime = Math.max(0, this.overdriveTime - dt);
    this.stunTime = Math.max(0, this.stunTime - dt);
    const stunned = this.stunTime > 0;
    const enabled = this.enabled && !stunned;
    const boosting = this.boostTime > 0;
    const steerTarget = enabled ? clamp(inp.steer, -1, 1) : 0;
    // Digital (keyboard) steering ramps in quickly at low speed and more gently at high
    // speed; releasing returns to centre faster than turning in. Analog sticks are already
    // smooth, so they get a much lighter filter (less input lag).
    const speedT = clamp(Math.abs(fwdSpeed) / 50, 0, 1);
    const returning = Math.abs(steerTarget) < Math.abs(this.steerInput) || Math.sign(steerTarget) !== Math.sign(this.steerInput);
    let steerRate = returning ? lerp(8, 6, speedT) : lerp(6.5, 3.4, speedT) * lerp(0.85, 1.1, def.handling);
    if (inp.analog) steerRate *= 3;
    this.steerInput = moveTowards(this.steerInput, steerTarget, steerRate * dt);
    this.steerAngle = this.steerInput * this.maxSteerAngle(fwdSpeed);

    // ---------- Arcade drift ----------
    if (!this.drifting) {
      if (enabled && inp.drift && fwdSpeed > 13 && Math.abs(steerTarget) > 0.3 && this.groundedWheels >= 3) {
        this.drifting = true;
        this.driftDir = Math.sign(steerTarget);
        this.driftTime = 0;
        this.driftCharge = 0;
        this.driftLevel = 0;
      }
    } else if (!enabled || !inp.drift || fwdSpeed < 8 || this.airTime > 0.7) {
      this.endDrift(enabled && !!inp.drift === false);
    }

    let throttle = enabled ? clamp(inp.throttle, 0, 1) : 0;
    if (boosting && enabled) throttle = Math.max(throttle, 0.6);
    let brake = enabled ? clamp(inp.brake, 0, 1) : stunned ? 0.25 : 0;
    // The drift button acts as a handbrake only at low speed (hairpin flicks, turning around).
    const handbrake = this.enabled ? !stunned && !!inp.handbrake && !this.drifting && (fwdSpeed < 13 || !inp.drift) : true;
    let driveDir = 1;
    this.reversing = false;
    // Brake pedal reverses once the car is (almost) stopped.
    // Holding brake at a standstill engages reverse after a short pause, so braking to a
    // stop doesn't immediately shoot the car backwards.
    if (brake > 0.1 && fwdSpeed < 1.0 && throttle < 0.1) this.reverseHold += dt;
    else if (brake <= 0.1) this.reverseHold = 0;
    if (brake > 0.1 && fwdSpeed < 1.0 && throttle < 0.1 && (this.reverseHold > 0.3 || fwdSpeed < -0.5)) {
      this.reversing = true;
      driveDir = -1;
      throttle = brake;
      brake = 0;
    } else if (throttle > 0.1 && fwdSpeed < -1.0) {
      // Pressing throttle while rolling backwards brakes first.
      brake = throttle;
      throttle = 0;
    }
    this.braking = brake > 0.05;

    // ---------- Gearbox (drives RPM, sound and a small shift cut) ----------
    const absV = Math.abs(fwdSpeed);
    if (this.reversing) {
      this.gear = -1;
    } else {
      if (this.gear < 1) this.gear = 1;
      const top = this.gearTop[this.gear - 1];
      if (absV > top * 0.97 && this.gear < def.gearCount && throttle > 0.1) {
        this.gear++;
        this.shiftTimer = 0.16;
      } else if (this.gear > 1 && absV < this.gearTop[this.gear - 2] * 0.72) {
        this.gear--;
      }
    }
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const gearIdx = Math.max(0, this.gear - 1);
    const gearTop = this.gear < 0 ? 14 : this.gearTop[gearIdx];
    const rpmNorm = clamp(absV / gearTop, 0, 1.05);
    const targetRpm = lerp(def.idleRPM, def.redlineRPM, rpmNorm);
    // Free-revving when off the ground / at standstill with throttle
    // Revving on the grid (inputs disabled) or with the wheels in the air.
    const revInput = enabled ? throttle : clamp(inp.throttle, 0, 1);
    const freeRev = this.groundedWheels === 0 || (absV < 3 && revInput > 0.3) || !enabled ? revInput * 0.7 : 0;
    const rpmGoal = Math.max(targetRpm, lerp(def.idleRPM, def.redlineRPM, freeRev));
    this.rpm = lerp(this.rpm || def.idleRPM, rpmGoal, 1 - Math.exp(-12 * dt));

    // Engine force: traction limited at low speed, power limited at high speed.
    let engineForce = 0;
    if (throttle > 0) {
      const maxRev = 14;
      if (driveDir < 0) {
        engineForce = absV < maxRev ? -this.maxDriveForce * 0.5 * throttle : 0;
      } else {
        const od = this.overdriveTime > 0 ? 1.45 : 1;
        const powerLimited = (this.power * od) / Math.max(absV, 1);
        // Mild torque curve for character.
        const curve = 0.88 + 0.12 * Math.sin(rpmNorm * Math.PI);
        engineForce = Math.min(this.maxDriveForce * (od > 1 ? 1.3 : 1), powerLimited) * throttle * curve;
        if (this.shiftTimer > 0) engineForce *= 0.35;
      }
    }
    this.engineLoad = enabled ? throttle : revInput;
    // Traction control: back off the power when the driven rear tyres slide past their peak.
    const rearRatio = Math.max(this.wheels[2].slipRatio, this.wheels[3].slipRatio);
    if (!handbrake && driveDir > 0 && rearRatio > 1.05) engineForce *= Math.max(0.35, 1 - (rearRatio - 1.05) * 2.5);
    const brakeForce = brake * def.braking * this.mass;

    // ---------- Wheels ----------
    let grounded = 0;
    let surfaceGrass = 0;
    const rest = def.suspension.restLength;
    const driveFront = def.frontDriveBias;

    this.rough += dt;
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i];
      _origin.copy(wh.mount).applyQuaternion(_q).add(_pos);
      const maxLen = rest + wh.radius;
      const ray = this.rays[i];
      ray.origin.x = _origin.x;
      ray.origin.y = _origin.y;
      ray.origin.z = _origin.z;
      ray.dir.x = -_up.x;
      ray.dir.y = -_up.y;
      ray.dir.z = -_up.z;
      const hit = world.castRayAndGetNormal(ray, maxLen, true, undefined, this.rayGroups, undefined, body);
      wh.prevCompression = wh.compression;
      if (hit && hit.timeOfImpact <= maxLen) {
        grounded++;
        wh.grounded = true;
        wh.surface = this.physics.surfaceOf(hit.collider.handle);
        const surf = this.surfaceProps(wh.surface, boosting);
        if (surf.dust && wh.surface !== 'dirt') surfaceGrass++;
        wh.suspension = Math.max(0.02, hit.timeOfImpact - wh.radius);
        wh.compression = rest - wh.suspension;
        // Surface roughness (curbs rumble, grass bumps)
        let roughF = 0;
        if (surf.roughness > 0 && absV > 2) {
          roughF = Math.sin(this.rough * (absV * 6 + i * 3.1)) * surf.roughness * 0.6 * this.springK * 0.012;
        }
        wh.contact.set(_origin.x - _up.x * hit.timeOfImpact, _origin.y - _up.y * hit.timeOfImpact, _origin.z - _up.z * hit.timeOfImpact);
        wh.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        // Clamp the damper velocity: stepping onto a 5 cm curb within one physics step would
        // otherwise read as 6 m/s of compression and kick the car into the air.
        const compVel = clamp((wh.compression - wh.prevCompression) / dt, -1.5, 1.5);
        let force = this.springK * wh.compression + this.damperC * compVel + roughF;
        // Progressive bump stop
        if (wh.suspension < 0.07) force += Math.min(0.05, 0.07 - wh.suspension) * this.springK * 3;
        force = Math.min(Math.max(0, force), this.mass * 9.81 * 2.2);
        wh.load = force;
        _f.copy(_up).multiplyScalar(force * dt);
        body.applyImpulseAtPoint(_f, _origin, true);
      } else {
        wh.grounded = false;
        wh.suspension = Math.min(rest, wh.suspension + dt * 3);
        wh.compression = 0;
        wh.load = 0;
        wh.slipLateral = 0;
        wh.slipRatio = 0;
        wh.slipLong = 0;
      }
    }
    this.groundedWheels = grounded;
    let onCurb = false;
    for (const w of this.wheels) if (w.grounded && w.surface === 'curb') onCurb = true;
    this.surface = surfaceGrass >= 2 ? 'grass' : onCurb ? 'curb' : 'asphalt';

    // Anti-roll bars
    for (let axle = 0; axle < 2; axle++) {
      const l = this.wheels[axle * 2];
      const r = this.wheels[axle * 2 + 1];
      const diff = l.compression - r.compression;
      const f = diff * def.suspension.antiRoll * dt;
      if (l.grounded) {
        _origin.copy(l.mount).applyQuaternion(_q).add(_pos);
        body.applyImpulseAtPoint(_f.copy(_up).multiplyScalar(f), _origin, true);
      }
      if (r.grounded) {
        _origin.copy(r.mount).applyQuaternion(_q).add(_pos);
        body.applyImpulseAtPoint(_f.copy(_up).multiplyScalar(-f), _origin, true);
      }
    }

    // Tyre forces
    const cosS = Math.cos(-this.steerAngle);
    const sinS = Math.sin(-this.steerAngle);
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i];
      if (!wh.grounded) {
        // Free-spinning wheel slowly loses speed
        wh.spinSpeed *= 1 - dt * 0.5;
        if (wh.front === false && throttle > 0 && driveFront < 1) wh.spinSpeed += throttle * 60 * dt * driveDir;
        wh.spinAngle += wh.spinSpeed * dt;
        continue;
      }
      const surf = this.surfaceProps(wh.surface, boosting);
      // Wheel heading: body forward rotated by steer angle around body up.
      if (wh.front) {
        _wFwd.copy(_fwd).multiplyScalar(cosS).addScaledVector(_right, -sinS);
      } else {
        _wFwd.copy(_fwd);
      }
      const n = wh.normal;
      _wFwd.addScaledVector(n, -_wFwd.dot(n)).normalize();
      _wSide.crossVectors(_wFwd, n).normalize(); // wheel right

      _r.copy(wh.contact).sub(_com);
      _pv.crossVectors(_w, _r).add(_v);
      const vLong = _pv.dot(_wFwd);
      const vLat = _pv.dot(_wSide);

      // Lateral grip uses a capped load: landings and curb strikes spike the suspension
      // force, and full grip on that spike trips the car over (arcade: it just lands).
      const N = Math.min(wh.load, this.mass * 9.81 * 0.4 + def.downforce * this.speed * this.speed * 0.3);
      let mu = def.grip * surf.grip;
      const rear = !wh.front;
      // Slightly more rear grip than front = stable, predictable (understeer-biased) balance.
      if (rear) mu *= handbrake ? 0.55 : 1.08;
      if (this.overdriveTime > 0) mu *= 0.88;

      // Lateral: slip-angle based with saturation and a small drop after the peak.
      const slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 4));
      const peak = rear ? 0.13 : 0.12;
      let latCoef = slipAngle / peak;
      const absC = Math.abs(latCoef);
      // Past the peak the tyre keeps most of its grip (slick, forgiving); the handbrake
      // path above still lets the rear break away for drifts.
      if (absC > 1) latCoef = Math.sign(latCoef) * Math.max(handbrake && rear ? 0.8 : 0.93, 1 - (absC - 1) * 0.05);
      let fLat = -latCoef * mu * N;
      // Drifting / spinning: the arcade layer below steers the car; tyres only scrub.
      if (this.drifting) fLat *= 0.18;
      else if (this.driftRecover > 0) fLat *= lerp(1, 0.3, this.driftRecover / 0.45);
      else if (stunned) fLat *= 0.2;

      // Longitudinal
      let fLong = 0;
      const driveShare = wh.front ? driveFront : 1 - driveFront;
      // Each axle has two wheels, so split the axle share in half.
      if (driveShare > 0 && engineForce !== 0) fLong += (engineForce * driveShare) / 2;
      if (brakeForce > 0) {
        const share = wh.front ? 0.68 : 0.32;
        fLong -= (clamp(vLong * 3, -1, 1) * brakeForce * share) / 2;
      }
      if (rear && handbrake) {
        fLong -= clamp(vLong * 2, -1, 1) * this.mass * 5 * 0.5;
      }
      // Rolling resistance
      fLong -= clamp(vLong, -1, 1) * surf.rollingResistance * N;
      // Engine braking when coasting
      if (throttle === 0 && brake === 0 && driveShare > 0) fLong -= clamp(vLong * 0.5, -1, 1) * this.mass * 0.6 * driveShare / 2;

      // Friction ellipse: longitudinal takes priority up to the limit, lateral keeps a minimum share.
      const limit = mu * N;
      let slipLong = 0;
      // ABS / traction control: longitudinal force can use at most ~85% of the grip,
      // so braking or accelerating in a corner never removes all lateral grip.
      const longCap = limit * (rear && handbrake ? 1 : 0.85);
      if (Math.abs(fLong) > longCap) {
        slipLong = (Math.abs(fLong) - longCap) / (this.mass * 0.25);
        fLong = Math.sign(fLong) * longCap;
      }
      const minLat = handbrake && rear ? 0.55 : rear ? 0.85 : 0.75;
      const latLimit = limit * Math.max(minLat, Math.sqrt(Math.max(0, 1 - (fLong / limit) ** 2)));
      if (Math.abs(fLat) > latLimit) fLat = Math.sign(fLat) * latLimit;

      wh.slipLateral = Math.abs(vLat);
      wh.slipRatio = Math.abs(vLong) > 2 || Math.abs(vLat) > 2 ? absC : 0;
      wh.slipLong = slipLong;

      // Apply at contact point raised towards the centre of mass to reduce body roll.
      _pt.copy(wh.contact).addScaledVector(_up, (_com.dot(_up) - wh.contact.dot(_up)) * 0.86);
      _f.copy(_wFwd).multiplyScalar(fLong * dt).addScaledVector(_wSide, fLat * dt);
      body.applyImpulseAtPoint(_f, _pt, true);

      // Visual spin
      const locked = rear && handbrake;
      let spin = vLong / wh.radius;
      if (locked) spin = 0;
      else if (slipLong > 0 && driveShare > 0 && engineForce !== 0) spin += Math.sign(engineForce) * slipLong * 8;
      wh.spinSpeed = spin;
      wh.spinAngle += spin * dt;
    }

    // ---------- Aero ----------
    const v2 = this.speed * this.speed;
    if (this.speed > 0.1) {
      const dragScale = (1 - 0.35 * this.slipstream) * (boosting ? 0.6 : 1) * (this.overdriveTime > 0 ? 0.62 : 1);
      _f.copy(_v).normalize().multiplyScalar(-this.dragCoef * dragScale * v2 * dt);
      body.applyImpulse(_f, true);
    }
    if (boosting && grounded > 0 && !this.reversing) {
      const cap = this.topSpeed * 1.38;
      const k = clamp(1 - fwdSpeed / cap, 0, 1);
      _f.copy(_fwd).multiplyScalar(this.mass * this.boostAccel * (0.35 + 0.65 * k) * dt);
      body.applyImpulse(_f, true);
    }
    if (grounded > 0) {
      _f.copy(_up).multiplyScalar(-def.downforce * v2 * dt);
      body.applyImpulse(_f, true);
    }

    // ---------- Stability / air control ----------
    if (grounded === 0) {
      this.airTime += dt;
      // Level the car in the air so jumps land wheels-down (arcade): spring toward upright
      // plus damping of pitch/roll rates (yaw is kept).
      _axis.crossVectors(_up, LOCAL_UP);
      const k = this.mass * 5 * dt;
      body.applyTorqueImpulse({ x: _axis.x * k, y: 0, z: _axis.z * k }, true);
      const yawR = _w.dot(_up);
      _axis.copy(_w).addScaledVector(_up, -yawR);
      body.applyTorqueImpulse(_axis.multiplyScalar(-this.mass * 3 * dt), true);
    } else {
      if (this.airTime > 0.25) {
        // Arcade landing: soak up the impact instead of bouncing off the springs.
        this.landed = this.airTime;
        this.sinceLanding = 0;
        const lv = body.linvel();
        if (lv.y < 0) body.setLinvel({ x: lv.x, y: lv.y * 0.15, z: lv.z }, true);
        const yawR = _w.dot(_up);
        body.setAngvel({ x: _up.x * yawR, y: _up.y * yawR, z: _up.z * yawR }, true);
      }
      this.airTime = 0;
      // Stability control: yaw damping that ramps up with the body slip angle, so slides
      // are caught instead of turning into spins. Mostly off with the handbrake (drifting).
      const yawRate = _w.dot(_up);
      let bodySlip = 0;
      const planar = Math.hypot(_v.x, _v.z);
      if (planar > 5 && fwdSpeed > 0) {
        const vx = _v.x / planar;
        const vz = _v.z / planar;
        const fl = Math.hypot(_fwd.x, _fwd.z) || 1;
        bodySlip = Math.abs(Math.asin(clamp((_fwd.x / fl) * vz - (_fwd.z / fl) * vx, -1, 1)));
      }
      const esc = handbrake ? 0 : clamp((bodySlip - 0.05) / 0.2, 0, 1);
      const assist = handbrake ? 0.1 : 0.35 + esc * 1.4;
      body.applyTorqueImpulse(_f.copy(_up).multiplyScalar(-yawRate * this.mass * assist * dt), true);

      // Roll/pitch damping while on the ground: bumps and impacts settle instead of
      // rocking the chassis (the suspension springs still do their job).
      _axis.copy(_w).addScaledVector(_up, -yawRate);
      body.applyTorqueImpulse(_axis.multiplyScalar(-this.mass * 2.2 * dt), true);


    }
    // Signed body slip (nose vs direction of travel).
    {
      const planar = Math.hypot(_v.x, _v.z);
      this.bodySlip = planar > 3 ? wrapPi(Math.atan2(_fwd.x, _fwd.z) - Math.atan2(_v.x, _v.z)) : 0;
    }

    if (this.drifting && grounded > 0) {
      // Assisted drift: steering picks how tight the arc is; the car holds a slip angle
      // into the turn and the path bends with a centripetal impulse (arcade, predictable).
      this.driftTime += dt;
      const dir = this.driftDir;
      const tight = clamp((this.steerInput * dir + 1) / 2, 0, 1);
      const speedNow = Math.max(8, Math.hypot(_v.x, _v.z));
      const latAcc = lerp(8, 23, tight) * (this.def.arcade?.driftTurn ?? 1);
      const turnRate = latAcc / speedNow; // rad/s, positive = turning right
      // Rotate the planar velocity (turning right decreases yaw in three.js coordinates).
      const ang = -dir * turnRate * dt;
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const nvx = _v.x * c + _v.z * sn;
      const nvz = -_v.x * sn + _v.z * c;
      const loss = 1 - 0.035 * dt; // drifting scrubs a little speed
      body.applyImpulse({ x: (nvx * loss - _v.x) * this.mass, y: 0, z: (nvz * loss - _v.z) * this.mass }, true);
      const targetSlip = -dir * lerp(0.26, 0.52, tight);
      const yawTarget = -dir * turnRate + (targetSlip - this.bodySlip) * 4.5;
      const w = body.angvel();
      const yr = w.x * _up.x + w.y * _up.y + w.z * _up.z;
      const d = yawTarget - yr;
      body.setAngvel({ x: w.x + _up.x * d, y: w.y + _up.y * d, z: w.z + _up.z * d }, true);
      // Charge: good angle on tarmac at speed charges fastest.
      if (this.surface !== 'grass' && grounded >= 3) {
        const a = Math.abs(this.bodySlip);
        let rate = a > 0.17 && a < 0.75 ? 1 : 0.35;
        if (speedNow < 18) rate *= 0.5;
        rate *= this.def.arcade?.driftCharge ?? 1;
        this.driftCharge += rate * dt;
        const L = CarPhysics.DRIFT_LEVELS;
        this.driftLevel = this.driftCharge >= L[2] ? 3 : this.driftCharge >= L[1] ? 2 : this.driftCharge >= L[0] ? 1 : 0;
      }
    }

    if (!this.drifting && this.driftRecover > 0) {
      // Drift exit: straighten the car along its direction of travel instead of letting
      // the tyres bite at full slip angle (which snaps it into a spin).
      this.driftRecover = Math.max(0, this.driftRecover - dt);
      if (grounded > 0 && Math.abs(this.bodySlip) > 0.03) {
        const w = body.angvel();
        const yr = w.x * _up.x + w.y * _up.y + w.z * _up.z;
        const target = -this.bodySlip * 5;
        const d = (target - yr) * Math.min(1, dt * 12);
        body.setAngvel({ x: w.x + _up.x * d, y: w.y + _up.y * d, z: w.z + _up.z * d }, true);
      }
    }

    if (stunned) {
      // Spin out: forced yaw rotation, scrub speed.
      const w = body.angvel();
      const yr = w.x * _up.x + w.y * _up.y + w.z * _up.z;
      const target = this.stunSpin * Math.min(1, this.stunTime * 1.4);
      const d = target - yr;
      body.setAngvel({ x: w.x + _up.x * d, y: w.y + _up.y * d, z: w.z + _up.z * d }, true);
      body.applyImpulse({ x: -_v.x * this.mass * 1.2 * dt, y: 0, z: -_v.z * this.mass * 1.2 * dt }, true);
    }

    // Impacts must never fling the car into a spin: cap yaw rate (handbrake drifts exempt),
    // on the ground and in the air.
    if (!this.drifting && !stunned) {
      const w = body.angvel();
      const yr = w.x * _up.x + w.y * _up.y + w.z * _up.z;
      const maxYaw = handbrake ? 4 : 2.6;
      if (Math.abs(yr) > maxYaw) {
        const excess = yr - Math.sign(yr) * maxYaw;
        body.setAngvel({ x: w.x - _up.x * excess, y: w.y - _up.y * excess, z: w.z - _up.z * excess }, true);
      }
    }
    if (_up.y < 0.25) this.upsideDownTime += dt;
    else this.upsideDownTime = 0;
  }

  /** Surface properties; a boost blasts through the off-road penalty. */
  private surfaceProps(type: SurfaceType, boosting: boolean) {
    const s = SURFACES[type];
    if (!s.dust) return s;
    if (boosting) return { grip: Math.max(s.grip, 0.9), rollingResistance: 0.015, roughness: s.roughness * 0.5, dust: true };
    const k = this.def.arcade?.offroad ?? 1;
    if (k === 1) return s;
    // Off-road specialists (rally) feel less of the penalty; track cars feel more.
    return {
      grip: clamp(lerp(0.95, s.grip, k), 0.3, 1),
      rollingResistance: Math.max(0.01, lerp(0.015, s.rollingResistance, k)),
      roughness: s.roughness * Math.min(1, k),
      dust: true,
    };
  }

  /** Distance from the body origin to the ground under each wheel (for visuals). */
  wheelOffsetY(i: number): number {
    return this.wheels[i].mount.y - this.wheels[i].suspension;
  }
}
