import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TrackGeometry } from './TrackGeometry';
import type { TrackLayout } from './TrackLayout';
import { shortcutRibbon, rampVertices, gatePositions } from '../physics/TrackColliders';
import * as tex from '../render/textures';

/** Glowing arrow strip for boost pads (scrolls toward the direction of travel). */
function boostPadTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#04121c';
  ctx.fillRect(0, 0, 128, 256);
  for (let k = 0; k < 2; k++) {
    const y0 = k * 128;
    const grad = ctx.createLinearGradient(0, y0 + 110, 0, y0 + 20);
    grad.addColorStop(0, '#0a6cff');
    grad.addColorStop(1, '#7ff6ff');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(10, y0 + 110);
    ctx.lineTo(64, y0 + 40);
    ctx.lineTo(118, y0 + 110);
    ctx.lineTo(92, y0 + 110);
    ctx.lineTo(64, y0 + 74);
    ctx.lineTo(36, y0 + 110);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = '#7ff6ff';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, -10, 122, 276);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 2);
  t.anisotropy = 4;
  return t;
}

/** Yellow/black hazard stripes for the ramp face. */
function hazardTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#f2c230';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#151515';
  for (let i = -128; i < 256; i += 48) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 24, 0);
    ctx.lineTo(i + 24 + 128, 128);
    ctx.lineTo(i + 128, 128);
    ctx.closePath();
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * Static meshes for track gameplay features: boost pads, and each shortcut's dirt path,
 * kicker ramp, tyre-stack gate and a tempting arrow sign at the entrance.
 */
export class FeatureMeshes {
  readonly group = new THREE.Group();
  private padTex: THREE.CanvasTexture;
  private padMat: THREE.MeshStandardMaterial;

  constructor(track: TrackGeometry, layout: TrackLayout) {
    this.group.name = 'features';
    this.padTex = boostPadTexture();
    this.padMat = new THREE.MeshStandardMaterial({
      map: this.padTex,
      emissiveMap: this.padTex,
      emissive: 0xffffff,
      emissiveIntensity: 1.6,
      roughness: 0.3,
      metalness: 0.2,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    // Boost pads: a short ribbon draped on the road (follows banking/crown).
    for (const d of track.def.gameplay?.boostPads ?? []) {
      const rows = 5;
      const across = 3;
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const p = new THREE.Vector3();
      for (let r = 0; r < rows; r++) {
        const s = d.s - 2.4 + (4.8 * r) / (rows - 1);
        for (let a = 0; a < across; a++) {
          const lat = d.lateral - 1.5 + (3 * a) / (across - 1);
          track.offsetPoint(s, lat, p);
          const h = track.project(p.x, p.z).height;
          pos.push(p.x, h + 0.03, p.z);
          uv.push(a / (across - 1), r / (rows - 1));
        }
      }
      for (let r = 0; r < rows - 1; r++)
        for (let a = 0; a < across - 1; a++) {
          const v = r * across + a;
          idx.push(v, v + 1, v + across, v + 1, v + across + 1, v + across);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      // Normals may point down depending on winding; make them up.
      const n = g.attributes.normal as THREE.BufferAttribute;
      if (n.getY(0) < 0) {
        g.setIndex(idx.map((_, i) => idx[i - (i % 3) + [0, 2, 1][i % 3]]));
        g.computeVertexNormals();
      }
      const m = new THREE.Mesh(g, this.padMat);
      m.receiveShadow = true;
      m.renderOrder = 2;
      this.group.add(m);
    }

    const dirt = tex.dirt();
    const dirtMap = dirt.map.clone();
    dirtMap.repeat.set(1, 1);
    dirtMap.needsUpdate = true;
    const dirtMat = new THREE.MeshStandardMaterial({ map: dirtMap, normalMap: dirt.normalMap, roughness: 0.95, color: 0xd8c2a4 });
    const hazard = hazardTexture();
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.85 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
    const red = new THREE.MeshStandardMaterial({ color: 0xd81e2c, roughness: 0.6 });
    for (const sc of layout.shortcuts) {
      const rib = shortcutRibbon(sc);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(rib.positions, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(rib.uvs, 2));
      g.setIndex(new THREE.BufferAttribute(rib.indices, 1));
      g.computeVertexNormals();
      const path = new THREE.Mesh(g, dirtMat);
      path.receiveShadow = true;
      path.renderOrder = 1;
      this.group.add(path);

      const point = (f: number, out: THREE.Vector3) => layout.shortcutPoint(sc, f, out);
      const rv = rampVertices(sc, point);
      if (rv) {
        // Wedge: vertices [low L, low R, high L, high R, base-high L, base-high R, base-low L, base-low R]
        const v = (i: number) => [rv[i * 3], rv[i * 3 + 1], rv[i * 3 + 2]];
        const quads = [
          [0, 1, 3, 2], // ramp surface
          [2, 3, 5, 4], // lip face
          [0, 2, 4, 6], // side
          [1, 7, 5, 3], // side
        ];
        const pos: number[] = [];
        const uv: number[] = [];
        for (const q of quads) {
          const [a, b, c, d] = q.map(v);
          pos.push(...a, ...b, ...c, ...a, ...c, ...d);
          uv.push(0, 0, 3, 0, 3, 2, 0, 0, 3, 2, 0, 2);
        }
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        wg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        wg.computeVertexNormals();
        const ramp = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ map: hazard, roughness: 0.6, side: THREE.DoubleSide }));
        ramp.castShadow = true;
        ramp.receiveShadow = true;
        this.group.add(ramp);
      }
      // Tyre stacks (three tyres each, alternating red/white tops)
      const tyre = new THREE.TorusGeometry(0.34, 0.14, 8, 14).rotateX(Math.PI / 2);
      const stacks: THREE.BufferGeometry[] = [];
      const tops: THREE.BufferGeometry[] = [];
      for (const p of gatePositions(sc, point)) {
        for (let k = 0; k < 4; k++) stacks.push(tyre.clone().translate(p.x, p.y + 0.14 + k * 0.28, p.z));
        tops.push(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 12).translate(p.x, p.y + 1.1, p.z));
      }
      if (stacks.length) {
        const sm = new THREE.Mesh(mergeGeometries(stacks)!, rubber);
        sm.castShadow = true;
        this.group.add(sm);
        const half = Math.ceil(tops.length / 2);
        this.group.add(new THREE.Mesh(mergeGeometries(tops.slice(0, half))!, red), new THREE.Mesh(mergeGeometries(tops.slice(half))!, white));
      }
      // Tempting arrow sign at the entrance (planted just outside the path).
      const entry = point(Math.max(0, sc.offStart - 0.02), new THREE.Vector3());
      const rx = sc.dir.z;
      const rz = -sc.dir.x;
      const side = Math.sign(track.project(entry.x + rx, entry.z + rz).distance - track.project(entry.x - rx, entry.z - rz).distance) || 1;
      const sx = entry.x + rx * side * (sc.def.width / 2 + 1.2);
      const sz = entry.z + rz * side * (sc.def.width / 2 + 1.2);
      const sy = track.project(sx, sz).height;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.9 }));
      post.position.set(sx, sy + 1.2, sz);
      const board = new THREE.Mesh(
        new THREE.PlaneGeometry(2.2, 0.8),
        new THREE.MeshStandardMaterial({ map: tex.signTexture({ text: 'SHORTCUT', sub: '→ RISK IT', bg: '#f2c230', fg: '#151515' }), roughness: 0.7, side: THREE.DoubleSide }),
      );
      board.position.set(sx, sy + 2.1, sz);
      board.rotation.y = Math.atan2(-sc.dir.x, -sc.dir.z);
      this.group.add(post, board);
    }
  }

  update(time: number): void {
    this.padTex.offset.y = -time * 1.6;
    this.padMat.emissiveIntensity = 1.4 + Math.sin(time * 6) * 0.35;
  }
}
