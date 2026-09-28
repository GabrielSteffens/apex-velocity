import * as THREE from 'three';
import type { RaceDefinition } from '../data/types';
import { RaceManager } from './RaceManager';
import type { TrackScene } from './TrackScene';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { SURFACES } from '../physics/PhysicsWorld';
import { CarVisual } from '../car/CarVisual';
import { PlayerController } from '../car/PlayerController';
import { AIController } from '../ai/AIController';
import type { Input } from '../core/Input';
import type { AudioManager } from '../audio/AudioManager';
import type { ParticleManager } from '../effects/ParticleManager';
import type { SkidMarks } from '../effects/SkidMarks';
import type { ChaseCamera } from '../camera/ChaseCamera';
import type { Car } from '../car/Car';

export interface SessionServices {
  scene: THREE.Scene;
  physics: PhysicsWorld;
  trackScene: TrackScene;
  input: Input;
  audio: AudioManager;
  particles: ParticleManager;
  skids: SkidMarks;
  camera: ChaseCamera;
}

export interface SessionUIHooks {
  countdown(value: number): void;
  go(): void;
  toast(text: string, sub?: string): void;
  playerFinished(position: number): void;
  raceComplete(): void;
}

const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const _n = new THREE.Vector3();
const _pt = { x: 0, y: 0, z: 0 };
const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();

interface CarFx {
  lastGear: number;
  smokeAcc: number;
  exhaustAcc: number;
  lastImpact: number;
}

/**
 * One race: owns the RaceManager and the per-car visuals, and wires race events to
 * audio, particles, camera shake and the UI.
 */
export class RaceSession {
  readonly rm: RaceManager;
  private visuals: CarVisual[] = [];
  private fx = new Map<Car, CarFx>();
  private unsubscribe: () => void;
  private time = 0;
  private otherA = { rpm: 0, load: 0, distance: 0, pan: 0 };
  private otherB = { rpm: 0, load: 0, distance: 0, pan: 0 };
  private othersBuf: { rpm: number; load: number; distance: number; pan: number }[] = [];

  constructor(
    private readonly svc: SessionServices,
    race: RaceDefinition,
    aiPace: number,
    ui: SessionUIHooks,
  ) {
    const ts = svc.trackScene;
    this.rm = new RaceManager(svc.physics, ts.track, ts.layout, race, ts.line);
    this.rm.cars.forEach((car, i) => {
      if (car.isPlayer) car.controller = new PlayerController(svc.input);
      else if (car.controller instanceof AIController) car.controller.paceScale = aiPace;
      this.visuals.push(new CarVisual(car, svc.scene, car.isPlayer ? 7 : i + 11));
      this.fx.set(car, { lastGear: 1, smokeAcc: 0, exhaustAcc: 0, lastImpact: 0 });
    });
    ts.scenery.setStartLights(0, false);

    const byCollider = new Map(this.rm.cars.map((c) => [c.physics.collider.handle, c]));
    const barriers = ts.colliders.barrierHandles;
    this.unsubscribe = svc.physics.onContactForce((e) => {
      const a = byCollider.get(e.colliderA);
      const b = byCollider.get(e.colliderB);
      if (!a && !b) return;
      const wall = barriers.has(e.colliderA) || barriers.has(e.colliderB);
      if (!wall && !(a && b)) return; // ground contacts are handled by suspension
      const car = (a ?? b)!;
      this.onImpact(car, a && b ? (car === a ? b : a) : null, e.force, e.colliderA, e.colliderB, wall);
    });

    this.rm.events = {
      countdown: (v) => {
        ts.scenery.setStartLights(Math.round(((4 - v) * 5) / 3), false);
        svc.audio.countdownBeep(false);
        ui.countdown(v);
      },
      go: () => {
        ts.scenery.setStartLights(0, true);
        svc.audio.countdownBeep(true);
        ui.go();
      },
      lap: (car, t, best) => {
        if (!car.isPlayer) return;
        svc.audio.lap();
        const lapNo = car.progress.lapsCompleted;
        if (best && lapNo > 1) ui.toast('Best Lap', formatLap(t));
        else ui.toast(`Lap ${lapNo + 1}`, formatLap(t));
      },
      finalLap: (car) => {
        if (car.isPlayer) setTimeout(() => ui.toast('Final Lap', 'Push!'), 1200);
      },
      finish: (car, pos) => {
        if (!car.isPlayer) return;
        svc.audio.finish(pos === 1);
        ui.playerFinished(pos);
      },
      complete: () => ui.raceComplete(),
      reset: (car) => {
        // Soft re-acquire: the camera glides to the new position instead of cutting.
        if (car.isPlayer) svc.camera.snap();
      },
    };
  }

  /** Headlights on/off for every car (real spotlight only on the player's car). */
  setNight(on: boolean): void {
    for (const v of this.visuals) v.setNight(on, v.car.isPlayer);
  }

  get player(): Car | null {
    return this.rm.player;
  }

  startCountdown(): void {
    this.rm.startCountdown();
  }

  fixedStep(dt: number): void {
    this.rm.step(dt);
    this.svc.physics.step();
    this.rm.postStep(dt);
  }

  private onImpact(car: Car, other: Car | null, force: number, ca: number, cb: number, wall: boolean): void {
    const f = this.fx.get(car);
    if (!f) return;
    if (this.time - f.lastImpact < 0.12) return;
    f.lastImpact = this.time;
    const strength = Math.min(1, force / (car.physics.def.mass * 90));
    if (strength < 0.04) return;
    const found = this.svc.physics.contactPoint(ca, cb, _pt);
    _p.set(_pt.x, _pt.y, _pt.z);
    if (!found) _p.copy(car.physics.position);
    // Spark direction: away from the barrier / other car, roughly along travel.
    _n.copy(car.physics.velocity).multiplyScalar(0.05);
    if (strength > 0.08) this.svc.particles.sparksAt(_p, _n, strength);
    const involvesPlayer = car.isPlayer || other?.isPlayer;
    const cam = this.svc.camera.camera.position;
    const dist = cam.distanceTo(_p);
    if (involvesPlayer) {
      this.svc.camera.shake(0.15 + strength * 0.6);
      this.svc.audio.impact(strength, wall);
    } else if (dist < 60) {
      this.svc.audio.impact(strength * (1 - dist / 60) * 0.6, wall);
    }
  }

  /** Per-frame (not per physics step) update: visuals, effects and audio. */
  frameUpdate(dt: number, alpha: number): void {
    this.time += dt;
    const { particles, skids, audio } = this.svc;
    const racing = this.rm.phase !== 'grid';
    let playerSkid = 0;
    let playerRough = 0;
    for (const car of this.rm.cars) {
      car.visual?.sync(alpha, dt);
      const ph = car.physics;
      const f = this.fx.get(car)!;
      const near = this.svc.camera.camera.position.distanceToSquared(ph.position) < 160 * 160;
      let skidSum = 0;
      for (let i = 0; i < 4; i++) {
        const w = ph.wheels[i];
        if (!w.grounded) {
          skids.add(car.id * 4 + i, w.contact, _side, 0.12, 0);
          continue;
        }
        const surf = SURFACES[w.surface];
        // Only slides past the tyre's peak slip angle mark the road / smoke.
        const lat = Math.min(1, Math.max(0, w.slipRatio - 1.15) * 1.2) * Math.min(1, w.slipLateral / 3);
        const handbrake = ph.input.handbrake && !w.front && ph.speed > 3 && ph.enabled ? 0.6 : 0;
        const spin = Math.min(1, w.slipLong * 0.6);
        const intensity = Math.min(1, lat + handbrake + spin);
        // Wheel lateral axis (car right rotated by steer)
        _side.set(-1, 0, 0).applyQuaternion(ph.quaternion);
        if (w.front) _side.applyAxisAngle(ph.up, -ph.steerAngle);
        if (!surf.dust) {
          skids.add(car.id * 4 + i, w.contact, _side, 0.12, intensity > 0.2 ? intensity : 0);
          skidSum += intensity;
          if (near && intensity > 0.3) {
            f.smokeAcc += dt * intensity * 22;
            while (f.smokeAcc > 1) {
              f.smokeAcc -= 1;
              particles.tireSmoke(w.contact, ph.velocity, intensity);
            }
          }
        } else {
          skids.add(car.id * 4 + i, w.contact, _side, 0.12, 0);
          if (near && ph.speed > 4) {
            f.smokeAcc += dt * Math.min(1, ph.speed / 25) * 6;
            while (f.smokeAcc > 1) {
              f.smokeAcc -= 1;
              particles.dust(w.contact, ph.velocity, Math.min(1, ph.speed / 20));
            }
          }
          if (car.isPlayer) playerRough = Math.max(playerRough, surf.roughness);
        }
        if (car.isPlayer && w.surface === 'curb') playerRough = Math.max(playerRough, SURFACES.curb.roughness * 0.8);
      }
      if (car.isPlayer) playerSkid = Math.min(1, skidSum / 2);

      // Exhaust puffs and up-shift pops
      if (near && car.visual) {
        const vis = car.visual as CarVisual;
        f.exhaustAcc += dt * (4 + ph.engineLoad * 18);
        const shifted = ph.gear > f.lastGear && ph.gear > 1;
        _dir.copy(ph.forward).negate();
        for (const e of vis.parts.exhausts) {
          _v.copy(e).applyQuaternion(ph.quaternion).add(ph.position);
          if (f.exhaustAcc > 1) particles.exhaust(_v, _dir, 0.4 + ph.engineLoad);
          if (shifted && ph.engineLoad > 0.6) particles.flame(_v, _dir);
        }
        if (shifted && ph.engineLoad > 0.6 && car.isPlayer) audio.backfire();
        if (f.exhaustAcc > 1) f.exhaustAcc = 0;
      }
      f.lastGear = ph.gear;
    }
    skids.update();

    // Audio mix
    const p = this.rm.player;
    if (p) {
      const cam = this.svc.camera.camera;
      const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion);
      // Two nearest opponents, found without allocating arrays every frame.
      let n0: Car | null = null;
      let n1: Car | null = null;
      let d0 = Infinity;
      let d1 = Infinity;
      for (const c of this.rm.cars) {
        if (c === p) continue;
        const d = c.physics.position.distanceTo(cam.position);
        if (d < d0) {
          n1 = n0;
          d1 = d0;
          n0 = c;
          d0 = d;
        } else if (d < d1) {
          n1 = c;
          d1 = d;
        }
      }
      const others = this.othersBuf;
      others.length = 0;
      this.fillOther(n0, d0, this.otherA, cam.position, right);
      this.fillOther(n1, d1, this.otherB, cam.position, right);
      audio.updateDriving({
        rpm: p.physics.rpm,
        load: p.physics.enabled ? p.physics.engineLoad : Math.min(1, this.svc.input.throttle),
        speed: p.physics.speed,
        skid: playerSkid,
        rough: playerRough,
        others,
        active: racing,
      });
    }
  }

  private fillOther(c: Car | null, d: number, slot: { rpm: number; load: number; distance: number; pan: number }, camPos: THREE.Vector3, right: THREE.Vector3): void {
    if (!c) return;
    slot.rpm = c.physics.rpm;
    slot.load = c.physics.engineLoad;
    slot.distance = d;
    slot.pan = Math.max(-1, Math.min(1, _p.copy(c.physics.position).sub(camPos).normalize().dot(right)));
    this.othersBuf.push(slot);
  }

  dispose(): void {
    this.unsubscribe();
    this.rm.dispose();
    this.visuals = [];
    this.svc.skids.clear();
    this.svc.trackScene.scenery.setStartLights(0, false);
  }
}

function formatLap(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
