import { h } from './dom';
import { NavList } from './NavList';
import { versionLabel } from '../version';
import type { AudioManager } from '../audio/AudioManager';
import type { Input } from '../core/Input';

export interface PauseActions {
  resume(): void;
  restart(): void;
  settings(): void;
  quit(): void;
}

export class PauseMenu {
  readonly el: HTMLElement;
  private nav: NavList;

  constructor(audio: AudioManager, actions: PauseActions) {
    const btn = (label: string, fn: () => void, extra = '') =>
      h('button', { class: `menu-btn interactive ${extra}`, onclick: () => { audio.uiClick(); fn(); } }, h('span', {}, label));
    const buttons = [btn('Resume', actions.resume, 'primary'), btn('Restart Race', actions.restart), btn('Settings', actions.settings), btn('Quit to Menu', actions.quit)];
    this.el = h(
      'div',
      { class: 'screen modal interactive' },
      h('div', { class: 'panel' }, h('h2', {}, h('small', {}, 'Race Paused'), 'Paused'), h('div', { class: 'menu-list' }, ...buttons), h('div', { class: 'version-inline' }, versionLabel())),
    );
    this.nav = new NavList(buttons, audio);
  }

  handleInput(input: Input): void {
    this.nav.handle(input);
  }
}
