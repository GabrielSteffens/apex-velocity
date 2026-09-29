import * as THREE from 'three';
import type { TrackGeometry } from './TrackGeometry';
import type { Terrain } from './Terrain';
import type { TrackLayout } from './TrackLayout';
import type { RacingLine } from '../ai/RacingLine';
import { Noise2D, Random } from '../core/math';
import * as tex from '../render/textures';
import { mergeByMaterial } from '../render/merge';
import { buildRibbon } from './TrackMeshData';
import { Vegetation } from './Vegetation';
import { Trackside } from './Trackside';
import { Venue } from './Venue';

export { windUniform } from './Vegetation';

function displace(g: THREE.BufferGeometry, noise: Noise2D, amount: number, freq: number): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const n = noise.get(x * freq + y * 0.7, z * freq - y * 0.3);
    const s = 1 + n * amount;
    p.setXYZ(i, x * s, y + n * amount * 0.5, z * s);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Trackside dressing: vegetation (chunked instancing for frustum culling), rocks,
 * pit building, grandstand, start gantry, sponsor bridge, billboards and signs.
 */
export class TrackScenery {
  readonly group = new THREE.Group();
  /** Countdown lamp materials on the start gantry: [pod][0=red,1=green] */
  private lampMats: THREE.MeshStandardMaterial[][] = [];
  /** Floodlight lamp heads (emissive at night). */
  private floodLampMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, emissive: 0xfff1d8, emissiveIntensity: 0, roughness: 0.3 });
  /** Additive light pools painted on the asphalt under the floodlights. */
  private poolMat!: THREE.MeshBasicMaterial;
  private rnd: Random;
  readonly vegetation: Vegetation;
  readonly venue: Venue;

  constructor(
    readonly track: TrackGeometry,
    readonly terrain: Terrain,
    readonly layout: TrackLayout,
    readonly line: RacingLine,
  ) {
    this.group.name = 'scenery';
    this.rnd = new Random(track.def.scenery.seed);
    this.venue = new Venue(track, terrain, layout, track.def.scenery.seed + 17);
    this.vegetation = new Vegetation(
      track,
      terrain,
      (x, z) => this.inComplex(x, z) || this.inLake(x, z) || this.venue.blocked(x, z),
      track.def.scenery.seed,
      track.def.scenery.treeCount,
    );
    this.buildRocks();
    this.buildPitBuilding();
    this.buildGantry();
    this.buildBridge();
    this.buildBillboards();
    this.buildCornerSigns();
    this.buildFloodlights();
    this.buildLake();
    this.group.add(new Trackside(track, terrain, layout, track.def.scenery.seed + 9).group);
    this.group.add(this.venue.group);
    // Collapse the hundreds of static prop meshes into one draw call per material.
    this.atlasSigns();
    mergeByMaterial(this.group, this.venue.animated, 400);
    this.group.add(this.vegetation.group);
  }

  /**
   * Moves every sign-like material (non-repeating canvas texture, not emissive) onto the
   * shared sign atlas so all boards/banners/chevrons merge into one draw call per chunk.
   * Thin boards don't cast shadows (their frames and posts do).
   */
  private atlasSigns(): void {
    const atlas = tex.SignAtlas.get();
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
      const m = o.material as THREE.MeshStandardMaterial;
      if (!(m instanceof THREE.MeshStandardMaterial) || !m.map || m.emissiveMap || m.alphaTest > 0) return;
      if (m.map.wrapS === THREE.RepeatWrapping || !(m.map.image instanceof HTMLCanvasElement)) return;
      o.geometry = atlas.remapUV(o.geometry.clone(), m.map);
      o.material = atlas.material;
      o.castShadow = false;
    });
  }

  /** Inside (or right at the edge of) the infield lake? */
  private inLake(x: number, z: number, margin = 1.15): boolean {
    const L = this.terrain.lake;
    return !!L && Math.hypot(x - L.x, z - L.z) < this.terrain.lakeRadiusAt(x, z) * margin;
  }

  /** Is (x,z) inside the start/finish complex footprint? */
  private inComplex(x: number, z: number): boolean {
    const p = this.track.project(x, z);
    const ds = this.track.deltaS(0, p.s);
    return ds > -230 && ds < 130 && p.distance < 95;
  }

  private buildRocks(): void {
    const tr = this.terrain;
    const rnd = this.rnd;
    const noise = new Noise2D(31);
    const geo = displace(new THREE.IcosahedronGeometry(1, 1).toNonIndexed(), noise, 0.3, 1.3);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, flatShading: true });
    const list: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const bo = this.track.def.barrierOffset;
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (let a = 0; a < this.track.def.scenery.rockCount * 20 && list.length < this.track.def.scenery.rockCount; a++) {
      const x = tr.originX + 40 + rnd.next() * (tr.size - 80);
      const z = tr.originZ + 40 + rnd.next() * (tr.size - 80);
      const d = tr.distanceAt(x, z);
      if (d < bo + 5) continue;
      if (this.inComplex(x, z) || this.inLake(x, z)) continue;
      // Boulders gather on slopes and rocky high ground.
      const y0 = tr.heightAt(x, z);
      const slope = Math.abs(tr.heightAt(x + 3, z) - tr.heightAt(x - 3, z)) + Math.abs(tr.heightAt(x, z + 3) - tr.heightAt(x, z - 3));
      if (rnd.next() > 0.12 + Math.min(0.8, slope * 0.15) + (y0 > 40 ? 0.3 : 0)) continue;
      const s = rnd.range(0.4, 2.6) * (d > 120 ? 1.6 : 1) * (slope > 3 ? 1.4 : 1);
      e.set(rnd.next() * 3, rnd.next() * 3, rnd.next() * 3);
      q.setFromEuler(e);
      list.push(new THREE.Matrix4().compose(new THREE.Vector3(x, tr.heightAt(x, z) - s * 0.3, z), q, new THREE.Vector3(s * rnd.range(0.8, 1.5), s * rnd.range(0.5, 0.9), s)));
      cols.push(new THREE.Color().setHSL(0.08, rnd.range(0.06, 0.18), rnd.range(0.32, 0.5)));
    }
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, i) => {
      im.setMatrixAt(i, m);
      im.setColorAt(i, cols[i]);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    this.group.add(im);
  }

  /** Returns a frame (position + yaw) at arc length s and lateral offset, with local +Z facing the track centre. */
  private frameAt(s: number, lateral: number): { pos: THREE.Vector3; yaw: number; tangentYaw: number } {
    const t = this.track;
    const pos = t.offsetPoint(s, lateral, new THREE.Vector3());
    pos.y = this.terrain.heightAt(pos.x, pos.z);
    const tan = t.tangentAt(s, new THREE.Vector3());
    const tangentYaw = Math.atan2(tan.x, tan.z);
    // Facing direction toward the centreline: -sign(lateral) * right
    const right = new THREE.Vector3(-tan.z, 0, tan.x).multiplyScalar(-Math.sign(lateral) || 1);
    return { pos, yaw: Math.atan2(right.x, right.z), tangentYaw };
  }

  private garageTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#e9e6df';
    ctx.fillRect(0, 0, 1024, 128);
    for (let i = 0; i < 8; i++) {
      const x = i * 128 + 10;
      const g = ctx.createLinearGradient(0, 20, 0, 128);
      g.addColorStop(0, '#3a3d42');
      g.addColorStop(1, '#1c1e21');
      ctx.fillStyle = g;
      ctx.fillRect(x, 26, 108, 102);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      for (let k = 0; k < 12; k++) ctx.fillRect(x, 30 + k * 8, 108, 2);
      ctx.fillStyle = ['#d81e2c', '#1f6fe0', '#f2b705', '#14a37f', '#e86a10', '#7b2fd0', '#f0f0f0', '#222'][i];
      ctx.fillRect(x, 8, 108, 12);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }

  private buildPitBuilding(): void {
    const bo = this.track.def.barrierOffset;
    const g = new THREE.Group();
    const f = this.frameAt(-70, bo + 18);
    g.position.copy(f.pos);
    g.rotation.y = f.tangentYaw;
    // With rotation.y = tangentYaw, local +Z runs along the track and local +X points to the
    // track's LEFT. This building sits on the right (+lateral) side, so +X faces the track.
    const length = 190;
    const white = new THREE.MeshStandardMaterial({ color: 0xe6e3dc, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6, metalness: 0.3 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x1b2a38, roughness: 0.08, metalness: 0.9, envMapIntensity: 1.4 });
    const garageMat = new THREE.MeshStandardMaterial({ map: this.garageTexture(), roughness: 0.7 });
    garageMat.map!.wrapS = THREE.RepeatWrapping;
    garageMat.map!.repeat.set(length / 90, 1);

    // Ground floor garages; box material slot 0 is the +X face (toward the track).
    const base = new THREE.Mesh(new THREE.BoxGeometry(14, 5.5, length), [garageMat, white, white, white, white, white]);
    base.position.set(0, 2.75, 0);
    g.add(base);
    // Upper hospitality floor with glass
    const upper = new THREE.Mesh(new THREE.BoxGeometry(12, 4, length), [glass, white, white, white, glass, glass]);
    upper.position.set(-1, 7.5, 0);
    g.add(upper);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(17, 0.5, length + 4), white);
    roof.position.set(1.2, 9.75, 0);
    g.add(roof);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.9, length), dark);
    band.position.set(9.7, 9.4, 0);
    g.add(band);
    // Control tower near the line
    const tower = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 18, 12), white);
    shaft.position.y = 9;
    tower.add(shaft);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(5, 3.6, 4, 12), glass);
    cab.position.y = 19.5;
    tower.add(cab);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.2, 0.8, 12), white);
    cap.position.y = 21.9;
    tower.add(cap);
    tower.position.set(-2, 0, 70 + 8);
    g.add(tower);
    // Name sign on the roof
    const signTex = tex.signTexture({ text: this.track.def.name.toUpperCase(), bg: '#101216', fg: '#ffffff', accent: '#ff3b2f', w: 1024, h: 128 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(60, 7.5), new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.5, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.15 }));
    sign.position.set(8, 14, 0);
    sign.rotation.y = Math.PI / 2;
    g.add(sign);
    const signPole = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4, 50), dark);
    signPole.position.set(7.6, 11.5, 0);
    g.add(signPole);

    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.group.add(g);
  }

  private buildGantry(): void {
    const t = this.track;
    const bo = t.def.barrierOffset;
    const f = this.frameAt(0, 0.001);
    const g = new THREE.Group();
    const center = t.pointAt(0, new THREE.Vector3());
    g.position.copy(center);
    g.rotation.y = f.tangentYaw;
    const steel = new THREE.MeshStandardMaterial({ color: 0x30343a, metalness: 0.7, roughness: 0.4 });
    const span = (bo + 0.8) * 2;
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 9, 0.9), steel);
      pillar.position.set(side * (bo + 0.8), 4.5, 0);
      g.add(pillar);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 1.6, 1.2), steel);
    beam.position.set(0, 8.2, 0);
    g.add(beam);
    // Checkered banner on both faces
    const bannerTex = tex.signTexture({ text: 'START · FINISH', bg: '#0e0f12', fg: '#fff', accent: '#ff3b2f', w: 1024, h: 128 });
    for (const dir of [-1, 1]) {
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(span * 0.62, 1.5), new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.6 }));
      banner.position.set(0, 9.9, dir * 0.62);
      banner.rotation.y = dir < 0 ? Math.PI : 0;
      g.add(banner);
      const chk = new THREE.Mesh(new THREE.PlaneGeometry(span, 0.5), new THREE.MeshStandardMaterial({ map: tex.checker(40, 1), roughness: 0.6 }));
      chk.position.set(0, 7.2, dir * 0.61);
      chk.rotation.y = dir < 0 ? Math.PI : 0;
      g.add(chk);
    }
    const bannerBack = new THREE.Mesh(new THREE.BoxGeometry(span * 0.62, 1.6, 1.2), steel);
    bannerBack.position.set(0, 9.9, 0);
    g.add(bannerBack);
    // Countdown light pods facing the grid (behind the line = local -Z)
    const podGeo = new THREE.BoxGeometry(1.1, 2.4, 0.5);
    const lampGeo = new THREE.CircleGeometry(0.32, 20);
    for (let i = 0; i < 5; i++) {
      const pod = new THREE.Mesh(podGeo, steel);
      const x = (i - 2) * 1.5;
      pod.position.set(x, 6.3, -0.7);
      g.add(pod);
      const red = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1a0d, emissiveIntensity: 0 });
      const green = new THREE.MeshStandardMaterial({ color: 0x002200, emissive: 0x19ff5a, emissiveIntensity: 0 });
      const l1 = new THREE.Mesh(lampGeo, red);
      l1.position.set(x, 6.85, -0.96);
      l1.rotation.y = Math.PI;
      const l2 = new THREE.Mesh(lampGeo, green);
      l2.position.set(x, 5.85, -0.96);
      l2.rotation.y = Math.PI;
      g.add(l1, l2);
      this.lampMats.push([red, green]);
    }
    g.traverse((o) => {
      if (o instanceof THREE.Mesh && o.geometry !== lampGeo) o.castShadow = true;
    });
    this.group.add(g);
  }

  /**
   * Floodlight towers along the whole lap. At night their lamps glow and each one paints
   * an additive pool of light on the road (cheap stand-in for dozens of real lights).
   */
  private buildFloodlights(): void {
    const t = this.track;
    const bo = t.def.barrierOffset;
    const steel = new THREE.MeshStandardMaterial({ color: 0x3c4046, metalness: 0.6, roughness: 0.45 });
    this.poolMat = new THREE.MeshBasicMaterial({
      map: tex.radialGradient('rgba(255,236,205,1)', 'rgba(255,236,205,0)'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.28,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      visible: false,
    });
    const spacing = 62;
    const poolLen = 56;
    const w = t.halfWidth + 3;
    const n = t.count;
    let k = 0;
    for (let s = 20; s < t.length - 20; s += spacing, k++) {
      const side = k % 2 === 0 ? 1 : -1;
      // Keep the pit lane (right of the main straight) clear of poles.
      if (side === 1 && Math.abs(t.deltaS(0, s)) < 230) continue;
      const lat = side * (bo + 2.6);
      const p = t.offsetPoint(s, lat, new THREE.Vector3());
      if (t.distanceToCenterline(p.x, p.z) < bo + 1) continue; // inside of a tight corner
      const f = this.frameAt(s, lat);
      const g = new THREE.Group();
      g.position.copy(f.pos);
      g.rotation.y = f.yaw; // local +Z faces the track
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.35, 16, 8), steel);
      pole.position.y = 8;
      g.add(pole);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 3.2), steel);
      arm.position.set(0, 15.6, 1.3);
      g.add(arm);
      for (const x of [-0.75, 0.75]) {
        const housing = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 0.35), steel);
        housing.position.set(x, 15.2, 2.7);
        housing.rotation.x = 0.6;
        g.add(housing);
        const lamp = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.65), this.floodLampMat);
        lamp.position.set(x, 15.02, 2.9);
        lamp.rotation.x = Math.PI / 2 - 0.6; // plane normal (+Z) tilted down toward the track
        g.add(lamp);
      }
      g.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material !== this.floodLampMat) o.castShadow = true;
      });
      this.group.add(g);

      // Pool of light on the asphalt, conforming to the road surface.
      const i0 = (t.indexAt(s - poolLen / 2) + n) % n;
      const i1 = (t.indexAt(s + poolLen / 2) + n) % n;
      const ribbon = buildRibbon(
        t,
        { laterals: [-w, -w / 2, 0, w / 2, w], heights: [0.03, 0.035, 0.04, 0.035, 0.03], us: [0, 0.25, 0.5, 0.75, 1] },
        { start: i0, end: i1, vScale: poolLen },
      );
      // Shift the pool slightly toward the tower side.
      for (let u = 0; u < ribbon.uvs.length; u += 2) ribbon.uvs[u] = ribbon.uvs[u] * 0.9 + 0.05 - side * 0.06;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(ribbon.positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(ribbon.uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(ribbon.indices, 1));
      geo.computeVertexNormals();
      const pool = new THREE.Mesh(geo, this.poolMat);
      pool.renderOrder = 3;
      this.group.add(pool);
    }
  }

  /** Vegetation LOD / culling around the camera (Infinity = show everything, for warm-up). */
  updateCulling(camera: THREE.Vector3, maxDistance: number): void {
    if (maxDistance === Infinity) this.vegetation.showAll();
    else this.vegetation.update(camera, maxDistance);
  }

  /** Switch trackside lighting for night races. */
  private waterMat: THREE.MeshPhysicalMaterial | null = null;

  /** Reflective lake surface with scrolling ripples. */
  private buildLake(): void {
    const L = this.terrain.lake;
    if (!L) return;
    const normal = tex.waterNormal();
    normal.repeat.set(L.r / 6, L.r / 6);
    this.waterMat = new THREE.MeshPhysicalMaterial({
      color: 0x1d3c46,
      roughness: 0.06,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.35, 0.35),
      envMapIntensity: 1.3,
    });
    const water = new THREE.Mesh(new THREE.CircleGeometry(L.r * 1.35, 64).rotateX(-Math.PI / 2), this.waterMat);
    water.position.set(L.x, L.level, L.z);
    water.receiveShadow = true;
    this.group.add(water);
  }

  /** Per-frame animation of scenery (water ripples). */
  update(time: number): void {
    this.venue.update(time);
    if (this.waterMat?.normalMap) this.waterMat.normalMap.offset.set(time * 0.012, time * 0.007);
  }

  setNight(on: boolean): void {
    this.floodLampMat.emissiveIntensity = on ? 9 : 0;
    this.floodLampMat.color.setHex(on ? 0xffffff : 0x9a9a9a);
    this.poolMat.visible = on;
  }

  /** Countdown lights: `reds` = number of red pods lit (0..5), `green` = all green. */
  setStartLights(reds: number, green: boolean): void {
    this.lampMats.forEach(([r, gr], i) => {
      r.emissiveIntensity = !green && i < reds ? 6 : 0;
      r.color.setHex(!green && i < reds ? 0x550000 : 0x1a0000);
      gr.emissiveIntensity = green ? 6 : 0;
    });
  }

  private buildBridge(): void {
    const t = this.track;
    // Find the longest straight away from the start line for the sponsor bridge.
    let bestS = t.length * 0.42;
    let bestScore = -1;
    for (let s = 200; s < t.length - 400; s += 10) {
      let ok = true;
      for (let d = -40; d <= 40; d += 5) if (Math.abs(t.curvatureAt(s + d)) > 1 / 400) ok = false;
      const score = ok ? Math.abs(t.deltaS(0, s)) : -1;
      if (score > bestScore) {
        bestScore = score;
        bestS = s;
      }
    }
    const bo = t.def.barrierOffset;
    const f = this.frameAt(bestS, 0.001);
    const g = new THREE.Group();
    g.position.copy(t.pointAt(bestS, new THREE.Vector3()));
    g.rotation.y = f.tangentYaw;
    const white = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.5 });
    const span = (bo + 2) * 2;
    for (const side of [-1, 1]) {
      const tower = new THREE.Mesh(new THREE.BoxGeometry(2.2, 11, 2.2), white);
      tower.position.set(side * (bo + 2), 5.5, 0);
      g.add(tower);
    }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(span + 2, 2.6, 3), white);
    deck.position.set(0, 9, 0);
    g.add(deck);
    const signs = [
      { text: 'NOVA TYRES', bg: '#101010', fg: '#ffd21f', accent: '#ffd21f' },
      { text: 'SOLARIS', sub: 'ENERGY DRINKS', bg: '#ff5a1f', fg: '#ffffff' },
    ];
    for (const dir of [-1, 1]) {
      const spec = signs[dir < 0 ? 0 : 1];
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(span * 0.85, 2.2),
        new THREE.MeshStandardMaterial({ map: tex.signTexture({ ...spec, w: 1024, h: 128 }), roughness: 0.5 }),
      );
      m.position.set(0, 9, dir * 1.52);
      m.rotation.y = dir < 0 ? Math.PI : 0;
      g.add(m);
    }
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.group.add(g);
  }

  private buildBillboards(): void {
    const t = this.track;
    const bo = t.def.barrierOffset;
    const specs: tex.SignSpec[] = [
      { text: 'APEX OIL', sub: 'PERFORMANCE LUBRICANTS', bg: '#0b3d91', fg: '#fff', accent: '#ffcc00' },
      { text: 'KESTREL', sub: 'WATCHES', bg: '#111', fg: '#e8c872' },
      { text: 'TURBOFUEL', bg: '#e8261d', fg: '#fff', accent: '#111' },
      { text: 'NOVA TYRES', bg: '#111', fg: '#ffd21f', accent: '#ffd21f' },
      { text: 'VELOCITÀ', sub: 'RACING APPAREL', bg: '#f2f2f2', fg: '#d81e2c', accent: '#d81e2c' },
      { text: 'SOLARIS', sub: 'ENERGY', bg: '#ff5a1f', fg: '#fff' },
      { text: 'HALCYON', sub: 'TELECOM', bg: '#14a37f', fg: '#fff', accent: '#0a5a45' },
      { text: 'ORBITA', sub: 'AEROSPACE', bg: '#1a1a2e', fg: '#8fd3ff', accent: '#8fd3ff' },
    ];
    const legMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.6, roughness: 0.5 });
    const billboardMats = new Map<tex.SignSpec, THREE.MeshStandardMaterial>();
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.6 });
    let k = 0;
    for (let s = 60; s < t.length - 250; s += 95) {
      let straight = true;
      for (let d = -25; d <= 25; d += 5) if (Math.abs(t.curvatureAt(s + d)) > 1 / 250) straight = false;
      if (!straight) continue;
      if (t.deltaS(0, s) > -240 && t.deltaS(0, s) < 140) continue;
      const side = k % 2 === 0 ? 1 : -1;
      const lat = side * (bo + 4.5);
      const pos = t.offsetPoint(s, lat, new THREE.Vector3());
      if (t.distanceToCenterline(pos.x, pos.z) < bo + 3) continue;
      const f = this.frameAt(s, lat);
      const g = new THREE.Group();
      g.position.copy(f.pos);
      // Angle the board slightly toward oncoming traffic.
      g.rotation.y = f.yaw + side * 0.35;
      const spec = specs[k % specs.length];
      let bmat = billboardMats.get(spec);
      if (!bmat) billboardMats.set(spec, (bmat = new THREE.MeshStandardMaterial({ map: tex.signTexture(spec), roughness: 0.55 })));
      const board = new THREE.Mesh(new THREE.PlaneGeometry(12, 3), bmat);
      board.position.set(0, 4.2, 0.08);
      const back = new THREE.Mesh(new THREE.BoxGeometry(12.4, 3.4, 0.15), frameMat);
      back.position.set(0, 4.2, 0);
      g.add(board, back);
      for (const lx of [-4.5, 4.5]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4.5, 0.25), legMat);
        leg.position.set(lx, 1.6, -0.1);
        g.add(leg);
      }
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = o !== board; // the backing frame already casts the board's shadow
          o.receiveShadow = true;
        }
      });
      this.group.add(g);
      k++;
    }
  }

  private buildCornerSigns(): void {
    const t = this.track;
    const bo = t.def.barrierOffset;
    const n = t.count;
    // Find corner apexes (local curvature maxima above a threshold).
    const apexes: number[] = [];
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.line.curvature[i]);
      if (k < 1 / 70) continue;
      let isMax = true;
      for (let d = -20; d <= 20; d++) if (Math.abs(this.line.curvature[(i + d + n) % n]) > k) isMax = false;
      if (isMax) apexes.push(i);
    }
    // One material per texture so identical boards merge into a single draw call.
    const boardMats = new Map<THREE.Texture, THREE.MeshStandardMaterial>();
    const boardMat = (m: THREE.Texture) => {
      let mat = boardMats.get(m);
      if (!mat) boardMats.set(m, (mat = new THREE.MeshStandardMaterial({ map: m, roughness: 0.5, side: THREE.DoubleSide })));
      return mat;
    };
    const postMat = new THREE.MeshStandardMaterial({ color: 0x505358, metalness: 0.5, roughness: 0.5 });
    for (const i of apexes) {
      const sApex = i * t.spacing;
      const turnSign = Math.sign(t.curvature[i]) || 1; // +1 = right-hander
      const outside = -turnSign;
      // Chevrons on the outside of the corner
      for (let c = -1; c <= 1; c++) {
        const s = sApex + c * 12 - 10;
        const lat = outside * (bo + 0.9);
        const p = t.offsetPoint(s, lat, new THREE.Vector3());
        if (t.distanceToCenterline(p.x, p.z) < bo - 0.5) continue;
        const f = this.frameAt(s, lat);
        const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), boardMat(tex.chevronTexture(turnSign > 0 ? 1 : -1)));
        board.position.copy(f.pos);
        board.position.y += 1.7;
        // Face oncoming cars (looking back along the track), angled toward the centre.
        board.rotation.y = f.tangentYaw + Math.PI - outside * 0.4;
        this.group.add(board);
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.2, 0.12), postMat);
        post.position.copy(f.pos);
        post.position.y += 0.6;
        this.group.add(post);
      }
      // Brake markers before heavy braking zones
      const vApex = this.line.speed[i];
      const vBefore = this.line.speed[(i - Math.round(160 / t.spacing) + n) % n];
      if (vBefore - vApex > 18) {
        // Braking point roughly where the speed profile starts to drop.
        let brakeIdx = i;
        for (let b = 0; b < 300; b++) {
          const j = (i - b + n) % n;
          if (this.line.speed[j] >= vBefore - 1) {
            brakeIdx = j;
            break;
          }
        }
        const sBrake = brakeIdx * t.spacing;
        for (const [dist, off] of [
          [300, 200],
          [200, 100],
          [100, 0],
        ] as const) {
          const s = sBrake - off + 20;
          const lat = outside * (bo + 0.9);
          const p = t.offsetPoint(s, lat, new THREE.Vector3());
          if (t.distanceToCenterline(p.x, p.z) < bo - 0.5) continue;
          const f = this.frameAt(s, lat);
          const board = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.3), boardMat(tex.distanceBoard(dist)));
          board.position.copy(f.pos);
          board.position.y += 2.0;
          board.rotation.y = f.tangentYaw + Math.PI - outside * 0.3;
          this.group.add(board);
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.4, 0.12), postMat);
          post.position.copy(f.pos);
          post.position.y += 0.7;
          this.group.add(post);
        }
      }
    }
  }
}
