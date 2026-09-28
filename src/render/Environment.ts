import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { EnvironmentPreset } from '../data/types';
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

function direction(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  return new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevationDeg), THREE.MathUtils.degToRad(azimuthDeg));
}

/** Procedural night sky: gradient, city glow on the horizon, stars and a moon. */
function createNightSky(preset: EnvironmentPreset, radius: number, withStars: boolean): THREE.Mesh {
  const moonDir = direction(preset.moonElevation ?? 25, preset.moonAzimuth ?? 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(0x02040b) },
      uHorizon: { value: new THREE.Color(0x0f1a33) },
      uGlow: { value: new THREE.Color(0x3a2c3a) },
      uMoonDir: { value: moonDir },
      uStars: { value: withStars ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // always at the far plane
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGlow;
      uniform vec3 uMoonDir;
      uniform float uStars;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 col = mix(uHorizon, uZenith, pow(h, 0.45));
        col += uGlow * exp(-h * 9.0) * 0.9;               // light pollution near the horizon
        if (d.y < 0.0) col = mix(uHorizon * 0.6, vec3(0.01, 0.012, 0.02), clamp(-d.y * 6.0, 0.0, 1.0));
        // Stars on a 3D grid of cells, one candidate per cell.
        if (uStars > 0.5 && d.y > 0.03) {
          vec3 p = d * 260.0;
          vec3 cell = floor(p);
          float rnd = hash(cell);
          if (rnd > 0.965) {
            vec3 c = cell + 0.5 + (vec3(hash(cell + 1.3), hash(cell + 7.1), hash(cell + 3.7)) - 0.5) * 0.6;
            float dist = length(p - c);
            float b = smoothstep(0.16, 0.0, dist) * (rnd - 0.965) / 0.035;
            col += vec3(0.85, 0.9, 1.0) * b * 2.2 * smoothstep(0.03, 0.25, d.y);
          }
        }
        // Moon disc + halo
        float m = dot(d, normalize(uMoonDir));
        col += vec3(0.75, 0.82, 1.0) * smoothstep(0.99955, 0.99975, m) * 2.4;
        col += vec3(0.25, 0.3, 0.45) * pow(max(m, 0.0), 180.0) * 0.6;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  return mesh;
}

/**
 * Sky, key light, ambient light, fog, image-based lighting and distant mountain
 * silhouettes, built from an EnvironmentPreset (sunset, night...). The key light's shadow
 * camera follows a target (the player's car) so shadows stay crisp.
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: THREE.Object3D;
  readonly sunDirection = new THREE.Vector3();
  readonly group = new THREE.Group();
  private envMap: THREE.Texture | null = null;
  private shadowExtent = 70;

  constructor(
    readonly scene: THREE.Scene,
    readonly renderer: THREE.WebGLRenderer,
    readonly preset: EnvironmentPreset,
    seed: number,
  ) {
    const env = preset;
    this.sunDirection.copy(direction(env.sunElevation, env.sunAzimuth));

    if (env.sky === 'physical') {
      const sky = new Sky();
      sky.scale.setScalar(10000);
      clampSky(sky, 3.2);
      const u = sky.material.uniforms;
      u.turbidity.value = env.turbidity;
      u.rayleigh.value = env.rayleigh;
      u.mieCoefficient.value = 0.0035;
      u.mieDirectionalG.value = 0.86;
      u.sunPosition.value.copy(this.sunDirection);
      this.sky = sky;
    } else {
      this.sky = createNightSky(env, 5000, true);
    }
    this.group.add(this.sky);

    // Reuse the fog object so materials/particles holding a reference stay in sync.
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.setHex(env.fogColor);
      scene.fog.near = env.fogNear;
      scene.fog.far = env.fogFar;
    } else {
      scene.fog = new THREE.Fog(env.fogColor, env.fogNear, env.fogFar);
    }
    scene.background = new THREE.Color(env.fogColor);

    this.sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
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

    this.hemi = new THREE.HemisphereLight(env.hemiSky, env.hemiGround, env.hemiIntensity);
    this.group.add(this.hemi);

    this.buildMountains(seed);
    scene.add(this.group);
    this.buildEnvMap();
  }

  get isNight(): boolean {
    return this.preset.lightsOn;
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
    let skyMat: THREE.Material;
    if (this.preset.sky === 'physical') {
      const sky = new Sky();
      sky.scale.setScalar(1000);
      clampSky(sky, 2.5);
      const src = (this.sky as Sky).material.uniforms;
      const dst = sky.material.uniforms;
      for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) dst[k].value = src[k].value;
      dst.sunPosition.value.copy(this.sunDirection);
      envScene.add(sky);
      skyMat = sky.material;
    } else {
      // No stars in reflections (they'd alias); add a few bright "floodlight" panels so the
      // car paint picks up glints at night.
      const sky = createNightSky(this.preset, 500, false);
      envScene.add(sky);
      skyMat = sky.material as THREE.Material;
      const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff2dd).multiplyScalar(6) });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const lamp = new THREE.Mesh(new THREE.PlaneGeometry(40, 14), lampMat);
        lamp.position.set(Math.cos(a) * 300, 90, Math.sin(a) * 300);
        lamp.lookAt(0, 0, 0);
        envScene.add(lamp);
      }
    }
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(900, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: this.preset.sky === 'physical' ? 0x5b5236 : 0x0b0d12 }),
    );
    ground.position.y = -5;
    envScene.add(ground);
    this.envMap = pmrem.fromScene(envScene, 0.02).texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = this.preset.envIntensity;
    pmrem.dispose();
    skyMat.dispose();
    envScene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }

  private buildMountains(seed: number): void {
    const rnd = new Random(seed * 13 + 1);
    const fog = new THREE.Color(this.preset.fogColor);
    const [near, far] = this.preset.mountainColors;
    const night = this.preset.sky === 'night';
    const layers = [
      { radius: 2600, height: 260, color: new THREE.Color(near).lerp(fog, night ? 0.15 : 0.55), seg: 240 },
      { radius: 3400, height: 420, color: new THREE.Color(far).lerp(fog, night ? 0.25 : 0.7), seg: 200 },
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
    this.sun.shadow.map?.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
