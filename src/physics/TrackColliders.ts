import type RAPIER from '@dimforge/rapier3d-compat';
import { GROUP, groups, type PhysicsWorld } from './PhysicsWorld';
import type { TrackGeometry } from '../track/TrackGeometry';
import type { Terrain } from '../track/Terrain';
import type { TrackLayout, ShortcutPath } from '../track/TrackLayout';
import * as THREE from 'three';
import { buildRibbon, curbProfile, roadProfile } from '../track/TrackMeshData';
import { buildRunoffRibbon } from '../track/RunoffMesh';

export interface TrackColliderSet {
  road: RAPIER.Collider;
  terrain: RAPIER.Collider;
  curbs: RAPIER.Collider[];
  barriers: RAPIER.Collider[];
  barrierHandles: Set<number>;
  /** Tyre stacks and other solid props (impact effects like barriers). */
  props: RAPIER.Collider[];
}

/** Ribbon over the off-road part of a shortcut path (shared with the visual mesh). */
export function shortcutRibbon(sc: ShortcutPath): { positions: Float32Array; indices: Uint32Array; uvs: Float32Array } {
  const n = sc.points.length - 1;
  const i0 = Math.max(0, Math.floor(sc.offStart * n) - 1);
  const i1 = Math.min(n, Math.ceil(sc.offEnd * n) + 1);
  const rows = i1 - i0 + 1;
  const across = 5;
  const positions = new Float32Array(rows * across * 3);
  const uvs = new Float32Array(rows * across * 2);
  const rx = sc.dir.z;
  const rz = -sc.dir.x;
  const w = sc.def.width;
  for (let r = 0; r < rows; r++) {
    const p = sc.points[i0 + r];
    for (let a = 0; a < across; a++) {
      const f = a / (across - 1);
      const lat = (f - 0.5) * w;
      const q = (r * across + a) * 3;
      positions[q] = p.x + rx * lat;
      // Slight camber: the middle is packed higher than the edges.
      positions[q + 1] = p.y + (0.5 - Math.abs(f - 0.5)) * 0.08;
      positions[q + 2] = p.z + rz * lat;
      uvs[(r * across + a) * 2] = f;
      uvs[(r * across + a) * 2 + 1] = ((i0 + r) * sc.length) / n / 6;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++)
    for (let a = 0; a < across - 1; a++) {
      const v = r * across + a;
      idx.push(v, v + across, v + 1, v + 1, v + across, v + across + 1);
    }
  return { positions, indices: new Uint32Array(idx), uvs };
}

/** Wedge vertices for a shortcut's kicker ramp (6 points: low edge x2, high edge x2 + base). */
export function rampVertices(sc: ShortcutPath, point: (f: number, out: THREE.Vector3) => THREE.Vector3): Float32Array | null {
  const r = sc.def.ramp;
  if (!r) return null;
  const mid = point(r.at, new THREE.Vector3());
  const half = r.length / 2;
  const w = sc.def.width / 2 - 0.6;
  const rx = sc.dir.z;
  const rz = -sc.dir.x;
  const v: number[] = [];
  for (const [along, up] of [
    [-half, 0],
    [half, r.height],
    [half, -0.3],
    [-half - 0.2, -0.3],
  ]) {
    for (const side of [-1, 1]) {
      v.push(mid.x + sc.dir.x * along + rx * w * side, mid.y + up, mid.z + sc.dir.z * along + rz * w * side);
    }
  }
  return new Float32Array(v);
}

/** Tyre-stack gate positions for a shortcut. */
export function gatePositions(sc: ShortcutPath, point: (f: number, out: THREE.Vector3) => THREE.Vector3): THREE.Vector3[] {
  const g = sc.def.gate;
  if (!g) return [];
  const mid = point(g.at, new THREE.Vector3());
  const rx = sc.dir.z;
  const rz = -sc.dir.x;
  const out: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const lat = side * (g.gap / 2 + 0.45 + k * 0.9);
      out.push(new THREE.Vector3(mid.x + rx * lat, mid.y, mid.z + rz * lat));
    }
  }
  return out;
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

  // Gravel traps (low grip, dust) and asphalt run-off areas.
  for (const zone of layout.runoffs) {
    const data = buildRunoffRibbon(track, terrain, zone);
    const c = world.createCollider(
      R.ColliderDesc.trimesh(data.positions, data.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.8).setCollisionGroups(groundGroups),
      fixed,
    );
    physics.setSurface(c, zone.kind === 'gravel' ? 'gravel' : 'asphalt');
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

  // Shortcuts: dirt path, kicker ramp and tyre-stack gates.
  const props: RAPIER.Collider[] = [];
  for (const sc of layout.shortcuts) {
    const rib = shortcutRibbon(sc);
    const c = world.createCollider(
      R.ColliderDesc.trimesh(rib.positions, rib.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.8).setCollisionGroups(groundGroups),
      fixed,
    );
    physics.setSurface(c, 'dirt');
    const point = (f: number, out: THREE.Vector3) => layout.shortcutPoint(sc, f, out);
    const ramp = rampVertices(sc, point);
    if (ramp) {
      const desc = R.ColliderDesc.convexHull(ramp);
      if (desc) {
        const rc = world.createCollider(desc.setFriction(0.9).setCollisionGroups(groundGroups), fixed);
        physics.setSurface(rc, 'asphalt');
      }
    }
    for (const p of gatePositions(sc, point)) {
      const col = world.createCollider(
        R.ColliderDesc.cylinder(0.6, 0.42).setTranslation(p.x, p.y + 0.55, p.z).setFriction(0.3).setRestitution(0.3).setCollisionGroups(barrierGroups),
        fixed,
      );
      props.push(col);
      handles.add(col.handle);
    }
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

  return { road: roadCol, terrain: terrainCol, curbs, barriers, barrierHandles: handles, props };
}
