import * as THREE from 'three';
import type { Car } from '../car/Car';
import { CarPhysics } from '../car/CarPhysics';
import * as tex from '../render/textures';

const _m = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _s = new THREE.Vector3();

/**
 * Soft contact shadows and night-time headlight pools for every car, drawn as two
 * InstancedMeshes (2 draw calls total instead of 2 per car).
 */
export class CarGroundFx {
  readonly group = new THREE.Group();
  private readonly shadows: THREE.InstancedMesh;
  private readonly beams: THREE.InstancedMesh;
  private readonly shadowOffset = new THREE.Matrix4();
  private readonly beamOffset = new THREE.Matrix4();

  constructor(private readonly cars: Car[]) {
    const def = cars[0].def;
    const G = -CarPhysics.restHeight(def);
    const shadowGeo = new THREE.PlaneGeometry(def.dimensions.width + 0.9, def.dimensions.length + 1.1).rotateX(-Math.PI / 2);
    this.shadows = new THREE.InstancedMesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({ map: tex.radialGradient('rgba(0,0,0,0.85)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false, opacity: 0.75 }),
      cars.length,
    );
    this.shadows.renderOrder = 2;
    this.shadowOffset.makeTranslation(0, G + 0.03, 0);

    const beamGeo = new THREE.PlaneGeometry(9, 26).rotateX(-Math.PI / 2);
    this.beams = new THREE.InstancedMesh(
      beamGeo,
      new THREE.MeshBasicMaterial({
        map: tex.radialGradient('rgba(255,244,225,0.9)', 'rgba(255,244,225,0)'),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.55,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
      cars.length,
    );
    this.beams.renderOrder = 4;
    this.beams.visible = false;
    this.beamOffset.makeTranslation(0, G + 0.06, def.dimensions.length / 2 + 12);
    for (const im of [this.shadows, this.beams]) {
      im.frustumCulled = false; // instances span the whole track
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(im);
    }
  }

  setNight(on: boolean): void {
    this.beams.visible = on;
  }

  /** Call after the car visuals were synced for this frame. */
  update(): void {
    this.cars.forEach((car, i) => {
      const root = car.visual ? (car.visual as unknown as { root: THREE.Object3D }).root : null;
      if (!root) return;
      root.updateMatrix();
      // Shadow shrinks and fades out of view when the car is airborne.
      const k = car.physics.groundedWheels > 0 ? 1 : 0.6;
      _local.copy(this.shadowOffset).scale(_s.set(k, 1, k));
      this.shadows.setMatrixAt(i, _m.multiplyMatrices(root.matrix, _local));
      if (this.beams.visible) this.beams.setMatrixAt(i, _m.multiplyMatrices(root.matrix, this.beamOffset));
    });
    this.shadows.instanceMatrix.needsUpdate = true;
    if (this.beams.visible) this.beams.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.shadows.dispose();
    this.beams.dispose();
  }
}
