import { h } from './dom';
import type { AudioManager } from '../audio/AudioManager';
import type { Settings, GameSettings } from '../core/Settings';

/** Settings modal, shared by the main menu and the pause menu. */
export class SettingsPanel {
  readonly el: HTMLElement;
  onClose: () => void = () => {};

  constructor(
    private readonly settings: Settings,
    private readonly audio: AudioManager,
  ) {
    const body = h('div', {});
    const render = () => {
      body.replaceChildren(
        this.choice('Time of Day', 'timeOfDay', [
          ['sunset', 'Sunset'],
          ['night', 'Night'],
        ]),
        this.choice('Graphics', 'quality', [
          ['low', 'Low'],
          ['medium', 'Medium'],
          ['high', 'High'],
        ]),
        this.choice('AI Difficulty', 'difficulty', [
          ['easy', 'Easy'],
          ['normal', 'Normal'],
          ['hard', 'Hard'],
        ]),
        this.choice('Laps', 'laps', [1, 2, 3, 5, 8].map((n) => [n, String(n)] as [number, string])),
        this.choice('Opponents', 'opponents', [1, 3, 5, 7].map((n) => [n, String(n)] as [number, string])),
        this.choice('Camera Shake', 'cameraShake', [
          [true, 'On'],
          [false, 'Off'],
        ]),
        this.choice('FPS Counter', 'showFps', [
          [true, 'On'],
          [false, 'Off'],
        ]),
        this.slider('Volume', 'volume'),
      );
    };
    settings.onChange(render);
    render();
    const done = h('button', { class: 'menu-btn primary interactive', onclick: () => { audio.uiClick(); this.onClose(); } }, h('span', {}, 'Done'));
    this.el = h(
      'div',
      { class: 'screen modal interactive' },
      h('div', { class: 'panel' }, h('h2', {}, h('small', {}, 'Options'), 'Settings'), body, h('div', { class: 'actions' }, done)),
    );
  }

  private choice<K extends keyof GameSettings>(label: string, key: K, opts: [GameSettings[K], string][]): HTMLElement {
    const cur = this.settings.values[key];
    return h(
      'div',
      { class: 'setting' },
      label,
      h(
        'div',
        { class: 'opts' },
        ...opts.map(([v, text]) =>
          h(
            'button',
            {
              class: `opt ${v === cur ? 'on' : ''}`,
              onclick: () => {
                this.audio.uiHover();
                this.settings.set(key, v);
              },
            },
            text,
          ),
        ),
      ),
    );
  }

  private slider(label: string, key: 'volume'): HTMLElement {
    const input = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: this.settings.values[key] });
    input.addEventListener('input', () => this.settings.set(key, Number(input.value)));
    return h('div', { class: 'setting' }, label, input);
  }
}
