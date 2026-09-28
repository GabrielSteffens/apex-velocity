import * as THREE from 'three';
import type { CarDefinition } from '../data/types';
import { CarPhysics } from './CarPhysics';
import type { CarController } from './CarController';
import { RaceProgress } from '../game/RaceProgress';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { TrackGeometry } from '../track/TrackGeometry';

let nextId = 0;

/** A race participant: physics body + controller + race progress (+ optional visual). */
export class Car {
  readonly id = nextId++;
  readonly physics: CarPhysics;
  readonly progress: RaceProgress;
  controller: CarController | null = null;
  /** Rendering hook, set by the game when running with graphics. */
  visual: { sync(alpha: number): void; dispose(): void } | null = null;
  /** Transform at the previous physics step, for render interpolation. */
  readonly prevPosition = new THREE.Vector3();
  readonly prevQuaternion = new THREE.Quaternion();
  position = 0;
  resetCooldown = 0;

  constructor(
    physicsWorld: PhysicsWorld,
    readonly track: TrackGeometry,
    readonly def: CarDefinition,
    readonly name: string,
    readonly color: number,
    readonly isPlayer: boolean,
    laps: number,
    spawn: THREE.Vector3,
    heading: THREE.Vector3,
  ) {
    this.physics = new CarPhysics(physicsWorld, def, spawn, heading);
    this.progress = new RaceProgress(track, laps);
    this.progress.resync(spawn.x, spawn.z);
    this.storePrevious();
  }

  storePrevious(): void {
    this.prevPosition.copy(this.physics.position);
    this.prevQuaternion.copy(this.physics.quaternion);
  }

  /** Put the car back on the racing surface at its current track position. */
  resetToTrack(others: Car[]): void {
    const t = this.track;
    const s = this.progress.proj.s;
    const pos = new THREE.Vector3();
    const heading = t.tangentAt(s, new THREE.Vector3());
    // Pick the lateral slot furthest from other cars.
    let bestLat = 0;
    let bestScore = -Infinity;
    for (const lat of [0, -3.5, 3.5, -5.5, 5.5]) {
      t.offsetPoint(s, lat, pos);
      let minD = 50;
      for (const o of others) {
        if (o === this) continue;
        minD = Math.min(minD, o.physics.position.distanceTo(pos));
      }
      const score = minD - Math.abs(lat) * 0.3;
      if (score > bestScore) {
        bestScore = score;
        bestLat = lat;
      }
    }
    t.offsetPoint(s, bestLat, pos);
    pos.y += CarPhysics.restHeight(this.def) + 0.35;
    this.physics.reset(pos, heading);
    this.progress.resync(pos.x, pos.z);
    this.storePrevious();
    this.resetCooldown = 2;
    this.controller?.onReset?.();
  }

  step(dt: number): void {
    this.storePrevious();
    if (this.controller) this.controller.update(dt, this.physics.input);
    this.physics.step(dt);
    this.resetCooldown = Math.max(0, this.resetCooldown - dt);
  }

  /** Must be called after the physics world stepped, so `physics.position` is current. */
  postStep(): void {
    this.physics.syncState();
  }
}
