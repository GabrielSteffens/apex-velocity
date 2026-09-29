import { h, formatTime, ordinal } from './dom';
import { NavList } from './NavList';
import type { AudioManager } from '../audio/AudioManager';
import type { Input } from '../core/Input';
import type { RaceManager } from '../game/RaceManager';

export interface ResultsActions {
  restart(): void;
  menu(): void;
  garage(): void;
}

export interface RaceProgressReport {
  score: number;
  newBest: boolean;
  bestCombo: number;
  chips: [string, number][];
  challenges: { text: string; done: boolean; xp: number }[];
  xp: { base: number; placement: number; challenges: number; total: number };
  levelBefore: number;
  levelAfter: number;
  /** Fraction of the level bar before / after (0..1, within the final level). */
  fracBefore: number;
  fracAfter: number;
  unlocks: string[];
}

/** Final classification. Updates live while the remaining AI cars complete their race. */
export class ResultsScreen {
  readonly el: HTMLElement;
  private headline = h('div', { class: 'headline' });
  private tbody = h('tbody');
  private nav: NavList;
  private progress = h('div', { class: 'results-progress' });

  constructor(audio: AudioManager, actions: ResultsActions) {
    const btn = (label: string, fn: () => void, extra = '') =>
      h('button', { class: `menu-btn interactive ${extra}`, onclick: () => { audio.uiClick(); fn(); } }, h('span', {}, label));
    const buttons = [btn('Race Again', actions.restart, 'primary'), btn('Garage', actions.garage), btn('Main Menu', actions.menu)];
    this.el = h(
      'div',
      { class: 'screen modal interactive results' },
      h(
        'div',
        { class: 'panel', style: 'min-width:min(760px,92vw)' },
        h('h2', {}, h('small', {}, 'Race Complete'), 'Results'),
        this.headline,
        this.progress,
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

  /** Style score, challenges and XP gained (the "one more race" hooks). */
  showProgress(r: RaceProgressReport): void {
    const chips = r.chips.filter(([, v]) => v > 0).map(([k, v]) => h('span', { class: 'chip-stat' }, h('b', {}, String(v)), ' ' + k));
    const ch = r.challenges.map((c) => h('div', { class: `challenge ${c.done ? 'done' : ''}` }, h('span', { class: 'mark' }, c.done ? '✔' : '✖'), c.text, h('span', { class: 'xp' }, c.done ? `+${c.xp} XP` : '')));
    const bar = h('i', { style: `width:${Math.round((r.levelAfter > r.levelBefore ? 0 : r.fracBefore) * 100)}%` });
    const levelUp = r.levelAfter > r.levelBefore;
    this.progress.replaceChildren(
      h(
        'div',
        { class: 'score-row' },
        h('div', { class: 'big-score' }, h('small', {}, 'STYLE SCORE'), r.score.toLocaleString('en-US'), r.newBest ? h('span', { class: 'badge' }, 'NEW BEST!') : null),
        h('div', { class: 'chips' }, ...chips),
      ),
      h('div', { class: 'challenges-res' }, h('small', {}, 'CHALLENGES'), ...ch),
      h(
        'div',
        { class: 'xp-row' },
        h('div', { class: 'lvl' }, levelUp ? h('span', { class: 'badge' }, 'LEVEL UP!') : null, `LEVEL ${r.levelAfter}`),
        h('div', { class: 'xp' }, bar),
        h('div', { class: 'gain' }, `+${r.xp.total.toLocaleString('en-US')} XP`, h('small', {}, ` (style ${r.xp.base} · finish ${r.xp.placement} · challenges ${r.xp.challenges})`)),
      ),
    );
    if (r.unlocks.length) this.progress.append(h('div', { class: 'unlock' }, `NEW CAR UNLOCKED: ${r.unlocks.join(', ')} — check the Garage!`));
    // Animate the XP bar filling up.
    setTimeout(() => (bar.style.width = `${Math.round(r.fracAfter * 100)}%`), 400);
  }

  clearProgress(): void {
    this.progress.replaceChildren();
  }

  handleInput(input: Input): void {
    this.nav.handle(input);
  }
}
