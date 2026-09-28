import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

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
  private frameTimeAvg = 16.7;
  private scaleCooldown = 2;
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
    // Ignore huge spikes (tab switches, loading) so they don't skew the average.
    if (frameMs > 100) return;
    this.frameTimeAvg += (frameMs - this.frameTimeAvg) * 0.05;
    this.scaleCooldown -= dt;
    if (this.scaleCooldown > 0) return;
    let next = this.renderScale;
    if (this.frameTimeAvg > 19) next = Math.max(0.55, this.renderScale - 0.1);
    else if (this.frameTimeAvg < 17.5 && this.renderScale < 1) next = Math.min(1, this.renderScale + 0.05);
    if (next !== this.renderScale) {
      this.renderScale = next;
      this.resize();
      this.scaleCooldown = 2.5;
    } else {
      this.scaleCooldown = 0.5;
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
    this.composer.render();
  }

  get stats(): { calls: number; triangles: number; scale: number } {
    return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, scale: this.renderScale };
  }
}
