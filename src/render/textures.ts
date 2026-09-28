import * as THREE from 'three';
import { Noise2D, Random } from '../core/math';

/**
 * Procedural textures generated on canvases at load time, so the game ships without any
 * binary assets. Each texture is cached.
 */

const cache = new Map<string, THREE.Texture>();

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return [c, ctx];
}

function finish(c: HTMLCanvasElement, srgb: boolean, repeat = true, anisotropy = 8): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Tileable fractal noise field in 0..1. */
function tileableNoise(size: number, seed: number, scale: number, octaves = 4): Float32Array {
  const n = new Noise2D(seed);
  const out = new Float32Array(size * size);
  // Sample noise on a torus so the result wraps seamlessly.
  const R = scale / (2 * Math.PI);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = (x / size) * Math.PI * 2;
      const b = (y / size) * Math.PI * 2;
      const nx = Math.cos(a) * R;
      const ny = Math.sin(a) * R;
      const nz = Math.cos(b) * R;
      const nw = Math.sin(b) * R;
      // Approximate 4D noise by combining two 2D samples.
      let v = 0;
      let amp = 1;
      let freq = 1;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        v += (n.get(nx * freq + nz * 0.7 * freq, ny * freq + 13.1) * 0.5 + n.get(nz * freq + 31.7, nw * freq + nx * 0.7 * freq) * 0.5) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      out[y * size + x] = v / norm * 0.5 + 0.5;
    }
  }
  return out;
}

/** Converts a height field to a tangent-space normal map canvas. */
function normalFromHeight(h: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export interface PBRSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap?: THREE.Texture;
}

export function asphalt(): PBRSet {
  const key = 'asphalt';
  if (cache.has(key)) return { map: cache.get(key)!, normalMap: cache.get(key + 'n')!, roughnessMap: cache.get(key + 'r')! };
  const size = 1024;
  const rnd = new Random(11);
  const large = tileableNoise(size, 3, 6, 4);
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  // Aggregate grains are ~2-3 texels wide (per-texel noise reads as sandpaper up close).
  const cells = size / 2;
  const grainCells = new Float32Array(cells * cells);
  for (let i = 0; i < grainCells.length; i++) grainCells[i] = rnd.next();
  for (let i = 0; i < size * size; i++) {
    const px = i % size;
    const py = (i / size) | 0;
    const grain = grainCells[(py >> 1) * cells + (px >> 1)] * 0.75 + rnd.next() * 0.25;
    const stone = grain > 0.9 ? (grain - 0.9) * 6 : grain < 0.08 ? -0.4 : 0;
    const base = 60 + (large[i] - 0.5) * 22 + (grain - 0.5) * 9 + stone * 14;
    img.data[i * 4] = base;
    img.data[i * 4 + 1] = base + 1;
    img.data[i * 4 + 2] = base + 4;
    img.data[i * 4 + 3] = 255;
    height[i] = grain * 0.6 + stone * 0.4 + large[i] * 0.3;
    rough[i] = 0.78 + (grain - 0.5) * 0.2 - stone * 0.15 - (large[i] - 0.5) * 0.25;
  }
  ctx.putImageData(img, 0, 0);
  // Subtle cracks / tar seams
  ctx.strokeStyle = 'rgba(15,15,17,0.55)';
  ctx.lineWidth = 1.5;
  for (let k = 0; k < 14; k++) {
    let x = rnd.next() * size;
    let y = rnd.next() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 12; s++) {
      x += rnd.range(-18, 18);
      y += rnd.range(-30, 30);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const map = finish(c, true);
  const normalMap = finish(normalFromHeight(height, size, 3.2), false);
  const [rc, rctx] = canvas(size, size);
  const rimg = rctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(1, rough[i])) * 255;
    rimg.data[i * 4] = v;
    rimg.data[i * 4 + 1] = v;
    rimg.data[i * 4 + 2] = v;
    rimg.data[i * 4 + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);
  const roughnessMap = finish(rc, false);
  cache.set(key, map);
  cache.set(key + 'n', normalMap);
  cache.set(key + 'r', roughnessMap);
  return { map, normalMap, roughnessMap };
}

export function grass(): PBRSet {
  const key = 'grass';
  if (cache.has(key)) return { map: cache.get(key)!, normalMap: cache.get(key + 'n')! };
  const size = 512;
  const rnd = new Random(5);
  const large = tileableNoise(size, 9, 5, 3);
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const g = rnd.next();
    const v = 0.75 + large[i] * 0.35 + (g - 0.5) * 0.35;
    img.data[i * 4] = 150 * v;
    img.data[i * 4 + 1] = 160 * v;
    img.data[i * 4 + 2] = 110 * v;
    img.data[i * 4 + 3] = 255;
    height[i] = g;
  }
  ctx.putImageData(img, 0, 0);
  // Blades
  for (let k = 0; k < 9000; k++) {
    const x = rnd.next() * size;
    const y = rnd.next() * size;
    const l = rnd.range(3, 9);
    const a = rnd.range(-0.5, 0.5) - Math.PI / 2;
    const b = rnd.range(0.7, 1.25);
    ctx.strokeStyle = `rgba(${Math.floor(120 * b)},${Math.floor(150 * b)},${Math.floor(80 * b)},0.5)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  const map = finish(c, true);
  const normalMap = finish(normalFromHeight(height, size, 2.0), false);
  cache.set(key, map);
  cache.set(key + 'n', normalMap);
  return { map, normalMap };
}

/** Red/white curb stripes: V runs along the track. */
export function curb(): THREE.Texture {
  const key = 'curb';
  if (cache.has(key)) return cache.get(key)!;
  const [c, ctx] = canvas(64, 256);
  ctx.fillStyle = '#d42a22';
  ctx.fillRect(0, 0, 64, 128);
  ctx.fillStyle = '#f2f0ea';
  ctx.fillRect(0, 128, 64, 128);
  // Worn edges and grime
  const rnd = new Random(3);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(30,30,30,${rnd.range(0.02, 0.12)})`;
    ctx.fillRect(rnd.next() * 64, rnd.next() * 256, rnd.range(1, 3), rnd.range(1, 4));
  }
  const g = ctx.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.25)');
  g.addColorStop(0.15, 'rgba(0,0,0,0)');
  g.addColorStop(0.85, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 256);
  const t = finish(c, true);
  cache.set(key, t);
  return t;
}

export function checker(cols = 8, rows = 2): THREE.Texture {
  const key = `checker${cols}x${rows}`;
  if (cache.has(key)) return cache.get(key)!;
  const [c, ctx] = canvas(cols * 32, rows * 32);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f4f4f4' : '#141414';
      ctx.fillRect(x * 32, y * 32, 32, 32);
    }
  const t = finish(c, true, false);
  t.magFilter = THREE.NearestFilter;
  cache.set(key, t);
  return t;
}

export function concrete(): PBRSet {
  const key = 'concrete';
  if (cache.has(key)) return { map: cache.get(key)!, normalMap: cache.get(key + 'n')! };
  const size = 256;
  const rnd = new Random(8);
  const large = tileableNoise(size, 4, 4, 3);
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  const h = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const g = rnd.next();
    const v = 190 + (large[i] - 0.5) * 40 + (g - 0.5) * 22;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v - 2;
    img.data[i * 4 + 2] = v - 6;
    img.data[i * 4 + 3] = 255;
    h[i] = g * 0.5 + large[i];
  }
  ctx.putImageData(img, 0, 0);
  // Dirt at the bottom (v near 1 = bottom of the wall in our UV layout)
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, 'rgba(60,45,30,0)');
  grad.addColorStop(0.7, 'rgba(60,45,30,0.05)');
  grad.addColorStop(1, 'rgba(60,45,30,0.45)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const map = finish(c, true);
  const normalMap = finish(normalFromHeight(h, size, 1.5), false);
  cache.set(key, map);
  cache.set(key + 'n', normalMap);
  return { map, normalMap };
}

/** Soft radial blob used for contact shadows and particles. */
export function radialGradient(inner = 'rgba(0,0,0,0.75)', outer = 'rgba(0,0,0,0)'): THREE.Texture {
  const key = `radial${inner}${outer}`;
  if (cache.has(key)) return cache.get(key)!;
  const [c, ctx] = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = finish(c, true, false);
  cache.set(key, t);
  return t;
}

/** Soft puffy smoke sprite (white, alpha in the alpha channel). */
export function smokeSprite(): THREE.Texture {
  const key = 'smoke';
  if (cache.has(key)) return cache.get(key)!;
  const size = 128;
  const [c, ctx] = canvas(size, size);
  const rnd = new Random(21);
  for (let i = 0; i < 26; i++) {
    const x = size / 2 + rnd.range(-22, 22);
    const y = size / 2 + rnd.range(-22, 22);
    const r = rnd.range(18, 40);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const t = finish(c, true, false);
  cache.set(key, t);
  return t;
}

export interface SignSpec {
  text: string;
  sub?: string;
  bg: string;
  fg: string;
  accent?: string;
  w?: number;
  h?: number;
  italic?: boolean;
}

/** Billboard / sponsor / trackside sign texture. */
export function signTexture(spec: SignSpec): THREE.Texture {
  const key = `sign:${JSON.stringify(spec)}`;
  if (cache.has(key)) return cache.get(key)!;
  const w = spec.w ?? 512;
  const h = spec.h ?? 128;
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = spec.bg;
  ctx.fillRect(0, 0, w, h);
  if (spec.accent) {
    ctx.fillStyle = spec.accent;
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w * 0.18, 0);
    ctx.lineTo(w * 0.24, 0);
    ctx.lineTo(w * 0.06, h);
    ctx.fill();
    ctx.fillRect(0, h - h * 0.08, w, h * 0.08);
  }
  ctx.fillStyle = spec.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fontSize = spec.sub ? h * 0.5 : h * 0.62;
  ctx.font = `${spec.italic === false ? '' : 'italic '}900 ${fontSize}px "Rajdhani", "Arial Black", Impact, sans-serif`;
  const cy = spec.sub ? h * 0.42 : h * 0.52;
  ctx.fillText(spec.text, w / 2 + (spec.accent ? w * 0.06 : 0), cy, w * 0.86);
  if (spec.sub) {
    ctx.font = `700 ${h * 0.2}px "Rajdhani", Arial, sans-serif`;
    ctx.fillText(spec.sub, w / 2 + (spec.accent ? w * 0.06 : 0), h * 0.8, w * 0.86);
  }
  const t = finish(c, true, false);
  cache.set(key, t);
  return t;
}

/** Corner chevron board (arrows pointing in `dir`). */
export function chevronTexture(dir: 1 | -1): THREE.Texture {
  const key = `chevron${dir}`;
  if (cache.has(key)) return cache.get(key)!;
  const [c, ctx] = canvas(256, 128);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#ffd21f';
  for (let i = 0; i < 3; i++) {
    const x0 = 40 + i * 70;
    ctx.beginPath();
    if (dir === 1) {
      ctx.moveTo(x0, 14);
      ctx.lineTo(x0 + 34, 14);
      ctx.lineTo(x0 + 70, 64);
      ctx.lineTo(x0 + 34, 114);
      ctx.lineTo(x0, 114);
      ctx.lineTo(x0 + 36, 64);
    } else {
      const xr = 256 - x0;
      ctx.moveTo(xr, 14);
      ctx.lineTo(xr - 34, 14);
      ctx.lineTo(xr - 70, 64);
      ctx.lineTo(xr - 34, 114);
      ctx.lineTo(xr, 114);
      ctx.lineTo(xr - 36, 64);
    }
    ctx.fill();
  }
  const t = finish(c, true, false);
  cache.set(key, t);
  return t;
}

/** Brake marker boards: "300", "200", "100". */
export function distanceBoard(meters: number): THREE.Texture {
  const key = `dist${meters}`;
  if (cache.has(key)) return cache.get(key)!;
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#d0261d';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, 118, 118);
  ctx.fillStyle = '#111';
  ctx.font = '900 56px "Rajdhani", "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(meters), 64, 68);
  const t = finish(c, true, false);
  cache.set(key, t);
  return t;
}

/** Door number roundel for car liveries. */
export function numberDecal(num: number, color: string): THREE.Texture {
  const key = `num${num}${color}`;
  if (cache.has(key)) return cache.get(key)!;
  const [c, ctx] = canvas(256, 256);
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = '#f7f7f7';
  ctx.beginPath();
  ctx.arc(128, 128, 110, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 12;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.font = 'italic 900 150px "Rajdhani", "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), 128, 138);
  const t = finish(c, true, false);
  cache.set(key, t);
  return t;
}

/** Grandstand crowd: a noisy field of colourful dots. */
export function crowdTexture(): THREE.Texture {
  const key = 'crowd';
  if (cache.has(key)) return cache.get(key)!;
  const [c, ctx] = canvas(512, 256);
  ctx.fillStyle = '#2a2a33';
  ctx.fillRect(0, 0, 512, 256);
  const rnd = new Random(77);
  const palette = ['#e8c4a0', '#c98d63', '#8a5a3c', '#f2d5b5', '#d93b3b', '#3b6fd9', '#f2f2f2', '#f2c230', '#2fb36b', '#111'];
  for (let row = 0; row < 16; row++) {
    for (let i = 0; i < 64; i++) {
      const x = i * 8 + rnd.range(0, 3);
      const y = row * 16 + rnd.range(0, 4);
      ctx.fillStyle = rnd.pick(palette);
      ctx.fillRect(x, y + 6, 6, 8);
      ctx.fillStyle = rnd.pick(palette.slice(0, 4));
      ctx.beginPath();
      ctx.arc(x + 3, y + 4, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const t = finish(c, true);
  cache.set(key, t);
  return t;
}

/** Windows grid for pit buildings. */
export function buildingFacade(): THREE.Texture {
  const key = 'facade';
  if (cache.has(key)) return cache.get(key)!;
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#d9d6cf';
  ctx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const g = ctx.createLinearGradient(0, y * 64 + 10, 0, y * 64 + 50);
      g.addColorStop(0, '#2c3c4f');
      g.addColorStop(1, '#6f8aa5');
      ctx.fillStyle = g;
      ctx.fillRect(x * 64 + 6, y * 64 + 10, 52, 40);
    }
  }
  const t = finish(c, true);
  cache.set(key, t);
  return t;
}
