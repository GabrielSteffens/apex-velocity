import './styles/main.css';
import { Game } from './game/Game';
import { VERSION, versionLabel } from './version';

console.info(`Apex Velocity ${versionLabel()}`);

const viewport = document.getElementById('viewport')!;
const ui = document.getElementById('ui')!;

const game = new Game(viewport, ui);
game.init().catch((err) => {
  console.error(err);
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0b0c10;color:#fff;font:600 18px sans-serif;padding:40px;text-align:center;z-index:100';
  box.textContent = `Failed to start the game: ${err instanceof Error ? err.message : String(err)}. A WebGL2-capable browser is required.`;
  document.body.appendChild(box);
});

// Expose for debugging in the console.
(window as unknown as { game: Game; version: typeof VERSION }).game = game;
(window as unknown as { version: typeof VERSION }).version = VERSION;
