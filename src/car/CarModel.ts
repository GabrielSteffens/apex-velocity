import * as THREE from 'three';
import type { CarDefinition } from '../data/types';
import { CarPhysics } from './CarPhysics';
import { CarShape, SKIN_END } from './CarShape';
import * as tex from '../render/textures';
import { mergeByMaterial, paintVertices, vertexFinishMaterial } from '../render/merge';

export interface CarModelParts {
  root: THREE.Group;
  body: THREE.Group;
  /** Pivot per wheel (FL, FR, RL, RR): positioned at the hub, rotated for steering. */
  wheelPivots: THREE.Group[];
  /** Spinning part of each wheel. */
  wheelSpinners: THREE.Group[];
  brakeLightMat: THREE.MeshStandardMaterial;
  reverseLightMat: THREE.MeshStandardMaterial;
  headLightMat: THREE.MeshStandardMaterial;
  /** Exhaust tip positions in car space. */
  exhausts: THREE.Vector3[];
  paint: THREE.MeshPhysicalMaterial;
}

// Per-vertex finishes for the shared trim material: [color, metalness, roughness]
type Finish = [number, number, number];
const FIN = {
  gloss: [0x0c0d10, 0.35, 0.18] as Finish, // gloss black / carbon
  satin: [0x121316, 0.2, 0.55] as Finish, // satin black trim
  matte: [0x08090a, 0, 0.85] as Finish, // vents, wells, shut lines
  chrome: [0xd8dadc, 1, 0.12] as Finish,
  lens: [0x07090c, 0.6, 0.05] as Finish, // light housings, visor
  seat: [0x1a1b1f, 0, 0.8] as Finish,
  alcantara: [0x26272c, 0, 0.95] as Finish,
};

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Shared across all cars (same texture). */
let grilleMat: THREE.MeshStandardMaterial | null = null;

/**
 * Builds an original mid-engined sports car. The body is a lofted surface generated from
 * CarShape (fenders, hood valley, coke-bottle waist, wheel wells, teardrop cabin) with
 * details that sit exactly on it: LED headlights, intakes, door shut lines, mirrors,
 * swan-neck wing, diffuser, see-through glass with a driver inside, conformal livery.
 * Car space: +Z forward, +X left, origin at the physics body origin.
 *
 * @param detailed extra close-up details (brake calipers) — used for the player's car only.
 */
export function buildCarModel(def: CarDefinition, color: number, number: number, detailed = true): CarModelParts {
  const S = new CarShape(def, detailed ? 1 : 0.55);
  const G = -CarPhysics.restHeight(def); // ground height in car space
  const L = S.L2;
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = G;
  root.add(body);

  const bodyColor = new THREE.Color(color);
  const lum = bodyColor.getHSL({ h: 0, s: 0, l: 0 }).l;
  const accentHex = lum > 0.6 ? '#141414' : lum < 0.12 ? '#ff3b2f' : '#f4f4f4';
  const accent = new THREE.Color(accentHex).getHex();

  // ---------------------------------------------------------------- materials
  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04 });
  const trim = vertexFinishMaterial();
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0d141c,
    metalness: 0.1,
    roughness: 0.03,
    clearcoat: 1,
    transparent: true,
    opacity: 0.58,
    envMapIntensity: 1.6,
    depthWrite: false,
  });
  if (!grilleMat) {
    const t = tex.honeycomb();
    t.repeat.set(6, 2);
    grilleMat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.7, metalness: 0.3 });
  }
  const liveryMat = new THREE.MeshPhysicalMaterial({
    map: tex.liveryAtlas(number, accentHex),
    transparent: true,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const headLightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f8ff, emissiveIntensity: 2.2, roughness: 0.2 });
  const brakeLightMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff0008, emissiveIntensity: 1.2, roughness: 0.3 });
  const reverseLightMat = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });

  const add = (g: THREE.BufferGeometry, m: THREE.Material, cast = true) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    body.add(mesh);
    return mesh;
  };
  const addTrim = (g: THREE.BufferGeometry, f: Finish, cast = false) => add(paintVertices(g, f[0], f[1], f[2]), trim, cast);
  const sides = [1, -1];

  // ---------------------------------------------------------------- body skin
  for (const side of sides) {
    add(S.bodyBand(side, 0, SKIN_END), paint);
    addTrim(S.bodyBand(side, SKIN_END, 10), FIN.matte); // wheel wells + floor
  }
  add(S.cap(true), paint);
  add(S.cap(false), paint);

  // Surface helper: point on the skin pushed out along its normal.
  const skin = (z: number, u: number, side: number, lift: number, out: THREE.Vector3) => {
    S.bodyPoint(z, u, side, out);
    S.bodyPoint(z + 0.01, u, side, _q);
    const dz = _q.sub(out);
    S.bodyPoint(z, u + 0.05, side, _n);
    const du = _n.sub(out);
    const n = dz.cross(du).normalize();
    if (n.x * out.x + n.y * (out.y - 0.45) < 0) n.negate();
    return out.addScaledVector(n, lift);
  };
  const skinPatch = (z0: number, z1: number, u0: number, u1: number, side: number, lift: number, nz = 8, nu = 4, uv?: (a: number, b: number) => [number, number]) =>
    S.grid((a, b, o) => skin(a, b, side, lift, o), z0, z1, nz, u0, u1, nu, { uv });

  // ---------------------------------------------------------------- cabin + glass
  type Cell = [number, number, number, number]; // z0, z1, t0, t1
  const zr = S.cabinRear;
  const zf = S.cabinFront;
  const paintCells: Cell[] = [
    [zr, -1.3, 0, 1],
    [-1.3, -0.72, 0, 0.5],
    [-0.72, 0.58, 0, 0.05],
    [-0.72, -0.55, 0.33, 0.5],
    [-0.55, 0.1, 0.33, 1],
    [0.1, 0.58, 0.33, 0.36],
    [0.58, zf, 0, 0.36],
  ];
  const glassCells: Cell[] = [
    [-1.3, -0.55, 0.5, 1], // rear screen
    [-0.72, 0.58, 0.05, 0.33], // side windows
    [0.1, zf, 0.36, 1], // windscreen
  ];
  const cabinCell = ([z0, z1, t0, t1]: Cell, side: number, lift: number) =>
    S.grid(
      (a, b, o) => {
        S.cabinPoint(a, b, side, o);
        if (lift) {
          // Glass sits a hair proud of the frame so the edges read as seals.
          o.x += Math.sign(o.x || side) * lift;
          o.y += lift;
        }
        return o;
      },
      z0,
      z1,
      Math.max(2, Math.ceil(((z1 - z0) / 0.06) * S.detail)),
      t0,
      t1,
      Math.max(2, Math.ceil(((t1 - t0) / 0.05) * S.detail)),
      { outward: (p, n) => n.x * p.x + n.y * (p.y - 0.6) > 0 },
    );
  for (const side of sides) {
    for (const c of paintCells) add(cabinCell(c, side, 0), paint);
    for (const c of glassCells) add(cabinCell(c, side, 0.003), glass, false);
    // Black window surround where glass meets paint.
    addTrim(cabinCell([-0.72, 0.58, 0.045, 0.06], side, 0.002), FIN.gloss);
    addTrim(cabinCell([-0.72, 0.58, 0.325, 0.34], side, 0.002), FIN.gloss);
  }

  // ---------------------------------------------------------------- interior (seen through the glass)
  const cabinFloorY = (z: number) => S.topAt(z, 0);
  addTrim(
    S.grid((a, b, o) => o.set(b, S.topAt(a, b) + 0.004, a), -1.25, 0.8, 12, -0.62, 0.62, 8, { outward: (_p0, n) => n.y > 0 }),
    FIN.alcantara,
  );
  addTrim(new THREE.BoxGeometry(1.1, 0.07, 0.26).translate(0, cabinFloorY(0.45) + 0.05, 0.45), FIN.alcantara);
  for (const sx of [0.3, -0.3]) {
    const seatY = cabinFloorY(-0.3) - 0.22; // driver sits low, inside the tub
    addTrim(new THREE.BoxGeometry(0.4, 0.1, 0.42).translate(sx, seatY + 0.04, -0.25), FIN.seat);
    const back = new THREE.BoxGeometry(0.42, 0.52, 0.09).translate(0, 0.26, 0);
    back.rotateX(-0.32);
    back.translate(sx, seatY, -0.5);
    addTrim(back, FIN.seat);
    const bolster = new THREE.BoxGeometry(0.05, 0.44, 0.1).translate(0, 0.25, 0);
    bolster.rotateX(-0.32);
    for (const bx of [-0.19, 0.19]) addTrim(bolster.clone().translate(sx + bx, seatY, -0.49), [accent, 0, 0.7]);
  }
  // Driver (left seat, +X): helmet in the car colour with a dark visor, shoulders, wheel.
  {
    const dx = 0.3;
    const roof = S.cabinPoint(-0.25, 1, 1, _p).y;
    const hy = roof - 0.2;
    addTrim(new THREE.SphereGeometry(0.125, 20, 14).scale(1, 1.08, 1.12).translate(dx, hy, -0.3), [color, 0.3, 0.3]);
    const visor = new THREE.SphereGeometry(0.128, 20, 10, -Math.PI * 0.35, Math.PI * 0.7, Math.PI * 0.35, Math.PI * 0.28);
    addTrim(visor.scale(1, 1.08, 1.12).translate(dx, hy, -0.3), FIN.lens);
    addTrim(new THREE.BoxGeometry(0.42, 0.22, 0.24).translate(dx, hy - 0.26, -0.36), [0x202226, 0, 0.8]);
    addTrim(new THREE.TorusGeometry(0.13, 0.018, 8, 24).rotateX(-1.15).translate(dx, hy - 0.22, 0.1), FIN.satin);
  }

  // ---------------------------------------------------------------- lights
  for (const side of sides) {
    // Headlight: dark glossy lens sculpted into the front fender corner...
    addTrim(skinPatch(1.84, 2.14, 3.05, 4.75, side, 0.004, 8, 6), FIN.lens);
    // ...an LED eyebrow along its upper edge...
    add(skinPatch(1.86, 2.13, 3.1, 3.3, side, 0.007, 8, 1), headLightMat, false);
    // ...and two projector lamps.
    for (const [z, u] of [
      [1.93, 3.95],
      [2.04, 3.85],
    ]) {
      skin(z, u, side, 0.006, _p);
      skin(z, u, side, 1, _q);
      const lamp = new THREE.CircleGeometry(0.035, 16);
      lamp.lookAt(_q.sub(_p));
      lamp.translate(_p.x, _p.y, _p.z);
      add(lamp, headLightMat, false);
    }
  }
  // Tail: full-width LED bar, corner lamps and reverse light on the rear face.
  const tailSec = S.section(-L);
  const tw = tailSec[5][0];
  const tailTop = S.topC(-L);
  add(new THREE.BoxGeometry(tw * 1.62, 0.028, 0.02).translate(0, tailTop - 0.07, -L - 0.006), brakeLightMat, false);
  for (const side of sides) {
    add(new THREE.BoxGeometry(0.26, 0.055, 0.025).translate(side * tw * 0.68, tailTop - 0.13, -L - 0.008), brakeLightMat, false);
    add(new THREE.BoxGeometry(0.035, 0.12, 0.025).translate(side * tw * 0.88, tailTop - 0.1, -L - 0.008), brakeLightMat, false);
  }
  add(new THREE.BoxGeometry(0.12, 0.03, 0.02).translate(0, tailTop - 0.13, -L - 0.008), reverseLightMat, false);
  add(new THREE.BoxGeometry(tw * 1.3, 0.14, 0.02).translate(0, 0.55, -L - 0.004), grilleMat, false);
  addTrim(new THREE.BoxGeometry(tw * 1.7, 0.2, 0.02).translate(0, 0.36, -L - 0.003), FIN.gloss);

  // ---------------------------------------------------------------- aero & details
  addTrim(new THREE.BoxGeometry(S.halfWidth(L - 0.05) * 1.9, 0.022, 0.4).translate(0, S.floor(L) - 0.02, L - 0.12), FIN.gloss, true);
  add(new THREE.BoxGeometry(0.62, 0.11, 0.02).translate(0, (S.floor(L) + S.topC(L)) / 2 - 0.02, L + 0.004), grilleMat, false);
  for (const side of sides) {
    // Lower front intakes
    add(skinPatch(1.97, L - 0.01, 5.25, 6.85, side, 0.004, 5, 4, (a, b) => [a * 2, b]), grilleMat, false);
    addTrim(new THREE.BoxGeometry(0.2, 0.012, 0.14).rotateZ(side * 0.25).translate(side * S.halfWidth(2.0) * 0.98, 0.3, 2.0), FIN.gloss);
    // Hood vents
    addTrim(skinPatch(1.34, 1.55, 1.05, 1.55, side, 0.003, 5, 2), FIN.matte);
    // Side intake ahead of the rear wheel (mid-engine) + a painted blade
    // Trapezoid scoop: both edges rake backwards towards the bottom, like a real
    // mid-engine intake feeding the radiators.
    const scoop = (lift: number, zShift: number, uPad: number) =>
      S.grid(
        (a, b, o) => {
          const u = 5.1 - uPad + (6.1 - 5.1 + 2 * uPad) * b;
          const z0 = -1.0 + 0.2 * b + zShift;
          const z1 = -0.42 - 0.2 * b + zShift;
          return skin(z0 + (z1 - z0) * a, u, side, lift, o);
        },
        0,
        1,
        6,
        0,
        1,
        4,
        { uv: (a, b) => [a * 3, b] },
      );
    add(scoop(0.004, 0, 0), grilleMat, false);
    // Painted lip framing the scoop's leading edge
    add(
      S.grid((a, b, o) => skin(-0.42 - 0.2 * b + 0.02 * a - 0.01, 4.98 + 1.3 * b, side, 0.014, o), 0, 1, 1, 0, 1, 5),
      paint,
    );
    // Door shut lines and side skirt
    addTrim(skinPatch(0.615, 0.628, 5.02, 6.9, side, 0.0015, 1, 6), FIN.matte);
    addTrim(skinPatch(-0.34, -0.327, 5.02, 6.9, side, 0.0015, 1, 6), FIN.matte);
    addTrim(skinPatch(-0.84, 0.84, 6.72, 6.98, side, 0.005, 16, 1), FIN.gloss, true);
    // Engine cover vents
    addTrim(
      S.grid((a, b, o) => o.set(b * side, S.topAt(a, b) + 0.004, a), -1.98, -1.58, 4, 0.12, 0.38, 3, { outward: (_p0, n) => n.y > 0 }),
      FIN.matte,
    );
    // Mirrors on aero stalks
    const mz = 0.56;
    const mx = S.cabinBaseHalfWidth(mz);
    const my = S.topAt(mz, mx);
    addTrim(new THREE.BoxGeometry(0.2, 0.022, 0.05).rotateZ(side * 0.35).translate(side * (mx + 0.1), my + 0.06, mz), FIN.gloss);
    add(new THREE.SphereGeometry(0.1, 16, 10).scale(1.05, 0.52, 1.25).translate(side * (mx + 0.2), my + 0.12, mz - 0.02), paint);
    addTrim(new THREE.CircleGeometry(0.075, 16).scale(1.1, 0.5, 1).rotateY(Math.PI).translate(side * (mx + 0.2), my + 0.12, mz - 0.13), FIN.chrome);
  }
  // Rear diffuser fins and twin centre exhausts
  const exhausts: THREE.Vector3[] = [];
  for (let i = -3; i <= 3; i++) addTrim(new THREE.BoxGeometry(0.02, 0.2, 0.45).translate(i * 0.2, S.floor(-L) - 0.05, -L + 0.2), FIN.gloss);
  for (const side of sides) {
    const ex = side * 0.15;
    const ey = 0.4;
    addTrim(new THREE.CylinderGeometry(0.068, 0.07, 0.16, 20, 1, true).rotateX(Math.PI / 2).translate(ex, ey, -L - 0.03), FIN.chrome);
    addTrim(new THREE.CircleGeometry(0.06, 20).rotateY(Math.PI).translate(ex, ey, -L + 0.02), FIN.matte);
    exhausts.push(new THREE.Vector3(ex, ey + G, -L - 0.12));
  }

  // Swan-neck rear wing (mounted from above, like modern GT cars)
  if (def.style.spoiler === 'wing') {
    const wz = -L + 0.28;
    const wy = 1.24;
    for (const side of sides) {
      const px = side * 0.36;
      const baseY = S.topAt(wz + 0.15, px);
      const h = wy - baseY + 0.05;
      const neck = new THREE.BoxGeometry(0.03, h, 0.16).translate(0, h / 2, 0);
      neck.rotateX(0.22);
      neck.translate(px, baseY, wz + 0.15);
      addTrim(neck, FIN.gloss, true);
      addTrim(new THREE.BoxGeometry(0.02, 0.2, 0.44).translate(side * 0.88, wy - 0.02, wz), FIN.gloss, true);
    }
    const airfoil: [number, number][] = [
      [0.2, 0.0],
      [0.12, 0.028],
      [-0.02, 0.036],
      [-0.16, 0.024],
      [-0.2, 0.004],
      [-0.1, -0.008],
      [0.1, -0.008],
    ];
    const shape = new THREE.Shape();
    shape.moveTo(airfoil[0][0], airfoil[0][1]);
    for (const [x, y] of airfoil.slice(1)) shape.lineTo(x, y);
    shape.closePath();
    const wingGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.74, bevelEnabled: false, curveSegments: 4 });
    wingGeo.rotateY(-Math.PI / 2).translate(0.87, 0, 0).rotateX(0.1).translate(0, wy, wz);
    addTrim(wingGeo, FIN.gloss, true);
    addTrim(new THREE.BoxGeometry(1.72, 0.022, 0.012).translate(0, wy + 0.015, wz - 0.2), [accent, 0.2, 0.4]);
  }

  // ---------------------------------------------------------------- livery (conformal decals)
  for (const side of sides) {
    // Door art (texture top half); u runs front->back as seen from each side.
    add(
      skinPatch(-0.3, 0.6, 5.08, 6.6, side, 0.003, 10, 4, (a, b) => [side > 0 ? 1 - a : a, 0.5 + 0.5 * (1 - b)]),
      liveryMat,
      false,
    );
  }
  // Twin stripes over the hood and engine cover (texture bottom half).
  const stripe = (z0: number, z1: number) =>
    S.grid((a, b, o) => o.set(b, S.topAt(a, b) + 0.003, a), z0, z1, 16, -0.34, 0.34, 6, {
      outward: (_p0, n) => n.y > 0,
      uv: (_a, b) => [b, 0.25],
    });
  add(stripe(0.95, L - 0.04), liveryMat, false);
  add(stripe(-L + 0.06, -1.45), liveryMat, false);

  // ---------------------------------------------------------------- consolidate
  mergeByMaterial(body);
  body.traverse((o) => {
    if (o instanceof THREE.Mesh && o.material === glass) o.renderOrder = 3;
  });

  // ---------------------------------------------------------------- wheels
  const wheelPivots: THREE.Group[] = [];
  const wheelSpinners: THREE.Group[] = [];
  const d = def.dimensions;
  const R = d.wheelRadius;
  const k = R / 0.34;
  const wheelMat = vertexFinishMaterial();
  const caliperMat = new THREE.MeshStandardMaterial({ color: 0xe8b21f, roughness: 0.35, metalness: 0.3 });
  const tireProfile = [
    [0.235, -0.13],
    [0.285, -0.138],
    [0.322, -0.13],
    [0.338, -0.105],
    [0.343, -0.06],
    [0.344, 0],
    [0.343, 0.06],
    [0.338, 0.105],
    [0.322, 0.13],
    [0.285, 0.138],
    [0.235, 0.13],
  ].map(([r, y]) => new THREE.Vector2(r * k, y));
  const tireGeo = paintVertices(new THREE.LatheGeometry(tireProfile, 40).rotateZ(Math.PI / 2), 0x121212, 0, 0.92);
  const rimR = R * 0.68;
  const barrel = paintVertices(new THREE.CylinderGeometry(rimR, rimR * 0.96, 0.25, 32, 1, true).rotateZ(Math.PI / 2), 0x2a2c30, 0.8, 0.4);
  const lip = paintVertices(new THREE.TorusGeometry(rimR, 0.011, 6, 40).rotateY(Math.PI / 2), 0xe0e2e4, 1, 0.12);
  const band = paintVertices(new THREE.TorusGeometry(R * 0.86, 0.006, 4, 40).rotateY(Math.PI / 2), 0xf2c230, 0, 0.6);
  const spoke = new THREE.CylinderGeometry(0.012, 0.022, rimR * 0.92, 6).translate(0, rimR * 0.5, 0);
  const hub = paintVertices(new THREE.CylinderGeometry(0.075, 0.085, 0.05, 20).rotateZ(Math.PI / 2), def.style.rimColor, 0.9, 0.28);
  const nut = paintVertices(new THREE.CylinderGeometry(0.035, 0.035, 0.07, 6).rotateZ(Math.PI / 2), 0xd0d2d4, 1, 0.2);
  const disc = paintVertices(new THREE.CylinderGeometry(rimR * 0.82, rimR * 0.82, 0.028, 28).rotateZ(Math.PI / 2), 0x4e5257, 0.85, 0.45);
  const hx = d.trackWidth / 2;
  const mounts: [number, number][] = [
    [hx, S.wb],
    [-hx, S.wb],
    [hx, -S.wb],
    [-hx, -S.wb],
  ];
  mounts.forEach(([x, z]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, G + R, z);
    const outward = Math.sign(x);
    const spinner = new THREE.Group();
    const addW = (g: THREE.BufferGeometry, px = 0) => {
      const m = new THREE.Mesh(g, wheelMat);
      m.position.x = px;
      spinner.add(m);
      return m;
    };
    addW(tireGeo);
    addW(barrel);
    addW(lip, outward * 0.11);
    addW(band, outward * 0.125);
    for (let s = 0; s < 5; s++) {
      for (const off of [-0.16, 0.16]) {
        const m = addW(paintVertices(spoke.clone(), def.style.rimColor, 0.9, 0.28), outward * 0.09);
        m.rotation.x = (s / 5) * Math.PI * 2 + off;
      }
    }
    addW(hub, outward * 0.085);
    addW(nut, outward * 0.11);
    addW(disc, outward * 0.02);
    spinner.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    mergeByMaterial(spinner);
    pivot.add(spinner);
    if (detailed) {
      const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.1), caliperMat);
      caliper.position.set(outward * 0.04, rimR * 0.58, -0.08);
      caliper.rotation.x = -0.5;
      pivot.add(caliper);
    }
    root.add(pivot);
    wheelPivots.push(pivot);
    wheelSpinners.push(spinner);
  });

  return { root, body, wheelPivots, wheelSpinners, brakeLightMat, reverseLightMat, headLightMat, exhausts, paint };
}
