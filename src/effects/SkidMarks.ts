import * as THREE from 'three';

interface Trail {
  active: boolean;
  lx: number;
  ly: number;
  lz: number;
  rx: number;
  ry: number;
  rz: number;
  a: number;
}

/**
 * Tyre marks as a ring buffer of quads in one mesh. Each emitter (wheel) continues its
 * strip while it keeps skidding; old marks are overwritten when the buffer wraps.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly cap: number;
  private head = 0;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private trails = new Map<number, Trail>();
  private dirty = false;

  constructor(capacity = 4000) {
    this.cap = capacity;
    this.pos = new Float32Array(capacity * 4 * 3);
    this.col = new Float32Array(capacity * 4 * 4);
    const idx = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6); // side x forward = up
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0a0a0a,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /**
   * Adds a point to emitter `id`'s trail. `side` is the wheel's lateral axis, `halfWidth`
   * the half tyre width. `intensity` 0 ends the trail.
   */
  add(id: number, p: THREE.Vector3, side: THREE.Vector3, halfWidth: number, intensity: number): void {
    let tr = this.trails.get(id);
    if (!tr) {
      tr = { active: false, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, a: 0 };
      this.trails.set(id, tr);
    }
    if (intensity <= 0.02) {
      tr.active = false;
      return;
    }
    const lx = p.x - side.x * halfWidth;
    const ly = p.y + 0.025;
    const lz = p.z - side.z * halfWidth;
    const rx = p.x + side.x * halfWidth;
    const ry = p.y + 0.025;
    const rz = p.z + side.z * halfWidth;
    const a = Math.min(0.85, intensity);
    if (tr.active) {
      const dx = lx - tr.lx;
      const dz = lz - tr.lz;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0.09) return; // wait until the wheel moved ~30 cm
      if (d2 < 16) {
        const q = this.head;
        this.head = (this.head + 1) % this.cap;
        const o = q * 12;
        this.pos.set([tr.lx, tr.ly, tr.lz, tr.rx, tr.ry, tr.rz, lx, ly, lz, rx, ry, rz], o);
        const c = q * 16;
        this.col.set([1, 1, 1, tr.a, 1, 1, 1, tr.a, 1, 1, 1, a, 1, 1, 1, a], c);
        this.dirty = true;
      }
    }
    tr.active = true;
    tr.lx = lx;
    tr.ly = ly;
    tr.lz = lz;
    tr.rx = rx;
    tr.ry = ry;
    tr.rz = rz;
    tr.a = a;
  }

  update(): void {
    if (!this.dirty) return;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.dirty = false;
  }

  clear(): void {
    this.pos.fill(0);
    this.col.fill(0);
    this.trails.clear();
    this.dirty = true;
  }
}
