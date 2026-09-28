import * as THREE from 'three';
import type { TrackDefinition } from '../data/types';

export interface TrackProjection {
  /** Arc length along the centreline, 0..length. */
  s: number;
  /** Index of the nearest sample. */
  index: number;
  /** Signed lateral offset (positive = right of the direction of travel). */
  lateral: number;
  /** Absolute planar distance to the centreline. */
  distance: number;
  /** Road surface height at the projected point. */
  height: number;
}

/**
 * Pure geometric description of a track: centreline samples at uniform arc length,
 * tangents, right vectors, curvature, and fast spatial queries. No rendering here so it
 * can be used by physics, AI, race logic and headless tests alike.
 */
export class TrackGeometry {
  readonly def: TrackDefinition;
  readonly length: number;
  readonly count: number;
  readonly spacing: number;
  readonly halfWidth: number;

  /** Flattened xyz */
  readonly pos: Float32Array;
  /** Horizontal unit tangent (x, z) and vertical slope in y */
  readonly tan: Float32Array;
  /** Horizontal right vector (x, z) */
  readonly right: Float32Array;
  /** Signed curvature (1/m, positive = turning right) */
  readonly curvature: Float32Array;

  private cellSize = 24;
  private grid = new Map<number, number[]>();
  private minX = Infinity;
  private minZ = Infinity;
  private maxX = -Infinity;
  private maxZ = -Infinity;

  constructor(def: TrackDefinition, spacing = 1.5) {
    this.def = def;
    this.halfWidth = def.roadWidth / 2;
    const pts = def.controlPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    curve.arcLengthDivisions = 4000;
    const approxLen = curve.getLength();
    this.count = Math.round(approxLen / spacing);
    this.spacing = approxLen / this.count;
    this.length = approxLen;

    const n = this.count;
    this.pos = new Float32Array(n * 3);
    this.tan = new Float32Array(n * 3);
    this.right = new Float32Array(n * 2);
    this.curvature = new Float32Array(n);

    const tmp = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      curve.getPointAt(i / n, tmp);
      this.pos[i * 3] = tmp.x;
      this.pos[i * 3 + 1] = tmp.y;
      this.pos[i * 3 + 2] = tmp.z;
    }
    // Smooth elevation a little to remove Catmull-Rom wobble on the y axis.
    const ys = new Float32Array(n);
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = -6; k <= 6; k++) acc += this.pos[((i + k + n) % n) * 3 + 1];
        ys[i] = acc / 13;
      }
      for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = ys[i];
    }

    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      let dx = this.pos[b * 3] - this.pos[a * 3];
      let dz = this.pos[b * 3 + 2] - this.pos[a * 3 + 2];
      const dy = this.pos[b * 3 + 1] - this.pos[a * 3 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      this.tan[i * 3] = dx;
      this.tan[i * 3 + 1] = dy / l; // slope
      this.tan[i * 3 + 2] = dz;
      // right = forward x up = (dx,0,dz) x (0,1,0) = (-dz, 0, dx)
      this.right[i * 2] = -dz;
      this.right[i * 2 + 1] = dx;
    }

    // Curvature from heading change (positive = turning right).
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 2 + n) % n;
      const b = (i + 2) % n;
      const ha = Math.atan2(this.tan[a * 3 + 2], this.tan[a * 3]);
      const hb = Math.atan2(this.tan[b * 3 + 2], this.tan[b * 3]);
      let d = hb - ha;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      raw[i] = d / (4 * this.spacing);
    }
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = -3; k <= 3; k++) acc += raw[(i + k + n) % n];
      this.curvature[i] = acc / 7;
    }

    for (let i = 0; i < n; i++) {
      const x = this.pos[i * 3];
      const z = this.pos[i * 3 + 2];
      this.minX = Math.min(this.minX, x);
      this.maxX = Math.max(this.maxX, x);
      this.minZ = Math.min(this.minZ, z);
      this.maxZ = Math.max(this.maxZ, z);
      const key = this.key(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize));
      let cell = this.grid.get(key);
      if (!cell) this.grid.set(key, (cell = []));
      cell.push(i);
    }
  }

  get bounds() {
    return { minX: this.minX, maxX: this.maxX, minZ: this.minZ, maxZ: this.maxZ };
  }

  private key(cx: number, cz: number): number {
    return (cx + 2048) * 4096 + (cz + 2048);
  }

  wrapS(s: number): number {
    const L = this.length;
    return ((s % L) + L) % L;
  }

  /** Signed distance along the track from a to b in the range (-L/2, L/2]. */
  deltaS(a: number, b: number): number {
    let d = b - a;
    const L = this.length;
    if (d > L / 2) d -= L;
    else if (d < -L / 2) d += L;
    return d;
  }

  indexAt(s: number): number {
    return Math.floor(this.wrapS(s) / this.spacing) % this.count;
  }

  /** Interpolated centreline position at arc length s. */
  pointAt(s: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.wrapS(s) / this.spacing;
    const i = Math.floor(f) % this.count;
    const j = (i + 1) % this.count;
    const t = f - Math.floor(f);
    out.set(
      this.pos[i * 3] + (this.pos[j * 3] - this.pos[i * 3]) * t,
      this.pos[i * 3 + 1] + (this.pos[j * 3 + 1] - this.pos[i * 3 + 1]) * t,
      this.pos[i * 3 + 2] + (this.pos[j * 3 + 2] - this.pos[i * 3 + 2]) * t,
    );
    return out;
  }

  /** Horizontal unit tangent at s (y = 0). */
  tangentAt(s: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.wrapS(s) / this.spacing;
    const i = Math.floor(f) % this.count;
    const j = (i + 1) % this.count;
    const t = f - Math.floor(f);
    out.set(
      this.tan[i * 3] + (this.tan[j * 3] - this.tan[i * 3]) * t,
      0,
      this.tan[i * 3 + 2] + (this.tan[j * 3 + 2] - this.tan[i * 3 + 2]) * t,
    );
    return out.normalize();
  }

  rightAt(s: number, out: THREE.Vector3): THREE.Vector3 {
    this.tangentAt(s, out);
    return out.set(-out.z, 0, out.x);
  }

  curvatureAt(s: number): number {
    return this.curvature[this.indexAt(s)];
  }

  /** Point at arc length s offset laterally (positive = right). */
  offsetPoint(s: number, lateral: number, out: THREE.Vector3): THREE.Vector3 {
    const i = this.indexAt(s);
    this.pointAt(s, out);
    out.x += this.right[i * 2] * lateral;
    out.z += this.right[i * 2 + 1] * lateral;
    return out;
  }

  /** Nearest sample index, or -1 if nothing lies within roughly `maxDist` meters. */
  nearestIndex(x: number, z: number, maxDist = Infinity): number {
    return this.nearestGlobal(x, z, Math.min(80, Math.ceil(maxDist / this.cellSize) + 1));
  }

  private nearestGlobal(x: number, z: number, maxRing = 80): number {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r < maxRing; r++) {
      // Scan only the cells on ring r.
      for (let ix = cx - r; ix <= cx + r; ix++) {
        for (let iz = cz - r; iz <= cz + r; iz++) {
          if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== r) continue;
          const cell = this.grid.get(this.key(ix, iz));
          if (!cell) continue;
          for (const i of cell) {
            const dx = this.pos[i * 3] - x;
            const dz = this.pos[i * 3 + 2] - z;
            const d = dx * dx + dz * dz;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // Every cell on ring r+1 is at least r * cellSize away.
      if (best >= 0 && r * this.cellSize >= Math.sqrt(bestD)) break;
    }
    return maxRing < 80 ? best : Math.max(best, 0);
  }

  /** Planar distance from (x,z) to the centreline (nearest sample approximation). */
  distanceToCenterline(x: number, z: number): number {
    const i = this.nearestGlobal(x, z);
    return Math.hypot(this.pos[i * 3] - x, this.pos[i * 3 + 2] - z);
  }

  /**
   * Projects a world position onto the track. With a hint index the search is local
   * (cheap and keeps close-by parallel sections from being confused).
   */
  project(x: number, z: number, hint = -1, out?: TrackProjection): TrackProjection {
    const n = this.count;
    let best = -1;
    let bestD = Infinity;
    if (hint >= 0) {
      for (let k = -40; k <= 40; k++) {
        const i = (hint + k + n) % n;
        const dx = this.pos[i * 3] - x;
        const dz = this.pos[i * 3 + 2] - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      // Lost track (e.g. teleported) -> global search.
      if (Math.sqrt(bestD) > this.def.barrierOffset * 2.5) best = -1;
    }
    if (best < 0) best = this.nearestGlobal(x, z);

    // Refine on adjacent segments.
    const res = out ?? { s: 0, index: 0, lateral: 0, distance: 0, height: 0 };
    let bestT = 0;
    let bestSeg = best;
    let bestDist = Infinity;
    for (const segStart of [(best - 1 + n) % n, best]) {
      const a = segStart;
      const b = (segStart + 1) % n;
      const ax = this.pos[a * 3];
      const az = this.pos[a * 3 + 2];
      const bx = this.pos[b * 3];
      const bz = this.pos[b * 3 + 2];
      const vx = bx - ax;
      const vz = bz - az;
      const len2 = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t;
      const pz = az + vz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestDist) {
        bestDist = d;
        bestT = t;
        bestSeg = a;
      }
    }
    const a = bestSeg;
    const b = (a + 1) % n;
    const px = this.pos[a * 3] + (this.pos[b * 3] - this.pos[a * 3]) * bestT;
    const pz = this.pos[a * 3 + 2] + (this.pos[b * 3 + 2] - this.pos[a * 3 + 2]) * bestT;
    const rx = this.right[a * 2];
    const rz = this.right[a * 2 + 1];
    res.s = this.wrapS((a + bestT) * this.spacing);
    res.index = bestT > 0.5 ? b : a;
    res.lateral = (x - px) * rx + (z - pz) * rz;
    res.distance = bestDist;
    res.height = this.pos[a * 3 + 1] + (this.pos[b * 3 + 1] - this.pos[a * 3 + 1]) * bestT;
    return res;
  }

  /** Arc-length positions of the sector checkpoints (index 0 is the finish line at s = 0). */
  checkpointPositions(): number[] {
    const n = this.def.checkpointCount + 1;
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((i / n) * this.length);
    return out;
  }
}
