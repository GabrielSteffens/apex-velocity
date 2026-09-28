/** State written by the on-screen touch controls. */
export interface TouchState {
  throttle: number;
  brake: number;
  left: boolean;
  right: boolean;
  handbrake: boolean;
  /** Analog steering from device tilt (-1..1), or null when tilt steering is off. */
  tilt: number | null;
}

/**
 * Keyboard + gamepad + touch input. Exposes analog axes for driving and edge-triggered actions
 * for menus (pause, reset, camera).
 */
export type Action = 'pause' | 'reset' | 'camera' | 'confirm' | 'up' | 'down' | 'back' | 'debug';

const ACTION_KEYS: Record<Action, string[]> = {
  debug: ['F3'],
  pause: ['Escape', 'KeyP'],
  reset: ['KeyR'],
  camera: ['KeyC'],
  confirm: ['Enter'],
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  back: ['Backspace'],
};

export class Input {
  private keys = new Set<string>();
  private pressedActions = new Set<Action>();
  private gamepadPrev: boolean[] = [];
  gamepadConnected = false;
  /** Last device used, so the UI can show the right hints. */
  lastDevice: 'keyboard' | 'gamepad' | 'touch' = 'keyboard';
  readonly touch: TouchState = { throttle: 0, brake: 0, left: false, right: false, handbrake: false, tilt: null };

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F3'].includes(e.code)) e.preventDefault();
      if (!e.repeat) {
        for (const [action, codes] of Object.entries(ACTION_KEYS) as [Action, string[]][]) {
          if (codes.includes(e.code)) this.pressedActions.add(action);
        }
      }
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', () => (this.gamepadConnected = true));
    window.addEventListener('gamepaddisconnected', () => (this.gamepadConnected = false));
  }

  private key(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Gamepad snapshot, refreshed once per frame in poll() (getGamepads() allocates). */
  private padCache: Gamepad | null = null;

  private pad(): Gamepad | null {
    return this.padCache;
  }

  /** Poll gamepad state once per frame and produce edge-triggered actions. */
  poll(): void {
    this.padCache = null;
    if (navigator.getGamepads) {
      for (const g of navigator.getGamepads()) {
        if (g && g.connected) {
          this.padCache = g;
          break;
        }
      }
    }
    const p = this.padCache;
    if (!p) return;
    const map: [number, Action][] = [
      [9, 'pause'], // Start
      [3, 'reset'], // Y
      [5, 'camera'], // RB
      [0, 'confirm'], // A
      [12, 'up'],
      [13, 'down'],
      [1, 'back'], // B
    ];
    for (const [idx, action] of map) {
      const down = !!p.buttons[idx]?.pressed;
      if (down && !this.gamepadPrev[idx]) {
        this.pressedActions.add(action);
        this.lastDevice = 'gamepad';
      }
      this.gamepadPrev[idx] = down;
    }
  }

  /** Returns true once per press. */
  consume(action: Action): boolean {
    if (this.pressedActions.has(action)) {
      this.pressedActions.delete(action);
      return true;
    }
    return false;
  }

  /** Fire an edge-triggered action from UI (e.g. an on-screen pause button). */
  trigger(action: Action): void {
    this.pressedActions.add(action);
  }

  clearActions(): void {
    this.pressedActions.clear();
  }

  get throttle(): number {
    let v = Math.max(this.key('KeyW', 'ArrowUp') ? 1 : 0, this.touch.throttle);
    const p = this.pad();
    if (p) v = Math.max(v, p.buttons[7]?.value ?? 0);
    return v;
  }

  get brake(): number {
    let v = Math.max(this.key('KeyS', 'ArrowDown') ? 1 : 0, this.touch.brake);
    const p = this.pad();
    if (p) v = Math.max(v, p.buttons[6]?.value ?? 0);
    return v;
  }

  get steer(): number {
    let v = (this.key('KeyD', 'ArrowRight') || this.touch.right ? 1 : 0) - (this.key('KeyA', 'ArrowLeft') || this.touch.left ? 1 : 0);
    if (v === 0 && this.touch.tilt !== null) return this.touch.tilt;
    const p = this.pad();
    if (p && v === 0) {
      const x = p.axes[0] ?? 0;
      const dz = 0.12;
      if (Math.abs(x) > dz) {
        v = Math.sign(x) * ((Math.abs(x) - dz) / (1 - dz));
        v = Math.sign(v) * Math.pow(Math.abs(v), 1.4);
        this.lastDevice = 'gamepad';
      }
    }
    return v;
  }

  /** True when the current steering value comes from an analog stick. */
  get steerIsAnalog(): boolean {
    if (this.touch.tilt !== null && !this.touch.left && !this.touch.right) return true;
    const p = this.pad();
    return !!p && this.key('KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight') === false && Math.abs(p.axes[0] ?? 0) > 0.12;
  }

  get handbrake(): boolean {
    if (this.key('Space') || this.touch.handbrake) return true;
    const p = this.pad();
    return !!p && (!!p.buttons[2]?.pressed || !!p.buttons[4]?.pressed);
  }

  /** Any key or button currently held (used for "press any key" prompts). */
  get anyThrottle(): boolean {
    return this.throttle > 0.1;
  }
}
