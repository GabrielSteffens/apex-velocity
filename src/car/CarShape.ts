import * as THREE from 'three';
import type { CarDefinition } from '../data/types';

/**
 * Smooth 1D curve through (z, value) keys (cubic Hermite with Catmull-Rom tangents).
 * Keys must be sorted by z ascending.
 */
function curve(keys: [number, number][]): (z: number) => number {
  const n = keys.length;
  const tangent = (i: number) => {
    const a = keys[Math.max(0, i - 1)];
    const b = keys[Math.min(n - 1, i + 1)];
    return b[0] === a[0] ? 0 : (b[1] - a[1]) / (b[0] - a[0]);
  };
  return (z: number) => {
    if (z <= keys[0][0]) return keys[0][1];
    if (z >= keys[n - 1][0]) return keys[n - 1][1];
    let i = 0;
    while (i < n - 2 && z > keys[i + 1][0]) i++;
    const [z0, y0] = keys[i];
    const [z1, y1] = keys[i + 1];
    const h = z1 - z0;
    const t = (z - z0) / h;
    const m0 = tangent(i) * h;
    const m1 = tangent(i + 1) * h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
  };
}

/** Number of points in a half body cross-section (see `section`). */
export const SECTION_POINTS = 11;
/** Index of the last point of the painted outer skin (the arch / sill edge). */
export const SKIN_END = 7;

export interface GridOptions {
  offset?: number;
  /** Flip the winding if the result faces inward. */
  outward?: (p: THREE.Vector3, n: THREE.Vector3) => boolean;
  uv?: (a: number, b: number) => [number, number];
}

/**
 * Parametric description of an original mid-engined sports car body: smooth
 * profile curves along the length, a cross-section generator (fenders, hood valley,
 * character line, wheel wells, floor) and a teardrop cabin. Everything visual —
 * the lofted skin, glass, lights, vents, livery — is sampled from these functions,
 * so details sit exactly on the surface.
 *
 * Space: +Z forward, +Y up (ground at 0), +X to the car's left; symmetric in X.
 */
export class CarShape {
  readonly L2: number;
  readonly W2: number;
  readonly wb: number;
  readonly wr: number;
  readonly archR: number;
  readonly archCY: number;
  private readonly topCurve: (z: number) => number;
  private readonly crestCurve: (z: number) => number;
  private readonly roofCurve: (z: number) => number;
  readonly cabinFront = 0.98;
  readonly cabinRear = -1.5;

  /**
   * @param detail mesh resolution multiplier (1 = player car, ~0.55 for AI cars that are
   *   rarely seen up close).
   */
  constructor(def: CarDefinition, readonly detail = 1) {
    const d = def.dimensions;
    this.L2 = d.length / 2;
    this.W2 = d.width / 2;
    this.wb = d.wheelBase / 2;
    this.wr = d.wheelRadius;
    this.archR = d.wheelRadius + 0.052;
    this.archCY = d.wheelRadius + 0.012;
    const L = this.L2;
    // Centreline height of the lower body (hood, engine deck).
    this.topCurve = curve([
      [-L, 0.84],
      [-L + 0.1, 0.9],
      [-1.7, 0.91],
      [-1.2, 0.86],
      [0, 0.76],
      [0.95, 0.75],
      [1.35, 0.7],
      [1.8, 0.58],
      [2.05, 0.48],
      [L, 0.4],
    ]);
    // Fender crest line: muscular haunches at the rear, tall front fenders, dip at the doors.
    this.crestCurve = curve([
      [-L, 0.87],
      [-L + 0.15, 0.93],
      [-1.35, 0.96],
      [-0.75, 0.88],
      [-0.2, 0.78],
      [0.45, 0.78],
      [1.3, 0.87],
      [1.85, 0.76],
      [2.1, 0.6],
      [L, 0.48],
    ]);
    // Cabin roof (teardrop greenhouse), from the engine cover to the windscreen base.
    this.roofCurve = curve([
      [this.cabinRear, 0.0],
      [-1.2, 0.1],
      [-0.85, 0.25],
      [-0.45, 0.37],
      [-0.1, 0.4],
      [0.25, 0.34],
      [0.6, 0.19],
      [this.cabinFront, 0.0],
    ]);
  }

  // ------------------------------------------------------------------ profiles
  halfWidth(z: number): number {
    const L = this.L2;
    let w = this.W2;
    // Coke-bottle waist between the wheels, full width over the fenders.
    w *= 1 - 0.03 * Math.exp(-(((z + 0.05) / 0.55) ** 2));
    if (z > 1.65) w *= 1 - 0.2 * ((z - 1.65) / (L - 1.65)) ** 2.2;
    if (z < -1.8) w *= 1 - 0.08 * ((-z - 1.8) / (L - 1.8)) ** 2;
    return w;
  }

  topC(z: number): number {
    return this.topCurve(z);
  }

  crest(z: number): number {
    return Math.max(this.topCurve(z) + 0.02, this.crestCurve(z));
  }

  floor(z: number): number {
    const L = this.L2;
    if (z > 1.75) return 0.13 + (z - 1.75) * 0.22; // nose rises for approach angle
    if (z < -1.55) return 0.13 + ((-z - 1.55) / (L - 1.55)) ** 1.5 * 0.2; // diffuser kick-up
    return 0.13;
  }

  /** Height of the lower edge of the side skin (follows the wheel arches). */
  sill(z: number): number {
    let s = 0.2;
    for (const wz of [this.wb, -this.wb]) {
      const dz = z - wz;
      if (Math.abs(dz) < this.archR) s = Math.max(s, this.archCY + Math.sqrt(this.archR ** 2 - dz ** 2));
    }
    return s;
  }

  /**
   * Half cross-section at z (x >= 0), 11 points from the top centreline, over the fender,
   * down the side, into the wheel well and back along the floor to the centreline.
   */
  section(z: number, out: [number, number][] = []): [number, number][] {
    const W = this.halfWidth(z);
    const top = this.topC(z);
    const crest = this.crest(z);
    const sill = this.sill(z);
    const floor = Math.min(this.floor(z), sill - 0.02);
    const shoulder = Math.max(crest - 0.13, sill + 0.06);
    const belly = Math.max(0.46, sill + 0.03);
    const pts: [number, number][] = [
      [0, top],
      [0.3 * W, top + (crest - top) * 0.32],
      [0.56 * W, crest - 0.012],
      [0.74 * W, crest],
      [0.89 * W, crest - 0.035],
      [0.975 * W, Math.max(shoulder, belly + 0.02)],
      [1.0 * W, Math.min(belly, Math.max(shoulder, belly + 0.02) - 0.01)],
      [0.972 * W, sill],
      [0.62 * W, sill],
      [0.6 * W, floor],
      [0, floor],
    ];
    out.length = 0;
    out.push(...pts);
    return out;
  }

  /** Point on the body skin: u in [0, 10] along the section, side = +1 (left/+X) or -1. */
  bodyPoint(z: number, u: number, side: number, out = new THREE.Vector3()): THREE.Vector3 {
    const s = this.section(z);
    const i = Math.max(0, Math.min(SECTION_POINTS - 2, Math.floor(u)));
    const t = Math.max(0, Math.min(1, u - i));
    const a = s[i];
    const b = s[i + 1];
    return out.set((a[0] + (b[0] - a[0]) * t) * side, a[1] + (b[1] - a[1]) * t, z);
  }

  /** Height of the body's top surface at lateral position x (for placing things on it). */
  topAt(z: number, x: number): number {
    const s = this.section(z);
    const ax = Math.abs(x);
    for (let i = 0; i < 5; i++) {
      if (ax <= s[i + 1][0]) {
        const t = (ax - s[i][0]) / (s[i + 1][0] - s[i][0] || 1);
        return s[i][1] + (s[i + 1][1] - s[i][1]) * t;
      }
    }
    return s[5][1];
  }

  // ------------------------------------------------------------------ cabin
  cabinBaseHalfWidth(z: number): number {
    return 0.66 - Math.max(0, -z - 0.6) * 0.06;
  }

  cabinTopHalfWidth(z: number): number {
    return 0.5 - Math.max(0, -z - 0.3) * 0.08;
  }

  cabinBaseY(z: number): number {
    return this.topAt(z, this.cabinBaseHalfWidth(z)) - 0.015;
  }

  /** Cabin surface: t in [0,1] from the side base (0) to the roof centreline (1). */
  cabinPoint(z: number, t: number, side: number, out = new THREE.Vector3()): THREE.Vector3 {
    const base = this.cabinBaseY(z);
    const height = Math.max(0, this.roofCurve(z));
    const roofY = Math.max(base, this.topAt(z, 0)) + height;
    const wb = this.cabinBaseHalfWidth(z);
    const wt = this.cabinTopHalfWidth(z) * (0.55 + 0.45 * Math.min(1, height / 0.2));
    const r = Math.min(0.13, height * 0.5); // roof edge radius
    const sideEnd = 0.45;
    let x: number;
    let y: number;
    if (t <= sideEnd) {
      const k = t / sideEnd;
      x = wb + (wt - wb) * k;
      y = base + (roofY - r - base) * k;
    } else {
      const k = (t - sideEnd) / (1 - sideEnd);
      const ang = (k * Math.PI) / 2;
      x = wt * Math.cos(ang);
      y = roofY - r + r * Math.sin(ang);
    }
    return out.set(x * side, y, z);
  }

  // ------------------------------------------------------------------ mesh builders
  /**
   * Builds a grid mesh from a parametric surface fn(a, b). Winding is chosen so faces
   * point along `outward` (default: away from the car's centre line).
   */
  grid(fn: (a: number, b: number, out: THREE.Vector3) => THREE.Vector3, a0: number, a1: number, na: number, b0: number, b1: number, nb: number, opts: GridOptions = {}): THREE.BufferGeometry {
    const pos = new Float32Array((na + 1) * (nb + 1) * 3);
    const uv = new Float32Array((na + 1) * (nb + 1) * 2);
    const p = new THREE.Vector3();
    for (let i = 0; i <= na; i++) {
      for (let j = 0; j <= nb; j++) {
        const a = a0 + ((a1 - a0) * i) / na;
        const b = b0 + ((b1 - b0) * j) / nb;
        fn(a, b, p);
        const k = i * (nb + 1) + j;
        pos[k * 3] = p.x;
        pos[k * 3 + 1] = p.y;
        pos[k * 3 + 2] = p.z;
        const [u, v] = opts.uv ? opts.uv(i / na, j / nb) : [i / na, j / nb];
        uv[k * 2] = u;
        uv[k * 2 + 1] = v;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < na; i++) {
      for (let j = 0; j < nb; j++) {
        const a = i * (nb + 1) + j;
        const b = a + nb + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Orientation check on a central vertex.
    const c = Math.floor(na / 2) * (nb + 1) + Math.floor(nb / 2);
    const cp = new THREE.Vector3().fromBufferAttribute(g.attributes.position as THREE.BufferAttribute, c);
    const cn = new THREE.Vector3().fromBufferAttribute(g.attributes.normal as THREE.BufferAttribute, c);
    const outward = opts.outward ?? ((pp: THREE.Vector3, nn: THREE.Vector3) => nn.x * pp.x + nn.y * (pp.y - 0.45) > 0);
    if (!outward(cp, cn)) {
      const ix = g.index!.array as Uint16Array | Uint32Array;
      for (let t = 0; t < ix.length; t += 3) {
        const tmp = ix[t + 1];
        ix[t + 1] = ix[t + 2];
        ix[t + 2] = tmp;
      }
      g.computeVertexNormals();
    }
    if (opts.offset) {
      const n = g.attributes.normal as THREE.BufferAttribute;
      const ps = g.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < ps.count; k++) ps.setXYZ(k, ps.getX(k) + n.getX(k) * opts.offset, ps.getY(k) + n.getY(k) * opts.offset, ps.getZ(k) + n.getZ(k) * opts.offset);
    }
    return g;
  }

  /** z stations for lofting: fine near the arches, where the sill line changes quickly. */
  stations(z0: number, z1: number, baseStep = 0.03): number[] {
    const step = baseStep / this.detail;
    const zs: number[] = [];
    for (let z = z0; z < z1; ) {
      zs.push(z);
      let s = step;
      for (const wz of [this.wb, -this.wb]) {
        const dz = Math.abs(Math.abs(z - wz) - this.archR);
        if (dz < 0.08) s = Math.min(s, 0.008 / this.detail);
      }
      z += s;
    }
    zs.push(z1);
    return zs;
  }

  /** Lofted body skin for one side (u range selects a band of the cross-section). */
  bodyBand(side: number, u0: number, u1: number): THREE.BufferGeometry {
    const zs = this.stations(-this.L2, this.L2);
    const nb = Math.max(1, Math.round((u1 - u0) * 3 * this.detail));
    return this.grid(
      (a, b, out) => this.bodyPoint(zs[Math.round(a)], b, side, out),
      0,
      zs.length - 1,
      zs.length - 1,
      u0,
      u1,
      nb,
      { outward: (p, n) => (u0 >= SKIN_END ? n.y < 0.3 || n.x * p.x < 0 : n.x * p.x + n.y * 0.5 > 0) },
    );
  }

  /** Flat cap closing the body at the nose or tail (fan from the section centroid). */
  cap(front: boolean): THREE.BufferGeometry {
    const z = front ? this.L2 : -this.L2;
    const s = this.section(z).slice(0, SKIN_END + 1);
    // Close the outline across the bottom so the cap is a clean shape.
    const outline: [number, number][] = [...s.map(([x, y]) => [x, y] as [number, number]), ...s.slice().reverse().map(([x, y]) => [-x, y] as [number, number])];
    const cx = 0;
    const cy = outline.reduce((a, p) => a + p[1], 0) / outline.length;
    const pos: number[] = [cx, cy, z];
    for (const [x, y] of outline) pos.push(x, y, z);
    const idx: number[] = [];
    for (let i = 1; i < outline.length; i++) {
      if (front) idx.push(0, i + 1 > outline.length ? 1 : i + 1, i);
      else idx.push(0, i, i + 1 > outline.length ? 1 : i + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Face forward at the nose, backward at the tail.
    const nz = (g.attributes.normal as THREE.BufferAttribute).getZ(0);
    if (front ? nz < 0 : nz > 0) {
      const ix = g.index!.array as Uint16Array | Uint32Array;
      for (let t = 0; t < ix.length; t += 3) {
        const tmp = ix[t + 1];
        ix[t + 1] = ix[t + 2];
        ix[t + 2] = tmp;
      }
      g.computeVertexNormals();
    }
    return g;
  }
}
