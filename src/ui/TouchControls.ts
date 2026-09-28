import { h } from './dom';
import type { Input } from '../core/Input';

type Control = 'left' | 'right' | 'gas' | 'brake' | 'hand' | 'pause' | 'camera' | 'reset';

const ARROW_L = '<svg viewBox="0 0 24 24"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ARROW_R = '<svg viewBox="0 0 24 24"><path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
const CAMERA = '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const RESET = '<svg viewBox="0 0 24 24"><path d="M5 12a7 7 0 1 0 2.1-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M4 4v5h5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * On-screen driving controls for touch devices. Every finger is tracked; a finger counts
 * for whichever control is under it *now*, so a thumb can slide from left to right or
 * from gas to brake without lifting. Optional tilt steering uses device orientation.
 */
export class TouchControls {
  readonly el: HTMLElement;
  private pointers = new Map<number, { x: number; y: number }>();
  private buttons = new Map<Control, HTMLElement>();
  private tiltEnabled = false;
  private tiltNeutral = 0;
  private tiltRaw = 0;
  private hasTilt = false;
  private readonly onOrientation = (e: DeviceOrientationEvent) => this.readTilt(e);

  constructor(private readonly input: Input) {
    const btn = (ctl: Control, cls: string, html: string, label: string) => {
      const b = h('div', { class: `tc-btn ${cls}`, 'data-ctl': ctl, 'aria-label': label, html });
      this.buttons.set(ctl, b);
      return b;
    };
    this.el = h(
      'div',
      { class: 'touch-controls' },
      h('div', { class: 'tc-steer' }, btn('left', 'tc-left', ARROW_L, 'Steer left'), btn('right', 'tc-right', ARROW_R, 'Steer right')),
      h(
        'div',
        { class: 'tc-pedals' },
        btn('hand', 'tc-hand', '<span>HB</span>', 'Handbrake'),
        btn('brake', 'tc-brake', '<span>BRAKE</span>', 'Brake / reverse'),
        btn('gas', 'tc-gas', '<span>GAS</span>', 'Accelerate'),
      ),
      h('div', { class: 'tc-top' }, btn('reset', 'tc-small', RESET, 'Reset car'), btn('camera', 'tc-small', CAMERA, 'Camera'), btn('pause', 'tc-small', PAUSE, 'Pause')),
    );

    const onDown = (e: PointerEvent) => {
      const ctl = this.controlAt(e.clientX, e.clientY);
      if (!ctl) return;
      e.preventDefault();
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.input.lastDevice = 'touch';
      // One-shot buttons fire on press.
      if (ctl === 'pause') this.input.trigger('pause');
      else if (ctl === 'camera') this.input.trigger('camera');
      else if (ctl === 'reset') this.input.trigger('reset');
      this.update();
    };
    const onMove = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      e.preventDefault();
      p.x = e.clientX;
      p.y = e.clientY;
      this.update();
    };
    const onUp = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      this.update();
    };
    this.el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    // Long-press / context menu would otherwise interrupt driving.
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private controlAt(x: number, y: number): Control | null {
    const el = document.elementFromPoint(x, y);
    const b = el instanceof Element ? el.closest('[data-ctl]') : null;
    return b && this.el.contains(b) ? (b.getAttribute('data-ctl') as Control) : null;
  }

  private update(): void {
    const held = new Set<Control>();
    for (const p of this.pointers.values()) {
      const c = this.controlAt(p.x, p.y);
      if (c) held.add(c);
    }
    const t = this.input.touch;
    t.throttle = held.has('gas') ? 1 : 0;
    t.brake = held.has('brake') ? 1 : 0;
    t.handbrake = held.has('hand');
    t.left = !this.tiltEnabled && held.has('left');
    t.right = !this.tiltEnabled && held.has('right');
    for (const [ctl, b] of this.buttons) b.classList.toggle('on', held.has(ctl));
  }

  /** Release everything (e.g. when pausing or leaving the race). */
  reset(): void {
    this.pointers.clear();
    this.update();
  }

  setVisible(on: boolean): void {
    this.el.classList.toggle('visible', on);
    if (!on) this.reset();
  }

  /**
   * Switch between arrow buttons and tilt steering. On iOS the orientation permission must
   * be requested from a user gesture, so call this from a click/tap handler.
   */
  async setSteering(mode: 'buttons' | 'tilt'): Promise<void> {
    const want = mode === 'tilt';
    if (want && !this.tiltEnabled) {
      const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
      try {
        if (DOE?.requestPermission && (await DOE.requestPermission()) !== 'granted') return;
      } catch {
        return;
      }
      window.addEventListener('deviceorientation', this.onOrientation);
    } else if (!want && this.tiltEnabled) {
      window.removeEventListener('deviceorientation', this.onOrientation);
      this.input.touch.tilt = null;
    }
    this.tiltEnabled = want;
    this.el.classList.toggle('tilt', want);
    this.update();
  }

  /** Treat the current device angle as "straight ahead". */
  calibrateTilt(): void {
    this.tiltNeutral = this.tiltRaw;
  }

  private readTilt(e: DeviceOrientationEvent): void {
    if (e.beta === null || e.gamma === null) return;
    // In landscape the "steering wheel" axis is beta; its sign flips with the rotation.
    const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number;
    let raw: number;
    if (angle === 90) raw = e.beta;
    else if (angle === 270 || angle === -90) raw = -e.beta;
    else raw = e.gamma; // portrait fallback
    this.tiltRaw = raw;
    if (!this.hasTilt) {
      this.hasTilt = true;
      this.tiltNeutral = raw;
    }
    if (!this.tiltEnabled) return;
    const deadzone = 2;
    let d = raw - this.tiltNeutral;
    d = Math.abs(d) < deadzone ? 0 : d - Math.sign(d) * deadzone;
    this.input.touch.tilt = Math.max(-1, Math.min(1, d / 22));
  }
}
