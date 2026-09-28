import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { GpuTimer } from './GpuTimer';

export type Quality = 'low' | 'medium' | 'high';

/** Final pass: vignette, gentle grade and a speed-dependent radial blur at the screen edges. */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSpeed: { value: 0 },
    uVignette: { value: 0.32 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSpeed;
    uniform float uVignette;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float edge = smoothstep(0.12, 0.75, length(c * vec2(1.3, 1.0)));
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      float blur = uSpeed * edge;
      if (blur > 0.002) {
        vec3 acc = col;
        for (int i = 1; i < 7; i++) {
          float f = float(i) / 6.0;
          acc += texture2D(tDiffuse, vUv - c * blur * 0.07 * f).rgb;
        }
        col = acc / 7.0;
      }
      // Grade: slight warm lift in the highlights, contrast.
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.18);
      col *= vec3(1.02, 1.0, 0.97);
      float vig = 1.0 - uVignette * pow(length(c) * 1.35, 2.2);
      col *= vig;
      // Film grain (tiny) to break banding.
      float n = fract(sin(dot(vUv * (uTime + 1.0), vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * 0.012;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/**
 * Wraps the WebGL renderer, the post-processing chain and resize handling.
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly bloom: UnrealBloomPass;
  readonly finalPass: ShaderPass;
  readonly fxaa: ShaderPass;
  private quality: Quality = 'high';
  /** Dynamic resolution multiplier (0.55..1), driven by measured frame time. */
  private renderScale = 1;
  private slowTime = 0;
  private fastTime = 0;
  private gpuAvg = NaN;
  private missed = 0;
  private upscaleLock = 0;
  private lastDownscaleAt = -1e9;
  private clock = 0;
  readonly gpuTimer: GpuTimer;
  private width = 1;
  private height = 1;

  constructor(
    readonly container: HTMLElement,
    readonly scene: THREE.Scene,
    public camera: THREE.PerspectiveCamera,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.6;
    this.renderer.shadowMap.enabled = true;
    // Reset per frame manually so stats include every post-processing pass.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('game-canvas');

    // No MSAA: a multisampled HDR target cost ~20 ms/frame on integrated GPUs. FXAA below
    // gives clean edges for ~1 ms instead.
    this.gpuTimer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext);
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.5, 2.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.finalPass = new ShaderPass(FinalShader);
    this.composer.addPass(this.finalPass);
    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.bloom.enabled = q !== 'low';
    this.fxaa.enabled = q !== 'low';
    this.resize();
  }

  getQuality(): Quality {
    return this.quality;
  }

  get pixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    const base = this.quality === 'high' ? Math.min(dpr, 1.5) : this.quality === 'medium' ? Math.min(dpr, 1) : Math.min(dpr, 0.75);
    return base * this.renderScale;
  }

  resize(): void {
    this.width = this.container.clientWidth || window.innerWidth;
    this.height = this.container.clientHeight || window.innerHeight;
    const pr = this.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this.width, this.height);
    // Bloom at reduced resolution is plenty and much cheaper.
    this.bloom.setSize((this.width * pr) / 2, (this.height * pr) / 2);
    this.fxaa.material.uniforms.resolution.value.set(1 / (this.width * pr), 1 / (this.height * pr));
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Dynamic resolution: lowers the internal resolution when frames take too long and
   * raises it again when there is headroom, so weak GPUs stay smooth instead of stuttering.
   */
  adaptResolution(frameMs: number, dt: number): void {
    this.clock += dt;
    // Ignore huge spikes (tab switches, loading) so they don't skew the averages.
    if (frameMs > 100) return;
    let tooSlow: boolean;
    let headroom: boolean;
    let ideal = this.renderScale;
    const gpu = this.gpuTimer.lastMs;
    if (this.gpuTimer.available && isFinite(gpu)) {
      // Keep GPU time around 13.5 ms so every frame makes a 60 Hz refresh with margin;
      // a frame that misses the 16.7 ms deadline is shown twice, which reads as a stutter.
      this.gpuAvg = isFinite(this.gpuAvg) ? this.gpuAvg + (gpu - this.gpuAvg) * 0.05 : gpu;
      tooSlow = this.gpuAvg > 15;
      headroom = this.gpuAvg < 10.5;
      // Cost scales with pixel count = scale^2.
      ideal = this.renderScale * Math.sqrt(13.5 / Math.max(1, this.gpuAvg));
    } else {
      // Fallback: count frames that missed a 60 Hz refresh.
      this.missed += ((frameMs > 20 ? 1 : 0) - this.missed) * 0.03;
      tooSlow = this.missed > 0.08;
      headroom = this.missed < 0.005 && frameMs < 17.5;
      ideal = tooSlow ? this.renderScale - 0.1 : this.renderScale + 0.05;
    }
    if (tooSlow) {
      this.slowTime += dt;
      this.fastTime = 0;
    } else if (headroom && this.renderScale < 1) {
      this.fastTime += dt;
      this.slowTime = 0;
    } else {
      this.slowTime = Math.max(0, this.slowTime - dt);
      this.fastTime = Math.max(0, this.fastTime - dt);
    }
    let next = this.renderScale;
    // Each change reallocates render targets (a small hitch), so act on sustained trends only.
    if (this.slowTime > 1.2) next = Math.max(0.5, Math.min(this.renderScale - 0.05, ideal));
    else if (this.fastTime > 5 && this.clock > this.upscaleLock) next = Math.min(1, Math.max(this.renderScale + 0.05, Math.min(ideal, this.renderScale + 0.15)));
    next = Math.round(next * 20) / 20;
    if (next !== this.renderScale) {
      if (next < this.renderScale) {
        // Upscaled and immediately had to come back down: stop oscillating for a while.
        if (this.clock - this.lastDownscaleAt < 20) this.upscaleLock = this.clock + 25;
        this.lastDownscaleAt = this.clock;
      }
      this.renderScale = next;
      this.slowTime = 0;
      this.fastTime = 0;
      this.missed = 0;
      this.resize();
    }
  }

  get resolutionScale(): number {
    return this.renderScale;
  }

  get aspect(): number {
    return this.width / this.height;
  }

  render(speedFactor: number, time: number): void {
    this.finalPass.uniforms.uSpeed.value = speedFactor;
    this.finalPass.uniforms.uTime.value = time % 100;
    this.renderer.info.reset();
    this.gpuTimer.begin();
    this.composer.render();
    this.gpuTimer.end();
  }

  get stats(): { calls: number; triangles: number; scale: number; gpuMs: number } {
    return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, scale: this.renderScale, gpuMs: this.gpuAvg };
  }
}
