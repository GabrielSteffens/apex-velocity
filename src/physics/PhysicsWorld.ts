import RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

export const GROUP = {
  GROUND: 0x0001,
  CAR: 0x0002,
  BARRIER: 0x0004,
  PROP: 0x0008,
} as const;

/** Packs Rapier interaction groups: membership in the high 16 bits, filter in the low 16. */
export const groups = (membership: number, filter: number): number => ((membership & 0xffff) << 16) | (filter & 0xffff);

export type SurfaceType = 'asphalt' | 'curb' | 'grass' | 'gravel' | 'dirt';

export interface SurfaceProps {
  grip: number;
  rollingResistance: number;
  /** Vertical noise amplitude applied to suspension (curbs / rough ground). */
  roughness: number;
  dust: boolean;
}

export const SURFACES: Record<SurfaceType, SurfaceProps> = {
  asphalt: { grip: 1, rollingResistance: 0.012, roughness: 0, dust: false },
  curb: { grip: 0.95, rollingResistance: 0.02, roughness: 0.6, dust: false },
  grass: { grip: 0.62, rollingResistance: 0.09, roughness: 0.25, dust: true },
  gravel: { grip: 0.5, rollingResistance: 0.2, roughness: 0.4, dust: true },
  // Packed dirt (shortcuts): loose but drivable, drifts still charge.
  dirt: { grip: 0.8, rollingResistance: 0.05, roughness: 0.45, dust: true },
};

let rapierReady: Promise<Rapier> | null = null;
export function loadRapier(): Promise<Rapier> {
  if (!rapierReady) rapierReady = RAPIER.init().then(() => RAPIER);
  return rapierReady;
}

export interface ContactForceInfo {
  colliderA: number;
  colliderB: number;
  force: number;
}

/**
 * Thin wrapper around the Rapier world: fixed timestep, surface registry for colliders,
 * and contact force events forwarded to listeners.
 */
export class PhysicsWorld {
  readonly R: Rapier;
  readonly world: RAPIER.World;
  readonly eventQueue: RAPIER.EventQueue;
  readonly fixedDt: number;
  private surfaces = new Map<number, SurfaceType>();
  private contactListeners: ((info: ContactForceInfo) => void)[] = [];

  constructor(R: Rapier, fixedDt = 1 / 120) {
    this.R = R;
    this.fixedDt = fixedDt;
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = fixedDt;
    this.eventQueue = new R.EventQueue(true);
  }

  setSurface(collider: RAPIER.Collider, surface: SurfaceType): void {
    this.surfaces.set(collider.handle, surface);
  }

  surfaceOf(colliderHandle: number): SurfaceType {
    return this.surfaces.get(colliderHandle) ?? 'asphalt';
  }

  /** Subscribes to contact force events; returns an unsubscribe function. */
  onContactForce(fn: (info: ContactForceInfo) => void): () => void {
    this.contactListeners.push(fn);
    return () => {
      this.contactListeners = this.contactListeners.filter((l) => l !== fn);
    };
  }

  step(): void {
    this.world.step(this.eventQueue);
    this.eventQueue.drainContactForceEvents((e) => {
      const info: ContactForceInfo = { colliderA: e.collider1(), colliderB: e.collider2(), force: e.totalForceMagnitude() };
      for (const l of this.contactListeners) l(info);
    });
    this.eventQueue.drainCollisionEvents(() => {});
  }

  /** Finds an approximate world-space contact point between two colliders (for sparks). */
  contactPoint(a: number, b: number, out: { x: number; y: number; z: number }): boolean {
    const ca = this.world.getCollider(a);
    const cb = this.world.getCollider(b);
    if (!ca || !cb) return false;
    let found = false;
    this.world.contactPair(ca, cb, (manifold) => {
      if (found) return;
      const n = manifold.numSolverContacts();
      if (n > 0) {
        const p = manifold.solverContactPoint(0);
        if (p) {
          out.x = p.x;
          out.y = p.y;
          out.z = p.z;
          found = true;
        }
      }
    });
    return found;
  }

  free(): void {
    this.eventQueue.free();
    this.world.free();
  }
}
