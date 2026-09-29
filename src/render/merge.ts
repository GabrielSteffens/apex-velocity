import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Attributes that survive a merge when every geometry in the group has them. */
const MERGEABLE = ['position', 'normal', 'uv', 'color', 'mr'];

/**
 * Collapses all static (non-instanced) meshes below `root` into one mesh per material,
 * expressed in `root`'s local space. Cuts draw calls dramatically for procedurally built
 * props (cars, buildings, signs). Meshes listed in `keep` are left untouched.
 */
export function mergeByMaterial(root: THREE.Object3D, keep: Set<THREE.Object3D> = new Set(), chunkSize = 0): void {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean; receive: boolean; order: number }>();
  const center = new THREE.Vector3();
  const remove: THREE.Mesh[] = [];
  const addPart = (o: THREE.Mesh, src: THREE.BufferGeometry, material: THREE.Material) => {
    const g = src.index ? src.toNonIndexed() : src.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (!g.attributes.normal) g.computeVertexNormals();
    g.morphAttributes = {};
    g.clearGroups();
    // Optionally keep merged meshes spatially compact so frustum culling (main camera and
    // shadow camera) can still skip far-away parts of the map.
    let key = material.uuid;
    if (chunkSize > 0) {
      g.computeBoundingSphere();
      center.copy(g.boundingSphere!.center);
      key += `:${Math.floor(center.x / chunkSize)}:${Math.floor(center.z / chunkSize)}`;
    }
    let entry = groups.get(key);
    if (!entry) groups.set(key, (entry = { mat: material, geos: [], cast: false, receive: false, order: 0 }));
    entry.geos.push(g);
    entry.cast ||= o.castShadow;
    entry.receive ||= o.receiveShadow;
    entry.order = Math.max(entry.order, o.renderOrder);
  };
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh || keep.has(o)) return;
    if (Array.isArray(o.material)) {
      // Multi-material mesh (e.g. a box with different faces): split it per geometry group.
      const geo = o.geometry;
      if (!geo.index || !geo.groups.length) return;
      for (const grp of geo.groups) {
        const mat = o.material[grp.materialIndex ?? 0];
        if (!mat) continue;
        const sub = geo.clone();
        sub.setIndex(Array.from(geo.index.array.slice(grp.start, grp.start + grp.count)));
        addPart(o, sub, mat);
        sub.dispose();
      }
    } else {
      addPart(o, o.geometry, o.material);
    }
    remove.push(o);
  });
  for (const o of remove) o.removeFromParent();
  for (const e of groups.values()) {
    const mat = e.mat;
    // Keep only attributes shared by every geometry in the group (uv is synthesised).
    const common = MERGEABLE.filter((name) => name === 'uv' || e.geos.every((g) => g.attributes[name]));
    for (const g of e.geos) {
      for (const name of Object.keys(g.attributes)) if (!common.includes(name)) g.deleteAttribute(name);
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    const merged = mergeGeometries(e.geos, false);
    e.geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = e.cast;
    mesh.receiveShadow = e.receive;
    mesh.renderOrder = e.order;
    root.add(mesh);
  }
}

/**
 * Marks a subtree as static: world matrices are computed once and three.js stops
 * recomputing them every frame (saves CPU for hundreds of trackside objects).
 */
export function freezeStatic(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.matrixWorldAutoUpdate = false;
  });
}

/**
 * A MeshStandardMaterial whose metalness/roughness come from a per-vertex `mr` attribute
 * (x = metalness, y = roughness) and colour from vertex colours, so parts with different
 * finishes (rubber, carbon, chrome, painted metal) can be drawn in one call.
 */
export function vertexFinishMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec2 mr;\nvarying vec2 vMR;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vMR = mr;');
    sh.fragmentShader =
      'varying vec2 vMR;\n' +
      sh.fragmentShader
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMR.y;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMR.x;');
  };
  m.customProgramCacheKey = () => 'vertex-finish';
  return m;
}

/** Bakes a flat colour (and optional metalness/roughness) into a geometry's vertices. */
export function paintVertices(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, metalness?: number, roughness?: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (metalness !== undefined && roughness !== undefined) {
    const mr = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      mr[i * 2] = metalness;
      mr[i * 2 + 1] = roughness;
    }
    g.setAttribute('mr', new THREE.BufferAttribute(mr, 2));
  }
  return g;
}
