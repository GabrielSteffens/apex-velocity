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
