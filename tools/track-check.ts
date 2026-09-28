import { TrackGeometry } from '../src/track/TrackGeometry';
import { tracks } from '../src/data/tracks';

for (const def of tracks) {
  const g = new TrackGeometry(def);
  console.log(def.id, 'length', g.length.toFixed(1), 'samples', g.count);
  let minR = Infinity, minRAt = 0;
  for (let i = 0; i < g.count; i++) {
    const r = 1 / Math.abs(g.curvature[i] || 1e-9);
    if (r < minR) { minR = r; minRAt = i; }
  }
  console.log('min radius', minR.toFixed(1), 'at s', (minRAt * g.spacing).toFixed(0));
  // Min separation between non-adjacent parts (> 150m apart along track)
  let minSep = Infinity, at = [0, 0];
  for (let i = 0; i < g.count; i += 2) for (let j = i + 2; j < g.count; j += 2) {
    const ds = Math.abs(g.deltaS(i * g.spacing, j * g.spacing));
    if (ds < 150) continue;
    const d = Math.hypot(g.pos[i*3]-g.pos[j*3], g.pos[i*3+2]-g.pos[j*3+2]);
    if (d < minSep) { minSep = d; at = [i * g.spacing, j * g.spacing]; }
  }
  console.log('min separation', minSep.toFixed(1), 'between s', at.map(v => v.toFixed(0)).join(','));
  // list tight corners
  const corners: string[] = [];
  let inCorner = false, peak = 0, peakS = 0;
  for (let i = 0; i < g.count; i++) {
    const k = Math.abs(g.curvature[i]);
    if (k > 1 / 120) { inCorner = true; if (k > peak) { peak = k; peakS = i * g.spacing; } }
    else if (inCorner) { corners.push(`s=${peakS.toFixed(0)} R=${(1/peak).toFixed(0)}`); inCorner = false; peak = 0; }
  }
  console.log('corners', corners.join(' | '));
  const p = g.project(-60, 3);
  console.log('projection test', p);
}
