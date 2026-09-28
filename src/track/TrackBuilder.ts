import * as THREE from 'three';
import type { TrackGeometry } from './TrackGeometry';
import type { Terrain } from './Terrain';
import type { TrackLayout, BarrierRun } from './TrackLayout';
import type { RacingLine } from '../ai/RacingLine';
import { buildRibbon, curbProfile, roadProfile, type RibbonData } from './TrackMeshData';
import * as tex from '../render/textures';
import { Noise2D, smoothstep } from '../core/math';
import { mergeByMaterial } from '../render/merge';

function ribbonGeometry(d: RibbonData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(d.indices, 1));
  g.computeVertexNormals();
  return g;
}

/**
 * Builds all track-surface visuals: terrain, asphalt, markings, curbs, start line,
 * grid boxes, barriers (armco / painted concrete / tyre walls).
 */
export class TrackBuilder {
  readonly group = new THREE.Group();

  constructor(
    readonly track: TrackGeometry,
    readonly terrain: Terrain,
    readonly layout: TrackLayout,
    readonly line: RacingLine,
  ) {
    this.group.name = 'track';
    this.buildTerrain();
    this.buildRoad();
    this.buildMarkings();
    this.buildCurbs();
    this.buildStartLine();
    this.buildGrid();
    this.buildBarriers();
    // Grid boxes, curbs, lines etc. -> one draw call per material. Terrain and road stay separate.
    const keep = new Set<THREE.Object3D>();
    this.group.children.forEach((c) => {
      if (c.name === 'terrain' || c.name === 'road') keep.add(c);
    });
    mergeByMaterial(this.group, keep);
  }

  private buildTerrain(): void {
    const tr = this.terrain;
    const n = tr.segments + 1;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const col = new Float32Array(n * n * 3);
    const noise = new Noise2D(tr.track.def.terrain.seed + 55);
    const lush = new THREE.Color(0x4f6a2a);
    const mowed = new THREE.Color(0x5b7a30);
    const dry = new THREE.Color(0xb39a58);
    const olive = new THREE.Color(0x77763a);
    const dirt = new THREE.Color(0x8a6a48);
    const c = new THREE.Color();
    const bo = tr.track.def.barrierOffset;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = tr.originX + i * tr.cell;
        const z = tr.originZ + j * tr.cell;
        pos[k * 3] = x;
        pos[k * 3 + 1] = tr.heights[k];
        pos[k * 3 + 2] = z;
        uv[k * 2] = x / 7;
        uv[k * 2 + 1] = z / 7;
        const d = tr.trackDistance[k];
        const nv = noise.fbm(x / 160, z / 160, 3) * 0.5 + 0.5;
        const fine = noise.get(x / 18, z / 18) * 0.5 + 0.5;
        c.copy(olive).lerp(dry, smoothstep(0.35, 0.7, nv));
        c.lerp(lush, smoothstep(0.55, 0.2, nv) * 0.6);
        // Mowed runoff near the track with stripes.
        const near = smoothstep(bo + 14, bo + 2, d);
        const stripe = Math.sin((x + z) * 0.18) > 0 ? 1 : 0.9;
        const mow = mowed.clone().multiplyScalar(stripe);
        c.lerp(mow, near);
        // Steep slopes show dirt.
        const hx = tr.heights[j * n + Math.min(n - 1, i + 1)] - tr.heights[k];
        const hz = tr.heights[Math.min(n - 1, j + 1) * n + i] - tr.heights[k];
        const slope = Math.hypot(hx, hz) / tr.cell;
        c.lerp(dirt, smoothstep(0.35, 0.8, slope) * 0.8);
        c.multiplyScalar(0.85 + fine * 0.25);
        col[k * 3] = c.r;
        col[k * 3 + 1] = c.g;
        col[k * 3 + 2] = c.b;
      }
    }
    const idx = new Uint32Array(tr.segments * tr.segments * 6);
    let p = 0;
    for (let j = 0; j < tr.segments; j++) {
      for (let i = 0; i < tr.segments; i++) {
        const a = j * n + i;
        const b = a + 1;
        const cc = a + n;
        const d = cc + 1;
        idx[p++] = a;
        idx[p++] = cc;
        idx[p++] = b;
        idx[p++] = b;
        idx[p++] = cc;
        idx[p++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const gr = tex.grass();
    const mat = new THREE.MeshStandardMaterial({
      map: gr.map,
      normalMap: gr.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    this.group.add(mesh);
  }

  private buildRoad(): void {
    const t = this.track;
    const data = buildRibbon(t, roadProfile(t.halfWidth), { closed: true, vScale: 14 });
    const a = tex.asphalt();
    const mat = new THREE.MeshStandardMaterial({
      map: a.map,
      normalMap: a.normalMap,
      normalScale: new THREE.Vector2(0.25, 0.25),
      roughnessMap: a.roughnessMap,
      roughness: 1,
      metalness: 0,
      color: 0xffffff,
    });
    const mesh = new THREE.Mesh(ribbonGeometry(data), mat);
    mesh.receiveShadow = true;
    mesh.name = 'road';
    this.group.add(mesh);

    // Rubbered-in racing line: dark translucent band following the AI line.
    const n = t.count;
    const across = 5;
    const w = 1.6;
    const pos = new Float32Array((n + 1) * across * 3);
    const uv = new Float32Array((n + 1) * across * 2);
    for (let r = 0; r <= n; r++) {
      const i = r % n;
      const o = this.line.offset[i];
      for (let k = 0; k < across; k++) {
        const lat = o + (k / (across - 1) - 0.5) * 2 * w;
        const q = (r * across + k) * 3;
        pos[q] = t.pos[i * 3] + t.right[i * 2] * lat;
        pos[q + 1] = t.pos[i * 3 + 1] + 0.018 - Math.abs(lat) * 0.0008;
        pos[q + 2] = t.pos[i * 3 + 2] + t.right[i * 2 + 1] * lat;
        uv[(r * across + k) * 2] = k / (across - 1);
        uv[(r * across + k) * 2 + 1] = r * t.spacing / 20;
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < n; r++)
      for (let k = 0; k < across - 1; k++) {
        const v00 = r * across + k;
        idx.push(v00, v00 + 1, v00 + across, v00 + 1, v00 + across + 1, v00 + across);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const alpha = document.createElement('canvas');
    alpha.width = 64;
    alpha.height = 4;
    const ctx = alpha.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 64, 0);
    grad.addColorStop(0, '#000');
    grad.addColorStop(0.3, '#888');
    grad.addColorStop(0.5, '#aaa');
    grad.addColorStop(0.7, '#888');
    grad.addColorStop(1, '#000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 4);
    const alphaTex = new THREE.CanvasTexture(alpha);
    const lineMat = new THREE.MeshStandardMaterial({
      color: 0x0c0c0c,
      transparent: true,
      opacity: 0.45,
      alphaMap: alphaTex,
      roughness: 0.55,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const lm = new THREE.Mesh(g, lineMat);
    lm.receiveShadow = true;
    lm.renderOrder = 1;
    this.group.add(lm);
  }

  private buildMarkings(): void {
    const t = this.track;
    const paint = new THREE.MeshStandardMaterial({
      color: 0xf2f2ec,
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    for (const side of [-1, 1]) {
      const l = side * (t.halfWidth - 0.35);
      const prof = { laterals: [l - 0.12, l + 0.12], heights: [0.012, 0.012] };
      const d = buildRibbon(t, prof, { closed: true });
      const m = new THREE.Mesh(ribbonGeometry(d), paint);
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  private buildCurbs(): void {
    const t = this.track;
    const mat = new THREE.MeshStandardMaterial({ map: tex.curb(), roughness: 0.55 });
    for (const zone of this.layout.curbs) {
      const d = buildRibbon(t, curbProfile(t.halfWidth, this.layout.curbWidth, zone.side), {
        start: zone.startIndex,
        end: zone.endIndex,
        vScale: 3.2,
      });
      const m = new THREE.Mesh(ribbonGeometry(d), mat);
      m.receiveShadow = true;
      m.castShadow = false;
      this.group.add(m);
    }
  }

  /** Oriented flat quad lying on the road at arc length s. */
  private roadQuad(s: number, lateral: number, width: number, length: number, mat: THREE.Material, lift = 0.022): THREE.Mesh {
    const t = this.track;
    const p = t.offsetPoint(s, lateral, new THREE.Vector3());
    const tan = t.tangentAt(s, new THREE.Vector3());
    const g = new THREE.PlaneGeometry(width, length).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(p.x, p.y + lift, p.z);
    m.rotation.y = Math.atan2(tan.x, tan.z);
    m.receiveShadow = true;
    return m;
  }

  private buildStartLine(): void {
    const t = this.track;
    const mat = new THREE.MeshStandardMaterial({
      map: tex.checker(24, 2),
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.group.add(this.roadQuad(0, 0, t.def.roadWidth - 0.2, 1.2, mat));
  }

  private buildGrid(): void {
    const paint = new THREE.MeshStandardMaterial({
      color: 0xf2f2ec,
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const slots = this.layout.gridSlots(10);
    for (const slot of slots) {
      // Front bar and two short side lines of the grid box.
      this.group.add(this.roadQuad(slot.s + 2.6, slot.lateral, 2.4, 0.18, paint));
      this.group.add(this.roadQuad(slot.s + 2.0, slot.lateral - 1.2, 0.15, 1.2, paint));
      this.group.add(this.roadQuad(slot.s + 2.0, slot.lateral + 1.2, 0.15, 1.2, paint));
    }
  }

  private buildBarriers(): void {
    const concreteTex = tex.concrete();
    const concreteMat = new THREE.MeshStandardMaterial({
      map: concreteTex.map,
      normalMap: concreteTex.normalMap,
      vertexColors: true,
      roughness: 0.85,
    });
    const armcoMat = new THREE.MeshStandardMaterial({ color: 0xc4c8cc, metalness: 0.75, roughness: 0.32, side: THREE.DoubleSide });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x6d7074, metalness: 0.6, roughness: 0.5 });

    const concreteGeo: { pos: number[]; col: number[]; uv: number[]; idx: number[] } = { pos: [], col: [], uv: [], idx: [] };
    const armcoGeo: { pos: number[]; idx: number[] } = { pos: [], idx: [] };
    const posts: THREE.Matrix4[] = [];
    const tires: { m: THREE.Matrix4; c: THREE.Color }[] = [];

    // Jersey-barrier profile (outward, up)
    const jersey = [
      [0, -0.4],
      [0, 0.2],
      [0.12, 0.34],
      [0.2, 0.95],
      [0.42, 0.95],
      [0.5, -0.4],
    ];
    const rail = [
      [0.02, 0.42],
      [-0.04, 0.5],
      [0.02, 0.58],
      [-0.04, 0.66],
      [0.02, 0.74],
    ];
    const red = new THREE.Color(0xc8261d);
    const white = new THREE.Color(0xf0efe8);
    const grey = new THREE.Color(0xd8d6d0);
    const tireColors = [new THREE.Color(0xd8261d), new THREE.Color(0xf2f2f2)];
    const tmpM = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);

    const extrude = (run: BarrierRun, i: number, profile: number[][], outward: number, target: { pos: number[]; idx: number[]; col?: number[]; uv?: number[] }, color?: THREE.Color) => {
      const a = run.points[i];
      const b = run.points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      // Outward normal of this segment (same for both ends -> crisp segments)
      const nx = (-dz / len) * run.side;
      const nz = (dx / len) * run.side;
      const base = target.pos.length / 3;
      const ext = 0.04; // tiny overlap hides seams
      for (const [end, P] of [
        [0, a],
        [1, b],
      ] as const) {
        const fx = (dx / len) * ext * (end === 0 ? -1 : 1);
        const fz = (dz / len) * ext * (end === 0 ? -1 : 1);
        for (let k = 0; k < profile.length; k++) {
          const [o, h] = profile[k];
          target.pos.push(P.x + nx * (o + outward) + fx, P.y + h, P.z + nz * (o + outward) + fz);
          if (target.col && color) target.col.push(color.r, color.g, color.b);
          if (target.uv) target.uv.push(end * len / 3, 1 - (h + 0.4) / 1.4);
        }
      }
      const m = profile.length;
      for (let k = 0; k < m - 1; k++) {
        const a0 = base + k;
        const a1 = base + k + 1;
        const b0 = base + m + k;
        const b1 = base + m + k + 1;
        // forward x up = track-right, so right-side walls need the opposite winding to face the track.
        if (run.side === 1) target.idx.push(a0, a1, b0, a1, b1, b0);
        else target.idx.push(a0, b0, a1, a1, b0, b1);
      }
    };

    for (const run of this.layout.barriers) {
      let stripe = 0;
      for (let i = 0; i < run.points.length - 1; i++) {
        const style = run.styles[i];
        const a = run.points[i];
        const b = run.points[i + 1];
        if (style === 'armco') {
          extrude(run, i, rail, 0, armcoGeo);
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const len = Math.hypot(dx, dz) || 1;
          {
            const nx = (-dz / len) * run.side;
            const nz = (dx / len) * run.side;
            q.setFromAxisAngle(up, Math.atan2(dx, dz));
            tmpM.compose(new THREE.Vector3(a.x + nx * 0.14, a.y + 0.35, a.z + nz * 0.14), q, new THREE.Vector3(1, 1, 1));
            posts.push(tmpM.clone());
          }
        } else {
          stripe++;
          const painted = style === 'concrete' ? (Math.floor(stripe / 1) % 2 === 0 ? red : white) : grey;
          const outward = style === 'tires' ? 0.62 : 0;
          extrude(run, i, jersey, outward, concreteGeo, painted);
          if (style === 'tires') {
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const len = Math.hypot(dx, dz) || 1;
            const nx = (-dz / len) * run.side;
            const nz = (dx / len) * run.side;
            const count = Math.max(1, Math.round(len / 0.62));
            for (let k = 0; k < count; k++) {
              const f = (k + 0.5) / count;
              const x = a.x + dx * f + nx * 0.31;
              const z = a.z + dz * f + nz * 0.31;
              const y = a.y + (b.y - a.y) * f;
              const colIdx = Math.floor((i * count + k) / 3) % 2;
              for (let h = 0; h < 3; h++) {
                tmpM.makeTranslation(x, y + 0.13 + h * 0.25, z);
                tires.push({ m: tmpM.clone(), c: h === 1 ? tireColors[colIdx] : new THREE.Color(0x1a1a1a) });
              }
            }
          }
        }
      }
    }

    if (concreteGeo.pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(concreteGeo.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(concreteGeo.col, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(concreteGeo.uv, 2));
      g.setIndex(concreteGeo.idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, concreteMat);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    if (armcoGeo.pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(armcoGeo.pos, 3));
      g.setIndex(armcoGeo.idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, armcoMat);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    if (posts.length) {
      const g = new THREE.BoxGeometry(0.1, 0.9, 0.14);
      const im = new THREE.InstancedMesh(g, postMat, posts.length);
      posts.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = true;
      im.receiveShadow = true;
      this.group.add(im);
    }
    if (tires.length) {
      const g = new THREE.TorusGeometry(0.22, 0.1, 6, 12).rotateX(Math.PI / 2);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
      const im = new THREE.InstancedMesh(g, mat, tires.length);
      tires.forEach((t, i) => {
        im.setMatrixAt(i, t.m);
        im.setColorAt(i, t.c);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      this.group.add(im);
    }
  }
}
