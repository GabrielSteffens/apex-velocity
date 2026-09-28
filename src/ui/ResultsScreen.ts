import { h, formatTime, ordinal } from './dom';
import { NavList } from './NavList';
import type { AudioManager } from '../audio/AudioManager';
import type { Input } from '../core/Input';
import type { RaceManager } from '../game/RaceManager';

export interface ResultsActions {
  restart(): void;
  menu(): void;
}

/** Final classification. Updates live while the remaining AI cars complete their race. */
export class ResultsScreen {
  readonly el: HTMLElement;
  private headline = h('div', { class: 'headline' });
  private tbody = h('tbody');
  private nav: NavList;

  constructor(audio: AudioManager, actions: ResultsActions) {
    const btn = (label: string, fn: () => void, extra = '') =>
      h('button', { class: `menu-btn interactive ${extra}`, onclick: () => { audio.uiClick(); fn(); } }, h('span', {}, label));
    const buttons = [btn('Race Again', actions.restart, 'primary'), btn('Main Menu', actions.menu)];
    this.el = h(
      'div',
      { class: 'screen modal interactive results' },
      h(
        'div',
        { class: 'panel', style: 'min-width:min(760px,92vw)' },
        h('h2', {}, h('small', {}, 'Race Complete'), 'Results'),
        this.headline,
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'POS'), h('th', {}, 'DRIVER'), h('th', {}, 'TIME'), h('th', {}, 'GAP'), h('th', {}, 'BEST LAP'))),
          this.tbody,
        ),
        h('div', { class: 'actions' }, ...buttons),
      ),
    );
    this.nav = new NavList(buttons, audio);
  }

  update(rm: RaceManager): void {
    const p = rm.player;
    if (p) {
      const pos = p.progress.finishPosition || p.position;
      this.headline.innerHTML = `${ordinal(pos)} <small>PLACE · ${formatTime(p.progress.finishTime)}</small>`;
    }
    const winner = rm.finishOrder[0];
    this.tbody.replaceChildren(
      ...rm.standings.map((car, i) => {
        const pr = car.progress;
        const gap = pr.finished && winner && car !== winner ? '+' + (pr.finishTime - winner.progress.finishTime).toFixed(3) : pr.finished ? '—' : `LAP ${pr.currentLap}`;
        return h(
          'tr',
          { class: `${car.isPlayer ? 'me' : ''} ${pr.finished ? '' : 'running'}` },
          h('td', { class: 'pos' }, String(i + 1)),
          h('td', {}, h('span', { class: 'chip', style: `background:#${car.color.toString(16).padStart(6, '0')}` }), car.name),
          h('td', {}, pr.finished ? formatTime(pr.finishTime) : 'RUNNING'),
          h('td', {}, gap),
          h('td', {}, formatTime(pr.bestLapTime)),
        );
      }),
    );
  }

  handleInput(input: Input): void {
    this.nav.handle(input);
  }
}
