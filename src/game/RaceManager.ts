import type { AIProfile, RaceDefinition } from '../data/types';
import { getCar } from '../data/cars';
import { getAIProfile } from '../data/aiProfiles';
import { Car } from '../car/Car';
import { CarPhysics } from '../car/CarPhysics';
import { AIController, type AIContext } from '../ai/AIController';
import { RacingLine } from '../ai/RacingLine';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { TrackGeometry } from '../track/TrackGeometry';
import type { TrackLayout } from '../track/TrackLayout';
import { ItemSystem } from '../gameplay/Items';
import { TrackFeatures } from '../gameplay/TrackFeatures';

export type RacePhase = 'grid' | 'countdown' | 'racing' | 'finished';

export interface RaceEvents {
  countdown?(value: number): void;
  go?(): void;
  lap?(car: Car, lapTime: number, isBest: boolean): void;
  finalLap?(car: Car): void;
  finish?(car: Car, position: number): void;
  /** Every car has finished (or the timeout after the player finished expired). */
  complete?(): void;
  reset?(car: Car): void;
}

export const COUNTDOWN_SECONDS = 3;

/** Driver profile used when a human-driven car finishes and continues on autopilot. */
const AUTOPILOT: AIProfile = {
  id: 'autopilot',
  driverName: 'Autopilot',
  skill: 0.8,
  aggression: 0.2,
  consistency: 1,
  mistakeRate: 0,
  reactionTime: 0,
  lineBias: 0,
  color: 0xffffff,
};

/**
 * Owns the race rules: grid, countdown, lap/checkpoint progress, standings and the finish.
 * Independent of rendering and input so it can be driven headlessly for tests.
 */
export class RaceManager {
  readonly cars: Car[] = [];
  readonly line: RacingLine;
  phase: RacePhase = 'grid';
  countdown = COUNTDOWN_SECONDS + 1;
  raceTime = 0;
  standings: Car[] = [];
  finishOrder: Car[] = [];
  player: Car | null = null;
  events: RaceEvents = {};
  /** Seconds the race continues after the player finishes, so AI can complete. */
  private completeTimer = -1;
  private lastCountdownValue = -1;
  private bestLapOverall = Infinity;
  readonly aiContext: AIContext;
  readonly items: ItemSystem;
  readonly features: TrackFeatures;

  constructor(
    readonly physics: PhysicsWorld,
    readonly track: TrackGeometry,
    readonly layout: TrackLayout,
    readonly race: RaceDefinition,
    line?: RacingLine,
  ) {
    const car0 = getCar(race.participants[0]?.carId ?? 'falcon-r');
    this.line = line ?? new RacingLine(track, {
      edgeMargin: 1.7,
      lateralAccel: car0.grip * 9.81 * 0.86,
      brakeDecel: car0.braking * 0.72,
      topSpeed: car0.topSpeed / 3.6,
    });
    this.items = new ItemSystem(track, this.cars, 17);
    this.features = new TrackFeatures(track, layout, this.cars);
    this.aiContext = {
      cars: this.cars,
      line: this.line,
      isRacing: () => this.phase === 'racing' || this.phase === 'finished',
      raceTime: () => this.raceTime,
      items: this.items,
      layout,
    };

    const slots = layout.gridSlots(race.participants.length);
    race.participants.forEach((pc, i) => {
      const def = getCar(pc.carId);
      const slot = slots[i];
      const spawn = slot.position.clone();
      spawn.y += CarPhysics.restHeight(def) + 0.02;
      const isPlayer = pc.aiProfileId === null;
      const profile = pc.aiProfileId ? getAIProfile(pc.aiProfileId) : null;
      const color = pc.color ?? profile?.color ?? def.style.bodyColor;
      const car = new Car(physics, track, def, pc.name ?? profile?.driverName ?? 'Driver', color, isPlayer, race.laps, spawn, slot.heading);
      car.physics.enabled = false;
      if (profile) car.controller = new AIController(car, profile, this.aiContext, 1000 + i * 7919);
      if (isPlayer) this.player = car;
      this.cars.push(car);
    });
    this.standings = [...this.cars];
    // Item slots are per car; register the cars created above.
    for (const c of this.cars) this.items.state.set(c, { slot: null, roulette: 0, pending: null, shield: 0, targetedBy: null });
    this.updateStandings();
  }

  startCountdown(): void {
    this.phase = 'countdown';
    this.countdown = COUNTDOWN_SECONDS + 1;
    this.lastCountdownValue = -1;
  }

  /** Fixed-step update. Call before `physics.step()`. */
  step(dt: number): void {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const value = Math.ceil(this.countdown - 1);
      if (value !== this.lastCountdownValue && value >= 1 && value <= COUNTDOWN_SECONDS) {
        this.lastCountdownValue = value;
        this.events.countdown?.(value);
      }
      if (this.countdown <= 1) {
        this.phase = 'racing';
        this.raceTime = 0;
        for (const c of this.cars) c.physics.enabled = true;
        this.events.go?.();
      }
    } else if (this.phase === 'racing' || this.phase === 'finished') {
      this.raceTime += dt;
    }

    this.computeSlipstream();
    for (const car of this.cars) car.step(dt);
  }

  /** Cars running close behind another car in its wake get reduced drag. */
  private computeSlipstream(): void {
    const t = this.track;
    for (const car of this.cars) {
      let tow = 0;
      const p = car.progress.proj;
      if (car.physics.speed > 20) {
        for (const o of this.cars) {
          if (o === car) continue;
          const ds = t.deltaS(p.s, o.progress.proj.s);
          if (ds <= 3 || ds > 32) continue;
          const dLat = Math.abs(o.progress.proj.lateral - p.lateral);
          if (dLat > 2.2) continue;
          tow = Math.max(tow, (1 - (ds - 3) / 29) * (1 - dLat / 2.2));
        }
      }
      car.physics.slipstream += (tow - car.physics.slipstream) * 0.05;
    }
  }

  /** Call after `physics.step()`. */
  postStep(dt: number): void {
    const racing = this.phase === 'racing' || this.phase === 'finished';
    for (const car of this.cars) {
      car.postStep();
      const ph = car.physics;
      const res = car.progress.update(ph.position.x, ph.position.z, ph.forward.x, ph.forward.z, ph.speed, this.raceTime, dt);
      if (!racing) continue;
      if (res === 'lap') {
        const lt = car.progress.lastLapTime;
        const best = lt <= car.progress.bestLapTime;
        if (lt < this.bestLapOverall) this.bestLapOverall = lt;
        this.events.lap?.(car, lt, best);
        if (car.progress.lapsCompleted === this.race.laps - 1) this.events.finalLap?.(car);
      } else if (res === 'finish') {
        this.finishOrder.push(car);
        car.progress.finishPosition = this.finishOrder.length;
        const lt = car.progress.lastLapTime;
        if (lt < this.bestLapOverall) this.bestLapOverall = lt;
        // Finished cars cruise around on autopilot (the player's car too).
        if (!(car.controller instanceof AIController)) {
          car.controller = new AIController(car, AUTOPILOT, this.aiContext, 4242);
        }
        (car.controller as AIController).paceScale = 0.8;
        this.events.finish?.(car, car.progress.finishPosition);
        if (car.isPlayer) {
          this.phase = 'finished';
          this.completeTimer = 25;
        }
      }

      // Automatic recovery for AI (player uses R, but also gets rescued if hopelessly stuck).
      const ai = car.controller instanceof AIController ? car.controller : null;
      const hopeless = ph.upsideDownTime > 3 || car.progress.proj.distance > this.track.def.barrierOffset + 12 || ph.position.y < car.progress.proj.height - 15;
      if ((ai?.wantsReset || hopeless) && car.resetCooldown <= 0) {
        car.resetToTrack(this.cars);
        this.events.reset?.(car);
      }
    }
    this.updateStandings();
    if (racing) {
      this.features.step(dt);
      this.items.step(dt, true);
    }

    if (this.phase === 'finished' && this.completeTimer > 0) {
      const allDone = this.cars.every((c) => c.progress.finished);
      this.completeTimer -= dt;
      if (allDone || this.completeTimer <= 0) {
        this.completeTimer = 0;
        this.events.complete?.();
      }
    }
  }

  private updateStandings(): void {
    this.standings.sort((a, b) => {
      const pa = a.progress;
      const pb = b.progress;
      if (pa.finished && pb.finished) return pa.finishPosition - pb.finishPosition;
      if (pa.finished) return -1;
      if (pb.finished) return 1;
      return pb.raceDistance - pa.raceDistance;
    });
    this.standings.forEach((c, i) => (c.position = i + 1));
  }

  resetPlayer(): void {
    if (this.player && this.player.resetCooldown <= 0) {
      this.player.resetToTrack(this.cars);
      this.events.reset?.(this.player);
    }
  }

  get bestLap(): number {
    return this.bestLapOverall;
  }

  /** Gap in seconds between a car and the leader (approximate for unfinished cars). */
  gapToLeader(car: Car): number {
    const leader = this.standings[0];
    if (car === leader) return 0;
    if (car.progress.finished && leader.progress.finished) return car.progress.finishTime - leader.progress.finishTime;
    const dist = leader.progress.raceDistance - car.progress.raceDistance;
    const v = Math.max(20, car.physics.speed);
    return dist / v;
  }

  /** Removes all cars from the physics world and the scene. */
  dispose(): void {
    for (const c of this.cars) {
      c.visual?.dispose();
      this.physics.world.removeRigidBody(c.physics.body);
    }
    this.cars.length = 0;
  }
}
