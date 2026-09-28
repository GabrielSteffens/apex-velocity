import * as THREE from 'three';
import type { AIProfile } from '../data/types';
import type { CarController } from '../car/CarController';
import type { CarInput } from '../car/CarPhysics';
import type { Car } from '../car/Car';
import type { RacingLine } from './RacingLine';
import { clamp, lerp, moveTowards, Random } from '../core/math';

export interface AIContext {
  cars: Car[];
  line: RacingLine;
  /** True once the lights went green. */
  isRacing(): boolean;
  /** Seconds since the green light. */
  raceTime(): number;
}

type Mistake = { kind: 'late-brake' | 'wide' | 'wobble'; time: number; dir: number };

const _local = new THREE.Vector3();
const _target = new THREE.Vector3();
const _inv = new THREE.Quaternion();

/**
 * Racing AI driving the same physics as the player:
 *  - follows a precomputed racing line with pure-pursuit steering
 *  - brakes using the line's speed profile (scaled by skill)
 *  - picks overtaking lines around slower cars, avoids side-by-side contact
 *  - makes occasional mistakes (late braking, running wide, wobbles)
 *  - recovers when stuck (reverses out) or asks for a reset when lost
 */
export class AIController implements CarController {
  readonly kind = 'ai' as const;
  private rng: Random;
  private avoidOffset = 0;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private reverseSteer = 0;
  private mistake: Mistake | null = null;
  private lapPace = 1;
  private lastLap = -2;
  private wobblePhase = 0;
  private heldUp = 0;
  private passSide = 0;
  private passTimer = 0;
  /** Whether the car should be put back on track by the race manager. */
  wantsReset = false;
  /** Scales pace (used for post-race cool-down laps and gentle rubber-banding). */
  paceScale = 1;

  constructor(
    readonly car: Car,
    readonly profile: AIProfile,
    readonly ctx: AIContext,
    seed: number,
  ) {
    this.rng = new Random(seed);
  }

  onReset(): void {
    this.stuckTimer = 0;
    this.reverseTimer = 0;
    this.avoidOffset = 0;
    this.mistake = null;
    this.wantsReset = false;
  }

  update(dt: number, input: CarInput): void {
    const car = this.car;
    const ph = car.physics;
    const prog = car.progress;
    const track = car.track;
    const line = this.ctx.line;
    const p = this.profile;

    if (!this.ctx.isRacing()) {
      input.throttle = 0;
      input.brake = 0;
      input.steer = 0;
      input.handbrake = false;
      return;
    }
    // Reaction time at the start
    if (this.ctx.raceTime() < p.reactionTime) {
      input.throttle = 0;
      input.brake = 0;
      return;
    }

    // New lap -> new pace variation depending on consistency.
    if (prog.lapsCompleted !== this.lastLap) {
      this.lastLap = prog.lapsCompleted;
      const spread = (1 - p.consistency) * 0.05;
      this.lapPace = 1 - spread * this.rng.next();
    }

    const v = ph.forwardSpeed;
    const speed = Math.max(0, v);
    const s = prog.proj.s;

    // ---------- Mistakes ----------
    if (!this.mistake && speed > 15 && this.rng.next() < (p.mistakeRate / 60) * dt) {
      const r = this.rng.next();
      this.mistake = {
        kind: r < 0.4 ? 'late-brake' : r < 0.75 ? 'wide' : 'wobble',
        time: this.rng.range(1.0, 2.2),
        dir: this.rng.next() < 0.5 ? -1 : 1,
      };
    }
    let mistakeSpeed = 1;
    let mistakeOffset = 0;
    let mistakeSteer = 0;
    if (this.mistake) {
      this.mistake.time -= dt;
      if (this.mistake.kind === 'late-brake') mistakeSpeed = 1.07;
      else if (this.mistake.kind === 'wide') mistakeOffset = this.mistake.dir * 2.2;
      else {
        this.wobblePhase += dt * 9;
        mistakeSteer = Math.sin(this.wobblePhase) * 0.12;
      }
      if (this.mistake.time <= 0) this.mistake = null;
    }

    // ---------- Traffic: overtaking and avoidance ----------
    const myLat = prog.proj.lateral;
    const halfW = track.halfWidth - 1.3;
    const skill = lerp(0.78, 0.985, p.skill) * this.lapPace * mistakeSpeed * this.paceScale;
    const ownPace = line.speedAt(s + 20) * skill;
    let blocker: Car | null = null;
    let blockerDs = Infinity;
    let sideAvoid = 0;
    for (const o of this.ctx.cars) {
      if (o === car) continue;
      const ds = track.deltaS(s, o.progress.proj.s);
      if (ds < -6 || ds > 40) continue;
      const dLat = o.progress.proj.lateral - myLat;
      if (ds > 2 && Math.abs(dLat) < 2.4 && ds < blockerDs) {
        blocker = o;
        blockerDs = ds;
      }
      // Side-by-side: keep a lateral gap.
      if (Math.abs(ds) < 5.5 && Math.abs(dLat) < 2.8) {
        sideAvoid += (dLat > 0 ? -1 : 1) * (2.8 - Math.abs(dLat)) * 1.1;
      }
    }

    let followSpeed = Infinity;
    let desiredAvoid = 0;
    if (blocker && blockerDs < 30) {
      const oSpeed = Math.max(0, blocker.physics.forwardSpeed);
      const oLat = blocker.progress.proj.lateral;
      // Being held up: our natural pace is higher than theirs.
      if (ownPace > oSpeed + 0.3 || speed > oSpeed + 1) this.heldUp += dt;
      else this.heldUp = Math.max(0, this.heldUp - dt * 0.5);
      if (this.passSide === 0 && this.heldUp > lerp(1.2, 0.25, p.aggression)) {
        const roomLeft = oLat - 3.2 > -halfW;
        const roomRight = oLat + 3.2 < halfW;
        const lineHere = line.offsetAt(s + blockerDs);
        if (roomLeft && roomRight) this.passSide = oLat > lineHere ? -1 : 1;
        else if (roomLeft) this.passSide = -1;
        else if (roomRight) this.passSide = 1;
        this.passTimer = 5;
      }
      if (this.passSide !== 0) {
        const wantLat = clamp(oLat + this.passSide * 3.3, -halfW, halfW);
        desiredAvoid = wantLat - line.offsetAt(s + 15);
      }
      // Don't rear-end: while still directly behind, match speed.
      const gapLat = Math.abs(oLat - myLat);
      if (blockerDs < 8 + speed * 0.3 && gapLat < 2.0) {
        followSpeed = oSpeed + (blockerDs - 6) * 0.6;
      }
    } else {
      this.heldUp = Math.max(0, this.heldUp - dt);
    }
    if (this.passSide !== 0) {
      this.passTimer -= dt;
      if (this.passTimer <= 0 || !blocker) this.passSide = 0;
    }
    desiredAvoid += sideAvoid;
    this.avoidOffset = moveTowards(this.avoidOffset, desiredAvoid, dt * (desiredAvoid === 0 ? 1.5 : 3.2));

    // ---------- Steering (pure pursuit) ----------
    const look = clamp(7 + speed * 0.5, 8, 36);
    const ts = s + look;
    let lat = line.offsetAt(ts) + this.avoidOffset + mistakeOffset + p.lineBias * 0.8;
    lat = clamp(lat, -halfW, halfW);
    track.offsetPoint(ts, lat, _target);
    _inv.copy(ph.quaternion).invert();
    _local.copy(_target).sub(ph.position).applyQuaternion(_inv);
    // Car-local: +Z forward, +X left.
    const alpha = Math.atan2(-_local.x, _local.z);
    const L = ph.def.dimensions.wheelBase;
    const delta = Math.atan((2 * L * Math.sin(alpha)) / Math.max(look, 1));
    let steer = delta / ph.maxSteerAngle(speed);
    steer += mistakeSteer;
    // Counter-steer when the rear steps out.
    const yawRate = ph.body.angvel().y;
    steer += clamp(yawRate * 0.05, -0.2, 0.2) * (ph.wheels[2].slipRatio > 1.4 ? 1 : 0);
    steer = clamp(steer, -1, 1);

    // ---------- Speed ----------
    const leadS = s + speed * 0.3;
    let targetSpeed = Math.min(line.speedAt(leadS), line.speedAt(leadS + 8)) * skill;
    targetSpeed = Math.min(targetSpeed, followSpeed);
    // Off the tarmac: be careful.
    if (prog.proj.distance > track.halfWidth + 1) targetSpeed = Math.min(targetSpeed, 22);
    // Big heading error (spun, rejoining): slow down.
    if (Math.abs(alpha) > 0.9) targetSpeed = Math.min(targetSpeed, 9);

    let throttle = 0;
    let brake = 0;
    const err = targetSpeed - speed;
    if (err > 0) throttle = clamp(err * 0.35 + 0.35, 0, 1);
    else if (err < -0.8) brake = clamp(-err * 0.18, 0, 1);
    else throttle = 0.15;
    // Simple traction control
    const rearSlip = Math.max(ph.wheels[2].slipRatio, ph.wheels[3].slipRatio);
    if (rearSlip > 1.5) throttle *= 0.5;

    // ---------- Stuck / recovery ----------
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      input.throttle = 0;
      input.brake = 1;
      input.steer = this.reverseSteer;
      input.handbrake = false;
      if (this.reverseTimer <= 0) this.stuckTimer = 0;
      return;
    }
    if (speed < 1.5 && throttle > 0.3 && ph.groundedWheels > 0) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.4) {
        this.reverseTimer = 1.3;
        this.reverseSteer = -Math.sign(steer || 1);
        this.stuckTimer = 0;
      }
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt);
    }
    if (ph.upsideDownTime > 1.5 || prog.offTrackTime > 8 || prog.proj.distance > track.def.barrierOffset + 8) {
      this.wantsReset = true;
    }
    if (prog.wrongWay && speed > 5) {
      brake = 1;
      throttle = 0;
    }

    input.throttle = throttle;
    input.brake = brake;
    input.steer = steer;
    input.handbrake = false;
  }
}
