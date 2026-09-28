import { h, formatTime } from './dom';
import type { RaceManager } from '../game/RaceManager';
import type { Car } from '../car/Car';
import type { TrackGeometry } from '../track/TrackGeometry';

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

/** Canvas tachometer + digital speed + gear. */
class Speedometer {
  readonly canvas = h('canvas');
  private ctx: CanvasRenderingContext2D;
  private size = 300;
  private shownSpeed = 0;
  private shownRpm = 0;

  constructor() {
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(cssSize: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size = cssSize;
    this.canvas.width = Math.round(cssSize * dpr);
    this.canvas.height = Math.round(cssSize * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(speedKmh: number, rpm: number, redline: number, gear: number, dt: number): void {
    const ctx = this.ctx;
    const S = this.size;
    const k = 1 - Math.exp(-14 * dt);
    this.shownSpeed += (speedKmh - this.shownSpeed) * k;
    this.shownRpm += (rpm - this.shownRpm) * k;
    ctx.clearRect(0, 0, S, S);
    const cx = S / 2;
    const cy = S / 2;
    const R = S * 0.44;
    const a0 = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    const maxRpm = Math.ceil(redline / 1000) * 1000 + 1000;

    // Backplate
    const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.12);
    g.addColorStop(0, 'rgba(10,11,14,0.85)');
    g.addColorStop(0.85, 'rgba(10,11,14,0.6)');
    g.addColorStop(1, 'rgba(10,11,14,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.12, 0, Math.PI * 2);
    ctx.fill();

    // Track arc
    ctx.lineCap = 'butt';
    ctx.lineWidth = S * 0.045;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a0 + sweep);
    ctx.stroke();
    // Red zone
    const rz = (redline - 500) / maxRpm;
    ctx.strokeStyle = 'rgba(255,59,47,0.45)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0 + sweep * rz, a0 + sweep);
    ctx.stroke();

    // RPM fill
    const f = Math.min(1, this.shownRpm / maxRpm);
    const hot = this.shownRpm > redline - 700;
    const grad = ctx.createLinearGradient(cx - R, cy + R, cx + R, cy - R);
    grad.addColorStop(0, '#ffc53d');
    grad.addColorStop(1, '#ff3b2f');
    ctx.strokeStyle = hot ? '#ff2a1f' : grad;
    ctx.shadowColor = hot ? 'rgba(255,40,30,0.9)' : 'rgba(255,120,40,0.6)';
    ctx.shadowBlur = hot ? 18 : 10;
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a0 + sweep * f);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Ticks and numbers
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
    // Needle tip marker
    const na = a0 + sweep * f;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx + Math.cos(na) * R, cy + Math.sin(na) * R, S * 0.018, 0, Math.PI * 2);
    ctx.fill();

    // Speed readout
    ctx.fillStyle = '#fff';
    ctx.font = `italic 900 ${S * 0.25}px "Saira Condensed", Rajdhani, sans-serif`;
    ctx.fillText(String(Math.round(this.shownSpeed)), cx, cy - S * 0.02);
    ctx.fillStyle = 'rgba(244,241,234,0.6)';
    ctx.font = `700 ${S * 0.055}px Rajdhani, sans-serif`;
    ctx.fillText('KM/H', cx, cy + S * 0.12);
    // Gear box
    const gw = S * 0.14;
    const gy = cy + S * 0.25;
    ctx.fillStyle = hot ? '#ff3b2f' : 'rgba(255,255,255,0.1)';
    ctx.fillRect(cx - gw / 2, gy - gw / 2, gw, gw);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - gw / 2, gy - gw / 2, gw, gw);
    ctx.fillStyle = '#fff';
    ctx.font = `italic 900 ${S * 0.11}px "Saira Condensed", Rajdhani, sans-serif`;
    ctx.fillText(gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear), cx, gy + S * 0.005);
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
  renderStats = { calls: 0, triangles: 0 };
  private speedoBox: HTMLElement;
  private mapBox: HTMLElement;

  constructor(track: TrackGeometry) {
    this.minimap = new Minimap(track);
    this.hints = h('div', {
      class: 'hints',
      html: '<span class="key">W</span> throttle &nbsp;<span class="key">S</span> brake / reverse &nbsp;<span class="key">A</span><span class="key">D</span> steer<br><span class="key">Space</span> handbrake &nbsp;<span class="key">R</span> reset car &nbsp;<span class="key">C</span> camera &nbsp;<span class="key">Esc</span> pause',
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
    this.rows.clear();
    this.standingsEl.replaceChildren();
  }

  update(rm: RaceManager, dt: number): void {
    const p = rm.player;
    if (!p) return;
    const prog = p.progress;
    const n = rm.cars.length;
    this.posEl.innerHTML = `${p.position}<span class="of">/${n}</span>`;
    this.lapEl.innerHTML = `${prog.currentLap}<span class="of">/${rm.race.laps}</span>`;
    const racing = rm.phase === 'racing' || rm.phase === 'finished';
    this.timeEl.textContent = formatTime(racing ? (prog.finished ? prog.finishTime : rm.raceTime) : 0).replace('--:--.---', '0:00.000');
    this.lapTimeEl.textContent = racing && !prog.finished ? formatTime(rm.raceTime - prog.lapStartTime) : '--:--.---';
    this.bestEl.textContent = formatTime(prog.bestLapTime);
    this.lastEl.textContent = formatTime(prog.lastLapTime);
    this.wrongWay.classList.toggle('on', prog.wrongWay && rm.phase === 'racing');

    const ph = p.physics;
    this.speedo.draw(Math.abs(ph.forwardSpeed) * 3.6, ph.rpm, ph.def.redlineRPM, ph.gear, dt);
    this.minimap.draw(rm.cars, p);

    this.standingsTimer -= dt;
    if (this.standingsTimer <= 0) {
      this.standingsTimer = 0.2;
      this.updateStandings(rm);
    }

    if (this.showFps) {
      this.fpsAcc += dt;
      this.fpsFrames++;
      if (this.fpsAcc > 0.5) {
        this.fpsEl.textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} FPS · ${this.renderStats.calls} calls · ${(this.renderStats.triangles / 1e6).toFixed(2)}M tris`;
        this.fpsAcc = 0;
        this.fpsFrames = 0;
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
      (row.children[0] as HTMLElement).textContent = String(i + 1);
      let gap = '';
      if (car.progress.finished) gap = car === leader ? formatTime(car.progress.finishTime) : '+' + (car.progress.finishTime - leader.progress.finishTime).toFixed(2);
      else if (car === leader) gap = rm.phase === 'racing' || rm.phase === 'finished' ? 'LEADER' : '';
      else {
        const lapsDown = Math.floor((leader.progress.raceDistance - car.progress.raceDistance) / rm.track.length);
        gap = lapsDown >= 1 ? `+${lapsDown} LAP` : rm.phase === 'racing' || rm.phase === 'finished' ? '+' + rm.gapToLeader(car).toFixed(1) : '';
      }
      (row.children[3] as HTMLElement).textContent = gap;
    });
  }
}
