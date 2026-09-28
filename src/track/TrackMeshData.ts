import type { TrackGeometry } from './TrackGeometry';

export interface RibbonProfile {
  /** Lateral offsets across the ribbon from left (negative) to right (positive). */
  laterals: number[];
  /** Height offset for each lateral vertex. */
  heights: number[];
  /** U texture coordinate for each lateral vertex. */
  us?: number[];
}

export interface RibbonData {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Number of vertices across. */
  across: number;
  rows: number;
}

/**
 * Sweeps a cross-section profile along the track centreline. Used for the road, curbs,
 * painted lines and their physics colliders so visuals and collision always agree.
 *
 * @param start first sample index
 * @param end   last sample index (inclusive); if `closed`, the ribbon wraps the whole loop
 * @param vScale meters per V texture repeat
 */
export function buildRibbon(
  track: TrackGeometry,
  profile: RibbonProfile,
  opts: { start?: number; end?: number; closed?: boolean; vScale?: number; step?: number } = {},
): RibbonData {
  const n = track.count;
  const closed = opts.closed ?? false;
  const step = opts.step ?? 1;
  const start = opts.start ?? 0;
  let span: number;
  if (closed) span = n;
  else {
    const end = opts.end ?? n - 1;
    span = ((end - start + n) % n) + 1;
  }
  const rowsIdx: number[] = [];
  for (let k = 0; k < span; k += step) rowsIdx.push((start + k) % n);
  if (!closed && rowsIdx[rowsIdx.length - 1] !== (start + span - 1) % n) rowsIdx.push((start + span - 1) % n);
  const rows = rowsIdx.length + (closed ? 1 : 0);
  const across = profile.laterals.length;
  const positions = new Float32Array(rows * across * 3);
  const uvs = new Float32Array(rows * across * 2);
  const vScale = opts.vScale ?? 10;
  const us = profile.us ?? profile.laterals.map((_, i) => i / (across - 1));

  let dist = 0;
  for (let r = 0; r < rows; r++) {
    const i = rowsIdx[r % rowsIdx.length];
    if (r > 0) dist += track.spacing * step;
    const cx = track.pos[i * 3];
    const cy = track.pos[i * 3 + 1];
    const cz = track.pos[i * 3 + 2];
    const rx = track.right[i * 2];
    const rz = track.right[i * 2 + 1];
    for (let a = 0; a < across; a++) {
      const lat = profile.laterals[a];
      const o = (r * across + a) * 3;
      positions[o] = cx + rx * lat;
      positions[o + 1] = cy + profile.heights[a];
      positions[o + 2] = cz + rz * lat;
      uvs[(r * across + a) * 2] = us[a];
      uvs[(r * across + a) * 2 + 1] = dist / vScale;
    }
  }

  const indices = new Uint32Array((rows - 1) * (across - 1) * 6);
  let p = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let a = 0; a < across - 1; a++) {
      const v00 = r * across + a;
      const v01 = r * across + a + 1;
      const v10 = (r + 1) * across + a;
      const v11 = (r + 1) * across + a + 1;
      // Counter-clockwise when seen from above (normal +Y).
      indices[p++] = v00;
      indices[p++] = v01;
      indices[p++] = v10;
      indices[p++] = v01;
      indices[p++] = v11;
      indices[p++] = v10;
    }
  }
  return { positions, uvs, indices, across, rows };
}

/** Road cross-section: flat asphalt with a slight bevel at the edges. */
export function roadProfile(halfWidth: number): RibbonProfile {
  const w = halfWidth;
  return {
    laterals: [-w - 0.5, -w, -w * 0.5, 0, w * 0.5, w, w + 0.5],
    heights: [-0.07, 0, 0.01, 0.015, 0.01, 0, -0.07],
    us: [-0.5 / (2 * w), 0, 0.25, 0.5, 0.75, 1, 1 + 0.5 / (2 * w)],
  };
}

/** Curb cross-section for one side. */
export function curbProfile(halfWidth: number, width: number, side: 1 | -1): RibbonProfile {
  const inner = halfWidth - 0.25;
  const outer = halfWidth + width;
  const lats = [inner, inner + 0.15, outer - 0.25, outer];
  const hs = [0.005, 0.045, 0.05, -0.04];
  if (side === 1) return { laterals: lats, heights: hs, us: [0, 0.1, 0.9, 1] };
  return {
    laterals: lats.map((l) => -l).reverse(),
    heights: [...hs].reverse(),
    us: [1, 0.9, 0.1, 0],
  };
}
