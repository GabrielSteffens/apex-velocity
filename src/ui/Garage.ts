import { h } from './dom';
import { cars } from '../data/cars';
import type { CarDefinition } from '../data/types';
import type { AudioManager } from '../audio/AudioManager';
import type { Input } from '../core/Input';
import type { Profile } from '../game/Profile';

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

export function statRows(car: CarDefinition): HTMLElement[] {
  const row = (label: string, v: number) => h('div', { class: 'stat' }, label, h('div', { class: 'bar' }, h('i', { style: `width:${v * 10}%` })));
  const s = car.stats;
  return [row('SPEED', s.speed), row('ACCEL', s.acceleration), row('HANDLING', s.handling), row('DRIFT', s.drift), row('OFF-ROAD', s.offroad)];
}

/**
 * Car selection. Each car plays differently (drift/off-road rally, heavy muscle with
 * big boosts, grippy hypercar); locked cars show the level that unlocks them.
 */
export class Garage {
  readonly el: HTMLElement;
  private cards: HTMLElement[] = [];
  private index = 0;
  private listEl = h('div', { class: 'garage-list' });
  private levelEl = h('div', { class: 'garage-level' });

  constructor(
    private readonly audio: AudioManager,
    private readonly profile: Profile,
    private readonly onSelect: (car: CarDefinition) => void,
    private readonly onClose: () => void,
  ) {
    const back = h('button', { class: 'menu-btn interactive', onclick: () => this.close() }, h('span', {}, 'Back'));
    this.el = h(
      'div',
      { class: 'screen modal interactive garage' },
      h('div', { class: 'panel', style: 'width:min(1100px,94vw)' }, h('h2', {}, h('small', {}, 'Choose your ride'), 'Garage'), this.levelEl, this.listEl, h('div', { class: 'actions' }, back)),
    );
    this.render();
  }

  open(): void {
    this.render();
    this.index = Math.max(0, cars.findIndex((c) => c.id === this.profile.data.selectedCar));
    this.focus(this.index);
    this.el.classList.add('visible');
  }

  close(): void {
    this.audio.uiClick();
    this.el.classList.remove('visible');
    this.onClose();
  }

  get visible(): boolean {
    return this.el.classList.contains('visible');
  }

  private render(): void {
    const lvl = this.profile.level;
    this.levelEl.textContent = `DRIVER LEVEL ${lvl}`;
    this.cards = cars.map((car, i) => {
      const locked = !this.profile.isUnlocked(car.id);
      const selected = this.profile.data.selectedCar === car.id;
      const card = h(
        'div',
        { class: `garage-card interactive ${locked ? 'locked' : ''} ${selected ? 'selected' : ''}`, style: `--car:${hex(car.style.bodyColor)}` },
        h('div', { class: 'swatch' }),
        h('div', { class: 'kicker' }, car.role),
        h('div', { class: 'title' }, car.name),
        h('div', { class: 'sub' }, `${car.manufacturer}`),
        h('div', { class: 'desc' }, car.description),
        ...statRows(car),
        h('div', { class: 'state' }, locked ? `🔒 Reach level ${car.unlockLevel}` : selected ? '✔ Selected' : 'Select'),
      );
      card.addEventListener('mouseenter', () => this.focus(i));
      card.addEventListener('click', () => this.choose(i));
      return card;
    });
    this.listEl.replaceChildren(...this.cards);
  }

  private focus(i: number): void {
    this.index = (i + this.cards.length) % this.cards.length;
    this.cards.forEach((c, k) => c.classList.toggle('focused', k === this.index));
  }

  private choose(i: number): void {
    const car = cars[i];
    if (!this.profile.isUnlocked(car.id)) {
      this.audio.comboLost();
      return;
    }
    this.audio.uiClick();
    this.profile.selectCar(car.id);
    this.onSelect(car);
    this.render();
    this.focus(i);
  }

  handleInput(input: Input): void {
    if (input.consume('left') || input.consume('up')) {
      this.focus(this.index - 1);
      this.audio.uiHover();
    }
    if (input.consume('right') || input.consume('down')) {
      this.focus(this.index + 1);
      this.audio.uiHover();
    }
    if (input.consume('confirm')) this.choose(this.index);
    if (input.consume('back') || input.consume('pause')) this.close();
  }
}
