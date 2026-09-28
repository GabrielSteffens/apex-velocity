import * as THREE from 'three';
import { GameStateMachine, type GameState } from './GameState';
import { TrackScene } from './TrackScene';
import { RaceSession } from './RaceSession';
import { Renderer } from '../render/Renderer';
import { Environment } from '../render/Environment';
import { PhysicsWorld, loadRapier } from '../physics/PhysicsWorld';
import { ChaseCamera } from '../camera/ChaseCamera';
import { Input } from '../core/Input';
import { Settings, DIFFICULTY_PACE } from '../core/Settings';
import { AudioManager } from '../audio/AudioManager';
import { ParticleManager } from '../effects/ParticleManager';
import { SkidMarks } from '../effects/SkidMarks';
import { windUniform } from '../track/TrackScenery';
import { freezeStatic } from '../render/merge';
import { getTrack } from '../data/tracks';
import { getCar } from '../data/cars';
import { createQuickRace } from '../data/races';
import { h } from '../ui/dom';
import { MainMenu } from '../ui/MainMenu';
import { SettingsPanel } from '../ui/SettingsPanel';
import { PauseMenu } from '../ui/PauseMenu';
import { RaceHUD } from '../ui/RaceHUD';
import { ResultsScreen } from '../ui/ResultsScreen';
import { Countdown, Toast, LoadingScreen } from '../ui/Overlay';
import { clamp } from '../core/math';

const MAX_STEPS_PER_FRAME = 12;

/**
 * Top-level game: owns the renderer, physics, loaded track, current race session, UI
 * screens and the main loop. Game states: MENU → COUNTDOWN → RACING → FINISHED, with
 * PAUSED reachable from COUNTDOWN / RACING.
 */
export class Game {
  readonly state = new GameStateMachine();
  readonly settings = new Settings();
  readonly input = new Input();
  readonly audio = new AudioManager();
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 9000);
  private renderer!: Renderer;
  private env!: Environment;
  private physics!: PhysicsWorld;
  private trackScene!: TrackScene;
  private session: RaceSession | null = null;
  private chase!: ChaseCamera;
  private particles!: ParticleManager;
  private skids = new SkidMarks();
  private accumulator = 0;
  private lastTime = 0;
  private elapsed = 0;
  private trackId = 'sunset-circuit';
  private carId = 'falcon-r';
  /** Debug: simulation speed multiplier (set from the console: game.timeScale = 4). */
  timeScale = 1;

  // UI
  private uiRoot: HTMLElement;
  private loading = new LoadingScreen();
  private menu!: MainMenu;
  private settingsPanel!: SettingsPanel;
  private pause!: PauseMenu;
  private hud!: RaceHUD;
  private results!: ResultsScreen;
  private countdown = new Countdown();
  private toast = new Toast();
  private settingsReturn: 'menu' | 'pause' = 'menu';
  private resultsShown = false;
  private sessionKey = '';
  private lastPreset: unknown = null;

  constructor(private readonly container: HTMLElement, uiContainer: HTMLElement) {
    this.uiRoot = h('div', { class: 'safe' });
    uiContainer.appendChild(this.uiRoot);
    this.uiRoot.append(this.loading.el);
    this.updateUIScale();
    window.addEventListener('resize', () => this.updateUIScale());
    // Coming back to the tab: drop the time that passed while hidden (no physics catch-up burst).
    document.addEventListener('visibilitychange', () => {
      this.accumulator = 0;
      this.lastTime = performance.now();
    });
  }

  private updateUIScale(): void {
    const s = clamp(Math.min(window.innerWidth / 1920, window.innerHeight / 1080), 0.55, 1.6);
    document.documentElement.style.setProperty('--s', s.toFixed(3));
    this.hud?.resize();
    if (this.particles && this.renderer) this.particles.setViewportHeight(window.innerHeight * this.renderer.pixelRatio, this.camera.fov);
  }

  async init(): Promise<void> {
    const progress = (p: number, msg: string) => this.loading.progress(p, msg);
    progress(0.02, 'Starting engines');
    this.renderer = new Renderer(this.container, this.scene, this.camera);
    const R = await loadRapier();
    this.physics = new PhysicsWorld(R);
    const trackDef = getTrack(this.trackId);
    this.env = this.createEnvironment();
    this.trackScene = await TrackScene.create(trackDef, this.physics, progress);
    this.scene.add(this.trackScene.group);
    // Track and scenery never move: compute their matrices once.
    freezeStatic(this.trackScene.group);
    this.chase = new ChaseCamera(this.camera, this.physics, this.trackScene.terrain);
    this.particles = new ParticleManager(this.scene.fog as THREE.Fog);
    this.scene.add(this.particles.group);
    this.scene.add(this.skids.mesh);
    this.buildUI();
    this.applySettings();
    this.settings.onChange(() => this.applySettings());
    progress(0.95, 'Compiling shaders');
    this.newSession();
    this.warmUpGpu();
    progress(1, 'Ready');
    this.state.onChange((to, from) => this.onStateChange(to, from));
    this.state.set('MENU');
    this.loading.el.classList.remove('visible');
    setTimeout(() => this.loading.el.remove(), 600);
    requestAnimationFrame((t) => {
      this.lastTime = t;
      this.loop(t);
    });
  }

  private buildUI(): void {
    const trackDef = getTrack(this.trackId);
    this.menu = new MainMenu(
      this.audio,
      {
        start: () => this.startRace(),
        settings: () => this.openSettings('menu'),
        comingSoon: (f) => this.toast.show('Coming Soon', f),
      },
      getCar(this.carId),
      trackDef,
      this.trackScene.track.length,
    );
    this.settingsPanel = new SettingsPanel(this.settings, this.audio);
    this.settingsPanel.onClose = () => this.closeSettings();
    this.pause = new PauseMenu(this.audio, {
      resume: () => this.state.set(this.state.resumeState),
      restart: () => this.restartRace(),
      settings: () => this.openSettings('pause'),
      quit: () => this.quitToMenu(),
    });
    this.hud = new RaceHUD(this.trackScene.track);
    this.results = new ResultsScreen(this.audio, {
      restart: () => this.restartRace(),
      menu: () => this.quitToMenu(),
    });
    this.uiRoot.append(this.hud.el, this.countdown.el, this.menu.el, this.pause.el, this.results.el, this.settingsPanel.el, this.toast.el);
    this.hud.resize();
  }

  private createEnvironment(): Environment {
    const trackDef = getTrack(this.trackId);
    const preset = trackDef.environments[this.settings.values.timeOfDay];
    this.renderer.renderer.toneMappingExposure = preset.exposure;
    return new Environment(this.scene, this.renderer.renderer, preset, trackDef.terrain.seed);
  }

  /** Applies the time-of-day preset to sky/lights, trackside lamps, headlights and particles. */
  private applyTimeOfDay(): void {
    const preset = getTrack(this.trackId).environments[this.settings.values.timeOfDay];
    if (this.env.preset !== preset) {
      this.env.dispose();
      this.env = this.createEnvironment();
    }
    const night = preset.lightsOn;
    const changed = this.env.preset !== this.lastPreset;
    this.lastPreset = this.env.preset;
    this.trackScene.scenery.setNight(night);
    this.session?.setNight(night);
    this.particles.setLight(preset.particleLight, night);
    if (changed && this.state.state !== 'LOADING') this.warmUpGpu();
  }

  private applySettings(): void {
    const s = this.settings.values;
    this.applyTimeOfDay();
    this.renderer.setQuality(s.quality);
    this.env.setShadowQuality(s.quality === 'low' ? 1024 : 2048);
    this.env.setShadowExtent(s.quality === 'high' ? 80 : 60);
    this.audio.setVolume(s.volume);
    this.hud.showFps = s.showFps;
    if (s.showFps) {
      let objects = 0;
      this.scene.traverse(() => objects++);
      this.hud.debug.objects = objects;
    }
    this.chase.shakeEnabled = s.cameraShake;
    this.updateUIScale();
    // Grid preview reflects the chosen opponent count while in the menu.
    if (this.state.is('MENU') && this.session && this.sessionKey !== this.raceKey()) this.newSession();
  }

  /** Settings that require a new grid when changed. */
  private raceKey(): string {
    const s = this.settings.values;
    return `${s.laps}|${s.opponents}|${s.difficulty}`;
  }

  private newSession(): void {
    this.session?.dispose();
    this.sessionKey = this.raceKey();
    const s = this.settings.values;
    const race = createQuickRace({ trackId: this.trackId, playerCarId: this.carId, laps: s.laps, opponents: s.opponents });
    this.session = new RaceSession(
      {
        scene: this.scene,
        physics: this.physics,
        trackScene: this.trackScene,
        input: this.input,
        audio: this.audio,
        particles: this.particles,
        skids: this.skids,
        camera: this.chase,
      },
      race,
      DIFFICULTY_PACE[s.difficulty],
      {
        countdown: (v) => this.countdown.show(String(v)),
        go: () => {
          this.countdown.show('GO!', true);
          this.state.set('RACING');
          setTimeout(() => this.hud.hideHints(), 6000);
        },
        toast: (t, sub) => this.toast.show(t, sub),
        playerFinished: (pos) => {
          this.toast.show(pos === 1 ? 'Victory!' : 'Finish', `P${pos}`);
          this.state.set('FINISHED');
        },
        raceComplete: () => this.results.update(this.session!.rm),
      },
    );
    this.session.setNight(this.env.isNight);
    if (this.state.state !== 'LOADING') this.warmUpGpu();
    this.hud.resetRows();
    this.accumulator = 0;
    this.chase.snap();
    this.resultsShown = false;
  }

  /**
   * Uploads every geometry, texture and shader to the GPU up front. WebGL otherwise uploads
   * lazily the first time an object becomes visible, which caused 40-130 ms hitches while
   * driving as new scenery came into view.
   */
  private warmUpGpu(): void {
    const r = this.renderer.renderer;
    this.trackScene.scenery.updateCulling(this.camera.position, Infinity);
    const culled: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (o.frustumCulled) {
        o.frustumCulled = false;
        culled.push(o);
      }
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) r.initTexture(v);
        }
      }
    });
    r.compile(this.scene, this.camera);
    // One full render (all objects, shadow pass included) forces every buffer upload.
    this.renderer.render(0, 0);
    for (const o of culled) o.frustumCulled = true;
  }

  private startRace(): void {
    this.audio.unlock();
    this.state.set('COUNTDOWN');
  }

  private restartRace(): void {
    this.newSession();
    this.state.set('MENU');
    this.state.set('COUNTDOWN');
  }

  private quitToMenu(): void {
    this.newSession();
    this.state.set('MENU');
  }

  private openSettings(from: 'menu' | 'pause'): void {
    this.settingsReturn = from;
    this.settingsPanel.el.classList.add('visible');
    if (from === 'pause') this.pause.el.classList.remove('visible');
  }

  private closeSettings(): void {
    this.settingsPanel.el.classList.remove('visible');
    if (this.settingsReturn === 'pause' && this.state.is('PAUSED')) this.pause.el.classList.add('visible');
  }

  private onStateChange(to: GameState, from: GameState): void {
    const show = (el: HTMLElement, on: boolean) => el.classList.toggle('visible', on);
    show(this.menu.el, to === 'MENU');
    show(this.hud.el, to === 'COUNTDOWN' || to === 'RACING' || to === 'FINISHED' || to === 'PAUSED');
    show(this.pause.el, to === 'PAUSED');
    if (to !== 'FINISHED') show(this.results.el, false);
    if (to !== 'PAUSED') this.settingsPanel.el.classList.remove('visible');
    this.audio.setMuted(to === 'PAUSED');
    if (to === 'MENU') {
      this.audio.stopDriving();
      this.countdown.clear();
    }
    if (to === 'COUNTDOWN' && from !== 'PAUSED') {
      this.hud.showHints();
      this.hud.resize();
      this.chase.snap();
      this.session?.startCountdown();
    }
    this.input.clearActions();
  }

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const frameStart = performance.now();
    const frameMs = Math.max(0, now - this.lastTime);
    const dt = Math.min(0.1, frameMs / 1000) * this.timeScale;
    if (!this.state.is('LOADING', 'PAUSED')) this.renderer.adaptResolution(frameMs, dt);
    this.lastTime = now;
    this.elapsed += dt;
    this.input.poll();
    this.handleActions();

    const session = this.session;
    if (!session) return;
    const fixed = this.physics.fixedDt;
    const simulate = this.state.is('MENU', 'COUNTDOWN', 'RACING', 'FINISHED');
    if (simulate) {
      this.accumulator += dt;
      let steps = 0;
      const tPhys = performance.now();
      while (this.accumulator >= fixed && steps < MAX_STEPS_PER_FRAME) {
        session.fixedStep(fixed);
        this.accumulator -= fixed;
        steps++;
      }
      // Couldn't keep up (very slow frame): drop the backlog rather than spiral.
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = Math.min(this.accumulator, fixed);
      this.hud.debug.physicsMs = performance.now() - tPhys;
      this.hud.debug.physicsSteps = steps;
    }
    const alpha = simulate ? this.accumulator / fixed : 1;
    session.frameUpdate(simulate ? dt : 0, alpha);

    const player = session.player;
    if (player) {
      if (this.state.is('MENU')) {
        this.chase.orbit(dt, player.physics.position);
      } else if (!this.state.is('PAUSED')) {
        this.chase.update(dt, player, alpha);
      }
      this.env.update(player.physics.position);
    }
    this.particles.update(simulate ? dt : 0, this.camera);
    const fog = this.scene.fog as THREE.Fog;
    this.trackScene.scenery.updateCulling(this.camera.position, fog.far);
    windUniform.value = this.elapsed;

    if (!this.state.is('MENU', 'LOADING')) this.hud.update(session.rm, dt);
    if (this.state.is('FINISHED')) {
      if (!this.resultsShown && player && this.elapsed > 0) {
        // Give the finish moment a beat before covering the screen with results.
        this.resultsShown = true;
        setTimeout(() => {
          if (this.state.is('FINISHED')) this.results.el.classList.add('visible');
        }, 2500);
      }
      this.results.update(session.rm);
    }

    const speedFx = player && this.chase.mode !== 'hood' && !this.state.is('MENU') ? clamp((player.physics.speed - 28) / 45, 0, 1) * 0.8 : 0;
    this.renderer.render(speedFx, this.elapsed);
    this.hud.renderStats = this.renderer.stats;
    this.hud.debug.frameMs = frameMs;
    this.hud.debug.cpuMs = performance.now() - frameStart;
  };

  private handleActions(): void {
    const st = this.state;
    if (this.input.consume('debug')) this.settings.set('showFps', !this.settings.values.showFps);
    if (st.is('MENU')) {
      if (!this.settingsPanel.el.classList.contains('visible')) this.menu.handleInput(this.input);
      else if (this.input.consume('pause') || this.input.consume('back')) this.closeSettings();
    } else if (st.is('COUNTDOWN', 'RACING')) {
      if (this.input.consume('pause')) st.set('PAUSED');
      if (this.input.consume('reset') && st.is('RACING')) this.session?.rm.resetPlayer();
      if (this.input.consume('camera')) this.chase.cycleMode();
    } else if (st.is('PAUSED')) {
      if (this.settingsPanel.el.classList.contains('visible')) {
        if (this.input.consume('pause') || this.input.consume('back')) this.closeSettings();
      } else {
        if (this.input.consume('pause') || this.input.consume('back')) st.set(st.resumeState);
        this.pause.handleInput(this.input);
      }
    } else if (st.is('FINISHED')) {
      if (this.input.consume('camera')) this.chase.cycleMode();
      if (this.results.el.classList.contains('visible')) this.results.handleInput(this.input);
    }
  }
}
