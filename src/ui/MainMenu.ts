import { h } from './dom';
import { NavList } from './NavList';
import type { AudioManager } from '../audio/AudioManager';
import type { Input } from '../core/Input';
import type { CarDefinition, TrackDefinition } from '../data/types';

export interface MainMenuActions {
  start(): void;
  settings(): void;
  comingSoon(feature: string): void;
}

/** Title screen. Only START RACE and SETTINGS are live; the rest are stubs for future modes. */
export class MainMenu {
  readonly el: HTMLElement;
  private nav: NavList;

  constructor(audio: AudioManager, actions: MainMenuActions, car: CarDefinition, track: TrackDefinition, trackLength: number) {
    const click = (fn: () => void) => () => {
      audio.unlock();
      audio.uiClick();
      fn();
    };
    const btn = (label: string, fn: () => void, extra = '', tag = '') =>
      h('button', { class: `menu-btn interactive ${extra}`, onclick: click(fn) }, h('span', {}, label), tag ? h('span', { class: 'tag' }, tag) : null);
    const buttons = [
      btn('Start Race', actions.start, 'primary', 'QUICK RACE'),
      btn('Garage', () => actions.comingSoon('Garage'), '', 'SOON'),
      btn('Track Select', () => actions.comingSoon('Track Select'), '', 'SOON'),
      btn('Tournament', () => actions.comingSoon('Tournament'), '', 'SOON'),
      btn('Settings', actions.settings),
    ];
    const statRow = (label: string, v: number) => h('div', { class: 'stat' }, label, h('div', { class: 'bar' }, h('i', { style: `width:${v * 10}%` })));
    this.el = h(
      'div',
      { class: 'screen menu' },
      h(
        'div',
        { class: 'left' },
        h('div', { class: 'logo', html: '<span class="a">Apex</span><br><span class="b">Velocity</span><small>Arcade Circuit Racing</small>' }),
        h('div', { class: 'menu-list' }, ...buttons),
      ),
      h(
        'div',
        { class: 'cards' },
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'kicker' }, 'Your Car'),
          h('div', { class: 'title' }, car.name),
          h('div', { class: 'sub' }, `${car.manufacturer} · ${car.powerKW} kW · ${car.topSpeed} km/h`),
          statRow('SPEED', car.stats.speed),
          statRow('ACCEL', car.stats.acceleration),
          statRow('HANDLING', car.stats.handling),
          statRow('BRAKING', car.stats.braking),
        ),
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'kicker' }, 'Circuit'),
          h('div', { class: 'title' }, track.name),
          h('div', { class: 'sub' }, `${track.location} · ${(trackLength / 1000).toFixed(2)} km`),
          h('div', { class: 'sub', style: 'margin-top:10px;max-width:320px;line-height:1.35' }, track.description),
        ),
      ),
      h(
        'div',
        { class: 'footer', html: '<span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span> drive &nbsp; <span class="key">Space</span> handbrake &nbsp; <span class="key">R</span> reset &nbsp; <span class="key">C</span> camera &nbsp; <span class="key">Esc</span> pause &nbsp; · &nbsp; Gamepad supported' },
      ),
    );
    this.nav = new NavList(buttons, audio);
  }

  handleInput(input: Input): void {
    this.nav.handle(input);
  }
}
