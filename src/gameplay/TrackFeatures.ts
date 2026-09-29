import * as THREE from 'three';
import type { Car } from '../car/Car';
import type { TrackGeometry } from '../track/TrackGeometry';
import type { TrackLayout, ShortcutPath } from '../track/TrackLayout';

export interface BoostPad {
  s: number;
  lateral: number;
  pos: THREE.Vector3;
  /** Yaw of the track direction at the pad. */
  yaw: number;
}

export interface FeatureEvents {
  boostPad?(car: Car, pad: BoostPad): void;
  shortcut?(car: Car, sc: ShortcutPath): void;
}

const PAD_HALF_LEN = 2.4;
const PAD_HALF_WIDTH = 1.6;

/**
 * Track gameplay: boost pads (placed on risky lines: inside curbs, wide exits) and
 * shortcut detection. Logic only; visuals live in FeatureVisuals.
 */
export class TrackFeatures {
  readonly pads: BoostPad[] = [];
  events: FeatureEvents = {};
  private padCooldown = new Map<Car, number>();
  /** Time a car entered the off-road middle of a shortcut (per shortcut index). */
  private inShortcut = new Map<Car, { sc: ShortcutPath; t: number }>();
  private time = 0;

  constructor(
    private readonly track: TrackGeometry,
    private readonly layout: TrackLayout,
    private readonly cars: Car[],
  ) {
    for (const d of track.def.gameplay?.boostPads ?? []) {
      const pos = track.offsetPoint(d.s, d.lateral, new THREE.Vector3());
      pos.y = track.project(pos.x, pos.z).height;
      const tan = track.tangentAt(d.s, new THREE.Vector3());
      this.pads.push({ s: d.s, lateral: d.lateral, pos, yaw: Math.atan2(tan.x, tan.z) });
    }
  }

  step(dt: number): void {
    this.time += dt;
    const t = this.track;
    for (const car of this.cars) {
      const pr = car.progress.proj;
      const cd = (this.padCooldown.get(car) ?? 0) - dt;
      this.padCooldown.set(car, cd);
      if (cd <= 0 && car.physics.groundedWheels > 0) {
        for (const pad of this.pads) {
          const ds = t.deltaS(pad.s, pr.s);
          if (Math.abs(ds) < PAD_HALF_LEN && Math.abs(pr.lateral - pad.lateral) < PAD_HALF_WIDTH) {
            car.physics.boost(1.2, 14);
            this.padCooldown.set(car, 0.8);
            this.events.boostPad?.(car, pad);
            break;
          }
        }
      }
      // Shortcut: counted once the car has been through the off-road middle and is back
      // on the road past the exit.
      const p = car.physics.position;
      for (const sc of this.layout.shortcuts) {
        const f = this.fractionAlong(sc, p);
        if (f > 0.3 && f < 0.7 && pr.distance > t.halfWidth + 2 && this.layout.nearShortcut(p.x, p.z, 1)) {
          if (!this.inShortcut.has(car)) this.inShortcut.set(car, { sc, t: this.time });
        }
      }
      const st = this.inShortcut.get(car);
      if (st) {
        const f = this.fractionAlong(st.sc, p);
        if (this.time - st.t > 8) this.inShortcut.delete(car);
        else if (f > 0.85 && pr.distance < t.halfWidth + 1) {
          this.inShortcut.delete(car);
          this.events.shortcut?.(car, st.sc);
        }
      }
    }
  }

  /** Fraction (unclamped) of the way along a shortcut for a world position. */
  fractionAlong(sc: ShortcutPath, p: THREE.Vector3): number {
    const a = sc.points[0];
    return ((p.x - a.x) * sc.dir.x + (p.z - a.z) * sc.dir.z) / sc.length;
  }
}
