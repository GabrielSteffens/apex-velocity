import * as THREE from 'three';
import type { TrackGeometry } from './TrackGeometry';
import type { Terrain } from './Terrain';
import type { TrackLayout, RunoffZone } from './TrackLayout';
import type { RibbonData } from './TrackMeshData';
import { buildRunoffRibbon } from './RunoffMesh';
import { Random } from '../core/math';
import * as tex from '../render/textures';

function ribbonGeometry(d: RibbonData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(d.indices, 1));
  g.computeVertexNormals();
  return g;
}

const TEAM_COLORS = [0xd81e2c, 0x1f6fe0, 0xf2b705, 0x14a37f, 0xf0f0f0, 0xe86a10, 0x7b2fd0, 0x1a1a1a];

/**
 * Everything that makes the edge of the circuit look like a real venue: gravel traps and
 * painted run-off, catch fences with sponsor banners, marshal posts, the pit lane and a
 * paddock full of team trucks. Built once; merged by material by the caller.
 */
export class Trackside {
  readonly group = new THREE.Group();
  private rnd: Random;

  constructor(
    private readonly track: TrackGeometry,
    private readonly terrain: Terrain,
    private readonly layout: TrackLayout,
    seed: number,
  ) {
    this.group.name = 'trackside';
    this.rnd = new Random(seed);
    this.buildRunoff();
    this.buildCatchFences();
    this.buildMarshalPosts();
    this.buildPitLane();
    this.buildPaddock();
  }

  private buildRunoff(): void {
    const gr = tex.gravel();
    const gravel = new THREE.MeshStandardMaterial({
      map: gr.map,
      normalMap: gr.normalMap,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const asph = tex.asphalt();
    const painted = new THREE.MeshStandardMaterial({
      map: tex.runoffStripes(),
      normalMap: asph.normalMap,
      normalScale: new THREE.Vector2(0.3, 0.3),
      roughness: 0.8,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    for (const zone of this.layout.runoffs) {
      const data = buildRunoffRibbon(this.track, this.terrain, zone, 0.035, 6, zone.kind === 'gravel' ? 5 : 8);
      const m = new THREE.Mesh(ribbonGeometry(data), zone.kind === 'gravel' ? gravel : painted);
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  /** Catch fences behind concrete walls and tyre barriers, with sponsor banners on them. */
  private buildCatchFences(): void {
    const fenceMat = new THREE.MeshStandardMaterial({ map: tex.chainLink(), alphaTest: 0.35, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x5c6066, metalness: 0.6, roughness: 0.45 });
    const bannerSpecs: tex.SignSpec[] = [
      { text: 'APEX OIL', bg: '#0b3d91', fg: '#fff', accent: '#ffcc00' },
      { text: 'NOVA TYRES', bg: '#111', fg: '#ffd21f' },
      { text: 'TURBOFUEL', bg: '#e8261d', fg: '#fff' },
      { text: 'KESTREL', bg: '#111', fg: '#e8c872' },
      { text: 'SOLARIS', bg: '#ff5a1f', fg: '#fff' },
    ];
    const bannerMats = bannerSpecs.map((spec) => new THREE.MeshStandardMaterial({ map: tex.signTexture(spec), roughness: 0.7, side: THREE.DoubleSide }));
    const postGeo = new THREE.BoxGeometry(0.09, 3.6, 0.09);
    const posts: THREE.Matrix4[] = [];
    const bottom = 0.95;
    const top = 4.2;
    const back = 0.35; // behind the wall's inner face
    let bannerK = 0;
    for (const run of this.layout.barriers) {
      const fenced = (i: number) => run.styles[i] !== 'armco' || Math.abs(this.track.deltaS(0, run.s[i])) < 240;
      let i = 0;
      while (i < run.points.length - 1) {
        if (!fenced(i)) {
          i++;
          continue;
        }
        let j = i;
        while (j < run.points.length - 1 && fenced(j)) j++;
        // Fence ribbon from point i to j
        const pos: number[] = [];
        const uv: number[] = [];
        const idx: number[] = [];
        let dist = 0;
        for (let k = i; k <= j; k++) {
          const a = run.points[Math.max(i, k - 1)];
          const b = run.points[Math.min(j, k + 1)];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const len = Math.hypot(dx, dz) || 1;
          const nx = (-dz / len) * run.side;
          const nz = (dx / len) * run.side;
          const p = run.points[k];
          if (k > i) dist += p.distanceTo(run.points[k - 1]);
          const x = p.x + nx * back;
          const z = p.z + nz * back;
          pos.push(x, p.y + bottom, z, x, p.y + top, z);
          uv.push(dist / 0.45, 0, dist / 0.45, (top - bottom) / 0.45);
          if (k < j) {
            const v = (k - i) * 2;
            idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
          }
          if ((k - i) % 2 === 0) posts.push(new THREE.Matrix4().makeTranslation(x, p.y + (bottom + top) / 2, z));
          // Sponsor banner every few panels, hung on the lower part of the fence.
          if ((k - i) % 6 === 2 && k + 2 <= j) {
            const q = run.points[k + 2];
            const mx = (p.x + q.x) / 2 + nx * (back - 0.04);
            const mz = (p.z + q.z) / 2 + nz * (back - 0.04);
            const w = p.distanceTo(q);
            const banner = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.8), bannerMats[bannerK++ % bannerMats.length]);
            banner.position.set(mx, (p.y + q.y) / 2 + bottom + 0.55, mz);
            banner.rotation.y = Math.atan2(-nx, -nz); // face the track
            this.group.add(banner);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        g.setIndex(idx);
        g.computeVertexNormals();
        const fence = new THREE.Mesh(g, fenceMat);
        fence.castShadow = false;
        this.group.add(fence);
        i = j;
      }
    }
    const im = new THREE.InstancedMesh(postGeo, postMat, posts.length);
    posts.forEach((m, k) => im.setMatrixAt(k, m));
    im.castShadow = true;
    this.group.add(im);
  }

  /** Frame at arc length s, lateral offset; local +Z faces the track. */
  private frame(s: number, lateral: number): { pos: THREE.Vector3; yaw: number; tangentYaw: number } {
    const t = this.track;
    const pos = t.offsetPoint(s, lateral, new THREE.Vector3());
    pos.y = this.terrain.heightAt(pos.x, pos.z);
    const tan = t.tangentAt(s, new THREE.Vector3());
    const toTrack = new THREE.Vector3(-tan.z, 0, tan.x).multiplyScalar(-Math.sign(lateral) || 1);
    return { pos, yaw: Math.atan2(toTrack.x, toTrack.z), tangentYaw: Math.atan2(tan.x, tan.z) };
  }

  private buildMarshalPosts(): void {
    const t = this.track;
    const bo = t.def.barrierOffset;
    const white = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.7 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1b2a38, roughness: 0.1, metalness: 0.6 });
    const pole = new THREE.MeshStandardMaterial({ color: 0x9a9da0, metalness: 0.7, roughness: 0.4 });
    const flag = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.8, side: THREE.DoubleSide });
    let k = 0;
    for (let s = 150; s < t.length - 100; s += 290, k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const lat = side * (bo + 4);
      const p = t.offsetPoint(s, lat, new THREE.Vector3());
      if (t.distanceToCenterline(p.x, p.z) < bo + 2 || this.layout.nearShortcut(p.x, p.z, 4)) continue;
      const f = this.frame(s, lat);
      const g = new THREE.Group();
      g.position.copy(f.pos);
      g.rotation.y = f.yaw;
      const booth = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.3, 1.6), white);
      booth.position.y = 1.15;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 2.0), roofMat);
      roof.position.y = 2.36;
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), glass);
      win.position.set(0, 1.55, 0.81);
      const fp = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3.2, 6), pole);
      fp.position.set(1.1, 1.6, 0.6);
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), flag);
      fl.position.set(1.55, 2.85, 0.6);
      g.add(booth, roof, win, fp, fl);
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) o.receiveShadow = true;
      });
      this.group.add(g);
    }
  }

  private buildPitLane(): void {
    const t = this.track;
    const bo = t.def.barrierOffset;
    const n = t.count;
    const zone: RunoffZone = {
      side: 1,
      startIndex: (t.indexAt(-215) + n) % n,
      endIndex: t.indexAt(75),
      kind: 'asphalt',
      inner: bo + 1.2,
      outer: bo + 10.5,
    };
    const a = tex.asphalt();
    const mat = new THREE.MeshStandardMaterial({ map: a.map, normalMap: a.normalMap, normalScale: new THREE.Vector2(0.25, 0.25), roughness: 0.9 });
    const lane = new THREE.Mesh(ribbonGeometry(buildRunoffRibbon(t, this.terrain, zone, 0.04, 6, 14)), mat);
    lane.receiveShadow = true;
    this.group.add(lane);
    // Dashed line separating the fast lane from the working lane, and a white edge line.
    const paint = new THREE.MeshStandardMaterial({ color: 0xf2f2ec, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const lineZone = (inner: number, outer: number, start: number, end: number): RunoffZone => ({ ...zone, inner, outer, startIndex: (t.indexAt(start) + n) % n, endIndex: (t.indexAt(end) + n) % n });
    for (let s = -200; s < 60; s += 8) {
      const d = buildRunoffRibbon(t, this.terrain, lineZone(bo + 5.9, bo + 6.1, s, s + 4), 0.05, 2);
      this.group.add(new THREE.Mesh(ribbonGeometry(d), paint));
    }
    this.group.add(new THREE.Mesh(ribbonGeometry(buildRunoffRibbon(t, this.terrain, lineZone(bo + 1.3, bo + 1.5, -205, 65), 0.05, 2)), paint));
  }

  /** Team trucks, motorhomes and awnings behind the pit building. */
  private buildPaddock(): void {
    const t = this.track;
    const bo = t.def.barrierOffset;
    const n = t.count;
    const pad: RunoffZone = {
      side: 1,
      startIndex: (t.indexAt(-175) + n) % n,
      endIndex: t.indexAt(25),
      kind: 'asphalt',
      inner: bo + 26,
      outer: bo + 66,
    };
    const a = tex.asphalt();
    const padMat = new THREE.MeshStandardMaterial({ map: a.map, color: 0xb8b8b8, roughness: 0.95 });
    const padMesh = new THREE.Mesh(ribbonGeometry(buildRunoffRibbon(t, this.terrain, pad, 0.06, 8, 14)), padMat);
    padMesh.receiveShadow = true;
    this.group.add(padMesh);

    const white = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.7 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1b2a38, roughness: 0.1, metalness: 0.6 });
    const teamMats = TEAM_COLORS.map((c) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.35, clearcoat: 0.6 }));
    const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 12).rotateZ(Math.PI / 2);
    let team = 0;
    for (let s = -160; s <= 10; s += 21, team++) {
      // Truck: trailer + cab, parked parallel to the track, facing the pits.
      const f = this.frame(s, bo + 42);
      const g = new THREE.Group();
      g.position.copy(f.pos);
      g.rotation.y = f.tangentYaw;
      const livery = teamMats[team % teamMats.length];
      const trailer = new THREE.Mesh(new THREE.BoxGeometry(2.5, 3.4, 13), livery);
      trailer.position.set(0, 2.2, 0);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.52, 0.35, 13.02), white);
      stripe.position.set(0, 1.2, 0);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.8, 2.4), livery);
      cab.position.set(0, 1.9, 7.9);
      const windscreen = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.0), glass);
      windscreen.position.set(0, 2.6, 9.11);
      g.add(trailer, stripe, cab, windscreen);
      for (const wz of [-5, -3.8, 6, 8.2]) {
        for (const wx of [-1.1, 1.1]) {
          const w = new THREE.Mesh(wheelGeo, tyre);
          w.position.set(wx, 0.5, wz);
          g.add(w);
        }
      }
      // Awning on the pit side of the trailer
      const awning = new THREE.Mesh(new THREE.BoxGeometry(4, 0.08, 10), white);
      awning.position.set(-3.2, 3.1, 0);
      awning.rotation.z = -0.08;
      g.add(awning);
      for (const az of [-4.8, 4.8]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3, 6), dark);
        leg.position.set(-5, 1.5, az);
        g.add(leg);
      }
      // Motorhome further back
      const mh = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.2, 11), this.rnd.next() < 0.5 ? white : dark);
      mh.position.set(12, 1.7, this.rnd.range(-2, 2));
      g.add(mh);
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) o.receiveShadow = true;
      });
      this.group.add(g);
    }
  }
}
