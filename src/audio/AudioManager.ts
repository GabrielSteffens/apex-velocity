/**
 * Procedural audio built on WebAudio: synthesized engines, tyre squeal, wind, rumble,
 * impacts and UI sounds. No audio files are required; every method is a safe no-op if
 * WebAudio is unavailable or the context has not been unlocked by a user gesture yet.
 * Recorded samples can be layered in later by extending the voice classes.
 */

class EngineVoice {
  private oscA: OscillatorNode;
  private oscB: OscillatorNode;
  private oscC: OscillatorNode;
  private filter: BiquadFilterNode;
  private out: GainNode;
  private panner: StereoPannerNode;
  private noiseGain: GainNode;
  private noiseFilter: BiquadFilterNode;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    noiseBuffer: AudioBuffer,
  ) {
    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscB = ctx.createOscillator();
    this.oscB.type = 'square';
    this.oscC = ctx.createOscillator();
    this.oscC.type = 'sawtooth';
    this.oscC.detune.value = 9;
    const gA = ctx.createGain();
    gA.gain.value = 0.5;
    const gB = ctx.createGain();
    gB.gain.value = 0.35;
    const gC = ctx.createGain();
    gC.gain.value = 0.18;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 2.5;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.oscA.connect(gA).connect(shaper);
    this.oscB.connect(gB).connect(shaper);
    this.oscC.connect(gC).connect(shaper);
    shaper.connect(this.filter).connect(this.out).connect(this.panner).connect(dest);
    // Intake / exhaust roar
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.Q.value = 0.8;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.panner);
    this.oscA.start();
    this.oscB.start();
    this.oscC.start();
    noise.start();
  }

  set(rpm: number, load: number, volume: number, pan = 0): void {
    const t = this.ctx.currentTime;
    const f = (rpm / 60) * 2; // 4-stroke V-engine firing-ish frequency
    this.oscA.frequency.setTargetAtTime(f, t, 0.03);
    this.oscB.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    this.oscC.frequency.setTargetAtTime(f * 2.01, t, 0.03);
    const rn = Math.min(1, rpm / 8500);
    this.filter.frequency.setTargetAtTime(350 + load * 1800 + rn * 2200, t, 0.05);
    this.out.gain.setTargetAtTime(volume * (0.16 + load * 0.14 + rn * 0.06), t, 0.05);
    this.noiseFilter.frequency.setTargetAtTime(400 + rn * 1600, t, 0.05);
    this.noiseGain.gain.setTargetAtTime(volume * load * (0.03 + rn * 0.07), t, 0.05);
    this.panner.pan.setTargetAtTime(pan, t, 0.05);
  }
}

class LoopNoise {
  private gain: GainNode;
  private filter: BiquadFilterNode;
  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    buffer: AudioBuffer,
    type: BiquadFilterType,
    freq: number,
    q: number,
  ) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = type;
    this.filter.frequency.value = freq;
    this.filter.Q.value = q;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    src.connect(this.filter).connect(this.gain).connect(dest);
    src.start(0, Math.random() * 2);
  }
  set(volume: number, freq?: number): void {
    const t = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(volume, t, 0.06);
    if (freq !== undefined) this.filter.frequency.setTargetAtTime(freq, t, 0.08);
  }
}

export interface EngineParams {
  rpm: number;
  load: number;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: EngineVoice | null = null;
  private others: EngineVoice[] = [];
  private skid: LoopNoise | null = null;
  private wind: LoopNoise | null = null;
  private rumble: LoopNoise | null = null;
  private volume = 0.8;
  private muted = false;
  private lastImpact = 0;

  /** Must be called from a user gesture (click / key) to unlock audio. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.master.connect(comp).connect(this.ctx.destination);
        this.sfx = this.ctx.createGain();
        this.sfx.connect(this.master);
        this.noise = this.makeNoise(3);
        this.engine = new EngineVoice(this.ctx, this.master, this.noise);
        for (let i = 0; i < 2; i++) this.others.push(new EngineVoice(this.ctx, this.master, this.noise));
        this.skid = new LoopNoise(this.ctx, this.sfx, this.noise, 'bandpass', 1300, 3);
        this.wind = new LoopNoise(this.ctx, this.sfx, this.noise, 'lowpass', 500, 0.5);
        this.rumble = new LoopNoise(this.ctx, this.sfx, this.noise, 'lowpass', 140, 1.5);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch (e) {
      console.warn('Audio unavailable', e);
      this.ctx = null;
    }
  }

  get ready(): boolean {
    return !!this.ctx;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  /** Silence the continuous sounds (pause / menu). */
  setMuted(m: boolean): void {
    this.muted = m;
    this.setVolume(this.volume);
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b = 0.97 * b + 0.03 * w; // mix of white and brown noise
      d[i] = w * 0.5 + b * 3;
    }
    return buf;
  }

  /** Per-frame update of continuous sounds. */
  updateDriving(p: {
    rpm: number;
    load: number;
    speed: number;
    skid: number;
    rough: number;
    others: { rpm: number; load: number; distance: number; pan: number }[];
    active: boolean;
  }): void {
    if (!this.ctx) return;
    const on = p.active ? 1 : 0;
    this.engine?.set(p.rpm, p.load, 0.9 * on);
    this.others.forEach((v, i) => {
      const o = p.others[i];
      if (!o) return v.set(900, 0, 0);
      const att = Math.max(0, 1 - o.distance / 70);
      v.set(o.rpm, o.load, 0.5 * att * att * on, o.pan);
    });
    this.skid?.set(Math.min(0.28, p.skid * 0.3) * on, 900 + Math.min(1, p.speed / 40) * 700);
    const sp = Math.min(1, p.speed / 75);
    this.wind?.set(sp * sp * 0.22 * on, 300 + sp * 1400);
    this.rumble?.set(Math.min(0.5, p.rough * Math.min(1, p.speed / 20)) * 0.6 * on, 90 + p.rough * 80);
  }

  stopDriving(): void {
    this.updateDriving({ rpm: 900, load: 0, speed: 0, skid: 0, rough: 0, others: [], active: false });
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0, slideTo?: number): void {
    if (!this.ctx || !this.sfx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private burst(dur: number, vol: number, freq: number, type: BiquadFilterType = 'lowpass'): void {
    if (!this.ctx || !this.sfx || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.25), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
  }

  impact(strength: number, metallic: boolean): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastImpact < 0.08) return;
    this.lastImpact = now;
    const s = Math.min(1, strength);
    this.burst(0.25 + s * 0.35, 0.25 + s * 0.6, 1800 + s * 2500);
    this.tone(70 + Math.random() * 20, 0.3, 'sine', 0.35 * s + 0.1, 0, 40);
    if (metallic) {
      this.tone(900 + Math.random() * 400, 0.25, 'triangle', 0.05 * s + 0.02, 0.01, 500);
      this.burst(0.35, 0.12 * s, 3500, 'bandpass');
    }
  }

  countdownBeep(final: boolean): void {
    this.tone(final ? 880 : 440, final ? 0.7 : 0.28, 'sine', 0.35);
    this.tone(final ? 1760 : 880, final ? 0.5 : 0.2, 'sine', 0.08);
  }

  uiHover(): void {
    this.tone(1400, 0.05, 'sine', 0.05);
  }

  uiClick(): void {
    this.tone(700, 0.08, 'triangle', 0.12);
    this.tone(1050, 0.12, 'triangle', 0.1, 0.05);
  }

  lap(): void {
    this.tone(988, 0.15, 'triangle', 0.15);
    this.tone(1318, 0.3, 'triangle', 0.15, 0.12);
  }

  finish(win: boolean): void {
    const notes = win ? [523, 659, 784, 1047, 1319] : [523, 659, 784, 988];
    notes.forEach((n, i) => this.tone(n, 0.5, 'triangle', 0.16, i * 0.13));
    notes.forEach((n, i) => this.tone(n / 2, 0.5, 'sine', 0.1, i * 0.13));
  }

  backfire(): void {
    this.burst(0.08, 0.25, 700);
  }

  // ---------- Arcade feedback ----------

  /** Boost ignition: rising turbine whoosh (stronger for bigger boosts). */
  boost(strength = 1): void {
    this.burst(0.5 + strength * 0.3, 0.22 + strength * 0.15, 3200, 'highpass');
    this.tone(180, 0.6, 'sawtooth', 0.05 * strength + 0.03, 0, 520);
    this.tone(360, 0.5, 'triangle', 0.05, 0.02, 1100);
  }

  /** Drift charge reached a new level: bright ping, higher for each level. */
  driftLevel(level: number): void {
    const f = [0, 880, 1175, 1568][level] ?? 1568;
    this.tone(f, 0.18, 'square', 0.05);
    this.tone(f * 1.5, 0.22, 'sine', 0.06, 0.04);
  }

  itemPickup(): void {
    [660, 880, 1320].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.08, i * 0.05));
  }

  rouletteTick(): void {
    this.tone(1200 + Math.random() * 300, 0.03, 'square', 0.025);
  }

  itemReady(): void {
    this.tone(1046, 0.12, 'triangle', 0.1);
    this.tone(1568, 0.25, 'triangle', 0.1, 0.07);
  }

  missile(): void {
    this.burst(0.7, 0.3, 2400, 'bandpass');
    this.tone(300, 0.6, 'sawtooth', 0.05, 0, 900);
  }

  explosion(strength = 1): void {
    this.burst(0.9, 0.55 * strength + 0.1, 900);
    this.tone(55, 0.7, 'sine', 0.45 * strength + 0.1, 0, 30);
    this.burst(0.3, 0.2 * strength, 4000, 'highpass');
  }

  shield(): void {
    [523, 659, 784].forEach((f) => this.tone(f, 0.5, 'sine', 0.06));
    this.tone(1568, 0.3, 'triangle', 0.04, 0.05, 2093);
  }

  shieldBlock(): void {
    this.tone(1318, 0.25, 'triangle', 0.12, 0, 660);
    this.burst(0.2, 0.15, 5000, 'highpass');
  }

  emp(): void {
    this.tone(1800, 0.5, 'sawtooth', 0.07, 0, 90);
    this.tone(90, 0.4, 'square', 0.05, 0.05, 60);
    this.burst(0.4, 0.2, 6000, 'bandpass');
  }

  oil(): void {
    this.burst(0.25, 0.25, 400);
    this.tone(160, 0.2, 'sine', 0.1, 0, 90);
  }

  overdrive(): void {
    this.tone(110, 0.9, 'sawtooth', 0.07, 0, 330);
    this.tone(220, 0.9, 'square', 0.04, 0.05, 660);
  }

  /** Style popup; pitch climbs with the combo. */
  popup(tier: 'small' | 'good' | 'great' | 'epic', combo: number): void {
    const base = 660 * Math.pow(2, Math.min(12, combo) / 12);
    const vol = tier === 'epic' ? 0.12 : tier === 'great' ? 0.1 : 0.07;
    this.tone(base, 0.12, 'triangle', vol);
    if (tier === 'great' || tier === 'epic') this.tone(base * 1.5, 0.2, 'triangle', vol * 0.8, 0.06);
    if (tier === 'epic') this.tone(base * 2, 0.3, 'sine', vol * 0.7, 0.12);
  }

  comboBanked(mult: number): void {
    const n = Math.min(6, Math.round(mult * 1.5));
    for (let i = 0; i < n; i++) this.tone(523 * Math.pow(2, i / 5), 0.15, 'triangle', 0.08, i * 0.05);
  }

  comboLost(): void {
    this.tone(440, 0.3, 'sawtooth', 0.06, 0, 110);
  }

  nearMiss(): void {
    this.burst(0.35, 0.22, 1600, 'bandpass');
  }

  landing(strength: number): void {
    this.burst(0.2, 0.2 + strength * 0.25, 500);
    this.tone(70, 0.25, 'sine', 0.2 + strength * 0.2, 0, 45);
  }
}
