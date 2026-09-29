import { h } from './dom';
import { ITEMS, ITEM_INFO, type ItemType, type ItemSystem } from '../gameplay/Items';
import type { StyleTracker, StylePopup } from '../gameplay/Style';
import type { Car } from '../car/Car';
import { CarPhysics } from '../car/CarPhysics';

export const ITEM_ICONS: Record<ItemType, string> = {
  nitro: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>',
  missile:
    '<svg viewBox="0 0 24 24"><path d="M12 2c3 2 5 6 5 10l-2 3H9l-2-3c0-4 2-8 5-10z" fill="currentColor"/><path d="M9 15l-3 4h4zM15 15l3 4h-4z" fill="currentColor"/><circle cx="12" cy="9" r="1.7" fill="#111"/><path d="M11 17h2l-1 5z" fill="#ffb800"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z" fill="currentColor"/><path d="M12 5v14" stroke="#111" stroke-width="1.4" opacity=".35"/></svg>',
  oil: '<svg viewBox="0 0 24 24"><path d="M12 2C9 7 6 10 6 14a6 6 0 0 0 12 0c0-4-3-7-6-12z" fill="currentColor"/><path d="M9.5 14.5a2.6 2.6 0 0 0 2.5 2.6" stroke="#111" stroke-width="1.4" fill="none" opacity=".5"/></svg>',
  overdrive: '<svg viewBox="0 0 24 24"><path d="M3 6l7 6-7 6zM12 6l7 6-7 6z" fill="currentColor"/><rect x="19.5" y="6" width="2" height="12" fill="currentColor"/></svg>',
  emp: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3"/></svg>',
};

const LEVEL_COLORS = ['#ffffff', '#3aa0ff', '#ff8a1f', '#c04dff'];

/**
 * Arcade layer of the HUD: item slot (with roulette), drift charge meter, style score
 * and combo, score popups, boost vignette and incoming-missile warning.
 */
export class ArcadeHUD {
  readonly el: HTMLElement;
  private itemSlot = h('div', { class: 'item-slot empty' });
  private itemIcon = h('div', { class: 'item-icon' });
  private itemName = h('div', { class: 'item-name' });
  private itemKey = h('div', { class: 'item-key' }, 'E');
  private drift = h('div', { class: 'drift-meter' });
  private driftSegs: HTMLElement[] = [];
  private driftFill = h('i');
  private scoreEl = h('div', { class: 'style-score' });
  private scoreNum = h('b');
  private comboEl = h('span', { class: 'combo' });
  private comboBar = h('i');
  private popups = h('div', { class: 'popups' });
  private boostFx = h('div', { class: 'boost-fx' });
  private warning = h('div', { class: 'missile-warning' }, '⚠ MISSILE');
  private banner = h('div', { class: 'arcade-banner' });
  private challengeEl = h('div', { class: 'challenge-hud' });
  private challengeRows: HTMLElement[] = [];
  private challengeShow = 0;
  private rouletteT = 0;
  private rouletteIdx = 0;
  private lastSlot: string | null = '';
  private shownScore = 0;
  private lastLevel = 0;
  private bannerTimer = 0;
  /** Roulette tick (sound). */
  onTick: () => void = () => {};
  onDriftLevel: (level: number) => void = () => {};

  constructor(isTouch: boolean) {
    this.itemSlot.append(this.itemIcon, this.itemName, this.itemKey);
    if (isTouch) this.itemKey.remove();
    for (let i = 0; i < 3; i++) {
      const seg = h('span');
      this.driftSegs.push(seg);
    }
    this.drift.append(h('div', { class: 'bar' }, this.driftFill, ...this.driftSegs), h('div', { class: 'label' }, 'DRIFT'));
    this.scoreEl.append(h('small', {}, 'STYLE'), this.scoreNum, this.comboEl, h('div', { class: 'combo-bar' }, this.comboBar));
    this.el = h('div', { class: 'arcade-hud' }, this.boostFx, this.itemSlot, this.drift, this.scoreEl, this.challengeEl, this.popups, this.warning, this.banner);
  }

  reset(): void {
    this.popups.replaceChildren();
    this.shownScore = 0;
    this.lastSlot = '';
    this.banner.classList.remove('on');
  }

  /** This race's challenges (shown during the countdown and the opening seconds). */
  setChallenges(list: { text: string; xp: number }[]): void {
    this.challengeRows = list.map((c) => h('div', { class: 'row' }, h('span', { class: 'box' }), h('span', { class: 't' }, c.text), h('span', { class: 'x' }, `${c.xp} XP`)));
    this.challengeEl.replaceChildren(h('small', {}, 'CHALLENGES'), ...this.challengeRows);
    this.challengeShow = 14;
  }

  setChallengeProgress(progress: number[]): void {
    progress.forEach((p, i) => {
      const row = this.challengeRows[i];
      if (!row) return;
      const done = p >= 1;
      if (done && !row.classList.contains('done')) this.challengeShow = Math.max(this.challengeShow, 4);
      row.classList.toggle('done', done);
      row.style.setProperty('--p', `${Math.round(Math.min(1, p) * 100)}%`);
    });
  }

  popup(p: StylePopup, combo: number): void {
    const el = h('div', { class: `popup ${p.tier}` }, h('span', { class: 't' }, p.text), h('span', { class: 'p' }, `+${p.points}`));
    if (combo >= 2) el.append(h('span', { class: 'c' }, `x${Math.min(5, 1 + 0.5 * (combo - 1)).toFixed(1).replace('.0', '')}`));
    this.popups.prepend(el);
    while (this.popups.children.length > 4) this.popups.lastElementChild?.remove();
    setTimeout(() => el.remove(), 1600);
  }

  /** Big centre banner ("COMBO x3 +1200", "SPUN OUT!", ...). */
  showBanner(text: string, sub: string, color: string, seconds = 1.6): void {
    this.banner.innerHTML = `<b style="color:${color}">${text}</b>${sub ? `<small>${sub}</small>` : ''}`;
    this.banner.classList.remove('on');
    void this.banner.offsetWidth; // restart the animation
    this.banner.classList.add('on');
    this.bannerTimer = seconds;
  }

  update(dt: number, player: Car, items: ItemSystem, style: StyleTracker | null): void {
    const ph = player.physics;
    const st = items.get(player);

    // Item slot
    let slotKey: string | null = st.slot;
    if (st.roulette > 0) {
      this.rouletteT -= dt;
      if (this.rouletteT <= 0) {
        this.rouletteT = 0.07 + (1.5 - st.roulette) * 0.04;
        this.rouletteIdx = (this.rouletteIdx + 1) % ITEMS.length;
        this.onTick();
      }
      slotKey = 'roulette:' + this.rouletteIdx;
    }
    if (slotKey !== this.lastSlot) {
      this.lastSlot = slotKey;
      const item: ItemType | null = st.roulette > 0 ? ITEMS[this.rouletteIdx] : st.slot;
      this.itemSlot.classList.toggle('empty', !item);
      this.itemSlot.classList.toggle('rolling', st.roulette > 0);
      this.itemSlot.classList.toggle('ready', !!st.slot && st.roulette <= 0);
      this.itemIcon.innerHTML = item ? ITEM_ICONS[item] : '';
      this.itemSlot.style.setProperty('--item', item ? ITEM_INFO[item].color : '#888');
      this.itemName.textContent = st.slot && st.roulette <= 0 ? ITEM_INFO[st.slot].name : '';
      this.itemSlot.title = st.slot ? ITEM_INFO[st.slot].hint : '';
    }

    // Drift meter
    const drifting = ph.drifting;
    this.drift.classList.toggle('on', drifting);
    if (drifting) {
      const L = CarPhysics.DRIFT_LEVELS;
      const f = Math.min(1, ph.driftCharge / L[2]);
      const lvl = ph.driftLevel;
      this.driftFill.style.transform = `scaleX(${f.toFixed(3)})`;
      this.drift.style.setProperty('--lvl', LEVEL_COLORS[lvl]);
      this.driftSegs.forEach((s, i) => s.classList.toggle('lit', lvl > i));
      if (lvl > this.lastLevel) {
        this.onDriftLevel(lvl);
        this.drift.classList.remove('pulse');
        void this.drift.offsetWidth;
        this.drift.classList.add('pulse');
      }
      this.lastLevel = lvl;
    } else this.lastLevel = 0;

    // Score + combo
    if (style) {
      this.shownScore += (style.score - this.shownScore) * Math.min(1, dt * 8);
      if (Math.abs(style.score - this.shownScore) < 1) this.shownScore = style.score;
      this.scoreNum.textContent = Math.round(this.shownScore).toLocaleString('en-US');
      const combo = style.combo;
      this.comboEl.textContent = combo >= 2 ? `COMBO x${style.multiplier.toFixed(1).replace('.0', '')}` : '';
      this.scoreEl.classList.toggle('combo-on', combo >= 2);
      this.comboBar.style.transform = `scaleX(${Math.max(0, style.comboTimer / 4.5).toFixed(3)})`;
    }

    // Boost vignette / missile warning
    const boost = ph.boostTime > 0 ? Math.min(1, ph.boostTime * 1.5) : 0;
    const od = ph.overdriveTime > 0 ? 0.6 : 0;
    this.boostFx.style.opacity = Math.max(boost, od).toFixed(2);
    this.boostFx.classList.toggle('overdrive', od > 0 && boost === 0);
    this.warning.classList.toggle('on', !!st.targetedBy);

    this.challengeShow -= dt;
    this.challengeEl.classList.toggle('on', this.challengeShow > 0);

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('on');
    }
  }
}
