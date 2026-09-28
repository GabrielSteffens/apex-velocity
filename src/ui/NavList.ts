import type { Input } from '../core/Input';
import type { AudioManager } from '../audio/AudioManager';

/** Keyboard / gamepad navigation for a vertical list of buttons (mouse works natively). */
export class NavList {
  private index = 0;

  constructor(
    private readonly buttons: HTMLElement[],
    private readonly audio: AudioManager,
  ) {
    buttons.forEach((b, i) =>
      b.addEventListener('mouseenter', () => {
        if (this.index !== i) audio.uiHover();
        this.focus(i);
      }),
    );
    this.focus(0);
  }

  focus(i: number): void {
    this.index = (i + this.buttons.length) % this.buttons.length;
    this.buttons.forEach((b, k) => b.classList.toggle('focused', k === this.index));
  }

  handle(input: Input): void {
    if (input.consume('up')) {
      this.focus(this.index - 1);
      this.audio.uiHover();
    }
    if (input.consume('down')) {
      this.focus(this.index + 1);
      this.audio.uiHover();
    }
    if (input.consume('confirm')) this.buttons[this.index].click();
  }
}
