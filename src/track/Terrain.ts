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
  private warp: Noise2D;
  /** Infield lake (placed where it's furthest from the track), or null. */
  readonly lake: { x: number; z: number; r: number; level: number } | null;

  constructor(readonly track: TrackGeometry, cellSize = 5) {
    const def = track.def.terrain;
    this.noise = new Noise2D(def.seed);
    this.detail = new Noise2D(def.seed + 101);
    this.warp = new Noise2D(def.seed + 202);
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

    // Lake: the infield point furthest from any part of the track.
    let best = { x: 0, z: 0, d: 0 };
    for (let x = b.minX + 40; x < b.maxX - 40; x += 10) {
      for (let z = b.minZ + 40; z < b.maxZ - 40; z += 10) {
        const d = track.distanceToCenterline(x, z);
        if (d > best.d) best = { x, z, d };
      }
    }
    const lakeR = Math.min(95, best.d - track.def.barrierOffset - 45);
    this.lake = lakeR > 25 ? { x: best.x, z: best.z, r: lakeR, level: this.naturalHeight(best.x, best.z, cx, cz) - 1.5 } : null;

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
        if (this.lake) {
          const L = this.lake;
          const d = Math.hypot(x - L.x, z - L.z) / this.lakeRadiusAt(x, z);
          if (d < 1.8) {
            // Bowl below the water line, a shore just above it, then back to nature.
            const shore = L.level + 0.35;
            if (d < 1) h = L.level - 2.6 + (2.6 + 0.35) * smoothstep(0.45, 1.0, d);
            else h = lerp(Math.max(h, shore), h, smoothstep(1.0, 1.8, d));
          }
        }
        this.heights[j * n + i] = h;
        this.trackDistance[j * n + i] = dist;
      }
    }
  }

  private naturalHeight(x: number, z: number, cx: number, cz: number): number {
    const hill = this.track.def.terrain.hilliness;
    // Domain warp breaks up the regular blobs of plain fBm.
    const wx = x + this.warp.fbm(x / 300, z / 300, 2) * 90;
    const wz = z + this.warp.fbm(x / 300 + 17, z / 300 - 9, 2) * 90;
    let h = 4;
    h += this.noise.fbm(wx / 380, wz / 380, 4) * 12 * hill; // rolling valley floor
    h += this.detail.fbm(x / 60, z / 60, 3) * 1.6;
    // Mountains around the valley: ridged noise (sharp crests, eroded-looking flanks)
    // rising only towards the edge of the map.
    const r = Math.hypot(x - cx, z - cz);
    const rim = Math.max(0, Math.min(1, (r - 470) / 380));
    if (rim > 0) {
      let ridged = 0;
      let amp = 1;
      let freq = 1 / 260;
      let norm = 0;
      for (let o = 0; o < 4; o++) {
        const n = 1 - Math.abs(this.noise.get(wx * freq + 31, wz * freq - 7));
        ridged += n * n * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.1;
      }
      ridged /= norm;
      h += rim * rim * (35 + ridged * 150) * hill;
    }
    return h;
  }

  /** Lake radius in the direction of (x, z): an irregular, natural-looking shoreline. */
  lakeRadiusAt(x: number, z: number): number {
    const L = this.lake;
    if (!L) return 0;
    const a = Math.atan2(z - L.z, x - L.x);
    const n = this.warp.get(Math.cos(a) * 1.4 + 50, Math.sin(a) * 1.4 + 50) * 0.8 + this.warp.get(Math.cos(a) * 3.1 - 20, Math.sin(a) * 3.1) * 0.35;
    return L.r * (1 + 0.24 * n);
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
