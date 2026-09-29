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
import { detailProfile, isTouchDevice } from '../core/device';
import { TouchControls } from '../ui/TouchControls';
import { ITEM_ICONS } from '../ui/ArcadeHUD';
import { ITEM_INFO } from '../gameplay/Items';
import { Profile, rollChallenges, raceXp, levelForXp, xpForLevel, type Challenge, type RaceSummary } from './Profile';
import { Garage } from '../ui/Garage';
import { cars } from '../data/cars';

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
  readonly profile = new Profile();
  private carId = this.profile.data.selectedCar;
  private garage!: Garage;
  private challenges: Challenge[] = [];
  private challengeDone: boolean[] = [];
  private raceSeed = Math.floor(Math.random() * 1e6);
  private challengeTimer = 0;
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
  readonly isTouch = isTouchDevice();
  private touch: TouchControls | null = null;
  private resultsShown = false;
  private sessionKey = '';
  private lastPreset: unknown = null;

  constructor(private readonly container: HTMLElement, uiContainer: HTMLElement) {
    this.uiRoot = h('div', { class: 'safe' });
    uiContainer.appendChild(this.uiRoot);
    if (this.isTouch) {
      document.body.classList.add('is-touch');
      this.touch = new TouchControls(this.input);
      uiContainer.appendChild(this.touch.el);
      document.body.appendChild(
        h('div', {
          class: 'rotate-hint',
          html:
            '<svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="18.5" r="1" fill="currentColor"/></svg>Gire o celular<small>O jogo funciona na horizontal</small>',
        }),
      );
      const checkOrientation = () => {
        const portrait = window.innerHeight > window.innerWidth;
        document.body.classList.toggle('portrait', portrait);
        // Turning the phone upright mid-race pauses instead of letting the car crash.
        if (portrait && this.state.is('RACING', 'COUNTDOWN')) this.state.set('PAUSED');
      };
      window.addEventListener('resize', checkOrientation);
      window.addEventListener('orientationchange', checkOrientation);
      checkOrientation();
    }
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
        garage: () => this.openGarage(),
        comingSoon: (f) => this.toast.show('Coming Soon', f),
      },
      getCar(this.carId),
      trackDef,
      this.trackScene.track.length,
    );
    this.settingsPanel = new SettingsPanel(this.settings, this.audio, this.isTouch);
    this.settingsPanel.onClose = () => this.closeSettings();
    this.pause = new PauseMenu(this.audio, {
      resume: () => this.state.set(this.state.resumeState),
      restart: () => this.restartRace(),
      settings: () => this.openSettings('pause'),
      quit: () => this.quitToMenu(),
    });
    this.hud = new RaceHUD(this.trackScene.track, this.isTouch);
    this.hud.arcade.onTick = () => this.audio.rouletteTick();
    this.hud.arcade.onDriftLevel = (l) => {
      this.audio.driftLevel(l);
      this.input.rumble(0.1, 0.4 + l * 0.15, 90);
    };
    this.results = new ResultsScreen(this.audio, {
      restart: () => this.restartRace(),
      menu: () => this.quitToMenu(),
      garage: () => {
        this.quitToMenu();
        this.openGarage();
      },
    });
    this.garage = new Garage(
      this.audio,
      this.profile,
      (car) => {
        this.carId = car.id;
        this.menu.setCar(car);
        this.newSession();
      },
      () => this.menu.el.classList.add('visible'),
    );
    this.refreshProfileUI();
    this.uiRoot.append(this.hud.el, this.countdown.el, this.menu.el, this.pause.el, this.results.el, this.garage.el, this.settingsPanel.el, this.toast.el);
    this.hud.resize();
  }

  private openGarage(): void {
    this.menu.el.classList.remove('visible');
    this.garage.open();
  }

  private refreshProfileUI(): void {
    const xp = this.profile.data.xp;
    const lvl = levelForXp(xp);
    const a = xpForLevel(lvl);
    const b = xpForLevel(lvl + 1);
    const next = cars.filter((c) => c.unlockLevel > lvl).sort((x, y) => x.unlockLevel - y.unlockLevel)[0];
    this.menu.setProfile(lvl, (xp - a) / (b - a), this.profile.data.bestScore[this.trackId] ?? 0, next ? `NEXT UNLOCK: ${next.name.toUpperCase()} AT LEVEL ${next.unlockLevel}` : '');
  }

  private raceSummary(): RaceSummary | null {
    const p = this.session?.player;
    const st = this.session?.style;
    if (!p || !st) return null;
    return { position: p.progress.finishPosition || p.position, finished: p.progress.finished, score: st.score, laps: this.settings.values.laps, stats: st.stats };
  }

  /** Player crossed the line: bank the combo, award XP, update records, fill the results. */
  private finishProgress(): void {
    const style = this.session?.style;
    if (!style) return;
    style.update(0); // count the final lap (clean lap) before banking
    style.finish();
    const r = this.raceSummary()!;
    const prof = this.profile;
    const before = prof.data.xp;
    const levelBefore = levelForXp(before);
    const xp = raceXp(r, this.challenges);
    prof.data.xp += xp.total;
    prof.data.races++;
    if (r.position === 1) prof.data.wins++;
    if (r.position <= 3) prof.data.podiums++;
    const best = prof.data.bestScore[this.trackId] ?? 0;
    const newBest = r.score > best;
    if (newBest) prof.data.bestScore[this.trackId] = r.score;
    const lap = this.session!.player!.progress.bestLapTime;
    if (isFinite(lap) && lap < (prof.data.bestLap[this.trackId] ?? Infinity)) prof.data.bestLap[this.trackId] = lap;
    prof.data.bestCombo = Math.max(prof.data.bestCombo, r.stats.bestCombo);
    prof.data.shortcuts += r.stats.shortcuts;
    prof.data.perfectDrifts += r.stats.perfectDrifts;
    const levelAfter = levelForXp(prof.data.xp);
    const unlocks = prof.takeNewUnlocks();
    prof.save();
    const frac = (x: number, l: number) => (x - xpForLevel(l)) / (xpForLevel(l + 1) - xpForLevel(l));
    this.results.showProgress({
      score: r.score,
      newBest,
      bestCombo: r.stats.bestCombo,
      chips: [
        ['DRIFTS', r.stats.drifts],
        ['PERFECT', r.stats.perfectDrifts],
        ['NEAR MISSES', r.stats.nearMisses],
        ['OVERTAKES', r.stats.overtakes],
        ['SHORTCUTS', r.stats.shortcuts],
        ['ITEM HITS', r.stats.hits],
        ['MAX COMBO', r.stats.bestCombo],
      ],
      challenges: this.challenges.map((c) => ({ text: c.text, done: c.progress(r) >= 1, xp: c.xp })),
      xp,
      levelBefore,
      levelAfter,
      fracBefore: frac(before, levelAfter),
      fracAfter: frac(prof.data.xp, levelAfter),
      unlocks,
    });
    this.refreshProfileUI();
    this.raceSeed++;
  }

  /** Live challenge progress (a banner when one completes mid-race). */
  private updateChallenges(dt: number): void {
    this.challengeTimer -= dt;
    if (this.challengeTimer > 0) return;
    this.challengeTimer = 0.4;
    const r = this.raceSummary();
    if (!r) return;
    const prog = this.challenges.map((c) => c.progress(r));
    prog.forEach((p, i) => {
      if (p >= 1 && !this.challengeDone[i]) {
        this.challengeDone[i] = true;
        // "Finish" challenges complete at the line; the results screen shows them.
        if (!r.finished) {
          this.hud.arcade.showBanner('CHALLENGE COMPLETE', `${this.challenges[i].text} · +${this.challenges[i].xp} XP`, '#7dffb0');
          this.audio.comboBanked(3);
        }
      }
    });
    this.hud.arcade.setChallengeProgress(prog);
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
    void this.touch?.setSteering(s.touchSteering);
    this.renderer.setQuality(s.quality);
    this.env.setShadowQuality(Math.min(detailProfile().shadowMapSize, s.quality === 'low' ? 1024 : 2048));
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
        popup: (p, combo) => this.hud.arcade.popup(p, combo),
        banner: (text, sub, color) => this.hud.arcade.showBanner(text, sub, color),
        playerFinished: (pos) => {
          this.toast.show(pos === 1 ? 'Victory!' : 'Finish', `P${pos}`);
          this.finishProgress();
          this.state.set('FINISHED');
        },
        raceComplete: () => this.results.update(this.session!.rm),
      },
    );
    this.session.setNight(this.env.isNight);
    this.hud.style = this.session.style;
    this.challenges = rollChallenges(this.raceSeed, s.laps);
    this.challengeDone = this.challenges.map(() => false);
    this.hud.arcade.setChallenges(this.challenges.map((c) => ({ text: c.text, xp: c.xp })));
    this.results.clearProgress();
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
    if (!this.env.sceneEnv) {
      const p = this.trackScene.track.offsetPoint(40, 0, new THREE.Vector3());
      p.y += 3;
      this.env.captureScene(p, this.isTouch ? 128 : 256);
    }
    this.session?.setEnvMap(this.env.sceneEnv, this.env.preset.envIntensity);
    this.renderer.render(0, 0);
    for (const o of culled) o.frustumCulled = true;
  }

  /** Phones: go fullscreen and lock landscape (must run from a user gesture). */
  private enterMobileFullscreen(): void {
    if (!this.isTouch) return;
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      const req = el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.();
      Promise.resolve(req)
        .then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.('landscape'))
        .catch(() => {});
    } catch {
      /* not supported (e.g. iPhone Safari): the game still works in the browser UI */
    }
  }

  private startRace(): void {
    this.enterMobileFullscreen();
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
    this.touch?.setVisible(to === 'COUNTDOWN' || to === 'RACING');
    if (to === 'COUNTDOWN' && from !== 'PAUSED') this.touch?.calibrateTilt();
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
    this.trackScene.scenery.update(this.elapsed);
    this.trackScene.features.update(this.elapsed);
    this.env.setTime(this.elapsed);

    if (!this.state.is('MENU', 'LOADING')) this.hud.update(session.rm, dt);
    if (this.state.is('RACING')) this.updateChallenges(dt);
    if (this.touch && player) {
      const st = session.rm.items.get(player);
      const it = st.roulette > 0 ? null : st.slot;
      this.touch.setItem(it ? ITEM_ICONS[it] : null, it ? ITEM_INFO[it].color : '#888');
    }
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

    const boostFx = player && player.physics.boostTime > 0 ? Math.min(1, player.physics.boostTime * 1.5) * 0.5 : 0;
    const speedFx = player && this.chase.mode !== 'hood' && !this.state.is('MENU') ? Math.min(1.2, clamp((player.physics.speed - 28) / 45, 0, 1) * 0.8 + boostFx) : 0;
    this.renderer.render(speedFx, this.elapsed);
    this.hud.renderStats = this.renderer.stats;
    this.hud.debug.frameMs = frameMs;
    this.hud.debug.cpuMs = performance.now() - frameStart;
  };

  private handleActions(): void {
    const st = this.state;
    if (this.input.consume('debug')) this.settings.set('showFps', !this.settings.values.showFps);
    if (st.is('MENU')) {
      if (this.garage.visible) this.garage.handleInput(this.input);
      else if (!this.settingsPanel.el.classList.contains('visible')) this.menu.handleInput(this.input);
      else if (this.input.consume('pause') || this.input.consume('back')) this.closeSettings();
    } else if (st.is('COUNTDOWN', 'RACING')) {
      if (this.input.consume('pause')) st.set('PAUSED');
      if (this.input.consume('reset') && st.is('RACING')) this.session?.rm.resetPlayer();
      if (this.input.consume('item') && st.is('RACING')) this.session?.useItem();
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
