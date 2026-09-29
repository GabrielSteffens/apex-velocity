import * as THREE from 'three';
import type { TrackGeometry } from './TrackGeometry';
import type { Terrain } from './Terrain';

export type BarrierStyle = 'armco' | 'concrete' | 'tires';

export interface BarrierRun {
  side: 1 | -1;
  /** Ground-level points along the barrier. */
  points: THREE.Vector3[];
  /** Arc length on the centreline for each point. */
  s: number[];
  /** Style for each segment (points.length - 1 entries). */
  styles: BarrierStyle[];
}

export interface CurbZone {
  side: 1 | -1;
  startIndex: number;
  /** Inclusive end sample; may be < startIndex when wrapping. */
  endIndex: number;
}

/** Run-off surface on the outside of a corner, between the curb and the barrier. */
export interface RunoffZone {
  side: 1 | -1;
  startIndex: number;
  endIndex: number;
  kind: 'gravel' | 'asphalt';
  /** Lateral extent (always positive, measured from the centreline). */
  inner: number;
  outer: number;
}

export interface GridSlot {
  position: THREE.Vector3;
  heading: THREE.Vector3;
  s: number;
  lateral: number;
}

/**
 * Derived layout for a track: where barriers go, which corners get curbs, and the
 * starting grid. Shared by the physics colliders, the visual builder and the AI.
 */
export class TrackLayout {
  readonly barriers: BarrierRun[] = [];
  readonly curbs: CurbZone[] = [];
  /** Per-sample flag (bit 0 = right curb, bit 1 = left curb). */
  readonly curbMask: Uint8Array;
  readonly curbWidth = 1.3;
  readonly runoffs: RunoffZone[] = [];

  constructor(readonly track: TrackGeometry, readonly terrain: Terrain) {
    this.curbMask = new Uint8Array(track.count);
    this.buildCurbs();
    this.buildBarriers();
    this.buildRunoffs();
  }

  /**
   * Gravel traps on the outside of tight corners (from the braking zone to the exit) and
   * striped asphalt run-off on the outside of medium-speed corners.
   */
  private buildRunoffs(): void {
    const t = this.track;
    const n = t.count;
    const inner = t.halfWidth + this.curbWidth + 0.15;
    const outer = t.def.barrierOffset - 1.3;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(t.curvature[i]);
      if (k < 1 / 110) continue;
      let isMax = true;
      for (let d = -25; d <= 25; d++) if (Math.abs(t.curvature[(i + d + n) % n]) > k) isMax = false;
      if (!isMax) continue;
      // Skip the start/finish area.
      if (Math.abs(t.deltaS(0, i * t.spacing)) < 80) continue;
      const side = (t.curvature[i] > 0 ? -1 : 1) as 1 | -1; // outside of the turn
      const tight = k > 1 / 60;
      const before = Math.round((tight ? 55 : 35) / t.spacing);
      const after = Math.round((tight ? 45 : 35) / t.spacing);
      this.runoffs.push({
        side,
        startIndex: (i - before + n) % n,
        endIndex: (i + after) % n,
        kind: tight ? 'gravel' : 'asphalt',
        inner,
        outer,
      });
    }
  }

  private buildCurbs(): void {
    const t = this.track;
    const n = t.count;
    const threshold = t.def.curbCurvature;
    // Mark corners, then grow each marked region so the curb starts before turn-in.
    const corner = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (Math.abs(t.curvature[i]) > threshold) corner[i] = 1;
    const grow = Math.round(18 / t.spacing);
    const grown = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!corner[i]) continue;
      for (let k = -grow; k <= grow; k++) grown[(i + k + n) % n] = 1;
    }
    // Keep the start/finish area free of curbs.
    for (let k = -20; k <= 20; k++) grown[(k + n) % n] = 0;
    for (let i = 0; i < n; i++) if (grown[i]) this.curbMask[i] = 3;

    for (const side of [1, -1] as const) {
      let i = 0;
      // Find a starting point outside a curb zone so wrap-around zones stay contiguous.
      let start = 0;
      while (start < n && grown[start]) start++;
      let inZone = false;
      let zoneStart = 0;
      for (let c = 0; c <= n; c++) {
        i = (start + c) % n;
        const on = c < n && grown[i] === 1;
        if (on && !inZone) {
          inZone = true;
          zoneStart = i;
        } else if (!on && inZone) {
          inZone = false;
          this.curbs.push({ side, startIndex: zoneStart, endIndex: (i - 1 + n) % n });
        }
      }
    }
  }

  private buildBarriers(): void {
    const t = this.track;
    const n = t.count;
    const offset = t.def.barrierOffset;
    const step = 2; // samples per barrier point (~3 m)
    for (const side of [1, -1] as const) {
      const valid: boolean[] = [];
      const pts: THREE.Vector3[] = [];
      const ss: number[] = [];
      for (let i = 0; i < n; i += step) {
        const rx = t.right[i * 2] * side;
        const rz = t.right[i * 2 + 1] * side;
        // Tight inner corners: pull the barrier in so it doesn't collapse to a point.
        const k = t.curvature[i] * side; // positive when this side is the inside of the turn
        let off = offset;
        if (k > 0) {
          const radius = 1 / k;
          off = Math.max(t.halfWidth + 3, Math.min(offset, radius * 0.55));
        }
        const x = t.pos[i * 3] + rx * off;
        const z = t.pos[i * 3 + 2] + rz * off;
        const d = t.distanceToCenterline(x, z);
        valid.push(d > off - 1.2);
        pts.push(new THREE.Vector3(x, this.terrain.heightAt(x, z), z));
        ss.push(i * t.spacing);
      }
      // Split into runs of valid points; rotate so we start on an invalid point if any.
      const m = pts.length;
      let first = valid.indexOf(false);
      const wraps = first < 0;
      if (first < 0) first = 0;
      let run: BarrierRun | null = null;
      for (let c = 0; c <= m; c++) {
        const i = (first + c) % m;
        const ok = valid[i] && !(c === m && !wraps);
        if (ok) {
          if (run) {
            const last = run.points[run.points.length - 1];
            if (last.distanceTo(pts[i]) > 12) {
              if (run.points.length > 1) this.barriers.push(run);
              run = null;
            }
          }
          if (!run) run = { side, points: [], s: [], styles: [] };
          run.points.push(pts[i]);
          run.s.push(ss[i]);
        } else if (run) {
          if (run.points.length > 1) this.barriers.push(run);
          run = null;
        }
      }
      if (run && run.points.length > 1) this.barriers.push(run);
    }

    // Styles: tyre walls on the outside of tight corners, concrete in medium corners,
    // armco guard rails on straights.
    for (const run of this.barriers) {
      for (let p = 0; p < run.points.length - 1; p++) {
        const s = run.s[p];
        let maxK = 0;
        let signedK = 0;
        for (let d = -30; d <= 30; d += 3) {
          const k = t.curvatureAt(s + d);
          if (Math.abs(k) > maxK) {
            maxK = Math.abs(k);
            signedK = k;
          }
        }
        const outside = signedK * run.side < 0;
        if (maxK > 1 / 45 && outside) run.styles.push('tires');
        else if (maxK > 1 / 110) run.styles.push('concrete');
        else run.styles.push('armco');
      }
    }
  }

  /** Grid slots behind the start line, staggered left/right. */
  gridSlots(count: number): GridSlot[] {
    const t = this.track;
    const slots: GridSlot[] = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const s = t.wrapS(-8 - i * t.def.gridSpacing);
      const lateral = i % 2 === 0 ? -3.2 : 3.2;
      t.offsetPoint(s, lateral, p);
      const heading = t.tangentAt(s, new THREE.Vector3());
      slots.push({ position: p.clone(), heading, s, lateral });
    }
    return slots;
  }
}
