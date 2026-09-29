import * as THREE from 'three';
import type { TrackDefinition } from '../data/types';
import { TrackGeometry } from '../track/TrackGeometry';
import { Terrain } from '../track/Terrain';
import { TrackLayout } from '../track/TrackLayout';
import { TrackBuilder } from '../track/TrackBuilder';
import { TrackScenery } from '../track/TrackScenery';
import { RacingLine } from '../ai/RacingLine';
import { createTrackColliders, type TrackColliderSet } from '../physics/TrackColliders';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { getCar } from '../data/cars';
import { FeatureMeshes } from '../track/FeatureMeshes';

// setTimeout (not rAF) so loading also progresses in a background tab.
const nextFrame = () => new Promise<void>((r) => setTimeout(r, 16));

/**
 * Everything static about a loaded track: geometry, terrain, layout, colliders and the
 * visual scene graph. Swapping tracks = disposing this and creating another.
 */
export class TrackScene {
  readonly group = new THREE.Group();
  track!: TrackGeometry;
  terrain!: Terrain;
  layout!: TrackLayout;
  line!: RacingLine;
  colliders!: TrackColliderSet;
  scenery!: TrackScenery;
  features!: FeatureMeshes;

  private constructor(readonly def: TrackDefinition) {}

  static async create(def: TrackDefinition, physics: PhysicsWorld, progress: (p: number, msg: string) => void): Promise<TrackScene> {
    const ts = new TrackScene(def);
    let t0 = performance.now();
    const step = (p: number, msg: string) => {
      const now = performance.now();
      console.debug(`[load] ${(now - t0).toFixed(0)} ms before "${msg}"`);
      t0 = now;
      progress(p, msg);
    };
    progress(0.1, 'Surveying circuit');
    await nextFrame();
    ts.track = new TrackGeometry(def);
    step(0.2, 'Shaping terrain');
    await nextFrame();
    ts.terrain = new Terrain(ts.track);
    ts.layout = new TrackLayout(ts.track, ts.terrain);
    const car = getCar('falcon-r');
    ts.line = new RacingLine(ts.track, { edgeMargin: 1.7, lateralAccel: car.grip * 9.81 * 0.86, brakeDecel: car.braking * 0.72, topSpeed: car.topSpeed / 3.6 });
    step(0.4, 'Laying asphalt');
    await nextFrame();
    ts.colliders = createTrackColliders(physics, ts.track, ts.terrain, ts.layout);
    const builder = new TrackBuilder(ts.track, ts.terrain, ts.layout, ts.line);
    ts.group.add(builder.group);
    ts.features = new FeatureMeshes(ts.track, ts.layout);
    ts.group.add(ts.features.group);
    step(0.65, 'Planting trees');
    await nextFrame();
    ts.scenery = new TrackScenery(ts.track, ts.terrain, ts.layout, ts.line);
    ts.group.add(ts.scenery.group);
    step(0.85, 'Warming up tyres');
    await nextFrame();
    return ts;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.group.removeFromParent();
  }
}
