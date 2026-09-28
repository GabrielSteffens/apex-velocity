import type RAPIER from '@dimforge/rapier3d-compat';
import { GROUP, groups, type PhysicsWorld } from './PhysicsWorld';
import type { TrackGeometry } from '../track/TrackGeometry';
import type { Terrain } from '../track/Terrain';
import type { TrackLayout } from '../track/TrackLayout';
import { buildRibbon, curbProfile, roadProfile } from '../track/TrackMeshData';

export interface TrackColliderSet {
  road: RAPIER.Collider;
  terrain: RAPIER.Collider;
  curbs: RAPIER.Collider[];
  barriers: RAPIER.Collider[];
  barrierHandles: Set<number>;
}

/** Wall cross-section (outward offset, height) — taller than the visual barrier so cars can't vault it. */
const WALL_PROFILE: [number, number][] = [
  [0, -0.6],
  [0, 2.8],
  [0.8, 2.8],
  [0.8, -0.6],
];

/**
 * Closed prism swept along a barrier polyline with mitred joints. Faces wind outward
 * (required by FIX_INTERNAL_EDGES, which also merges the shared vertices).
 */
function barrierMesh(points: { x: number; y: number; z: number }[], side: 1 | -1): { vertices: Float32Array; indices: Uint32Array } | null {
  const n = points.length;
  if (n < 2) return null;
  const m = WALL_PROFILE.length;
  const verts = new Float32Array(n * m * 3);
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    // Outward normal (away from the track).
    const nx = -dz * side;
    const nz = dx * side;
    const p = points[i];
    for (let k = 0; k < m; k++) {
      const [o, h] = WALL_PROFILE[k];
      const q = (i * m + k) * 3;
      verts[q] = p.x + nx * o;
      verts[q + 1] = p.y + h;
      verts[q + 2] = p.z + nz * o;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      const a0 = i * m + k;
      const a1 = i * m + k2;
      const b0 = (i + 1) * m + k;
      const b1 = (i + 1) * m + k2;
      if (side === 1) idx.push(a0, a1, b0, a1, b1, b0);
      else idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  // End caps
  const cap = (i: number, flip: boolean) => {
    const base = i * m;
    const tri = [base, base + 1, base + 2, base, base + 2, base + 3];
    const outward = (side === 1) !== flip;
    idx.push(...(outward ? tri : [tri[0], tri[2], tri[1], tri[3], tri[5], tri[4]]));
  };
  cap(0, true);
  cap(n - 1, false);
  return { vertices: verts, indices: new Uint32Array(idx) };
}

/** Creates all static colliders for a track: road, curbs, terrain corridor, barriers, world bounds. */
export function createTrackColliders(physics: PhysicsWorld, track: TrackGeometry, terrain: Terrain, layout: TrackLayout): TrackColliderSet {
  const { R, world } = physics;
  const groundGroups = groups(GROUP.GROUND, GROUP.CAR | GROUP.PROP);
  const barrierGroups = groups(GROUP.BARRIER, GROUP.CAR | GROUP.PROP);

  const fixed = world.createRigidBody(R.RigidBodyDesc.fixed());

  const road = buildRibbon(track, roadProfile(track.halfWidth), { closed: true });
  const roadCol = world.createCollider(
    R.ColliderDesc.trimesh(road.positions, road.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.9).setCollisionGroups(groundGroups),
    fixed,
  );
  physics.setSurface(roadCol, 'asphalt');

  const curbs: RAPIER.Collider[] = [];
  for (const zone of layout.curbs) {
    const data = buildRibbon(track, curbProfile(track.halfWidth, layout.curbWidth, zone.side), {
      start: zone.startIndex,
      end: zone.endIndex,
    });
    const c = world.createCollider(
      R.ColliderDesc.trimesh(data.positions, data.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.9).setCollisionGroups(groundGroups),
      fixed,
    );
    physics.setSurface(c, 'curb');
    curbs.push(c);
  }

  const corridor = terrain.buildCorridorMesh(track.def.barrierOffset + 40);
  const terrainCol = world.createCollider(
    R.ColliderDesc.trimesh(corridor.vertices, corridor.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.8).setCollisionGroups(groundGroups),
    fixed,
  );
  physics.setSurface(terrainCol, 'grass');

  // One continuous, closed wall mesh per barrier run (instead of ~1600 separate boxes):
  // no seams for the car to catch on, and internal edges are fixed so sliding along the
  // wall is smooth. Low friction lets cars glance off instead of being stopped dead.
  const barriers: RAPIER.Collider[] = [];
  const handles = new Set<number>();
  for (const run of layout.barriers) {
    const mesh = barrierMesh(run.points, run.side);
    if (!mesh) continue;
    const col = world.createCollider(
      R.ColliderDesc.trimesh(mesh.vertices, mesh.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES)
        .setFriction(0.05)
        .setFrictionCombineRule(R.CoefficientCombineRule.Min)
        .setRestitution(0.08)
        .setRestitutionCombineRule(R.CoefficientCombineRule.Min)
        .setCollisionGroups(barrierGroups),
      fixed,
    );
    barriers.push(col);
    handles.add(col.handle);
  }

  // World bounds so nothing can ever leave the map.
  const size = terrain.size;
  const cx = terrain.originX + size / 2;
  const cz = terrain.originZ + size / 2;
  const walls: [number, number, number, number][] = [
    [cx, cz - size / 2 + 40, size / 2, 2],
    [cx, cz + size / 2 - 40, size / 2, 2],
    [cx - size / 2 + 40, cz, 2, size / 2],
    [cx + size / 2 - 40, cz, 2, size / 2],
  ];
  for (const [x, z, hx, hz] of walls) {
    const col = world.createCollider(
      R.ColliderDesc.cuboid(hx, 200, hz).setTranslation(x, 0, z).setCollisionGroups(barrierGroups),
      fixed,
    );
    handles.add(col.handle);
  }

  return { road: roadCol, terrain: terrainCol, curbs, barriers, barrierHandles: handles };
}
