import * as THREE from 'three';
import type { TrackGeometry } from './TrackGeometry';
import type { Terrain } from './Terrain';
import type { TrackLayout, BarrierRun } from './TrackLayout';
import type { RacingLine } from '../ai/RacingLine';
import { buildRibbon, curbProfile, roadProfile, type RibbonData } from './TrackMeshData';
import * as tex from '../render/textures';
import { Noise2D, Random, smoothstep } from '../core/math';
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

  /**
   * Terrain: per-vertex tint (grass colour variation, mowed stripes) and splat weights
   * (rock on steep slopes and peaks, dirt patches, sand on the lake shore) blended in the
   * shader with two-scale texture sampling so the grass never visibly tiles. Split into
   * chunks so off-screen parts are culled.
   */
  private buildTerrain(): void {
    const tr = this.terrain;
    const n = tr.segments + 1;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const tint = new Float32Array(n * n * 3);
    const splat = new Float32Array(n * n * 3);
    const norm = new Float32Array(n * n * 3);
    const noise = new Noise2D(tr.track.def.terrain.seed + 55);
    const lush = new THREE.Color(0x587630);
    const mowed = new THREE.Color(0x587a34);
    const dry = new THREE.Color(0xc2a45e);
    const olive = new THREE.Color(0x86863e);
    const forest = new THREE.Color(0x3f5a24);
    const c = new THREE.Color();
    const bo = tr.track.def.barrierOffset;
    const lake = tr.lake;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = tr.originX + i * tr.cell;
        const z = tr.originZ + j * tr.cell;
        const y = tr.heights[k];
        pos[k * 3] = x;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = z;
        uv[k * 2] = x / 7;
        uv[k * 2 + 1] = z / 7;
        const d = tr.trackDistance[k];
        const nv = noise.fbm(x / 170, z / 170, 3) * 0.5 + 0.5;
        const fine = noise.get(x / 23, z / 23) * 0.5 + 0.5;
        c.copy(olive).lerp(dry, smoothstep(0.4, 0.75, nv));
        c.lerp(lush, smoothstep(0.5, 0.2, nv) * 0.7);
        c.lerp(forest, smoothstep(0.62, 0.8, noise.get(x / 90 + 40, z / 90)) * 0.5);
        // Mowed verges near the track, in stripes.
        const near = smoothstep(bo + 16, bo + 3, d);
        const stripe = Math.sin((x * 0.8 + z) * 0.16) > 0 ? 1.04 : 0.9;
        c.lerp(mowed.clone().multiplyScalar(stripe), near);
        c.multiplyScalar(0.88 + fine * 0.22);
        tint[k * 3] = c.r;
        tint[k * 3 + 1] = c.g;
        tint[k * 3 + 2] = c.b;
        // Splat weights
        const hx = tr.heights[j * n + Math.min(n - 1, i + 1)] - tr.heights[j * n + Math.max(0, i - 1)];
        const hz = tr.heights[Math.min(n - 1, j + 1) * n + i] - tr.heights[Math.max(0, j - 1) * n + i];
        const slope = Math.hypot(hx, hz) / (2 * tr.cell);
        // Normals from the whole heightfield (no lighting seams between chunks).
        const nx = -hx / (2 * tr.cell);
        const nz = -hz / (2 * tr.cell);
        const nl = Math.hypot(nx, 1, nz);
        norm[k * 3] = nx / nl;
        norm[k * 3 + 1] = 1 / nl;
        norm[k * 3 + 2] = nz / nl;
        let rock = smoothstep(0.42, 0.85, slope) + smoothstep(70, 130, y) * 0.6;
        rock *= 1 - near;
        let dirtW = smoothstep(0.66, 0.82, noise.get(x / 45 - 13, z / 45 + 5)) * 0.8 * (1 - near);
        dirtW = Math.max(dirtW, smoothstep(0.2, 0.35, slope) * 0.5 * (1 - near));
        let sand = 0;
        if (lake) {
          const ld = Math.hypot(x - lake.x, z - lake.z) / tr.lakeRadiusAt(x, z);
          sand = smoothstep(1.14, 1.0, ld) * 0.85;
        }
        splat[k * 3] = Math.min(1, rock);
        splat[k * 3 + 1] = Math.min(1, dirtW);
        splat[k * 3 + 2] = sand;
      }
    }
    const gr = tex.grass();
    const rockT = tex.rock();
    const dirtT = tex.dirt();
    const sandT = tex.gravel();
    const mat = new THREE.MeshStandardMaterial({
      map: gr.map,
      normalMap: gr.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.95,
      metalness: 0,
    });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uRock = { value: rockT.map };
      sh.uniforms.uDirt = { value: dirtT.map };
      sh.uniforms.uSand = { value: sandT.map };
      sh.vertexShader =
        'attribute vec3 tint;\nattribute vec3 splat;\nvarying vec3 vTint;\nvarying vec3 vSplat;\n' +
        sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTint = tint;\n  vSplat = splat;');
      sh.fragmentShader =
        'uniform sampler2D uRock;\nuniform sampler2D uDirt;\nuniform sampler2D uSand;\nvarying vec3 vTint;\nvarying vec3 vSplat;\n' +
        sh.fragmentShader.replace(
          '#include <map_fragment>',
          `vec3 g1 = texture2D(map, vMapUv).rgb;
          vec3 g2 = texture2D(map, vMapUv * 0.21 + vec2(0.31, 0.77)).rgb;
          vec3 terrainCol = mix(g1, g2, 0.5) * vTint * 1.85;
          float macro = texture2D(uDirt, vMapUv * 0.029).r;
          terrainCol *= 0.78 + macro * 0.55;
          float lumT = dot(terrainCol, vec3(0.3, 0.59, 0.11));
          terrainCol = mix(vec3(lumT), terrainCol, 0.82);
          terrainCol = mix(terrainCol, texture2D(uDirt, vMapUv * 0.8).rgb, vSplat.y);
          terrainCol = mix(terrainCol, texture2D(uSand, vMapUv * 1.1).rgb, vSplat.z);
          terrainCol = mix(terrainCol, texture2D(uRock, vMapUv * 0.45).rgb * 0.95, vSplat.x);
          diffuseColor.rgb *= terrainCol;`,
        );
    };
    mat.customProgramCacheKey = () => 'terrain-splat';

    // Chunked meshes (shared material) for frustum culling.
    const CH = 6;
    const per = Math.ceil(tr.segments / CH);
    for (let cj = 0; cj < CH; cj++) {
      for (let ci = 0; ci < CH; ci++) {
        const i0 = ci * per;
        const j0 = cj * per;
        const i1 = Math.min(tr.segments, i0 + per);
        const j1 = Math.min(tr.segments, j0 + per);
        if (i0 >= i1 || j0 >= j1) continue;
        const w = i1 - i0 + 1;
        const h = j1 - j0 + 1;
        const cp = new Float32Array(w * h * 3);
        const cu = new Float32Array(w * h * 2);
        const ct = new Float32Array(w * h * 3);
        const cs = new Float32Array(w * h * 3);
        const cn = new Float32Array(w * h * 3);
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            const src = (j0 + j) * n + (i0 + i);
            const dst = j * w + i;
            cp.set(pos.subarray(src * 3, src * 3 + 3), dst * 3);
            cu.set(uv.subarray(src * 2, src * 2 + 2), dst * 2);
            ct.set(tint.subarray(src * 3, src * 3 + 3), dst * 3);
            cs.set(splat.subarray(src * 3, src * 3 + 3), dst * 3);
            cn.set(norm.subarray(src * 3, src * 3 + 3), dst * 3);
          }
        }
        const idx: number[] = [];
        for (let j = 0; j < h - 1; j++) {
          for (let i = 0; i < w - 1; i++) {
            const a = j * w + i;
            const b = a + 1;
            const cc = a + w;
            const d = cc + 1;
            idx.push(a, cc, b, b, cc, d);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(cp, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(cu, 2));
        g.setAttribute('tint', new THREE.BufferAttribute(ct, 3));
        g.setAttribute('splat', new THREE.BufferAttribute(cs, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(cn, 3));
        g.setIndex(idx);
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, mat);
        mesh.receiveShadow = true;
        mesh.name = 'terrain';
        this.group.add(mesh);
      }
    }
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
    // Large-scale wear so the surface doesn't read as one repeating tile: resurfaced
    // patches with seams, dusty edges, a darker polished groove and oily stains.
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = 'varying vec2 vRoadUv;\nvarying vec3 vRoadW;\n' + sh.vertexShader.replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n  vRoadUv = uv;\n  vRoadW = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
      sh.fragmentShader =
        `varying vec2 vRoadUv;
        varying vec3 vRoadW;
        float rh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float rn(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(rh(i), rh(i + vec2(1, 0)), f.x), mix(rh(i + vec2(0, 1)), rh(i + vec2(1, 1)), f.x), f.y);
        }
        float roadWear;
        ` +
        sh.fragmentShader
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
            {
              float along = vRoadUv.y * 14.0;
              // Resurfaced rectangles (~every few hundred metres), one lane or full width.
              float cell = floor(along / 23.0);
              float h = rh(vec2(cell, 3.7));
              float lane = floor(clamp(vRoadUv.x, 0.0, 0.999) * 2.0);
              float fullW = step(0.5, rh(vec2(cell, 9.1)));
              float inPatch = step(0.86, h) * max(fullW, step(0.5, abs(lane - step(0.5, rh(vec2(cell, 5.3))))));
              float fa = fract(along / 23.0);
              float seam = inPatch * (1.0 - smoothstep(0.0, 0.006, min(fa, 1.0 - fa)));
              diffuseColor.rgb *= mix(1.0, 0.72, inPatch);
              diffuseColor.rgb *= 1.0 - seam * 0.6;
              // Macro blotches
              float m = rn(vRoadW.xz * 0.035) * 0.6 + rn(vRoadW.xz * 0.11) * 0.4;
              diffuseColor.rgb *= 0.9 + m * 0.2;
              // Oil / fluid stains
              float st = smoothstep(0.78, 0.9, rn(vRoadW.xz * 0.22 + 17.0)) * smoothstep(0.5, 0.7, rn(vRoadW.xz * 0.013));
              diffuseColor.rgb *= 1.0 - st * 0.35;
              // Dust and marbles toward the edges
              float edge = smoothstep(0.16, 0.0, min(vRoadUv.x, 1.0 - vRoadUv.x));
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.4, 0.36), edge * (0.25 + 0.2 * rn(vRoadW.xz * 0.4)));
              roadWear = inPatch * 0.12 + st * 0.3 - edge * 0.12;
            }`,
          )
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor - roadWear, 0.25, 1.0);');
    };
    mat.customProgramCacheKey = () => 'road-wear';
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
    this.buildBrakeMarks();
  }

  /** Dark tyre streaks laid down in the braking zones before each slow corner. */
  private buildBrakeMarks(): void {
    const t = this.track;
    const L = this.line;
    const n = t.count;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const rnd = new Random(77);
    // Braking zones: consecutive samples where the target speed drops.
    let i = 0;
    let guard = 0;
    while (i < n && guard++ < n) {
      if (L.speed[(i + 1) % n] < L.speed[i] - 0.05) {
        let j = i;
        while (j - i < n / 4 && L.speed[(j + 1) % n] < L.speed[j % n] - 0.02) j++;
        const drop = L.speed[i] - L.speed[j % n];
        if (drop > 12) {
          // Several overlapping streak sets per zone, varying length and lateral spread.
          for (let set = 0; set < 3; set++) {
            const start = i + Math.floor(((j - i) * rnd.range(0.3, 0.7)));
            const end = j + Math.floor(rnd.range(-2, 3));
            const jitter = rnd.range(-0.6, 0.6);
            for (const wheel of [-0.8, 0.8]) {
              const base = pos.length / 3;
              const rows = end - start + 1;
              if (rows < 3) continue;
              for (let r = 0; r < rows; r++) {
                const k = (start + r + n) % n;
                const o = L.offset[k] + jitter + wheel + Math.sin((start + r) * 0.13 + set) * 0.08;
                const fade = Math.min(1, r / (rows * 0.3)) * Math.min(1, (rows - 1 - r) / 3);
                for (const side of [-0.13, 0.13]) {
                  pos.push(t.pos[k * 3] + t.right[k * 2] * (o + side), t.pos[k * 3 + 1] + 0.02, t.pos[k * 3 + 2] + t.right[k * 2 + 1] * (o + side));
                  uv.push(fade, 0);
                }
                if (r < rows - 1) {
                  const v = base + r * 2;
                  idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
                }
              }
            }
          }
        }
        i = j + 1;
      } else i++;
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    // Opacity rides in uv.x (vertex fade); the material reads it as a vertex alpha.
    const col = new Float32Array((pos.length / 3) * 4);
    for (let v = 0; v < pos.length / 3; v++) col.set([0.03, 0.03, 0.03, uv[v * 2] * 0.55], v * 4);
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      roughness: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1.5,
      polygonOffsetUnits: -1.5,
    });
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.renderOrder = 1;
    this.group.add(m);
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
