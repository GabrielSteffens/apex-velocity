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

const BARRIER_HALF_HEIGHT = 1.7;
const BARRIER_HALF_THICKNESS = 0.35;

/** Creates all static colliders for a track: road, curbs, terrain corridor, barriers, world bounds. */
export function createTrackColliders(physics: PhysicsWorld, track: TrackGeometry, terrain: Terrain, layout: TrackLayout): TrackColliderSet {
  const { R, world } = physics;
  const groundGroups = groups(GROUP.GROUND, GROUP.CAR | GROUP.PROP);
  const barrierGroups = groups(GROUP.BARRIER, GROUP.CAR | GROUP.PROP);

  const fixed = world.createRigidBody(R.RigidBodyDesc.fixed());

  const road = buildRibbon(track, roadProfile(track.halfWidth), { closed: true });
  const roadCol = world.createCollider(
    R.ColliderDesc.trimesh(road.positions, road.indices).setFriction(0.9).setCollisionGroups(groundGroups),
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
      R.ColliderDesc.trimesh(data.positions, data.indices).setFriction(0.9).setCollisionGroups(groundGroups),
      fixed,
    );
    physics.setSurface(c, 'curb');
    curbs.push(c);
  }

  const corridor = terrain.buildCorridorMesh(track.def.barrierOffset + 40);
  const terrainCol = world.createCollider(
    R.ColliderDesc.trimesh(corridor.vertices, corridor.indices).setFriction(0.8).setCollisionGroups(groundGroups),
    fixed,
  );
  physics.setSurface(terrainCol, 'grass');

  const barriers: RAPIER.Collider[] = [];
  const handles = new Set<number>();
  for (const run of layout.barriers) {
    for (let i = 0; i < run.points.length - 1; i++) {
      const a = run.points[i];
      const b = run.points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const yaw = Math.atan2(dx, dz);
      const half = yaw / 2;
      const cy = Math.min(a.y, b.y) + BARRIER_HALF_HEIGHT - 0.6;
      // Push the collider outward by its half thickness so its inner face is the visual face.
      const nx = (-dz / len) * run.side;
      const nz = (dx / len) * run.side;
      const col = world.createCollider(
        R.ColliderDesc.cuboid(BARRIER_HALF_THICKNESS, BARRIER_HALF_HEIGHT, len / 2 + 0.25)
          .setTranslation((a.x + b.x) / 2 + nx * BARRIER_HALF_THICKNESS, cy, (a.z + b.z) / 2 + nz * BARRIER_HALF_THICKNESS)
          .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) })
          .setFriction(0.15)
          .setRestitution(0.25)
          .setCollisionGroups(barrierGroups),
        fixed,
      );
      barriers.push(col);
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

  return { road: roadCol, terrain: terrainCol, curbs, barriers, barrierHandles: handles };
}
