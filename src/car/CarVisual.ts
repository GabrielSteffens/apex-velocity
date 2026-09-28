import * as THREE from 'three';
import type { Car } from './Car';
import { buildCarModel, type CarModelParts } from './CarModel';
import { CarPhysics } from './CarPhysics';
import * as tex from '../render/textures';

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Renders a Car: interpolates the physics transform and animates wheels and lights. */
export class CarVisual {
  readonly parts: CarModelParts;
  private brakeGlow = 0;
  private beam: THREE.Mesh | null = null;
  private spot: THREE.SpotLight | null = null;
  private tailBase = 1.2;

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

  /**
   * Night driving: brighter lamps, a light pool on the road ahead of every car, and a real
   * spotlight for the player's car only (one extra light keeps shading cheap).
   */
  setNight(on: boolean, realLight: boolean): void {
    const p = this.parts;
    p.headLightMat.emissiveIntensity = on ? 7 : 2.2;
    this.tailBase = on ? 5 : 1.2;
    if (on && !this.beam) {
      const G = -CarPhysics.restHeight(this.car.def);
      const geo = new THREE.PlaneGeometry(9, 26).rotateX(-Math.PI / 2);
      geo.translate(0, G + 0.06, this.car.def.dimensions.length / 2 + 12);
      this.beam = new THREE.Mesh(
        geo,
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
      );
      this.beam.renderOrder = 4;
      p.root.add(this.beam);
    }
    if (this.beam) this.beam.visible = on;
    if (on && realLight && !this.spot) {
      const spot = new THREE.SpotLight(0xfff2de, 90, 90, 0.42, 0.55, 1.3);
      spot.position.set(0, 0.1, this.car.def.dimensions.length / 2);
      spot.target.position.set(0, -1.2, 30);
      p.root.add(spot, spot.target);
      this.spot = spot;
    }
    if (this.spot) this.spot.visible = on && realLight;
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
    this.parts.brakeLightMat.emissiveIntensity = this.tailBase + this.brakeGlow * 7;
    this.parts.reverseLightMat.emissiveIntensity = ph.reversing ? 3 : 0;
    // Contact shadow fades when airborne.
    (this.parts.shadow.material as THREE.MeshBasicMaterial).opacity = ph.groundedWheels > 0 ? 0.75 : 0.25;
  }

  dispose(): void {
    this.spot?.dispose();
    this.scene.remove(this.parts.root);
    this.parts.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
      }
    });
  }
}
