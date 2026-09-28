import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Collapses all static (non-instanced) meshes below `root` into one mesh per material,
 * expressed in `root`'s local space. Cuts draw calls dramatically for procedurally built
 * props (cars, buildings, signs). Meshes listed in `keep` are left untouched.
 */
export function mergeByMaterial(root: THREE.Object3D, keep: Set<THREE.Object3D> = new Set()): void {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; cast: boolean; receive: boolean; order: number }>();
  const remove: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh || keep.has(o) || Array.isArray(o.material)) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    g.applyMatrix4(m);
    // Keep only the attributes every geometry has.
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g = (g.computeVertexNormals(), g);
    g.morphAttributes = {};
    let entry = groups.get(o.material);
    if (!entry) groups.set(o.material, (entry = { geos: [], cast: false, receive: false, order: 0 }));
    entry.geos.push(g);
    entry.cast ||= o.castShadow;
    entry.receive ||= o.receiveShadow;
    entry.order = Math.max(entry.order, o.renderOrder);
    remove.push(o);
  });
  for (const o of remove) o.removeFromParent();
  for (const [mat, e] of groups) {
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
