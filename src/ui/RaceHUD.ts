import { h, formatTime } from './dom';
import type { RaceManager } from '../game/RaceManager';
import type { Car } from '../car/Car';
import type { TrackGeometry } from '../track/TrackGeometry';
import { ArcadeHUD } from './ArcadeHUD';
import type { StyleTracker } from '../gameplay/Style';

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

/**
 * Canvas tachometer + digital speed + gear. The static dial (plate, ticks, numbers) is
 * rendered once into a cached canvas; each frame only draws the needle arc and digits,
 * and skips the redraw entirely when nothing visible changed.
 */
class Speedometer {
  readonly canvas = h('canvas');
  private ctx: CanvasRenderingContext2D;
  private size = 300;
  private dpr = 1;
  private shownSpeed = 0;
  private shownRpm = 0;
  private dial: HTMLCanvasElement | null = null;
  private dialRedline = -1;
  private lastKey = '';

  constructor() {
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(cssSize: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size = cssSize;
    this.canvas.width = Math.round(cssSize * this.dpr);
    this.canvas.height = Math.round(cssSize * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.dial = null;
    this.lastKey = '';
  }

  private geometry(redline: number) {
    const S = this.size;
    return { S, cx: S / 2, cy: S / 2, R: S * 0.44, a0: Math.PI * 0.75, sweep: Math.PI * 1.5, maxRpm: Math.ceil(redline / 1000) * 1000 + 1000 };
  }

  private buildDial(redline: number): void {
    const { S, cx, cy, R, a0, sweep, maxRpm } = this.geometry(redline);
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.12);
    g.addColorStop(0, 'rgba(10,11,14,0.85)');
    g.addColorStop(0.85, 'rgba(10,11,14,0.6)');
    g.addColorStop(1, 'rgba(10,11,14,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = S * 0.045;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a0 + sweep);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,59,47,0.45)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0 + sweep * ((redline - 500) / maxRpm), a0 + sweep);
    ctx.stroke();
    ctx.fillStyle = 'rgba(244,241,234,0.75)';
    ctx.strokeStyle = 'rgba(244,241,234,0.8)';
    ctx.font = `700 ${S * 0.05}px Rajdhani, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r <= maxRpm; r += 500) {
      const a = a0 + sweep * (r / maxRpm);
      const major = r % 1000 === 0;
      const r1 = R - S * (major ? 0.06 : 0.04);
      const r2 = R - S * 0.025;
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
      if (major) {
        const rt = R - S * 0.11;
        ctx.fillText(String(r / 1000), cx + Math.cos(a) * rt, cy + Math.sin(a) * rt);
      }
    }
    ctx.fillStyle = 'rgba(244,241,234,0.6)';
    ctx.font = `700 ${S * 0.055}px Rajdhani, sans-serif`;
    ctx.fillText('KM/H', cx, cy + S * 0.12);
    this.dial = c;
    this.dialRedline = redline;
  }

  draw(speedKmh: number, rpm: number, redline: number, gear: number, dt: number): void {
    const k = 1 - Math.exp(-14 * dt);
    this.shownSpeed += (speedKmh - this.shownSpeed) * k;
    this.shownRpm += (rpm - this.shownRpm) * k;
    const speedText = String(Math.round(this.shownSpeed));
    const gearText = gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear);
    const hot = this.shownRpm > redline - 700;
    // Skip the redraw when nothing visible changed (rpm quantised to ~0.25% of the dial).
    const key = `${speedText}|${gearText}|${Math.round(this.shownRpm / 25)}|${hot}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (!this.dial || this.dialRedline !== redline) this.buildDial(redline);

    const ctx = this.ctx;
    const { S, cx, cy, R, a0, sweep, maxRpm } = this.geometry(redline);
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this.dial!, 0, 0, S, S);

    const f = Math.min(1, this.shownRpm / maxRpm);
    const end = a0 + sweep * f;
    // Cheap glow: a wider translucent arc under the main one (shadowBlur is very slow).
    ctx.lineCap = 'butt';
    ctx.lineWidth = S * 0.075;
    ctx.strokeStyle = hot ? 'rgba(255,40,30,0.3)' : 'rgba(255,120,40,0.18)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, end);
    ctx.stroke();
    ctx.lineWidth = S * 0.045;
    if (hot) ctx.strokeStyle = '#ff2a1f';
    else {
      const grad = ctx.createLinearGradient(cx - R, cy + R, cx + R, cy - R);
      grad.addColorStop(0, '#ffc53d');
      grad.addColorStop(1, '#ff3b2f');
      ctx.strokeStyle = grad;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, end);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx + Math.cos(end) * R, cy + Math.sin(end) * R, S * 0.018, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `italic 900 ${S * 0.25}px "Saira Condensed", Rajdhani, sans-serif`;
    ctx.fillText(speedText, cx, cy - S * 0.02);
    const gw = S * 0.14;
    const gy = cy + S * 0.25;
    ctx.fillStyle = hot ? '#ff3b2f' : 'rgba(255,255,255,0.1)';
    ctx.fillRect(cx - gw / 2, gy - gw / 2, gw, gw);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - gw / 2, gy - gw / 2, gw, gw);
    ctx.fillStyle = '#fff';
    ctx.font = `italic 900 ${S * 0.11}px "Saira Condensed", Rajdhani, sans-serif`;
    ctx.fillText(gearText, cx, gy + S * 0.005);
  }
}

/** Top-down track map with every car as a dot. */
class Minimap {
  readonly canvas = h('canvas');
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private size = 230;
  private scale = 1;
  private ox = 0;
  private oz = 0;

  constructor(private readonly track: TrackGeometry) {
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(cssSize: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size = cssSize;
    this.canvas.width = Math.round(cssSize * dpr);
    this.canvas.height = Math.round(cssSize * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const b = this.track.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    this.scale = (cssSize * 0.78) / span;
    this.ox = (b.minX + b.maxX) / 2;
    this.oz = (b.minZ + b.maxZ) / 2;
    // Pre-render the track outline.
    const base = document.createElement('canvas');
    base.width = this.canvas.width;
    base.height = this.canvas.height;
    const c = base.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineJoin = 'round';
    const path = () => {
      c.beginPath();
      const t = this.track;
      for (let i = 0; i <= t.count; i += 3) {
        const k = i % t.count;
        const [x, y] = this.map(t.pos[k * 3], t.pos[k * 3 + 2]);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.closePath();
    };
    path();
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = 9;
    c.stroke();
    path();
    c.strokeStyle = 'rgba(244,241,234,0.85)';
    c.lineWidth = 4;
    c.stroke();
    // Start line
    const [sx, sy] = this.map(this.track.pos[0], this.track.pos[2]);
    c.fillStyle = '#ff3b2f';
    c.fillRect(sx - 2, sy - 7, 4, 14);
    this.base = base;
  }

  private map(x: number, z: number): [number, number] {
    return [this.size / 2 + (x - this.ox) * this.scale, this.size / 2 + (z - this.oz) * this.scale];
  }

  draw(cars: Car[], player: Car | null): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.size, this.size);
    if (this.base) ctx.drawImage(this.base, 0, 0, this.size, this.size);
    for (const car of cars) {
      if (car === player) continue;
      const [x, y] = this.map(car.physics.position.x, car.physics.position.z);
      ctx.fillStyle = hex(car.color);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (player) {
      const [x, y] = this.map(player.physics.position.x, player.physics.position.z);
      const f = player.physics.forward;
      const a = Math.atan2(f.z, f.x);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillStyle = '#ff3b2f';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(-6, 5.5);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-6, -5.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}

/** In-race heads-up display. */
export class RaceHUD {
  readonly el: HTMLElement;
  private speedo = new Speedometer();
  private minimap: Minimap;
  private posEl = h('div', { class: 'hud-big' });
  private lapEl = h('div', { class: 'hud-big' });
  private timeEl = h('div', { class: 'main' });
  private lapTimeEl = h('b');
  private bestEl = h('b');
  private lastEl = h('b');
  private standingsEl = h('div', { class: 'standings' });
  private wrongWay = h('div', { class: 'wrongway' }, 'WRONG WAY');
  private hints: HTMLElement;
  private fpsEl = h('div', { class: 'fps' });
  private rows = new Map<Car, HTMLElement>();
  private standingsTimer = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  showFps = false;
  renderStats = { calls: 0, triangles: 0, scale: 1, gpuMs: NaN };
  /** Debug overlay data (F3 / Settings > FPS Counter). */
  debug = { frameMs: 0, cpuMs: 0, physicsMs: 0, physicsSteps: 0, objects: 0 };
  private worstFrame = 0;
  private speedoBox: HTMLElement;
  private textCache = new Map<HTMLElement, string>();
  private mapTimer = 0;

  /** Writes to the DOM only when the value changed (avoids per-frame style/layout work). */
  private set(el: HTMLElement, value: string, html = false): void {
    if (this.textCache.get(el) === value) return;
    this.textCache.set(el, value);
    if (html) el.innerHTML = value;
    else el.textContent = value;
  }
  private mapBox: HTMLElement;
  readonly arcade: ArcadeHUD;
  /** Style tracker of the current session (set by the game). */
  style: StyleTracker | null = null;

  constructor(track: TrackGeometry, isTouch = false) {
    this.arcade = new ArcadeHUD(isTouch);
    this.minimap = new Minimap(track);
    this.hints = h('div', {
      class: 'hints',
      html: '<span class="key">W</span> throttle &nbsp;<span class="key">S</span> brake &nbsp;<span class="key">A</span><span class="key">D</span> steer &nbsp;<span class="key">Space</span> + steer: drift → release = turbo<br><span class="key">E</span> use item &nbsp;<span class="key">R</span> reset car &nbsp;<span class="key">C</span> camera &nbsp;<span class="key">Esc</span> pause',
    });
    this.speedoBox = h('div', { class: 'speedo' }, this.speedo.canvas);
    this.mapBox = h('div', { class: 'minimap' }, this.minimap.canvas);
    this.el = h(
      'div',
      { class: 'screen hud' },
      h(
        'div',
        { class: 'tl' },
        h('div', { class: 'hud-box' }, h('div', {}, h('div', { class: 'hud-label' }, 'POSITION'), this.posEl)),
        h('div', { class: 'hud-box' }, h('div', {}, h('div', { class: 'hud-label' }, 'LAP'), this.lapEl)),
      ),
      h(
        'div',
        { class: 'timer' },
        this.timeEl,
        h('div', { class: 'rows' }, h('span', {}, 'LAP ', this.lapTimeEl), h('span', { class: 'best' }, 'BEST ', this.bestEl), h('span', {}, 'LAST ', this.lastEl)),
      ),
      this.standingsEl,
      this.mapBox,
      this.speedoBox,
      this.wrongWay,
      this.arcade.el,
      this.hints,
      this.fpsEl,
    );
  }

  /** Re-layout canvases for the current UI scale. */
  resize(): void {
    const s = this.speedoBox.clientWidth || 300;
    this.speedo.resize(s);
    this.minimap.resize(this.mapBox.clientWidth || 230);
  }

  hideHints(): void {
    this.hints.classList.add('hide');
  }

  showHints(): void {
    this.hints.classList.remove('hide');
  }

  resetRows(): void {
    this.arcade.reset();
    this.rows.clear();
    this.textCache.clear();
    this.standingsEl.replaceChildren();
  }

  update(rm: RaceManager, dt: number): void {
    const p = rm.player;
    if (!p) return;
    const prog = p.progress;
    const n = rm.cars.length;
    this.set(this.posEl, `${p.position}<span class="of">/${n}</span>`, true);
    this.set(this.lapEl, `${prog.currentLap}<span class="of">/${rm.race.laps}</span>`, true);
    const racing = rm.phase === 'racing' || rm.phase === 'finished';
    this.set(this.timeEl, formatTime(racing ? (prog.finished ? prog.finishTime : rm.raceTime) : 0).replace('--:--.---', '0:00.000'));
    this.set(this.lapTimeEl, racing && !prog.finished ? formatTime(rm.raceTime - prog.lapStartTime) : '--:--.---');
    this.set(this.bestEl, formatTime(prog.bestLapTime));
    this.set(this.lastEl, formatTime(prog.lastLapTime));
    const ww = prog.wrongWay && rm.phase === 'racing';
    if (this.wrongWay.classList.contains('on') !== ww) this.wrongWay.classList.toggle('on', ww);

    const ph = p.physics;
    this.arcade.update(dt, p, rm.items, this.style);
    this.speedo.draw(Math.abs(ph.forwardSpeed) * 3.6, ph.rpm, ph.def.redlineRPM, ph.gear, dt);
    // The minimap doesn't need 60+ Hz.
    this.mapTimer -= dt;
    if (this.mapTimer <= 0) {
      this.mapTimer = 1 / 30;
      this.minimap.draw(rm.cars, p);
    }

    this.standingsTimer -= dt;
    if (this.standingsTimer <= 0) {
      this.standingsTimer = 0.2;
      this.updateStandings(rm);
    }

    if (this.showFps) {
      this.fpsAcc += dt;
      this.fpsFrames++;
      this.worstFrame = Math.max(this.worstFrame, this.debug.frameMs);
      if (this.fpsAcc > 0.5) {
        const r = this.renderStats;
        const d = this.debug;
        const gpu = isFinite(r.gpuMs) ? `${r.gpuMs.toFixed(1)} ms` : 'n/a';
        this.fpsEl.textContent =
          `${Math.round(this.fpsFrames / this.fpsAcc)} FPS · frame ${d.frameMs.toFixed(1)} ms (worst ${this.worstFrame.toFixed(0)}) · ` +
          `CPU ${d.cpuMs.toFixed(1)} ms · physics ${d.physicsMs.toFixed(2)} ms/${d.physicsSteps} steps · GPU ${gpu} · ` +
          `${r.calls} calls · ${(r.triangles / 1e6).toFixed(2)}M tris · ${d.objects} objects · ${Math.round(r.scale * 100)}% res`;
        this.fpsAcc = 0;
        this.fpsFrames = 0;
        this.worstFrame = 0;
      }
    } else if (this.fpsEl.textContent) this.fpsEl.textContent = '';
  }

  private updateStandings(rm: RaceManager): void {
    const leader = rm.standings[0];
    rm.standings.forEach((car, i) => {
      let row = this.rows.get(car);
      if (!row) {
        row = h(
          'div',
          { class: `row ${car.isPlayer ? 'me' : ''}` },
          h('span', { class: 'p' }),
          h('span', { class: 'chip', style: `background:${hex(car.color)}` }),
          h('span', { class: 'n' }, car.name),
          h('span', { class: 'gap' }),
        );
        this.rows.set(car, row);
      }
      if (this.standingsEl.children[i] !== row) this.standingsEl.insertBefore(row, this.standingsEl.children[i] ?? null);
      this.set(row.children[0] as HTMLElement, String(i + 1));
      let gap = '';
      if (car.progress.finished) gap = car === leader ? formatTime(car.progress.finishTime) : '+' + (car.progress.finishTime - leader.progress.finishTime).toFixed(2);
      else if (car === leader) gap = rm.phase === 'racing' || rm.phase === 'finished' ? 'LEADER' : '';
      else {
        const lapsDown = Math.floor((leader.progress.raceDistance - car.progress.raceDistance) / rm.track.length);
        gap = lapsDown >= 1 ? `+${lapsDown} LAP` : rm.phase === 'racing' || rm.phase === 'finished' ? '+' + rm.gapToLeader(car).toFixed(1) : '';
      }
      this.set(row.children[3] as HTMLElement, gap);
    });
  }
}
