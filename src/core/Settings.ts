import type { Quality } from '../render/Renderer';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface GameSettings {
  quality: Quality;
  volume: number;
  laps: number;
  opponents: number;
  difficulty: Difficulty;
  cameraShake: boolean;
  showFps: boolean;
}

const DEFAULTS: GameSettings = {
  quality: 'high',
  volume: 0.7,
  laps: 3,
  opponents: 5,
  difficulty: 'normal',
  cameraShake: true,
  showFps: false,
};

const KEY = 'apex-velocity.settings.v1';

/** Persistent user settings (localStorage, failing gracefully when unavailable). */
export class Settings {
  private data: GameSettings;
  private listeners: ((s: GameSettings) => void)[] = [];

  constructor() {
    let stored: Partial<GameSettings> = {};
    try {
      stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
      stored = {};
    }
    this.data = { ...DEFAULTS, ...stored };
  }

  get values(): Readonly<GameSettings> {
    return this.data;
  }

  set<K extends keyof GameSettings>(key: K, value: GameSettings[K]): void {
    this.data[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable: settings last for this session only */
    }
    for (const l of this.listeners) l(this.data);
  }

  onChange(fn: (s: GameSettings) => void): void {
    this.listeners.push(fn);
  }
}

export const DIFFICULTY_PACE: Record<Difficulty, number> = { easy: 0.9, normal: 0.955, hard: 1.0 };
