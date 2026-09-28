export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const inverseLerp = (a: number, b: number, v: number): number => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = inverseLerp(a, b, v);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential smoothing. `lambda` ~ responsiveness (1/s). */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));
/** Move `current` toward `target` by at most `maxDelta`. */
export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
};
export const wrapAngle = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/** Mulberry32 — small, fast deterministic RNG. */
export class Random {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

/** 2D value-gradient noise (Perlin-style) with seeded permutation. */
export class Noise2D {
  private perm = new Uint8Array(512);
  private gx = new Float32Array(256);
  private gy = new Float32Array(256);

  constructor(seed: number) {
    const rnd = new Random(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      p[i] = i;
      const a = rnd.next() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private grad(ix: number, iy: number, x: number, y: number): number {
    const h = this.perm[(ix & 255) + this.perm[iy & 255]];
    return this.gx[h] * (x - ix) + this.gy[h] * (y - iy);
  }

  /** Returns roughly -1..1 */
  get(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const sx = x - x0;
    const sy = y - y0;
    const u = sx * sx * sx * (sx * (sx * 6 - 15) + 10);
    const v = sy * sy * sy * (sy * (sy * 6 - 15) + 10);
    const n00 = this.grad(x0, y0, x, y);
    const n10 = this.grad(x0 + 1, y0, x, y);
    const n01 = this.grad(x0, y0 + 1, x, y);
    const n11 = this.grad(x0 + 1, y0 + 1, x, y);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4;
  }

  fbm(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.get(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}
