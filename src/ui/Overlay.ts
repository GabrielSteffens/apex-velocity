import { h } from './dom';
import { versionLabel } from '../version';

/** Big centre-screen countdown numbers. */
export class Countdown {
  readonly el = h('div', { class: 'countdown' });

  show(text: string, go = false): void {
    this.el.textContent = text;
    this.el.className = 'countdown';
    void this.el.offsetWidth; // restart animation
    this.el.classList.add(go ? 'go' : 'pop');
  }

  clear(): void {
    this.el.textContent = '';
    this.el.className = 'countdown';
  }
}

/** Transient announcements: "FINAL LAP", "NEW BEST LAP", "COMING SOON"... */
export class Toast {
  readonly el = h('div', { class: 'toast' });

  show(text: string, sub = ''): void {
    this.el.innerHTML = '';
    this.el.append(text);
    if (sub) this.el.append(h('small', {}, sub));
    this.el.classList.remove('show');
    void this.el.offsetWidth;
    this.el.classList.add('show');
  }
}

export class LoadingScreen {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private status: HTMLElement;

  constructor() {
    this.bar = h('i');
    this.status = h('div', { class: 'status' }, 'Loading');
    this.el = h(
      'div',
      { class: 'screen loading visible' },
      h('div', { class: 'logo', html: '<span class="a">Apex</span> <span class="b">Velocity</span>' }),
      h('div', { class: 'bar' }, this.bar),
      this.status,
      h('div', { class: 'version-inline' }, versionLabel()),
    );
  }

  progress(p: number, text: string): void {
    this.bar.style.width = `${Math.round(p * 100)}%`;
    this.status.textContent = text;
  }
}
