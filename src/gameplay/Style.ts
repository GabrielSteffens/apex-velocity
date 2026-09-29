import * as THREE from 'three';
import type { Car } from '../car/Car';
import type { RaceManager } from '../game/RaceManager';

export type PopupTier = 'small' | 'good' | 'great' | 'epic';

export interface StylePopup {
  text: string;
  points: number;
  tier: PopupTier;
}

export interface StyleStats {
  drifts: number;
  perfectDrifts: number;
  nearMisses: number;
  overtakes: number;
  multiOvertakes: number;
  jumps: number;
  bestAir: number;
  shortcuts: number;
  hits: number;
  blocks: number;
  pads: number;
  cleanLaps: number;
  bestCombo: number;
  crashes: number;
}

const COMBO_WINDOW = 4.5;
const _inv = new THREE.Quaternion();
const _rel = new THREE.Vector3();

/**
 * Style score for the player: everything spectacular or risky (drifts, near misses,
 * overtakes, air, shortcuts, item hits, clean laps) scores points and extends a combo.
 * The combo multiplier is banked when the chain runs out — and lost on a crash.
 */
export class StyleTracker {
  score = 0;
  /** Events in the current chain. */
  combo = 0;
  /** Points collected during the current chain (the multiplier applies to these). */
  private pot = 0;
  comboTimer = 0;
  readonly stats: StyleStats = {
    drifts: 0,
    perfectDrifts: 0,
    nearMisses: 0,
    overtakes: 0,
    multiOvertakes: 0,
    jumps: 0,
    bestAir: 0,
    shortcuts: 0,
    hits: 0,
    blocks: 0,
    pads: 0,
    cleanLaps: 0,
    bestCombo: 0,
    crashes: 0,
  };
  onPopup: (p: StylePopup) => void = () => {};
  onComboBanked: (mult: number, bonus: number) => void = () => {};
  onComboLost: () => void = () => {};

  private lastPosition = 0;
  private recentOvertakes: number[] = [];
  private time = 0;
  private lastContact = new Map<Car, number>();
  private nearMissAt = new Map<Car, number>();
  private alongside = new Map<Car, number>();
  private lapWallHits = 0;
  private lastLap = -1;

  constructor(
    private readonly player: Car,
    private readonly rm: RaceManager,
  ) {}

  get multiplier(): number {
    return Math.min(5, 1 + 0.5 * Math.max(0, this.combo - 1));
  }

  add(text: string, points: number, tier: PopupTier = 'good'): void {
    if (this.player.progress.finished) return;
    this.combo++;
    this.pot += points;
    this.score += points;
    this.comboTimer = COMBO_WINDOW;
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.combo);
    this.onPopup({ text, points, tier });
  }

  /** A hard crash (big wall hit, spin-out) breaks the chain: the multiplier bonus is lost. */
  crash(): void {
    this.stats.crashes++;
    this.lapWallHits++;
    if (this.combo >= 2) this.onComboLost();
    this.combo = 0;
    this.pot = 0;
    this.comboTimer = 0;
  }

  /** Any contact with another car (cancels a near miss with it). */
  contact(other: Car | null): void {
    if (other) this.lastContact.set(other, this.time);
    else this.lapWallHits++;
  }

  private bank(): void {
    const mult = this.multiplier;
    if (this.combo >= 2) {
      const bonus = Math.round(this.pot * (mult - 1));
      this.score += bonus;
      this.onComboBanked(mult, bonus);
    }
    this.combo = 0;
    this.pot = 0;
  }

  update(dt: number): void {
    this.time += dt;
    const p = this.player;
    const racing = this.rm.phase === 'racing';
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.bank();
    }
    // Clean laps (no wall hits and no crashes) — checked before the finish cut-off so the
    // final lap counts too.
    const lap = p.progress.lapsCompleted;
    if (lap !== this.lastLap) {
      if (this.lastLap >= 0 && lap > this.lastLap && this.lapWallHits === 0) {
        this.stats.cleanLaps++;
        if (p.progress.finished) this.score += 500;
        else this.add('CLEAN LAP', 500, 'great');
      }
      this.lastLap = lap;
      this.lapWallHits = 0;
    }
    if (!racing || p.progress.finished) {
      this.lastPosition = p.position;
      return;
    }
    const ph = p.physics;

    // Drifts
    const rel = ph.driftReleased;
    if (rel) {
      ph.driftReleased = null;
      if (rel.time > 0.6) {
        this.stats.drifts++;
        const base = Math.round(rel.time * 90);
        if (rel.level === 3) {
          this.stats.perfectDrifts++;
          this.add('PERFECT DRIFT', base + 600, 'epic');
        } else if (rel.level === 2) this.add('GREAT DRIFT', base + 300, 'great');
        else if (rel.level === 1) this.add('DRIFT', base + 100, 'good');
        else this.add('DRIFT', base, 'small');
      }
    }
    // Jumps
    if (ph.landed > 0) {
      const air = ph.landed;
      ph.landed = 0;
      if (air > 0.35) {
        this.stats.jumps++;
        this.stats.bestAir = Math.max(this.stats.bestAir, air);
        if (air > 0.9) this.add(`BIG AIR ${air.toFixed(1)}s`, Math.round(250 + air * 500), 'great');
        else this.add(`AIR ${air.toFixed(1)}s`, Math.round(120 + air * 300), 'good');
      }
    }
    // Overtakes (positions gained); several in a short window = multi overtake.
    if (this.lastPosition && p.position < this.lastPosition) {
      const gained = this.lastPosition - p.position;
      for (let i = 0; i < gained; i++) {
        this.stats.overtakes++;
        this.recentOvertakes.push(this.time);
      }
      this.recentOvertakes = this.recentOvertakes.filter((t) => this.time - t < 3.5);
      const n = this.recentOvertakes.length;
      if (n >= 2) {
        this.stats.multiOvertakes++;
        this.add(`MULTI OVERTAKE x${n}`, 300 * gained + 250 * n, 'epic');
      } else this.add('OVERTAKE', 300 * gained, 'good');
    }
    this.lastPosition = p.position;

    // Near misses: another car sweeps past within a hand's width at a good speed difference.
    _inv.copy(ph.quaternion).invert();
    for (const o of this.rm.cars) {
      if (o === p) continue;
      _rel.copy(o.physics.position).sub(ph.position).applyQuaternion(_inv);
      const lat = Math.abs(_rel.x);
      const lon = _rel.z;
      const close = Math.abs(lon) < 3.2 && lat > 1.7 && lat < 3.2;
      if (close) this.alongside.set(o, this.time);
      const wasAlongside = this.time - (this.alongside.get(o) ?? -9) < 0.05;
      const relSpeed = Math.abs(ph.forwardSpeed - o.physics.forwardSpeed);
      if (
        close &&
        wasAlongside &&
        relSpeed > 5 &&
        ph.speed > 20 &&
        this.time - (this.lastContact.get(o) ?? -9) > 1.5 &&
        this.time - (this.nearMissAt.get(o) ?? -9) > 4
      ) {
        this.nearMissAt.set(o, this.time);
        this.stats.nearMisses++;
        this.add('NEAR MISS', 250, 'good');
      }
    }

  }

  /** Banks any open combo (race end). */
  finish(): void {
    if (this.combo > 0) this.bank();
  }
}
