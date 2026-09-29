import * as THREE from 'three';
import type { ItemSystem } from './Items';
import type { Car } from '../car/Car';
import type { ParticleManager } from '../effects/ParticleManager';

/** "?" face for item boxes. */
function itemBoxTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 128, 128);
  g.addColorStop(0, '#ff3b8d');
  g.addColorStop(0.35, '#ffb800');
  g.addColorStop(0.65, '#28e0ff');
  g.addColorStop(1, '#8a5bff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(6, 6, 116, 116);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, 116, 116);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 92px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Fresnel bubble for shields. */
function shieldMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x7dffb0) } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vP = position;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uColor;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        float f = pow(1.0 - abs(dot(vN, vV)), 2.2);
        float bands = 0.5 + 0.5 * sin(vP.y * 9.0 - uTime * 6.0);
        gl_FragColor = vec4(uColor * (1.6 + bands), f * 0.85 + 0.05);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

interface Ring {
  mesh: THREE.Mesh;
  age: number;
  radius: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _zero = new THREE.Vector3();

/**
 * Renders the dynamic item layer: floating item boxes, missiles (with trails), oil
 * slicks, shield bubbles and EMP shock rings. Everything is pooled.
 */
export class GameplayVisuals {
  readonly group = new THREE.Group();
  private boxes: THREE.InstancedMesh;
  private boxScale: number[] = [];
  private missiles: THREE.Mesh[] = [];
  private slicks: THREE.Mesh[] = [];
  private shields = new Map<Car, THREE.Mesh>();
  private rings: Ring[] = [];
  private shieldMat = shieldMaterial();
  private missileGeo: THREE.BufferGeometry;
  private missileMat = new THREE.MeshStandardMaterial({ color: 0xdedede, metalness: 0.6, roughness: 0.3, emissive: 0xff3300, emissiveIntensity: 0.4 });
  private slickGeo = new THREE.CircleGeometry(2.1, 20).rotateX(-Math.PI / 2);
  private slickMat = new THREE.MeshStandardMaterial({ color: 0x120a1c, roughness: 0.05, metalness: 0.8, transparent: true, opacity: 0.92, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  private time = 0;

  constructor(
    private readonly items: ItemSystem,
    private readonly particles: ParticleManager,
  ) {
    this.group.name = 'gameplay-fx';
    const tex = itemBoxTexture();
    const boxMat = new THREE.MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: 0xffffff,
      emissiveIntensity: 0.9,
      roughness: 0.2,
      transparent: true,
      opacity: 0.88,
    });
    this.boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), boxMat, Math.max(1, items.boxes.length));
    this.boxes.count = items.boxes.length;
    this.boxes.frustumCulled = false;
    this.boxes.castShadow = true;
    this.boxScale = items.boxes.map(() => 1);
    this.group.add(this.boxes);
    const body = new THREE.CylinderGeometry(0.16, 0.16, 1.1, 10).rotateX(Math.PI / 2);
    const nose = new THREE.ConeGeometry(0.16, 0.4, 10).rotateX(Math.PI / 2).translate(0, 0, 0.75);
    const fins = new THREE.BoxGeometry(0.7, 0.05, 0.25).translate(0, 0, -0.45);
    const fins2 = new THREE.BoxGeometry(0.05, 0.7, 0.25).translate(0, 0, -0.45);
    this.missileGeo = mergeSimple([body, nose, fins, fins2]);
  }

  /** Expanding shock ring (EMP). */
  ring(center: THREE.Vector3, radius: number): void {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x5ef2ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    mesh.position.copy(center);
    mesh.position.y += 0.4;
    this.group.add(mesh);
    this.rings.push({ mesh, age: 0, radius });
  }

  update(dt: number, cars: Car[]): void {
    this.time += dt;
    const t = this.time;
    // Item boxes: spin + bob, pop back in when they respawn.
    this.items.boxes.forEach((b, i) => {
      const target = b.active ? 1 : 0;
      const k = target > this.boxScale[i] ? 5 : 20;
      this.boxScale[i] += (target - this.boxScale[i]) * Math.min(1, dt * k);
      const sc = this.boxScale[i] < 0.02 ? 0 : this.boxScale[i] * (1 + Math.sin(t * 5 + i) * 0.04);
      _e.set(t * 0.9 + i, t * 1.3 + i * 0.7, 0.3);
      _q.setFromEuler(_e);
      _s.setScalar(sc);
      _m.compose(_zero.set(b.pos.x, b.pos.y + Math.sin(t * 2.2 + i * 1.3) * 0.18, b.pos.z), _q, _s);
      this.boxes.setMatrixAt(i, _m);
    });
    this.boxes.instanceMatrix.needsUpdate = true;
    _zero.set(0, 0, 0);

    // Missiles
    const ms = this.items.missiles;
    while (this.missiles.length < ms.length) {
      const m = new THREE.Mesh(this.missileGeo, this.missileMat);
      this.group.add(m);
      this.missiles.push(m);
    }
    this.missiles.forEach((mesh, i) => {
      const m = ms[i];
      mesh.visible = !!m;
      if (!m) return;
      if (mesh.userData.last) mesh.lookAt(m.pos.clone().multiplyScalar(2).sub(mesh.userData.last));
      mesh.position.copy(m.pos);
      mesh.userData.last = (mesh.userData.last ?? new THREE.Vector3()).copy(m.pos);
      this.particles.coloredSparks(m.pos, _zero, 1, 0.6, 0.2, 2, 1.5, 0.25, 0.14);
    });

    // Oil slicks
    const sl = this.items.slicks;
    while (this.slicks.length < sl.length) {
      const m = new THREE.Mesh(this.slickGeo, this.slickMat);
      m.renderOrder = 2;
      this.group.add(m);
      this.slicks.push(m);
    }
    this.slicks.forEach((mesh, i) => {
      const o = sl[i];
      mesh.visible = !!o;
      if (!o) return;
      mesh.position.set(o.pos.x, o.pos.y + 0.04, o.pos.z);
      const grow = Math.min(1, (30 - o.life) * 3);
      mesh.scale.setScalar(0.3 + 0.7 * grow);
    });

    // Shields
    this.shieldMat.uniforms.uTime.value = t;
    for (const car of cars) {
      const st = this.items.get(car);
      let m = this.shields.get(car);
      if (st.shield > 0) {
        if (!m) {
          m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.shieldMat);
          m.scale.set(1.5, 1.05, 2.7);
          m.renderOrder = 6;
          this.group.add(m);
          this.shields.set(car, m);
        }
        m.visible = st.shield > 2 || Math.sin(t * 20) > 0; // blink before it runs out
        m.position.copy(car.physics.position);
        m.position.y += 0.35;
        m.quaternion.copy(car.physics.quaternion);
      } else if (m) m.visible = false;
    }

    // EMP rings
    for (const r of this.rings) {
      r.age += dt;
      const k = Math.min(1, r.age / 0.45);
      r.mesh.scale.setScalar(1 + k * r.radius);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      if (this.rings[i].age > 0.45) {
        this.group.remove(this.rings[i].mesh);
        this.rings[i].mesh.geometry.dispose();
        this.rings.splice(i, 1);
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}

function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    return n;
  });
  let count = 0;
  for (const p of parts) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, o * 3);
    nor.set(p.attributes.normal.array as Float32Array, o * 3);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}
