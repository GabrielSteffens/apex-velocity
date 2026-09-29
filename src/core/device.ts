/**
 * Touch-device detection. `?touch=1` / `?touch=0` in the URL forces the mode (handy for
 * testing the mobile UI on a desktop browser).
 */
export function isTouchDevice(): boolean {
  const q = new URLSearchParams(location.search).get('touch');
  if (q === '1') return true;
  if (q === '0') return false;
  return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 && !window.matchMedia('(pointer: fine)').matches;
}

/**
 * Scene density profile. Phones/tablets get fewer trees, grass tufts and spectators,
 * shorter LOD distances and lighter shadows (faster loading and rendering); desktops get
 * the full scene.
 */
export interface DetailProfile {
  trees: number;
  grass: number;
  crowd: number;
  props: number;
  treeNearDistance: number;
  shadowMapSize: number;
}

let profile: DetailProfile | null = null;
export function detailProfile(): DetailProfile {
  if (!profile) {
    profile = isTouchDevice()
      ? { trees: 0.55, grass: 0.35, crowd: 0.45, props: 0.6, treeNearDistance: 170, shadowMapSize: 1024 }
      : { trees: 1, grass: 1, crowd: 1, props: 1, treeNearDistance: 280, shadowMapSize: 2048 };
  }
  return profile;
}
