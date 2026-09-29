import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TrackGeometry } from './TrackGeometry';
import type { Terrain } from './Terrain';
import { Noise2D, Random, smoothstep } from '../core/math';

type TreeKind = 'pine' | 'broad' | 'cypress';
const KINDS: TreeKind[] = ['pine', 'broad', 'cypress'];

/** Shared uniform for foliage wind sway (driven by the game loop). */
export const windUniform = { value: 0 };

// ------------------------------------------------------------------ geometry helpers

function jitter(g: THREE.BufferGeometry, noise: Noise2D, amount: number, freq: number): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const n = noise.get(x * freq + y * 0.7, z * freq - y * 0.3);
    const s = 1 + n * amount;
    p.setXYZ(i, x * s, y + n * amount * 0.4, z * s);
  }
  return g;
}

/**
 * Finalises a tree part: non-indexed flat-shaded geometry with `trunk` (0/1) and `ao`
 * (ambient occlusion: darker low and inside the crown) attributes.
 */
function part(g: THREE.BufferGeometry, isTrunk: boolean, crownMinY = 0, crownMaxY = 1, crownR = 1): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(ng.attributes)) if (name !== 'position') ng.deleteAttribute(name);
  ng.computeVertexNormals();
  const p = ng.attributes.position as THREE.BufferAttribute;
  const trunk = new Float32Array(p.count).fill(isTrunk ? 1 : 0);
  const ao = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    if (isTrunk) {
      ao[i] = 0.55 + 0.3 * Math.min(1, p.getY(i) / 3);
      continue;
    }
    const hy = smoothstep(crownMinY, crownMaxY, p.getY(i));
    const out = Math.min(1, Math.hypot(p.getX(i), p.getZ(i)) / crownR);
    ao[i] = 0.45 + 0.35 * hy + 0.25 * out;
  }
  ng.setAttribute('trunk', new THREE.BufferAttribute(trunk, 1));
  ng.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
  return ng;
}

function treeGeometry(kind: TreeKind, lod: 'near' | 'far', noise: Noise2D): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (kind === 'pine') {
    parts.push(part(new THREE.CylinderGeometry(0.1, 0.24, 3.2, lod === 'near' ? 6 : 4).translate(0, 1.6, 0), true));
    if (lod === 'near') {
      // Six drooping tiers of jagged branches, narrowing to a spike.
      const tiers = 6;
      for (let t = 0; t < tiers; t++) {
        const k = t / (tiers - 1);
        const r = 2.5 - k * 1.9;
        const h = 2.3 - k * 0.9;
        const y = 2.4 + t * 1.25;
        const cone = new THREE.ConeGeometry(r, h, 9, 1, true).translate(0, y, 0);
        cone.rotateY(t * 0.9);
        // Jagged rim: push every other rim vertex outwards and down.
        const p = cone.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) {
          if (p.getY(i) < y - h / 2 + 0.01) {
            const a = Math.atan2(p.getZ(i), p.getX(i));
            const spike = 1 + 0.22 * Math.abs(Math.sin(a * 4.5));
            p.setXYZ(i, p.getX(i) * spike, p.getY(i) - 0.25 * (spike - 1) * 4, p.getZ(i) * spike);
          }
        }
        parts.push(part(jitter(cone, noise, 0.07, 1.1), false, 1.5, 10, 2.6));
      }
      parts.push(part(new THREE.ConeGeometry(0.35, 1.4, 6).translate(0, 9.6, 0), false, 1.5, 10, 2.6));
    } else {
      parts.push(part(new THREE.ConeGeometry(2.4, 8.2, 6).translate(0, 5.6, 0), false, 1.5, 10, 2.4));
    }
  } else if (kind === 'cypress') {
    parts.push(part(new THREE.CylinderGeometry(0.1, 0.16, 1.2, 5).translate(0, 0.6, 0), true));
    const body = new THREE.IcosahedronGeometry(1, lod === 'near' ? 2 : 0).scale(0.95, 3.8, 0.95).translate(0, 4.3, 0);
    parts.push(part(jitter(body, noise, lod === 'near' ? 0.12 : 0.05, 1.4), false, 0.8, 8, 1));
  } else {
    // Broadleaf: trunk with two limbs and a domed crown of foliage clumps.
    parts.push(part(new THREE.CylinderGeometry(0.16, 0.3, 3.4, lod === 'near' ? 6 : 4).translate(0, 1.7, 0), true));
    if (lod === 'near') {
      for (const s of [-1, 1]) {
        const limb = new THREE.CylinderGeometry(0.06, 0.11, 1.8, 5).translate(0, 0.9, 0).rotateZ(s * 0.6).translate(0, 2.8, 0);
        parts.push(part(limb, true));
      }
      const rnd = new Random(7);
      const clumps: [number, number, number, number][] = [
        [0, 5.0, 0, 2.0],
        [1.5, 4.4, 0.4, 1.5],
        [-1.4, 4.5, -0.5, 1.5],
        [0.4, 4.3, 1.5, 1.4],
        [-0.5, 4.2, -1.4, 1.4],
        [0.3, 6.2, -0.2, 1.3],
        [1.1, 5.6, -1.0, 1.1],
        [-1.0, 5.7, 0.9, 1.1],
      ];
      for (const [x, y, z, r] of clumps) {
        const blob = new THREE.IcosahedronGeometry(r * (0.9 + rnd.next() * 0.2), 1).translate(x, y, z);
        parts.push(part(jitter(blob, noise, 0.16, 0.9), false, 2.8, 7.2, 3));
      }
    } else {
      parts.push(part(new THREE.IcosahedronGeometry(2.6, 0).scale(1.1, 0.9, 1.1).translate(0, 5, 0), false, 2.8, 7.2, 3));
    }
  }
  return mergeGeometries(parts)!;
}

function foliageMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWind = windUniform;
    shader.vertexShader =
      'uniform float uWind;\nattribute float trunk;\nattribute float ao;\n' +
      shader.vertexShader
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
          #ifdef USE_INSTANCING_COLOR
            vColor.xyz = mix(vColor.xyz, vec3(0.2, 0.14, 0.09), trunk) * ao;
          #endif`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            float phase = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.11;
            float sway = max(0.0, position.y - 2.0) * 0.016;
            transformed.x += sin(uWind * 1.4 + phase) * sway;
            transformed.z += cos(uWind * 1.1 + phase * 1.3) * sway * 0.7;
          #endif`,
        );
  };
  mat.customProgramCacheKey = () => 'foliage';
  return mat;
}

/** Transparent tuft of grass blades (with the odd wildflower) for alpha-tested billboards. */
function grassTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const rnd = new Random(12);
  ctx.clearRect(0, 0, 128, 128);
  for (let i = 0; i < 70; i++) {
    const x = 10 + rnd.next() * 108;
    const h = 50 + rnd.next() * 72;
    const lean = (rnd.next() - 0.5) * 30;
    const g = 110 + rnd.next() * 90;
    ctx.strokeStyle = `rgb(${Math.floor(g * 0.62)},${Math.floor(g)},${Math.floor(g * 0.35)})`;
    ctx.lineWidth = 2 + rnd.next() * 2.5;
    ctx.beginPath();
    ctx.moveTo(x, 128);
    ctx.quadraticCurveTo(x + lean * 0.3, 128 - h * 0.6, x + lean, 128 - h);
    ctx.stroke();
  }
  // A few flowers
  const flowers = ['#f2d23c', '#ffffff', '#d9483b', '#b07ad8'];
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = flowers[i % flowers.length];
    const x = 15 + rnd.next() * 98;
    const y = 18 + rnd.next() * 40;
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------ vegetation

interface TreeChunk {
  center: THREE.Vector3;
  radius: number;
  near: THREE.InstancedMesh[];
  far: THREE.InstancedMesh[];
}

interface GrassChunk {
  center: THREE.Vector3;
  radius: number;
  mesh: THREE.InstancedMesh;
}

/**
 * Forests, scattered trees and grass tufts. Trees are grouped into map chunks with a
 * detailed and a low-poly version (switched by distance); grass tufts only exist near
 * the circuit and are drawn only close to the camera.
 */
export class Vegetation {
  readonly group = new THREE.Group();
  private chunks: TreeChunk[] = [];
  private grass: GrassChunk[] = [];
  private readonly _v = new THREE.Vector3();

  constructor(
    private readonly track: TrackGeometry,
    private readonly terrain: Terrain,
    private readonly blocked: (x: number, z: number) => boolean,
    seed: number,
    treeCount: number,
  ) {
    this.group.name = 'vegetation';
    this.buildTrees(seed, treeCount);
    this.buildGrass(seed + 1);
  }

  private buildTrees(seed: number, target: number): void {
    const tr = this.terrain;
    const rnd = new Random(seed);
    const density = new Noise2D(seed + 3);
    const shapeNoise = new Noise2D(9);
    const geos = {
      near: Object.fromEntries(KINDS.map((k) => [k, treeGeometry(k, 'near', shapeNoise)])) as Record<TreeKind, THREE.BufferGeometry>,
      far: Object.fromEntries(KINDS.map((k) => [k, treeGeometry(k, 'far', shapeNoise)])) as Record<TreeKind, THREE.BufferGeometry>,
    };
    const palettes: Record<TreeKind, number[]> = {
      pine: [0x2a4523, 0x2f4d27, 0x243c1f, 0x35532b],
      broad: [0x55702c, 0x4c6a28, 0x607a30, 0x6f7a2e, 0x8a7a30, 0xa3752a],
      cypress: [0x2b4122, 0x324a27, 0x273b1e],
    };
    const bo = this.track.def.barrierOffset;
    const CH = 6;
    const chunkSize = tr.size / CH;
    type Inst = { m: THREE.Matrix4; c: THREE.Color };
    const buckets: Inst[][][] = []; // [chunk][kind]
    for (let i = 0; i < CH * CH; i++) buckets.push(KINDS.map(() => []));
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const lake = tr.lake;
    let placed = 0;
    for (let attempt = 0; attempt < target * 14 && placed < target; attempt++) {
      const x = tr.originX + 30 + rnd.next() * (tr.size - 60);
      const z = tr.originZ + 30 + rnd.next() * (tr.size - 60);
      const d = tr.distanceAt(x, z);
      if (d < bo + 9 || this.blocked(x, z)) continue;
      const y = tr.heightAt(x, z);
      const slope = Math.abs(tr.heightAt(x + 3, z) - tr.heightAt(x - 3, z)) + Math.abs(tr.heightAt(x, z + 3) - tr.heightAt(x, z - 3));
      if (slope > 5.5 || y > 120) continue; // cliffs and bare peaks
      // Density: forest patches, wooded lower mountain slopes, a ring around the lake,
      // a light scattering near the circuit, sparse elsewhere.
      let p = 0.04;
      p += smoothstep(0.5, 0.72, density.fbm(x / 260, z / 260, 3) * 0.5 + 0.5) * 0.95;
      p += smoothstep(14, 40, y) * (1 - smoothstep(80, 115, y)) * 0.55;
      if (d < bo + 70) p += 0.12;
      if (lake) {
        const ld = Math.hypot(x - lake.x, z - lake.z) / tr.lakeRadiusAt(x, z);
        if (ld > 1.12 && ld < 1.7) p += 0.4;
      }
      if (rnd.next() > p) continue;
      const alt = y > 35 ? 1 : 0;
      const r = rnd.next();
      const kind: TreeKind = alt ? (r < 0.8 ? 'pine' : 'cypress') : r < 0.55 ? 'broad' : r < 0.85 ? 'pine' : 'cypress';
      const s = rnd.range(0.7, 1.35) * (kind === 'pine' ? 1.1 : 1);
      e.set(rnd.range(-0.05, 0.05), rnd.next() * Math.PI * 2, rnd.range(-0.05, 0.05));
      q.setFromEuler(e);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.25, z), q, new THREE.Vector3(s, s * rnd.range(0.9, 1.25), s));
      const ci = Math.min(CH - 1, Math.max(0, Math.floor((x - tr.originX) / chunkSize)));
      const cj = Math.min(CH - 1, Math.max(0, Math.floor((z - tr.originZ) / chunkSize)));
      const c = new THREE.Color(rnd.pick(palettes[kind])).multiplyScalar(rnd.range(0.85, 1.15));
      buckets[cj * CH + ci][KINDS.indexOf(kind)].push({ m, c });
      placed++;
    }

    const mat = foliageMaterial();
    for (let cj = 0; cj < CH; cj++) {
      for (let ci = 0; ci < CH; ci++) {
        const lists = buckets[cj * CH + ci];
        if (lists.every((l) => l.length === 0)) continue;
        const cx = tr.originX + (ci + 0.5) * chunkSize;
        const cz = tr.originZ + (cj + 0.5) * chunkSize;
        const chunk: TreeChunk = { center: new THREE.Vector3(cx, tr.heightAt(cx, cz), cz), radius: chunkSize * 0.75, near: [], far: [] };
        lists.forEach((list, k) => {
          if (!list.length) return;
          for (const lod of ['near', 'far'] as const) {
            const im = new THREE.InstancedMesh(geos[lod][KINDS[k]], mat, list.length);
            list.forEach((inst, i) => {
              im.setMatrixAt(i, inst.m);
              im.setColorAt(i, inst.c);
            });
            im.castShadow = lod === 'near';
            im.receiveShadow = lod === 'near';
            im.computeBoundingSphere();
            im.visible = lod === 'far';
            this.group.add(im);
            chunk[lod].push(im);
          }
        });
        this.chunks.push(chunk);
      }
    }
  }

  private buildGrass(seed: number): void {
    const tr = this.terrain;
    const t = this.track;
    const rnd = new Random(seed);
    const bo = t.def.barrierOffset;
    // Three crossed quads per tuft; normals point up so tufts light like the ground.
    const quad = new THREE.PlaneGeometry(1.1, 0.6).translate(0, 0.3, 0);
    const tuft = mergeGeometries([0, 1, 2].map((i) => quad.clone().rotateY((i * Math.PI) / 3)))!;
    const nrm = tuft.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const mat = new THREE.MeshStandardMaterial({ map: grassTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWind = windUniform;
      shader.vertexShader =
        'uniform float uWind;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            float ph = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.5;
            transformed.x += sin(uWind * 2.2 + ph) * position.y * 0.12;
          #endif`,
        );
    };
    mat.customProgramCacheKey = () => 'grass-tuft';
    const cell = 150;
    const buckets = new Map<string, { m: THREE.Matrix4; c: THREE.Color }[]>();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const tints = [0x86a14a, 0x9aa653, 0x7f9a43, 0xb3a860, 0x6f8f3a];
    for (let i = 0; i < 16000; i++) {
      const s = rnd.next() * t.length;
      const side = rnd.next() < 0.5 ? -1 : 1;
      const lat = side * (bo + 1.5 + Math.pow(rnd.next(), 1.6) * 45);
      t.offsetPoint(s, lat, p);
      if (t.distanceToCenterline(p.x, p.z) < bo + 1 || this.blocked(p.x, p.z)) continue;
      const sc = rnd.range(0.6, 1.4);
      q.setFromAxisAngle(up, rnd.next() * Math.PI);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, tr.heightAt(p.x, p.z) - 0.04, p.z), q, new THREE.Vector3(sc, sc * rnd.range(0.8, 1.3), sc));
      const key = `${Math.floor(p.x / cell)}:${Math.floor(p.z / cell)}`;
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push({ m, c: new THREE.Color(rnd.pick(tints)) });
    }
    for (const [key, list] of buckets) {
      const [ci, cj] = key.split(':').map(Number);
      const im = new THREE.InstancedMesh(tuft, mat, list.length);
      list.forEach((inst, i) => {
        im.setMatrixAt(i, inst.m);
        im.setColorAt(i, inst.c);
      });
      im.receiveShadow = true;
      im.computeBoundingSphere();
      im.visible = false;
      this.group.add(im);
      const cx = (ci + 0.5) * cell;
      const cz = (cj + 0.5) * cell;
      this.grass.push({ center: new THREE.Vector3(cx, tr.heightAt(cx, cz), cz), radius: cell * 0.72, mesh: im });
    }
  }

  /** Distance-based LOD / culling; `maxDistance` is usually the fog's far plane. */
  update(camera: THREE.Vector3, maxDistance: number): void {
    const nearDist = 280;
    for (const c of this.chunks) {
      const d = this._v.copy(c.center).distanceTo(camera) - c.radius;
      const near = d < nearDist;
      for (const m of c.near) m.visible = near;
      for (const m of c.far) m.visible = !near && d < maxDistance;
    }
    for (const g of this.grass) g.mesh.visible = g.center.distanceTo(camera) - g.radius < Math.min(170, maxDistance);
  }

  /** Make everything visible (GPU warm-up uploads every buffer once). */
  showAll(): void {
    for (const c of this.chunks) for (const m of [...c.near, ...c.far]) m.visible = true;
    for (const g of this.grass) g.mesh.visible = true;
  }
}
