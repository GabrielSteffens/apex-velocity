import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { TrackDefinition } from '../data/types';
import { Random } from '../core/math';

/**
 * The stock Sky shader outputs enormous HDR values around the sun (the disc alone is
 * ~19000 x extinction), which floods the bloom pass and washes out the whole screen when
 * driving towards the sunset. Clamp its output to a sane range.
 */
function clampSky(sky: Sky, max: number): void {
  sky.material.fragmentShader = sky.material.fragmentShader.replace(
    'gl_FragColor = vec4( texColor, 1.0 );',
    `gl_FragColor = vec4( min( texColor, vec3( ${max.toFixed(2)} ) ), 1.0 );`,
  );
  sky.material.needsUpdate = true;
}

/**
 * Sky, sun, ambient light, fog, image-based lighting and distant mountain silhouettes.
 * The sun's shadow camera follows a target (the player's car) so shadows stay crisp.
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: Sky;
  readonly sunDirection = new THREE.Vector3();
  readonly group = new THREE.Group();
  private envMap: THREE.Texture | null = null;
  private shadowExtent = 70;

  constructor(
    readonly scene: THREE.Scene,
    readonly renderer: THREE.WebGLRenderer,
    def: TrackDefinition,
  ) {
    const env = def.environment;
    const phi = THREE.MathUtils.degToRad(90 - env.sunElevation);
    const theta = THREE.MathUtils.degToRad(env.sunAzimuth);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);

    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    clampSky(this.sky, 3.2);
    const u = this.sky.material.uniforms;
    u.turbidity.value = env.turbidity;
    u.rayleigh.value = env.rayleigh;
    u.mieCoefficient.value = 0.0035;
    u.mieDirectionalG.value = 0.86;
    u.sunPosition.value.copy(this.sunDirection);
    this.group.add(this.sky);

    scene.fog = new THREE.Fog(env.fogColor, env.fogNear, env.fogFar);
    scene.background = new THREE.Color(env.fogColor);

    this.sun = new THREE.DirectionalLight(0xffd6ae, 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    const cam = this.sun.shadow.camera;
    cam.near = 1;
    cam.far = 600;
    this.setShadowExtent(70);
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xa9c4e8, 0x5a4a30, 0.55);
    this.group.add(this.hemi);

    this.buildMountains(def);
    scene.add(this.group);
    this.buildEnvMap();
  }

  setShadowExtent(extent: number): void {
    this.shadowExtent = extent;
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.updateProjectionMatrix();
  }

  setShadowQuality(size: number): void {
    if (this.sun.shadow.mapSize.x === size) return;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  /** Renders the sky into a PMREM environment map used for reflections and IBL. */
  private buildEnvMap(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky = new Sky();
    sky.scale.setScalar(1000);
    clampSky(sky, 2.5);
    const src = this.sky.material.uniforms;
    const dst = sky.material.uniforms;
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) dst[k].value = src[k].value;
    dst.sunPosition.value.copy(this.sunDirection);
    envScene.add(sky);
    // A warm ground plane so reflections have a horizon.
    const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x5b5236 }));
    ground.position.y = -5;
    envScene.add(ground);
    this.envMap = pmrem.fromScene(envScene, 0.02).texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();
    sky.material.dispose();
    ground.geometry.dispose();
  }

  private buildMountains(def: TrackDefinition): void {
    const rnd = new Random(def.terrain.seed * 13 + 1);
    const fog = new THREE.Color(def.environment.fogColor);
    const layers = [
      { radius: 2600, height: 260, color: new THREE.Color(0x7d6874).lerp(fog, 0.55), seg: 240 },
      { radius: 3400, height: 420, color: new THREE.Color(0x76698a).lerp(fog, 0.7), seg: 200 },
    ];
    for (const layer of layers) {
      const positions: number[] = [];
      const colors: number[] = [];
      const idx: number[] = [];
      const seg = layer.seg;
      const phase = rnd.range(0, 100);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const h =
          layer.height *
          (0.22 +
            0.28 * Math.abs(Math.sin(a * 2 + phase)) +
            0.22 * Math.abs(Math.sin(a * 5.3 + phase * 1.7)) +
            0.14 * Math.sin(a * 13 + phase * 2) ** 2 +
            0.08 * Math.sin(a * 29 + phase) ** 2 +
            0.06 * rnd.next());
        const x = Math.cos(a) * layer.radius;
        const z = Math.sin(a) * layer.radius;
        positions.push(x, -50, z, x, h, z);
        const bottom = layer.color.clone().lerp(fog, 0.55);
        colors.push(bottom.r, bottom.g, bottom.b, layer.color.r, layer.color.g, layer.color.b);
        if (i < seg) {
          const b = i * 2;
          idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
      m.renderOrder = -1;
      this.group.add(m);
    }
  }

  /** Keep the shadow frustum centred on the focus point (texel-snapped to avoid shimmering). */
  update(focus: THREE.Vector3): void {
    const d = this.sunDirection;
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + d.x * 300, focus.y + d.y * 300, fz + d.z * 300);
    this.sun.target.updateMatrixWorld();
    // Sky dome follows the camera focus so it never clips.
    this.sky.position.set(focus.x, 0, focus.z);
  }

  dispose(): void {
    this.envMap?.dispose();
    this.scene.remove(this.group);
  }
}
