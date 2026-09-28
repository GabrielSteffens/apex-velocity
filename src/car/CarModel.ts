import * as THREE from 'three';
import type { CarDefinition } from '../data/types';
import { CarPhysics } from './CarPhysics';
import * as tex from '../render/textures';
import { mergeByMaterial } from '../render/merge';

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
  shadow: THREE.Mesh;
  /** Exhaust tip positions in car space. */
  exhausts: THREE.Vector3[];
  paint: THREE.MeshPhysicalMaterial;
}

type P = [number, number];

function arc(cz: number, cy: number, r: number, a0: number, a1: number, steps: number): P[] {
  const out: P[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cz + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** Side-profile (z, y) extruded across the car width, then sculpted. */
function extrudeProfile(points: P[], width: number, bevel: number, taper: (x: number, y: number, z: number) => number, curveSegments = 8): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const depth = Math.max(0.01, width - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 3,
    curveSegments,
    steps: 1,
  });
  // Shape X -> car Z, extrusion -> car X (centred).
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    pos.setX(i, x * taper(x, y, z));
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Builds an original mid-engined sports car from procedural geometry.
 * Car space: +Z forward, +X left, origin at the physics body origin.
 */
export function buildCarModel(def: CarDefinition, color: number, number: number): CarModelParts {
  const d = def.dimensions;
  const G = -CarPhysics.restHeight(def); // ground height in car space
  const L = d.length / 2;
  const W = d.width;
  const wb = d.wheelBase / 2;
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = G;
  root.add(body);

  const paint = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.5,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  });
  const accentColor = new THREE.Color(color).getHSL({ h: 0, s: 0, l: 0 }).l > 0.6 ? 0x151515 : 0xf4f4f4;
  const accent = new THREE.MeshPhysicalMaterial({ color: accentColor, metalness: 0.3, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x121314, roughness: 0.45, metalness: 0.4 });
  const matteBlack = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.8 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b1118, metalness: 0.2, roughness: 0.04, clearcoat: 1, envMapIntensity: 1.8 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: 0.2 });

  // Arch geometry
  const ar = d.wheelRadius + 0.1;
  const acy = d.wheelRadius - 0.02;
  const bottom = 0.17;
  const aOpen = Math.asin((bottom - acy) / ar);
  // Walking the outline from the front bottom backwards, each arch goes front edge -> over -> rear edge.
  const frontArch = arc(wb, acy, ar, aOpen, Math.PI - aOpen, 12);
  const rearArch = arc(-wb, acy, ar, aOpen, Math.PI - aOpen, 12);
  const lower: P[] = [
    [L - 0.2, bottom],
    ...frontArch,
    ...rearArch,
    [-L + 0.22, bottom],
    [-L + 0.02, 0.32],
    [-L, 0.45],
    [-L + 0.02, 0.72],
    [-L + 0.25, 0.8],
    [-1.3, 0.88],
    [-0.4, 0.86],
    [0.75, 0.8],
    [1.25, 0.74],
    [1.8, 0.63],
    [L - 0.08, 0.53],
    [L, 0.42],
    [L - 0.04, 0.25],
  ];
  const bodyTaper = (_x: number, y: number, z: number) => {
    let s = 1;
    if (y > 0.55) s *= 1 - (y - 0.55) * 0.28;
    const az = Math.abs(z);
    if (az > 1.65) s *= 1 - ((az - 1.65) / (L - 1.65)) ** 2 * (z > 0 ? 0.24 : 0.2);
    if (y < 0.24) s *= 0.965;
    return s;
  };
  const lowerGeo = extrudeProfile(lower, W, 0.09, bodyTaper, 10);
  const lowerMesh = new THREE.Mesh(lowerGeo, paint);
  body.add(lowerMesh);

  // Canopy (glass)
  const cabin: P[] = [
    [0.92, 0.77],
    [0.55, 0.92],
    [0.05, 1.13],
    [-0.35, 1.16],
    [-0.75, 1.12],
    [-1.15, 1.0],
    [-1.62, 0.86],
    [-1.62, 0.78],
  ];
  const cabinTaper = (_x: number, y: number) => 1 - Math.max(0, y - 0.82) * 0.62;
  const cabinGeo = extrudeProfile(cabin, 1.44, 0.07, cabinTaper, 6);
  body.add(new THREE.Mesh(cabinGeo, glass));
  // Painted roof panel over the glass
  const roof: P[] = [
    [0.1, 1.118],
    [-0.35, 1.172],
    [-0.8, 1.13],
    [-1.12, 1.03],
    [-1.12, 1.0],
    [-0.8, 1.1],
    [-0.35, 1.14],
    [0.1, 1.09],
  ];
  body.add(new THREE.Mesh(extrudeProfile(roof, 1.2, 0.02, cabinTaper, 4), paint));
  // Engine cover louvres (carbon) behind the canopy
  for (let i = 0; i < 5; i++) {
    const lv = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.02, 0.06), carbon);
    lv.position.set(0, 0.885 - i * 0.004, -1.72 - i * 0.1);
    lv.rotation.x = -0.05;
    body.add(lv);
  }

  // Racing stripes (hood + rear deck), follow the top profile.
  const stripeProfile = (pts: P[], lift: number): P[] => {
    const top = pts.map(([z, y]) => [z, y + lift] as P);
    const bottomLine = pts.map(([z, y]) => [z, y + lift - 0.012] as P).reverse();
    return [...top, ...bottomLine];
  };
  const hoodTop: P[] = [
    [L - 0.09, 0.528],
    [1.8, 0.63],
    [1.25, 0.74],
    [0.9, 0.78],
  ];
  const deckTop: P[] = [
    [-1.62, 0.875],
    [-1.95, 0.866],
    [-L + 0.26, 0.838],
  ];
  for (const xo of [-0.2, 0.2]) {
    for (const src of [hoodTop, deckTop]) {
      const sg = extrudeProfile(stripeProfile(src, 0.012), 0.22, 0, () => 1, 1);
      const m = new THREE.Mesh(sg, accent);
      m.position.x = xo;
      body.add(m);
    }
  }

  // Front splitter, side skirts, diffuser
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 0.035, 0.32), carbon);
  splitter.position.set(0, 0.14, L - 0.12);
  body.add(splitter);
  for (const side of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, wb * 2 - ar * 2 - 0.05), carbon);
    skirt.position.set(side * (W / 2 - 0.05), 0.2, 0);
    body.add(skirt);
    // Side intake
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.55), matteBlack);
    intake.position.set(side * (W / 2 - 0.07), 0.52, -0.62);
    intake.rotation.y = side * 0.08;
    body.add(intake);
    // Mirrors
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.05), carbon);
    stalk.position.set(side * 0.78, 0.9, 0.62);
    body.add(stalk);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.17), paint);
    mirror.position.set(side * 0.9, 0.93, 0.6);
    body.add(mirror);
    // Front intakes
    const fi = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.06), matteBlack);
    fi.position.set(side * 0.55, 0.3, L - 0.02);
    body.add(fi);
  }
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.06), matteBlack);
  grille.position.set(0, 0.26, L - 0.015);
  body.add(grille);
  for (let i = -3; i <= 3; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.16, 0.34), carbon);
    fin.position.set(i * 0.2, 0.22, -L + 0.12);
    body.add(fin);
  }
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, 0.14, 0.05), matteBlack);
  diffuser.position.set(0, 0.3, -L + 0.01);
  body.add(diffuser);

  // Lights
  const headLightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4e0, emissiveIntensity: 2.2, roughness: 0.2 });
  const lensMat = new THREE.MeshPhysicalMaterial({ color: 0x0c0c0c, metalness: 0.8, roughness: 0.1, clearcoat: 1 });
  for (const side of [-1, 1]) {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.07, 0.3), lensMat);
    housing.position.set(side * 0.6, 0.575, L - 0.2);
    housing.rotation.x = 0.33;
    housing.rotation.y = side * -0.2;
    body.add(housing);
    const drl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.05), headLightMat);
    drl.position.set(side * 0.6, 0.555, L - 0.08);
    drl.rotation.y = side * -0.2;
    body.add(drl);
    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.055, 12), headLightMat);
    lamp.position.set(side * 0.66, 0.59, L - 0.17);
    lamp.rotation.x = -1.2;
    body.add(lamp);
  }
  const brakeLightMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1010, emissiveIntensity: 1.2, roughness: 0.3 });
  // Dark rear fascia with a full-width light bar and wrap-around corner lamps.
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(W * 0.74, 0.26, 0.04), carbon);
  fascia.position.set(0, 0.5, -L + 0.005);
  body.add(fascia);
  const tailBar = new THREE.Mesh(new THREE.BoxGeometry(W * 0.62, 0.035, 0.04), brakeLightMat);
  tailBar.position.set(0, 0.665, -L + 0.02);
  body.add(tailBar);
  for (const side of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.075, 0.05), brakeLightMat);
    tl.position.set(side * (W * 0.3), 0.64, -L + 0.03);
    tl.rotation.y = side * 0.12;
    body.add(tl);
  }
  const reverseLightMat = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
  const rev = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.03), reverseLightMat);
  rev.position.set(0, 0.45, -L + 0.03);
  body.add(rev);

  // Exhausts
  const exhausts: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.2, 14, 1, true).rotateX(Math.PI / 2), chrome);
    pipe.position.set(side * 0.2, 0.36, -L - 0.02);
    body.add(pipe);
    const inner = new THREE.Mesh(new THREE.CircleGeometry(0.05, 14), matteBlack);
    inner.position.set(side * 0.2, 0.36, -L + 0.03);
    inner.rotation.y = Math.PI;
    body.add(inner);
    exhausts.push(new THREE.Vector3(side * 0.2, 0.36 + G, -L - 0.1));
  }

  // Rear wing
  if (def.style.spoiler === 'wing') {
    for (const side of [-1, 1]) {
      const up = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.34, 0.16), carbon);
      up.position.set(side * 0.46, 1.02, -L + 0.3);
      up.rotation.x = -0.25;
      body.add(up);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.24, 0.46), carbon);
      plate.position.set(side * 0.86, 1.2, -L + 0.2);
      body.add(plate);
    }
    const airfoil: P[] = [
      [0.2, 0.0],
      [0.1, 0.035],
      [-0.1, 0.04],
      [-0.22, 0.02],
      [-0.2, -0.005],
      [0.05, -0.01],
    ];
    const wing = new THREE.Mesh(extrudeProfile(airfoil, 1.7, 0.01, () => 1, 2), paint);
    wing.position.set(0, 1.2, -L + 0.2);
    wing.rotation.x = 0.12;
    body.add(wing);
    const gurney = new THREE.Mesh(new THREE.BoxGeometry(1.68, 0.03, 0.015), accent);
    gurney.position.set(0, 1.235, -L + 0.0);
    body.add(gurney);
  }

  // Number decals on the doors
  const decalTex = tex.numberDecal(number, '#' + new THREE.Color(color).getHexString());
  const decalMat = new THREE.MeshStandardMaterial({ map: decalTex, transparent: true, roughness: 0.35, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const side of [-1, 1]) {
    const y = 0.5;
    const z = 0.05;
    const x = (W / 2) * bodyTaper(0, y, z) + 0.004;
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36), decalMat);
    decal.position.set(side * x, y, z);
    decal.rotation.y = side * Math.PI / 2;
    body.add(decal);
  }

  body.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  mergeByMaterial(body);

  // Wheels
  const wheelPivots: THREE.Group[] = [];
  const wheelSpinners: THREE.Group[] = [];
  const tireProfile: THREE.Vector2[] = [
    [0.2, -0.13],
    [0.27, -0.135],
    [0.315, -0.125],
    [0.337, -0.095],
    [0.342, -0.04],
    [0.342, 0.04],
    [0.337, 0.095],
    [0.315, 0.125],
    [0.27, 0.135],
    [0.2, 0.13],
  ].map(([r, y]) => new THREE.Vector2(r * (d.wheelRadius / 0.34), y));
  const tireGeo = new THREE.LatheGeometry(tireProfile, 28).rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.88 });
  const rimMat = new THREE.MeshStandardMaterial({ color: def.style.rimColor, metalness: 0.9, roughness: 0.28 });
  const caliperMat = new THREE.MeshStandardMaterial({ color: 0xe8b21f, roughness: 0.4, metalness: 0.2 });
  const rimR = d.wheelRadius * 0.64;
  const barrel = new THREE.CylinderGeometry(rimR, rimR, 0.24, 24, 1, true).rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.035, rimR * 0.95, 0.05);
  spokeGeo.translate(0, rimR * 0.5, 0);
  const hubGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.05, 12).rotateZ(Math.PI / 2);
  const lipGeo = new THREE.TorusGeometry(rimR, 0.012, 6, 28).rotateY(Math.PI / 2);
  const discGeo = new THREE.CylinderGeometry(rimR * 0.78, rimR * 0.78, 0.025, 20).rotateZ(Math.PI / 2);

  const hx = d.trackWidth / 2;
  const mounts: [number, number][] = [
    [hx, wb],
    [-hx, wb],
    [hx, -wb],
    [-hx, -wb],
  ];
  mounts.forEach(([x, z]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, G + d.wheelRadius, z);
    const outward = Math.sign(x); // +1 for left side (+X)
    const spinner = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, tireMat);
    spinner.add(tire);
    const rim = new THREE.Mesh(barrel, rimMat);
    spinner.add(rim);
    const face = new THREE.Group();
    for (let k = 0; k < 5; k++) {
      const spoke = new THREE.Mesh(spokeGeo, rimMat);
      spoke.rotation.x = (k / 5) * Math.PI * 2;
      face.add(spoke);
      const spoke2 = new THREE.Mesh(spokeGeo, rimMat);
      spoke2.rotation.x = (k / 5) * Math.PI * 2 + 0.18;
      spoke2.scale.set(0.8, 1, 0.7);
      face.add(spoke2);
    }
    face.add(new THREE.Mesh(hubGeo, rimMat));
    face.add(new THREE.Mesh(lipGeo, rimMat));
    face.position.x = outward * 0.085;
    spinner.add(face);
    pivot.add(spinner);
    // Brake disc (spins) and caliper (fixed)
    const disc = new THREE.Mesh(discGeo, rimMat);
    disc.position.x = outward * 0.02;
    spinner.add(disc);
    const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.09), caliperMat);
    caliper.position.set(outward * 0.035, rimR * 0.62, -0.07);
    caliper.rotation.x = -0.5;
    pivot.add(caliper);
    pivot.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    mergeByMaterial(spinner);
    root.add(pivot);
    wheelPivots.push(pivot);
    wheelSpinners.push(spinner);
  });

  // Soft contact shadow
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(W + 0.9, d.length + 1.1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: tex.radialGradient('rgba(0,0,0,0.85)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false, opacity: 0.75 }),
  );
  shadow.position.y = G + 0.03;
  shadow.renderOrder = 2;
  root.add(shadow);

  return { root, body, wheelPivots, wheelSpinners, brakeLightMat, reverseLightMat, headLightMat, shadow, exhausts, paint };
}
