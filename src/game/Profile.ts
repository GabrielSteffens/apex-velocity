import { cars } from '../data/cars';
import type { StyleStats } from '../gameplay/Style';
import { Random } from '../core/math';

/** XP needed to reach each level (index = level - 1). Beyond the table: +14000 per level. */
const LEVEL_XP = [0, 1500, 4000, 7500, 12000, 17500, 24000, 32000, 41000, 51000];

export function xpForLevel(level: number): number {
  if (level <= LEVEL_XP.length) return LEVEL_XP[level - 1];
  return LEVEL_XP[LEVEL_XP.length - 1] + (level - LEVEL_XP.length) * 14000;
}

export function levelForXp(xp: number): number {
  let l = 1;
  while (xp >= xpForLevel(l + 1)) l++;
  return l;
}

export interface ProfileData {
  xp: number;
  races: number;
  wins: number;
  podiums: number;
  bestScore: Record<string, number>;
  bestLap: Record<string, number>;
  bestCombo: number;
  shortcuts: number;
  perfectDrifts: number;
  selectedCar: string;
  /** Cars the player has seen the unlock message for. */
  seenUnlocks: string[];
}

const KEY = 'apex-velocity.profile.v1';

/**
 * Persistent player progression: XP and level (which unlock cars), personal bests and
 * lifetime counters. Stored in localStorage; the game still works without it.
 */
export class Profile {
  data: ProfileData;

  constructor() {
    const defaults: ProfileData = {
      xp: 0,
      races: 0,
      wins: 0,
      podiums: 0,
      bestScore: {},
      bestLap: {},
      bestCombo: 0,
      shortcuts: 0,
      perfectDrifts: 0,
      selectedCar: 'falcon-r',
      seenUnlocks: ['falcon-r'],
    };
    let stored: Partial<ProfileData> = {};
    try {
      stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
      stored = {};
    }
    this.data = { ...defaults, ...stored };
    if (!this.isUnlocked(this.data.selectedCar)) this.data.selectedCar = 'falcon-r';
  }

  get level(): number {
    return levelForXp(this.data.xp);
  }

  isUnlocked(carId: string): boolean {
    const car = cars.find((c) => c.id === carId);
    return !!car && this.level >= car.unlockLevel;
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable */
    }
  }

  selectCar(id: string): void {
    if (!this.isUnlocked(id)) return;
    this.data.selectedCar = id;
    this.save();
  }

  /** Cars unlocked by the current level that haven't been announced yet. */
  takeNewUnlocks(): string[] {
    const fresh = cars.filter((c) => this.isUnlocked(c.id) && !this.data.seenUnlocks.includes(c.id)).map((c) => c.name);
    for (const c of cars) if (this.isUnlocked(c.id) && !this.data.seenUnlocks.includes(c.id)) this.data.seenUnlocks.push(c.id);
    if (fresh.length) this.save();
    return fresh;
  }
}

// ---------------------------------------------------------------- challenges

export interface RaceSummary {
  position: number;
  finished: boolean;
  score: number;
  laps: number;
  stats: StyleStats;
}

export interface Challenge {
  id: string;
  text: string;
  xp: number;
  /** Current progress 0..1 (1 = done). */
  progress(r: RaceSummary): number;
}

type Factory = (rng: Random, laps: number) => Challenge;

const count = (id: string, text: (n: number) => string, key: keyof StyleStats, options: number[], xpEach: number, perLap = false): Factory => (rng, laps) => {
  let n = options[Math.floor(rng.next() * options.length)];
  // Once-per-lap goals can't ask for more than the race has laps.
  if (perLap) n = Math.min(n, Math.max(1, laps - (key === 'cleanLaps' ? 1 : 0)));
  return { id: `${id}-${n}`, text: text(n), xp: Math.round(xpEach * n), progress: (r) => Math.min(1, r.stats[key] / n) };
};

const POOL: Factory[] = [
  (rng) => {
    const n = [4000, 7000, 10000][Math.floor(rng.next() * 3)];
    return { id: `score-${n}`, text: `Score ${n.toLocaleString('en-US')} style points`, xp: n / 10, progress: (r) => Math.min(1, r.score / n) };
  },
  count('perfect', (n) => (n === 1 ? 'Land a PERFECT drift' : `Land ${n} PERFECT drifts`), 'perfectDrifts', [1, 2, 3], 350),
  count('near', (n) => `${n} near misses`, 'nearMisses', [2, 3, 5], 180),
  count('overtake', (n) => `Overtake ${n} cars`, 'overtakes', [4, 6, 8], 90),
  count('hits', (n) => (n === 1 ? 'Hit a rival with an item' : `Hit rivals ${n} times with items`), 'hits', [1, 2, 3], 250),
  count('shortcut', (n) => (n === 1 ? 'Take the Chicane Cut' : `Take the Chicane Cut ${n} times`), 'shortcuts', [1, 2], 400, true),
  count('pads', (n) => `Hit ${n} boost pads`, 'pads', [5, 8], 60),
  count('jump', (n) => (n === 1 ? 'Catch air off a ramp' : `Catch air ${n} times`), 'jumps', [1, 2], 300, true),
  count('clean', (n) => (n === 1 ? 'Drive a clean lap' : `Drive ${n} clean laps`), 'cleanLaps', [1, 2], 400, true),
  (rng) => {
    const n = [4, 5, 7][Math.floor(rng.next() * 3)];
    const mult = 1 + 0.5 * (n - 1);
    return { id: `combo-${n}`, text: `Reach a COMBO x${mult}`, xp: n * 120, progress: (r) => Math.min(1, r.stats.bestCombo / n) };
  },
  (rng) => {
    const top = rng.next() < 0.5 ? 3 : 1;
    return {
      id: `finish-${top}`,
      text: top === 1 ? 'Win the race' : 'Finish on the podium',
      xp: top === 1 ? 900 : 500,
      progress: (r) => (r.finished && r.position <= top ? 1 : 0),
    };
  },
];

/** Three distinct challenges for a race (seeded so a restart keeps the same goals). */
export function rollChallenges(seed: number, laps: number): Challenge[] {
  const rng = new Random(seed);
  const picked: Challenge[] = [];
  const used = new Set<number>();
  while (picked.length < 3 && used.size < POOL.length) {
    const i = Math.floor(rng.next() * POOL.length);
    if (used.has(i)) continue;
    used.add(i);
    picked.push(POOL[i](rng, laps));
  }
  return picked;
}

/** XP for a finished race. */
export function raceXp(r: RaceSummary, challenges: Challenge[]): { base: number; placement: number; challenges: number; total: number } {
  const base = Math.round(r.score / 5);
  const placementTable = [1200, 850, 600, 420, 300, 220, 160, 120];
  const placement = r.finished ? placementTable[r.position - 1] ?? 100 : 0;
  const ch = challenges.reduce((a, c) => a + (c.progress(r) >= 1 ? c.xp : 0), 0);
  return { base, placement, challenges: ch, total: base + placement + ch };
}
