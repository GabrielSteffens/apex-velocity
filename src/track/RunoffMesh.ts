import type { TrackGeometry } from './TrackGeometry';
import type { Terrain } from './Terrain';
import type { RunoffZone } from './TrackLayout';
import type { RibbonData } from './TrackMeshData';

/**
 * Surface ribbon for a run-off zone, draped over the terrain (a few centimetres above it)
 * between the curb and the barrier. Shared by the visual mesh and the physics collider.
 */
export function buildRunoffRibbon(track: TrackGeometry, terrain: Terrain, zone: RunoffZone, lift = 0.035, across = 6, vScale = 6): RibbonData {
  const n = track.count;
  const span = ((zone.endIndex - zone.startIndex + n) % n) + 1;
  const rows = span;
  const positions = new Float32Array(rows * across * 3);
  const uvs = new Float32Array(rows * across * 2);
  // Laterals must increase left->right for consistent winding.
  const lo = zone.side > 0 ? zone.inner : -zone.outer;
  const hi = zone.side > 0 ? zone.outer : -zone.inner;
  for (let r = 0; r < rows; r++) {
    const i = (zone.startIndex + r) % n;
    const cx = track.pos[i * 3];
    const cz = track.pos[i * 3 + 2];
    const rx = track.right[i * 2];
    const rz = track.right[i * 2 + 1];
    // Taper the zone in and out at its ends so it doesn't start as a hard rectangle.
    const edge = Math.min(r, rows - 1 - r) / Math.max(1, Math.min(12, rows / 4));
    const taper = Math.min(1, edge);
    for (let a = 0; a < across; a++) {
      const f = a / (across - 1);
      let lat = lo + (hi - lo) * f;
      // Pull the far edge towards the curb near the ends.
      const near = zone.side > 0 ? lo : hi;
      lat = near + (lat - near) * (0.25 + 0.75 * taper);
      const x = cx + rx * lat;
      const z = cz + rz * lat;
      const o = (r * across + a) * 3;
      positions[o] = x;
      positions[o + 1] = terrain.heightAt(x, z) + lift;
      positions[o + 2] = z;
      uvs[(r * across + a) * 2] = (lat - lo) / 4;
      uvs[(r * across + a) * 2 + 1] = (r * track.spacing) / vScale;
    }
  }
  const indices = new Uint32Array((rows - 1) * (across - 1) * 6);
  let p = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let a = 0; a < across - 1; a++) {
      const v00 = r * across + a;
      const v01 = v00 + 1;
      const v10 = v00 + across;
      const v11 = v10 + 1;
      indices.set([v00, v01, v10, v01, v11, v10], p);
      p += 6;
    }
  }
  return { positions, uvs, indices, across, rows };
}
