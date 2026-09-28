import * as THREE from 'three';
import type { Car } from './Car';
import { buildCarModel, type CarModelParts } from './CarModel';

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Renders a Car: interpolates the physics transform and animates wheels and lights. */
export class CarVisual {
  readonly parts: CarModelParts;
  private brakeGlow = 0;

  constructor(
    readonly car: Car,
    readonly scene: THREE.Object3D,
    number: number,
  ) {
    this.parts = buildCarModel(car.def, car.color, number);
    scene.add(this.parts.root);
    car.visual = this;
    this.sync(1);
  }

  get root(): THREE.Group {
    return this.parts.root;
  }

  sync(alpha: number): void {
    const car = this.car;
    const ph = car.physics;
    const root = this.parts.root;
    _p.copy(car.prevPosition).lerp(ph.position, alpha);
    _q.copy(car.prevQuaternion).slerp(ph.quaternion, alpha);
    root.position.copy(_p);
    root.quaternion.copy(_q);

    for (let i = 0; i < 4; i++) {
      const w = ph.wheels[i];
      const pivot = this.parts.wheelPivots[i];
      pivot.position.y = ph.wheelOffsetY(i);
      if (w.front) pivot.rotation.y = -ph.steerAngle;
      this.parts.wheelSpinners[i].rotation.x = w.spinAngle;
    }

    const braking = ph.braking || (ph.input.handbrake && ph.enabled && ph.speed > 1);
    this.brakeGlow += ((braking ? 1 : 0) - this.brakeGlow) * 0.35;
    this.parts.brakeLightMat.emissiveIntensity = 1.2 + this.brakeGlow * 7;
    this.parts.reverseLightMat.emissiveIntensity = ph.reversing ? 3 : 0;
    // Contact shadow fades when airborne.
    (this.parts.shadow.material as THREE.MeshBasicMaterial).opacity = ph.groundedWheels > 0 ? 0.75 : 0.25;
  }

  dispose(): void {
    this.scene.remove(this.parts.root);
    this.parts.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
      }
    });
  }
}
