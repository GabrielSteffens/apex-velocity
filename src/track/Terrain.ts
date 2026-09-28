import { Noise2D, smoothstep, lerp } from '../core/math';
import type { TrackGeometry } from './TrackGeometry';

/**
 * Heightfield terrain generated around a track. Natural hills (fBm noise) are blended
 * into a flat corridor that follows the road elevation, so the road always sits on the
 * ground and the runoff areas are drivable.
 */
export class Terrain {
  readonly size: number;
  readonly segments: number;
  readonly cell: number;
  readonly originX: number;
  readonly originZ: number;
  /** (segments+1)^2 heights, row-major along x then z. */
  readonly heights: Float32Array;
  /** Distance from each vertex to the track centreline (capped). */
  readonly trackDistance: Float32Array;
  private noise: Noise2D;
  private detail: Noise2D;

  constructor(readonly track: TrackGeometry, cellSize = 5) {
    const def = track.def.terrain;
    this.noise = new Noise2D(def.seed);
    this.detail = new Noise2D(def.seed + 101);
    this.size = def.size;
    this.segments = Math.round(def.size / cellSize);
    this.cell = def.size / this.segments;
    const b = track.bounds;
    this.originX = (b.minX + b.maxX) / 2 - def.size / 2;
    this.originZ = (b.minZ + b.maxZ) / 2 - def.size / 2;

    const n = this.segments + 1;
    this.heights = new Float32Array(n * n);
    this.trackDistance = new Float32Array(n * n);
    const flat = track.def.barrierOffset + 5;
    const blend = 55;
    const maxQuery = flat + blend + 10;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = this.originX + i * this.cell;
        const z = this.originZ + j * this.cell;
        const natural = this.naturalHeight(x, z, cx, cz);
        const idx = track.nearestIndex(x, z, maxQuery);
        let h = natural;
        let dist = maxQuery + 50;
        if (idx >= 0) {
          const p = track.project(x, z, idx);
          dist = p.distance;
          // Terrain sits just under the road edge (no step for the wheels to drop off) and
          // dishes away gently across the runoff.
          const roadH = p.height - 0.07;
          const runoff = roadH - smoothstep(track.halfWidth + 1, flat, dist) * 0.15;
          const t = smoothstep(flat, flat + blend, dist);
          h = lerp(runoff, natural, t);
        }
        this.heights[j * n + i] = h;
        this.trackDistance[j * n + i] = dist;
      }
    }
  }

  private naturalHeight(x: number, z: number, cx: number, cz: number): number {
    const hill = this.track.def.terrain.hilliness;
    let h = 5;
    h += this.noise.fbm(x / 420, z / 420, 4) * 22 * hill;
    h += this.detail.fbm(x / 70, z / 70, 3) * 2.2;
    // Rising rim towards the edge of the map so the world feels enclosed by hills.
    const r = Math.hypot(x - cx, z - cz);
    h += Math.max(0, r - 520) * 0.18 * hill + Math.pow(Math.max(0, r - 700) / 100, 2) * 6;
    return h;
  }

  /** Bilinear height lookup, clamped to the terrain edges. */
  heightAt(x: number, z: number): number {
    const n = this.segments + 1;
    let fx = (x - this.originX) / this.cell;
    let fz = (z - this.originZ) / this.cell;
    fx = Math.max(0, Math.min(this.segments - 0.0001, fx));
    fz = Math.max(0, Math.min(this.segments - 0.0001, fz));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h00 = this.heights[j * n + i];
    const h10 = this.heights[j * n + i + 1];
    const h01 = this.heights[(j + 1) * n + i];
    const h11 = this.heights[(j + 1) * n + i + 1];
    // Match the triangle split used by the mesh (diagonal from (i,j+1) to (i+1,j)).
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }

  distanceAt(x: number, z: number): number {
    const n = this.segments + 1;
    const i = Math.max(0, Math.min(this.segments, Math.round((x - this.originX) / this.cell)));
    const j = Math.max(0, Math.min(this.segments, Math.round((z - this.originZ) / this.cell)));
    return this.trackDistance[j * n + i];
  }

  /**
   * Builds vertex/index buffers for the region of terrain that can be reached by cars
   * (used for the physics collider). Vertex layout matches the visual mesh.
   */
  buildCorridorMesh(maxDistance: number): { vertices: Float32Array; indices: Uint32Array } {
    const n = this.segments + 1;
    const vertices = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        vertices[k * 3] = this.originX + i * this.cell;
        vertices[k * 3 + 1] = this.heights[k];
        vertices[k * 3 + 2] = this.originZ + j * this.cell;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < this.segments; j++) {
      for (let i = 0; i < this.segments; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        const md = Math.min(this.trackDistance[a], this.trackDistance[b], this.trackDistance[c], this.trackDistance[d]);
        if (md > maxDistance) continue;
        idx.push(a, c, b, b, c, d);
      }
    }
    return { vertices, indices: new Uint32Array(idx) };
  }
}
