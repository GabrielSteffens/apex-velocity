import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TrackGeometry } from './TrackGeometry';
import type { Terrain } from './Terrain';
import type { TrackLayout, RunoffZone } from './TrackLayout';
import { buildRunoffRibbon } from './RunoffMesh';
import { Random } from '../core/math';
import { detailProfile } from '../core/device';
import { windUniform } from './Vegetation';
import * as tex from '../render/textures';

const SHIRTS = [0xd81e2c, 0x1f6fe0, 0xf2b705, 0x14a37f, 0xf0f0f0, 0x1a1a1a, 0xe86a10, 0x7b2fd0, 0x2b3a67, 0xc9c2b0, 0x8a1c2b, 0x3f7f4f];
const CAR_PAINTS = [0xc9ccd1, 0x1c1d21, 0xf1f1ef, 0x8b1a1a, 0x1e3f7a, 0x4a4f55, 0x6b7a3a, 0xb8860b, 0x2a2a2a, 0xe0e0e0];

/** Low-poly person (seated or standing). Vertex attribute `head` = 1 on the head. */
function personGeometry(standing: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tag = (g: THREE.BufferGeometry, head: number) => {
    const ng = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(ng.attributes)) if (k !== 'position') ng.deleteAttribute(k);
    ng.computeVertexNormals();
    ng.setAttribute('head', new THREE.BufferAttribute(new Float32Array(ng.attributes.position.count).fill(head), 1));
    return ng;
  };
  const base = standing ? 0.85 : 0.05;
  parts.push(tag(new THREE.BoxGeometry(0.4, 0.52, 0.24).translate(0, base + 0.3, 0), 0));
  parts.push(tag(new THREE.IcosahedronGeometry(0.115, 0).translate(0, base + 0.68, 0), 1));
  if (standing) {
    parts.push(tag(new THREE.BoxGeometry(0.34, 0.85, 0.2).translate(0, 0.43, 0), 0.5)); // legs (trousers)
  } else {
    parts.push(tag(new THREE.BoxGeometry(0.36, 0.14, 0.4).translate(0, base + 0.02, 0.18), 0.5)); // thighs
  }
  return mergeGeometries(parts)!;
}

/** Crowd material: shirt from instance colour, skin/trousers per vertex, gentle bobbing. */
function crowdMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windUniform;
    sh.vertexShader =
      'uniform float uTime;\nattribute float head;\n' +
      sh.vertexShader
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
          #ifdef USE_INSTANCING_COLOR
            float seed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
            vec3 skin = mix(vec3(0.95, 0.76, 0.6), vec3(0.36, 0.23, 0.15), seed);
            vec3 trousers = mix(vec3(0.12, 0.14, 0.2), vec3(0.45, 0.42, 0.36), fract(seed * 7.3));
            vColor.xyz = head > 0.75 ? skin : (head > 0.25 ? trousers : vColor.xyz);
          #endif`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            float ph = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 1.3;
            transformed.y += max(0.0, sin(uTime * 3.0 + ph)) * 0.05 * step(0.2, position.y);
          #endif`,
        );
  };
  m.customProgramCacheKey = () => 'crowd';
  return m;
}

/** Simple parked car (~100 triangles). */
function parkedCarGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1.8, 0.6, 4.3).translate(0, 0.55, 0);
  const cabin = new THREE.BoxGeometry(1.6, 0.5, 2.2).translate(0, 1.08, -0.2);
  const wheels = [-1.3, 1.3].flatMap((z) => [-0.85, 0.85].map((x) => new THREE.CylinderGeometry(0.32, 0.32, 0.22, 8).rotateZ(Math.PI / 2).translate(x, 0.32, z)));
  const parts = [body, cabin, ...wheels].map((g) => {
    const ng = g.toNonIndexed();
    for (const k of Object.keys(ng.attributes)) if (k !== 'position') ng.deleteAttribute(k);
    ng.computeVertexNormals();
    return ng;
  });
  // Darken cabin (windows) and wheels via a per-vertex factor stored in `head` (reused attr name).
  const tags = [0, 1, 1, 1, 1, 1];
  parts.forEach((g, i) => g.setAttribute('shade', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(tags[i]), 1)));
  return mergeGeometries(parts)!;
}

function shadedInstanceMaterial(dark: [number, number, number]): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.3, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader =
      'attribute float shade;\n' +
      sh.vertexShader.replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.xyz = mix(vColor.xyz, vec3(${dark.map((v) => v.toFixed(3)).join(',')}), shade);
        #endif`,
      );
  };
  m.customProgramCacheKey = () => 'shaded-instance';
  return m;
}

interface Footprint {
  x: number;
  z: number;
  r: number;
}

/**
 * The spectator venue and surrounding life: grandstands full of fans, spectator banks
 * with tents and umbrellas at the corners, a busy car park, wind turbines on the ridges
 * and farmhouses in the valley.
 */
export class Venue {
  readonly group = new THREE.Group();
  private footprints: Footprint[] = [];
  private rotors: THREE.Object3D[] = [];
  /** Moving meshes that must not be merged into static batches. */
  readonly animated = new Set<THREE.Object3D>();
  private rnd: Random;
  private seated: THREE.Matrix4[] = [];
  private seatedColors: THREE.Color[] = [];
  private standing: THREE.Matrix4[] = [];
  private standingColors: THREE.Color[] = [];
  private readonly D = detailProfile();
  /** Shared by every stand so merged batches span all of them. */
  private readonly standMats = {
    concrete: new THREE.MeshStandardMaterial({ color: 0xbab6ad, roughness: 0.85 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.7, roughness: 0.4 }),
    roofMat: new THREE.MeshStandardMaterial({ color: 0xe9ebee, metalness: 0.3, roughness: 0.35 }),
    seatMats: [0xd81e2c, 0x1f6fe0, 0xe8e8e8].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 })),
    flagPole: new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 0.6, roughness: 0.4 }),
    flagMats: SHIRTS.slice(0, 6).map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, side: THREE.DoubleSide })),
  };

  constructor(
    private readonly track: TrackGeometry,
    private readonly terrain: Terrain,
    _layout: TrackLayout,
    seed: number,
  ) {
    this.group.name = 'venue';
    this.rnd = new Random(seed);
    this.buildGrandstands();
    this.buildSpectatorBanks();
    this.buildCarPark();
    this.buildTurbines();
    this.buildHouses();
    this.buildCrowdMeshes();
  }

  /** True where venue structures stand (vegetation keeps clear of them). */
  blocked(x: number, z: number): boolean {
    for (const f of this.footprints) if ((x - f.x) ** 2 + (z - f.z) ** 2 < f.r * f.r) return true;
    return false;
  }

  update(time: number): void {
    // The track is frozen (static matrices), so rotors refresh their own world matrices.
    for (const r of this.rotors) {
      r.rotation.z = time * 0.9 + r.userData.phase;
      r.updateMatrix();
      r.matrixWorld.multiplyMatrices(r.parent!.matrixWorld, r.matrix);
    }
  }

  // ---------------------------------------------------------------- helpers
  /** Group placed at arc length s on one side; local +X points away from the track, +Z along it. */
  private placeAt(s: number, lateral: number, side: 1 | -1): THREE.Group {
    const t = this.track;
    const p = t.offsetPoint(s, lateral * side, new THREE.Vector3());
    p.y = this.terrain.heightAt(p.x, p.z);
    const tan = t.tangentAt(s, new THREE.Vector3());
    const g = new THREE.Group();
    g.position.copy(p);
    // Local +X is the track's LEFT when yaw = tangent yaw; flip for the right side.
    g.rotation.y = Math.atan2(tan.x, tan.z) + (side === 1 ? Math.PI : 0);
    return g;
  }

  private footprintFromGroup(g: THREE.Group, halfLen: number, depth: number): void {
    g.updateMatrixWorld(true);
    for (let z = -halfLen; z <= halfLen; z += 15) {
      for (let x = 0; x <= depth; x += 15) {
        const w = new THREE.Vector3(x, 0, z).applyMatrix4(g.matrixWorld);
        this.footprints.push({ x: w.x, z: w.z, r: 14 });
      }
    }
  }

  private addWorldCrowd(g: THREE.Group, localMatrices: THREE.Matrix4[], standing: boolean): void {
    g.updateMatrixWorld(true);
    for (const m of localMatrices) {
      const wm = new THREE.Matrix4().multiplyMatrices(g.matrixWorld, m);
      const c = new THREE.Color(this.rnd.pick(SHIRTS)).multiplyScalar(this.rnd.range(0.8, 1.1));
      if (standing) {
        this.standing.push(wm);
        this.standingColors.push(c);
      } else {
        this.seated.push(wm);
        this.seatedColors.push(c);
      }
    }
  }

  // ---------------------------------------------------------------- grandstands
  /**
   * Covered grandstand: stepped concrete terraces with coloured seat rows, fans, a front
   * wall with sponsor boards, back wall, steel columns and a cantilevered roof.
   */
  private grandstand(s: number, side: 1 | -1, length: number, rows: number, frontLateral: number): void {
    const g = this.placeAt(s, frontLateral, side);
    const d = 0.85; // row depth
    const r = 0.42; // row rise
    const h0 = 1.3; // front podium height
    const { concrete, steel, roofMat, seatMats, flagPole, flagMats } = this.standMats;
    const L = length;
    const top = h0 + rows * r;
    for (let i = 0; i < rows; i++) {
      const y = h0 + i * r;
      const tread = new THREE.Mesh(new THREE.BoxGeometry(d, y, L), concrete);
      tread.position.set(i * d + d / 2, y / 2, 0);
      g.add(tread);
      // Seat backs in blocks of colour (a big stripe pattern across the stand)
      const blocks = Math.ceil(L / 8);
      for (let b = 0; b < blocks; b++) {
        const z0 = -L / 2 + b * 8;
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.36, Math.min(8, L / 2 - z0) - 0.6), seatMats[(b + Math.floor(i / 4)) % 3]);
        seat.position.set(i * d + d - 0.14, y + 0.2, z0 + (Math.min(8, L / 2 - z0)) / 2);
        g.add(seat);
      }
      // Fans (skip aisles every ~16 m)
      const people: THREE.Matrix4[] = [];
      for (let z = -L / 2 + 0.5; z < L / 2 - 0.5; z += 0.62) {
        if (((z + L / 2) % 16) < 1.3) continue;
        if (this.rnd.next() > 0.78 * this.D.crowd) continue;
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(i * d + d - 0.42, y, z + this.rnd.range(-0.08, 0.08)),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2 + this.rnd.range(-0.25, 0.25)),
          new THREE.Vector3(1, this.rnd.range(0.92, 1.08), 1),
        );
        people.push(m);
      }
      this.addWorldCrowd(g, people, false);
    }
    // Aisle stairs
    for (let z = -L / 2 + 16; z < L / 2; z += 16) {
      const stair = new THREE.Mesh(new THREE.BoxGeometry(rows * d, 0.05, 1.2), concrete);
      stair.position.set((rows * d) / 2, h0 + (rows * r) / 2, z - 0.6);
      stair.rotation.z = Math.atan2(r, d);
      g.add(stair);
    }
    // Front wall with sponsor boards; back wall
    const front = new THREE.Mesh(new THREE.BoxGeometry(0.3, h0 + 0.9, L), concrete);
    front.position.set(-0.15, (h0 + 0.9) / 2, 0);
    g.add(front);
    for (const end of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(rows * d + 0.6, top + 3.2, 0.4), concrete);
      wall.position.set((rows * d) / 2, (top + 3.2) / 2, end * (L / 2 + 0.2));
      g.add(wall);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.4, top + 3.2, L), concrete);
    back.position.set(rows * d + 0.2, (top + 3.2) / 2, 0);
    g.add(back);
    const boards: tex.SignSpec[] = [
      { text: 'APEX OIL', bg: '#0b3d91', fg: '#fff', accent: '#ffcc00' },
      { text: 'NOVA TYRES', bg: '#111', fg: '#ffd21f' },
      { text: 'SOLARIS', bg: '#ff5a1f', fg: '#fff' },
      { text: 'KESTREL', bg: '#111', fg: '#e8c872' },
    ];
    for (let z = -L / 2 + 5, k = 0; z < L / 2 - 5; z += 10, k++) {
      const board = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.9), new THREE.MeshStandardMaterial({ map: tex.signTexture(boards[k % boards.length]), roughness: 0.6 }));
      board.position.set(-0.31, h0 * 0.55, z);
      board.rotation.y = -Math.PI / 2;
      g.add(board);
    }
    // Roof: columns at the back, trusses cantilevering over the terraces, tilted canopy.
    const roofY = top + 4.2;
    const depth = rows * d + 2.5;
    for (let z = -L / 2 + 2; z <= L / 2 - 2; z += 12) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.5, roofY, 0.5), steel);
      col.position.set(rows * d + 0.8, roofY / 2, z);
      g.add(col);
      const truss = new THREE.Mesh(new THREE.BoxGeometry(depth + 1, 0.35, 0.25), steel);
      truss.position.set(rows * d - depth / 2 + 1, roofY + 0.9, z);
      truss.rotation.z = 0.06;
      g.add(truss);
      const tie = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(depth * 0.6, 3.2), 0.12, 0.12), steel);
      tie.position.set(rows * d - depth * 0.3 + 0.8, roofY + 2.3, z);
      tie.rotation.z = -Math.atan2(3.2, depth * 0.6);
      g.add(tie);
      const mast = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4, 0.3), steel);
      mast.position.set(rows * d + 0.8, roofY + 2, z);
      g.add(mast);
    }
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(depth, 0.25, L + 3), roofMat);
    canopy.position.set(rows * d - depth / 2 + 1, roofY + 0.6, 0);
    canopy.rotation.z = 0.06;
    g.add(canopy);
    const fascia = new THREE.Mesh(
      new THREE.PlaneGeometry(L, 1.6),
      new THREE.MeshStandardMaterial({ map: tex.signTexture({ text: 'APEX VELOCITY', sub: 'GRAND PRIX · VALLE DORADO', bg: '#d81e2c', fg: '#fff', w: 1024, h: 128 }), roughness: 0.5 }),
    );
    fascia.position.set(rows * d - depth + 0.95, roofY + 0.45, 0);
    fascia.rotation.y = -Math.PI / 2;
    g.add(fascia);
    // Flags along the roof edge
    for (let z = -L / 2 + 6, k = 0; z < L / 2; z += 14, k++) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3, 6), flagPole);
      pole.position.set(rows * d + 0.8, roofY + 5.5, z);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), flagMats[k % flagMats.length]);
      flag.position.set(rows * d + 0.8, roofY + 6.5, z + 0.72);
      flag.rotation.y = Math.PI / 2;
      g.add(pole, flag);
    }
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = o.material !== seatMats[0] && o.material !== seatMats[1] && o.material !== seatMats[2];
        o.receiveShadow = true;
      }
    });
    this.group.add(g);
    this.footprintFromGroup(g, L / 2 + 4, rows * d + 6);
  }

  /** Is a rectangle of terraces placeable here without touching another part of the track? */
  private standFits(s: number, side: 1 | -1, lateral: number, length: number, depth: number): boolean {
    const t = this.track;
    const bo = t.def.barrierOffset;
    const p = new THREE.Vector3();
    for (let ds = -length / 2; ds <= length / 2; ds += 10) {
      for (let dl = 0; dl <= depth; dl += 6) {
        t.offsetPoint(s + ds, side * (lateral + dl), p);
        if (t.distanceToCenterline(p.x, p.z) < bo + 1.5) return false;
        if (this.terrain.lake && Math.hypot(p.x - this.terrain.lake.x, p.z - this.terrain.lake.z) < this.terrain.lake.r * 1.3) return false;
      }
    }
    return true;
  }

  private buildGrandstands(): void {
    const t = this.track;
    const bo = t.def.barrierOffset;
    // Main stand opposite the pits along the start/finish straight.
    this.grandstand(-40, -1, 150, 18, bo + 3.5);
    // Smaller covered stands on the outside of the biggest corners.
    const corners: { s: number; k: number }[] = [];
    const n = t.count;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(t.curvature[i]);
      if (k < 1 / 75) continue;
      let isMax = true;
      for (let d = -30; d <= 30; d++) if (Math.abs(t.curvature[(i + d + n) % n]) > k) isMax = false;
      if (isMax) corners.push({ s: i * t.spacing, k: t.curvature[i] });
    }
    let placed = 0;
    for (const c of corners.sort((a, b) => Math.abs(b.k) - Math.abs(a.k))) {
      if (placed >= 3) break;
      if (Math.abs(t.deltaS(0, c.s)) < 200) continue;
      const side = (c.k > 0 ? -1 : 1) as 1 | -1; // outside of the corner
      const lateral = bo + 5;
      if (!this.standFits(c.s, side, lateral, 56, 16)) continue;
      this.grandstand(c.s, side, 56, 11, lateral);
      placed++;
    }
  }

  // ---------------------------------------------------------------- spectator banks
  private buildSpectatorBanks(): void {
    const t = this.track;
    const bo = t.def.barrierOffset;
    const tentMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.7 });
    const umbrellaMats = [0xd81e2c, 0x1f6fe0, 0xf2b705, 0xffffff].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xbfc3c7, metalness: 0.5, roughness: 0.5 });
    let banks = 0;
    for (let s = 300; s < t.length - 250 && banks < 6; s += 170) {
      const k = t.curvatureAt(s);
      if (Math.abs(k) < 1 / 250) continue;
      const side = (k > 0 ? -1 : 1) as 1 | -1;
      const lateral = bo + 6;
      if (!this.standFits(s, side, lateral, 60, 18)) continue;
      banks++;
      const g = this.placeAt(s, lateral, side);
      const people: THREE.Matrix4[] = [];
      for (let i = 0; i < 180 * this.D.crowd; i++) {
        const x = Math.pow(this.rnd.next(), 1.8) * 14 + 0.4;
        const z = this.rnd.range(-28, 28);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(x, 0, z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2 + this.rnd.range(-0.6, 0.6)),
          new THREE.Vector3(1, this.rnd.range(0.9, 1.1), 1),
        );
        people.push(m);
      }
      // Terrain height under each fan (group is placed at the bank's front edge).
      g.updateMatrixWorld(true);
      for (const m of people) {
        const w = new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(g.matrixWorld);
        const dy = this.terrain.heightAt(w.x, w.z) - g.position.y;
        m.elements[13] += dy - 0.05;
      }
      this.addWorldCrowd(g, people, true);
      // Tents and umbrellas
      for (let i = 0; i < 3; i++) {
        const tent = new THREE.Mesh(new THREE.ConeGeometry(2.6, 2.4, 4), tentMat);
        tent.position.set(15 + this.rnd.range(0, 4), 1.2 + this.localHeight(g, 16, (i - 1) * 16), (i - 1) * 16);
        tent.rotation.y = Math.PI / 4;
        g.add(tent);
      }
      for (let i = 0; i < 8; i++) {
        const x = this.rnd.range(3, 13);
        const z = this.rnd.range(-26, 26);
        const y = this.localHeight(g, x, z);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 5), poleMat);
        pole.position.set(x, y + 1.1, z);
        const top = new THREE.Mesh(new THREE.ConeGeometry(1.2, 0.5, 8), umbrellaMats[i % umbrellaMats.length]);
        top.position.set(x, y + 2.3, z);
        g.add(pole, top);
      }
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      this.group.add(g);
      this.footprintFromGroup(g, 32, 20);
    }
  }

  /** Terrain height at local (x, z) of a placed group, relative to the group's origin. */
  private localHeight(g: THREE.Group, x: number, z: number): number {
    g.updateMatrixWorld(true);
    const w = new THREE.Vector3(x, 0, z).applyMatrix4(g.matrixWorld);
    return this.terrain.heightAt(w.x, w.z) - g.position.y;
  }

  // ---------------------------------------------------------------- car park
  private buildCarPark(): void {
    const t = this.track;
    const bo = t.def.barrierOffset;
    const n = t.count;
    // Behind the main grandstand (left of the start straight).
    const zone: RunoffZone = {
      side: -1,
      startIndex: (t.indexAt(-150) + n) % n,
      endIndex: t.indexAt(40),
      kind: 'asphalt',
      inner: bo + 28,
      outer: bo + 78,
    };
    const a = tex.asphalt();
    const padMat = new THREE.MeshStandardMaterial({ map: a.map, color: 0xd8d8d8, roughness: 0.95 });
    const pad = new THREE.Mesh(this.ribbon(zone), padMat);
    pad.receiveShadow = true;
    this.group.add(pad);
    const paint = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.7 });
    const cars: THREE.Matrix4[] = [];
    const colors: THREE.Color[] = [];
    const p = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let row = 0; row < 6; row++) {
      const lat = -(bo + 34 + row * 7.5);
      for (let s = -140; s < 30; s += 2.8) {
        if (this.rnd.next() > 0.72 * this.D.props) continue;
        t.offsetPoint(s, lat, p);
        t.tangentAt(s, tan);
        const yaw = Math.atan2(tan.x, tan.z) + Math.PI / 2 + (row % 2 ? Math.PI : 0) + this.rnd.range(-0.06, 0.06);
        q.setFromAxisAngle(up, yaw);
        cars.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x, this.terrain.heightAt(p.x, p.z) + 0.06, p.z), q, new THREE.Vector3(1, 1, 1)));
        colors.push(new THREE.Color(this.rnd.pick(CAR_PAINTS)));
      }
      // Bay lines
      const line = new THREE.Mesh(this.ribbon({ ...zone, inner: bo + 37.6 + row * 7.5, outer: bo + 37.8 + row * 7.5, startIndex: (t.indexAt(-142) + n) % n, endIndex: t.indexAt(32) }, 0.08, 2), paint);
      this.group.add(line);
    }
    const im = new THREE.InstancedMesh(parkedCarGeometry(), shadedInstanceMaterial([0.05, 0.06, 0.08]), cars.length);
    cars.forEach((m, i) => {
      im.setMatrixAt(i, m);
      im.setColorAt(i, colors[i]);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    this.group.add(im);
    // Footprint for vegetation
    for (let s = -150; s < 40; s += 20) {
      for (let lat = bo + 28; lat < bo + 80; lat += 20) {
        t.offsetPoint(s, -lat, p);
        this.footprints.push({ x: p.x, z: p.z, r: 16 });
      }
    }
  }

  private ribbon(zone: RunoffZone, lift = 0.06, across = 8): THREE.BufferGeometry {
    const d = buildRunoffRibbon(this.track, this.terrain, zone, lift, across, 14);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(d.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(d.indices, 1));
    g.computeVertexNormals();
    return g;
  }

  // ---------------------------------------------------------------- wind turbines
  private buildTurbines(): void {
    const tr = this.terrain;
    const b = this.track.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const white = new THREE.MeshStandardMaterial({ color: 0xf0f1f2, roughness: 0.45 });
    // Hub + three blades in one geometry (one draw call per rotor).
    const rotorGeo = mergeGeometries([
      new THREE.SphereGeometry(1.2, 10, 8).toNonIndexed(),
      ...[0, 1, 2].map((i) => new THREE.BoxGeometry(1.2, 22, 0.35).translate(0, 11.5, 0).rotateZ((i * Math.PI * 2) / 3).toNonIndexed()),
    ])!;
    let placed = 0;
    for (let a = 0; a < Math.PI * 2 && placed < 12; a += 0.21) {
      // Walk outwards to the ridge crest in this direction.
      let best = { h: -Infinity, x: 0, z: 0 };
      for (let r = 560; r < 820; r += 20) {
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        const h = tr.heightAt(x, z);
        if (h > best.h) best = { h, x, z };
      }
      if (best.h < 45 || this.rnd.next() < 0.3) continue;
      placed++;
      const g = new THREE.Group();
      g.position.set(best.x, best.h - 1, best.z);
      g.rotation.y = Math.atan2(cx - best.x, cz - best.z) + this.rnd.range(-0.4, 0.4);
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.6, 48, 10).translate(0, 24, 0), white);
      const nacelle = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 6).translate(0, 49, -1), white);
      g.add(tower, nacelle);
      const rotor = new THREE.Mesh(rotorGeo, white);
      rotor.position.set(0, 49, 2.2);
      rotor.userData.phase = this.rnd.next() * 6;
      rotor.traverse((o) => this.animated.add(o));
      g.add(rotor);
      this.rotors.push(rotor);
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) o.receiveShadow = true;
      });
      this.group.add(g);
    }
  }

  // ---------------------------------------------------------------- farmhouses
  private buildHouses(): void {
    const tr = this.terrain;
    const bodies: THREE.Matrix4[] = [];
    const roofs: THREE.Matrix4[] = [];
    const bodyColors: THREE.Color[] = [];
    const roofColors: THREE.Color[] = [];
    const walls = [0xefe7d6, 0xe4d6bb, 0xf5f2ea, 0xd9c7a5];
    const roofTones = [0xa4442f, 0x8c3a28, 0x5b5f66, 0x7a4a2a];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let clusters = 0;
    for (let tries = 0; tries < 400 && clusters < 9 * this.D.props; tries++) {
      const x = tr.originX + 150 + this.rnd.next() * (tr.size - 300);
      const z = tr.originZ + 150 + this.rnd.next() * (tr.size - 300);
      const d = tr.distanceAt(x, z);
      const h = tr.heightAt(x, z);
      if (d < 110 || h > 30 || this.blocked(x, z)) continue;
      if (tr.lake && Math.hypot(x - tr.lake.x, z - tr.lake.z) < tr.lake.r * 1.6) continue;
      const slope = Math.abs(tr.heightAt(x + 6, z) - tr.heightAt(x - 6, z)) + Math.abs(tr.heightAt(x, z + 6) - tr.heightAt(x, z - 6));
      if (slope > 2.5) continue;
      clusters++;
      const count = 3 + Math.floor(this.rnd.next() * 5);
      const baseYaw = this.rnd.next() * Math.PI;
      for (let i = 0; i < count; i++) {
        const hx = x + this.rnd.range(-28, 28);
        const hz = z + this.rnd.range(-28, 28);
        const hy = tr.heightAt(hx, hz);
        const sx = this.rnd.range(6, 11);
        const sz = this.rnd.range(8, 14);
        const sy = this.rnd.range(3.2, 5.5);
        q.setFromAxisAngle(up, baseYaw + (this.rnd.next() < 0.5 ? 0 : Math.PI / 2));
        bodies.push(new THREE.Matrix4().compose(new THREE.Vector3(hx, hy - 0.5, hz), q, new THREE.Vector3(sx, sy + 0.5, sz)));
        roofs.push(new THREE.Matrix4().compose(new THREE.Vector3(hx, hy + sy, hz), q, new THREE.Vector3(sx * 1.1, sy * 0.5, sz * 1.05)));
        bodyColors.push(new THREE.Color(this.rnd.pick(walls)));
        roofColors.push(new THREE.Color(this.rnd.pick(roofTones)));
      }
      this.footprints.push({ x, z, r: 40 });
    }
    // Unit box with its base at y=0, and a unit gable roof prism.
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const gable = new THREE.BufferGeometry();
    const v = [
      -0.5, 0, -0.5, 0.5, 0, -0.5, 0, 1, -0.5,
      0.5, 0, 0.5, -0.5, 0, 0.5, 0, 1, 0.5,
      -0.5, 0, -0.5, 0, 1, -0.5, 0, 1, 0.5, -0.5, 0, -0.5, 0, 1, 0.5, -0.5, 0, 0.5,
      0.5, 0, -0.5, 0.5, 0, 0.5, 0, 1, 0.5, 0.5, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5,
    ];
    gable.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    gable.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, flatShading: true });
    for (const [geo, list, cols] of [
      [box, bodies, bodyColors],
      [gable, roofs, roofColors],
    ] as const) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((m, i) => {
        im.setMatrixAt(i, m);
        im.setColorAt(i, cols[i]);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);
    }
  }

  // ---------------------------------------------------------------- crowd
  private buildCrowdMeshes(): void {
    const mat = crowdMaterial();
    for (const [standing, list, colors] of [
      [false, this.seated, this.seatedColors],
      [true, this.standing, this.standingColors],
    ] as const) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(personGeometry(standing), mat, list.length);
      list.forEach((m, i) => {
        im.setMatrixAt(i, m);
        im.setColorAt(i, colors[i]);
      });
      im.castShadow = false;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);
    }
  }
}

