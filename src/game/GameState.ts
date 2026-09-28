export type GameState = 'LOADING' | 'MENU' | 'COUNTDOWN' | 'RACING' | 'PAUSED' | 'FINISHED';

/** Tiny state machine with transition listeners and pause/resume memory. */
export class GameStateMachine {
  private _state: GameState = 'LOADING';
  private _beforePause: GameState = 'RACING';
  private listeners: ((to: GameState, from: GameState) => void)[] = [];

  get state(): GameState {
    return this._state;
  }

  /** The state the game will return to when un-paused. */
  get resumeState(): GameState {
    return this._beforePause;
  }

  set(next: GameState): void {
    if (next === this._state) return;
    const prev = this._state;
    if (next === 'PAUSED') this._beforePause = prev;
    this._state = next;
    for (const l of this.listeners) l(next, prev);
  }

  is(...states: GameState[]): boolean {
    return states.includes(this._state);
  }

  onChange(fn: (to: GameState, from: GameState) => void): void {
    this.listeners.push(fn);
  }
}
