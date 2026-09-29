import * as THREE from 'three';
import * as tex from '../render/textures';

/**
 * Fixed-size particle pool rendered as a single THREE.Points draw call. Particles are
 * recycled in ring-buffer order, so emitting never allocates.
 */
class ParticlePool {
  readonly points: THREE.Points;
  private readonly cap: number;
  private head = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly growth: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private active = 0;

  constructor(
    cap: number,
    material: THREE.ShaderMaterial,
    private readonly gravity: number,
    private readonly drag: number,
  ) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.growth = new Float32Array(cap);
    this.alpha0 = new Float32Array(cap);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(this.geo, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, growth: number, life: number, alpha: number, r: number, g: number, b: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
    this.size[i] = size;
    this.growth[i] = growth;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alpha0[i] = alpha;
    this.alpha[i] = alpha;
    this.active = Math.min(this.cap, this.active + 1);
  }

  update(dt: number): void {
    if (this.active === 0) return;
    const dragK = Math.exp(-this.drag * dt);
    let alive = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      alive++;
      const o = i * 3;
      this.vel[o + 1] += this.gravity * dt;
      this.vel[o] *= dragK;
      this.vel[o + 1] *= dragK;
      this.vel[o + 2] *= dragK;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      this.size[i] += this.growth[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      // Fade in quickly, fade out slowly.
      this.alpha[i] = this.alpha0[i] * Math.min(1, (1 - t) * 8) * t;
    }
    this.active = alive;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }
}

function particleMaterial(additive: boolean, map: THREE.Texture | null, fog: THREE.Fog | null): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uScale: { value: 600 },
      uFogColor: { value: fog ? fog.color : new THREE.Color() },
      uFogNear: { value: fog ? fog.near : 1e6 },
      uFogFar: { value: fog ? fog.far : 2e6 },
      uLight: { value: new THREE.Color(1.0, 0.86, 0.72) },
    },
    vertexShader: /* glsl */ `
      attribute float size;
      attribute float alpha;
      attribute vec3 color;
      uniform float uScale;
      varying float vAlpha;
      varying vec3 vColor;
      varying float vFogDepth;
      void main() {
        vAlpha = alpha;
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFogDepth = -mv.z;
        // Cap sprite size and fade out sprites right in front of the lens (overdraw killer).
        gl_PointSize = min(size * uScale / max(0.5, -mv.z), uScale * 0.18);
        vAlpha *= smoothstep(1.5, 5.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform vec3 uLight;
      varying float vAlpha;
      varying vec3 vColor;
      varying float vFogDepth;
      void main() {
        ${
          map
            ? 'vec4 t = texture2D(uMap, gl_PointCoord); float a = t.a * vAlpha; vec3 c = vColor * uLight;'
            : 'float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d) * vAlpha; vec3 c = vColor;'
        }
        if (a < 0.003) discard;
        float f = smoothstep(uFogNear, uFogFar, vFogDepth);
        c = mix(c, uFogColor, f * ${additive ? '0.0' : '1.0'});
        gl_FragColor = vec4(c, a * ${additive ? '(1.0 - f)' : '1.0'});
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

export class ParticleManager {
  readonly group = new THREE.Group();
  private smoke: ParticlePool;
  private sparks: ParticlePool;
  private motes: THREE.Points;
  private moteBase: Float32Array;
  private time = 0;

  constructor(fog: THREE.Fog | null) {
    this.smoke = new ParticlePool(700, particleMaterial(false, tex.smokeSprite(), fog), 0.35, 0.9);
    this.sparks = new ParticlePool(400, particleMaterial(true, null, fog), -9.81, 0.6);
    this.group.add(this.smoke.points, this.sparks.points);

    // Ambient floating pollen / dust motes around the camera (catch the low sun).
    const count = 220;
    this.moteBase = new Float32Array(count * 3);
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.moteBase[i * 3] = (Math.random() - 0.5) * 60;
      this.moteBase[i * 3 + 1] = Math.random() * 12;
      this.moteBase[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.motes = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: 0xffe2b0, size: 0.045, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.motes.frustumCulled = false;
    this.group.add(this.motes);
  }

  /** Tint smoke/dust by the ambient light of the current time of day. */
  setLight(color: number, night: boolean): void {
    for (const pool of [this.smoke]) (pool.points.material as THREE.ShaderMaterial).uniforms.uLight.value.setHex(color);
    // Sunlit pollen only makes sense at golden hour; at night near-camera motes read as blobs.
    this.motes.visible = !night;
  }

  setViewportHeight(h: number, fovDeg: number): void {
    const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
    (this.smoke.points.material as THREE.ShaderMaterial).uniforms.uScale.value = scale;
    (this.sparks.points.material as THREE.ShaderMaterial).uniforms.uScale.value = scale;
  }

  tireSmoke(p: THREE.Vector3, v: THREE.Vector3, intensity: number): void {
    const s = 0.5 + Math.random() * 0.4;
    const c = 0.82 + Math.random() * 0.12;
    this.smoke.emit(
      p.x + (Math.random() - 0.5) * 0.3,
      p.y + 0.15,
      p.z + (Math.random() - 0.5) * 0.3,
      v.x * 0.25 + (Math.random() - 0.5) * 1.2,
      0.6 + Math.random() * 0.8,
      v.z * 0.25 + (Math.random() - 0.5) * 1.2,
      s,
      2.4,
      1.3 + Math.random() * 1.2,
      0.28 * intensity,
      c,
      c,
      c,
    );
  }

  dust(p: THREE.Vector3, v: THREE.Vector3, intensity: number): void {
    this.smoke.emit(
      p.x + (Math.random() - 0.5) * 0.4,
      p.y + 0.1,
      p.z + (Math.random() - 0.5) * 0.4,
      v.x * 0.15 + (Math.random() - 0.5) * 1.5,
      0.8 + Math.random() * 1.2,
      v.z * 0.15 + (Math.random() - 0.5) * 1.5,
      0.6 + Math.random() * 0.5,
      2.8,
      1.4 + Math.random() * 1.0,
      0.33 * intensity,
      0.62,
      0.5,
      0.34,
    );
  }

  exhaust(p: THREE.Vector3, dir: THREE.Vector3, amount: number): void {
    this.smoke.emit(p.x, p.y, p.z, dir.x * 2 + (Math.random() - 0.5) * 0.4, 0.3 + Math.random() * 0.3, dir.z * 2 + (Math.random() - 0.5) * 0.4, 0.12, 0.9, 0.5 + Math.random() * 0.3, 0.12 * amount, 0.55, 0.55, 0.58);
  }

  /** Backfire pop on up-shifts. */
  flame(p: THREE.Vector3, dir: THREE.Vector3): void {
    for (let i = 0; i < 4; i++) {
      this.sparks.emit(p.x, p.y, p.z, dir.x * (3 + i) + (Math.random() - 0.5), 0.2, dir.z * (3 + i) + (Math.random() - 0.5), 0.2 - i * 0.03, -0.3, 0.07 + Math.random() * 0.05, 1, 1.0, 0.55, 0.2);
    }
  }

  sparksAt(p: THREE.Vector3, normal: THREE.Vector3, strength: number): void {
    const n = Math.min(40, Math.floor(8 + strength * 30));
    for (let i = 0; i < n; i++) {
      const sp = 3 + Math.random() * 9 * (0.5 + strength);
      this.sparks.emit(
        p.x,
        p.y,
        p.z,
        normal.x * sp * 0.6 + (Math.random() - 0.5) * sp,
        Math.random() * sp * 0.6 + 1,
        normal.z * sp * 0.6 + (Math.random() - 0.5) * sp,
        0.05 + Math.random() * 0.05,
        -0.03,
        0.25 + Math.random() * 0.45,
        1,
        1.0,
        0.62 + Math.random() * 0.25,
        0.25,
      );
    }
  }

  /** Coloured spark spray (drift charge sparks, boost pads, item pickups). */
  coloredSparks(p: THREE.Vector3, v: THREE.Vector3, r: number, g: number, b: number, count: number, speed: number, life = 0.35, size = 0.07): void {
    for (let i = 0; i < count; i++) {
      this.sparks.emit(
        p.x,
        p.y,
        p.z,
        v.x + (Math.random() - 0.5) * speed,
        Math.random() * speed * 0.7 + 0.5,
        v.z + (Math.random() - 0.5) * speed,
        size * (0.7 + Math.random() * 0.6),
        -0.05,
        life * (0.6 + Math.random() * 0.8),
        1,
        r,
        g,
        b,
      );
    }
  }

  /** Item hit: fireball sparks + a burst of dark smoke. */
  explosion(p: THREE.Vector3): void {
    const zero = new THREE.Vector3();
    this.coloredSparks(p, zero, 1, 0.55, 0.15, 45, 16, 0.6, 0.12);
    this.coloredSparks(p, zero, 1, 0.9, 0.5, 20, 9, 0.4, 0.18);
    for (let i = 0; i < 14; i++) {
      this.smoke.emit(p.x + (Math.random() - 0.5) * 1.5, p.y + Math.random(), p.z + (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 4, 1 + Math.random() * 2.5, (Math.random() - 0.5) * 4, 0.9 + Math.random() * 0.6, 2.6, 1.2 + Math.random(), 0.45, 0.2, 0.19, 0.2);
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    this.smoke.update(dt);
    this.sparks.update(dt);
    // Motes wrap around the camera.
    const attr = this.motes.geometry.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const cp = camera.position;
    for (let i = 0; i < arr.length / 3; i++) {
      const bx = this.moteBase[i * 3] + Math.sin(this.time * 0.3 + i) * 1.5;
      const by = this.moteBase[i * 3 + 1] + Math.sin(this.time * 0.5 + i * 1.7) * 0.6;
      const bz = this.moteBase[i * 3 + 2] + Math.cos(this.time * 0.25 + i) * 1.5;
      arr[i * 3] = cp.x + ((((bx - cp.x) % 60) + 90) % 60) - 30;
      arr[i * 3 + 1] = cp.y - 3 + by;
      arr[i * 3 + 2] = cp.z + ((((bz - cp.z) % 60) + 90) % 60) - 30;
    }
    attr.needsUpdate = true;
  }
}
