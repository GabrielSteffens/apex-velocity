import * as THREE from 'three';
import type { Car } from '../car/Car';
import type { TrackGeometry } from '../track/TrackGeometry';
import { Random } from '../core/math';

export type ItemType = 'nitro' | 'missile' | 'shield' | 'oil' | 'overdrive' | 'emp';

export const ITEMS: ItemType[] = ['nitro', 'missile', 'shield', 'oil', 'overdrive', 'emp'];

export const ITEM_INFO: Record<ItemType, { name: string; color: string; hint: string }> = {
  nitro: { name: 'NITRO', color: '#28c8ff', hint: 'Huge burst of speed — blasts through dirt and grass' },
  missile: { name: 'MISSILE', color: '#ff4a2f', hint: 'Homes in on the car ahead and spins it out' },
  shield: { name: 'SHIELD', color: '#7dffb0', hint: 'Blocks one hit · bash rivals out of your way' },
  oil: { name: 'OIL SLICK', color: '#c9a2ff', hint: 'Dropped behind you — anyone who hits it spins' },
  overdrive: { name: 'OVERDRIVE', color: '#ffb800', hint: '+speed, −steering: perfect on a straight, deadly in a corner' },
  emp: { name: 'EMP', color: '#5ef2ff', hint: 'Shocks every rival close to you' },
};

export interface ItemBox {
  pos: THREE.Vector3;
  active: boolean;
  respawn: number;
}

export interface Missile {
  owner: Car;
  target: Car | null;
  s: number;
  lateral: number;
  life: number;
  pos: THREE.Vector3;
  alive: boolean;
}

export interface OilSlick {
  owner: Car;
  pos: THREE.Vector3;
  life: number;
  armed: number;
  alive: boolean;
}

export interface CarItemState {
  slot: ItemType | null;
  /** Seconds left on the roulette (item not usable yet). */
  roulette: number;
  pending: ItemType | null;
  shield: number;
  /** Missile currently homing on this car. */
  targetedBy: Missile | null;
}

export interface ItemEvents {
  pickup?(car: Car, box: ItemBox): void;
  ready?(car: Car, item: ItemType): void;
  use?(car: Car, item: ItemType): void;
  hit?(target: Car, by: Car | null, item: ItemType): void;
  blocked?(target: Car, by: Car | null, item: ItemType): void;
  explode?(pos: THREE.Vector3): void;
  emp?(car: Car, radius: number): void;
}

const EMP_RADIUS = 20;
const MISSILE_SPEED = 92;
const _v = new THREE.Vector3();

/**
 * Arcade items: boxes on the track, a one-item slot per car with a short roulette,
 * and the effects (missiles, oil slicks, EMP, shields, nitro, overdrive).
 *
 * Distribution depends on race position: the leader mostly gets defensive items,
 * cars at the back get the tools to come back (controlled chaos, not a lottery).
 * Pure logic, no rendering, so the headless race sim exercises it too.
 */
export class ItemSystem {
  readonly boxes: ItemBox[] = [];
  readonly missiles: Missile[] = [];
  readonly slicks: OilSlick[] = [];
  readonly state = new Map<Car, CarItemState>();
  events: ItemEvents = {};
  private rng: Random;
  private time = 0;

  constructor(
    private readonly track: TrackGeometry,
    private readonly cars: Car[],
    seed = 7,
  ) {
    this.rng = new Random(seed);
    for (const s of track.def.gameplay?.itemRows ?? []) {
      for (const lat of [-5, -2.5, 0, 2.5, 5]) {
        const pos = track.offsetPoint(s, lat, new THREE.Vector3());
        pos.y = track.project(pos.x, pos.z).height + 1.1;
        this.boxes.push({ pos, active: true, respawn: 0 });
      }
    }
    for (const c of cars) this.state.set(c, { slot: null, roulette: 0, pending: null, shield: 0, targetedBy: null });
  }

  get(car: Car): CarItemState {
    return this.state.get(car)!;
  }

  /** Weighted roll by race position: 0 = leader, 1 = last. */
  roll(car: Car): ItemType {
    const n = this.cars.length;
    const f = n > 1 ? (car.position - 1) / (n - 1) : 0.5;
    const leader = car.position === 1;
    const w: Record<ItemType, number> = {
      nitro: 10 + 26 * f,
      missile: leader ? 0 : 6 + 28 * f,
      shield: 30 - 24 * f,
      oil: 30 - 24 * f,
      overdrive: f < 0.3 ? 0 : 26 * f,
      emp: 10 + 10 * f,
    };
    let total = 0;
    for (const k of ITEMS) total += w[k];
    let r = this.rng.next() * total;
    for (const k of ITEMS) {
      r -= w[k];
      if (r <= 0) return k;
    }
    return 'nitro';
  }

  /** Fixed-step update (pickups, projectiles, hazards). */
  step(dt: number, racing: boolean): void {
    this.time += dt;
    for (const b of this.boxes) {
      if (!b.active) {
        b.respawn -= dt;
        if (b.respawn <= 0) b.active = true;
      }
    }
    for (const car of this.cars) {
      const st = this.get(car);
      st.shield = Math.max(0, st.shield - dt);
      if (st.roulette > 0) {
        st.roulette -= dt;
        if (st.roulette <= 0) {
          st.roulette = 0;
          st.slot = st.pending;
          st.pending = null;
          if (st.slot) this.events.ready?.(car, st.slot);
        }
      }
      if (!racing) continue;
      const p = car.physics.position;
      for (const b of this.boxes) {
        if (!b.active) continue;
        const dx = b.pos.x - p.x;
        const dz = b.pos.z - p.z;
        if (dx * dx + dz * dz > 2.4 * 2.4 || Math.abs(b.pos.y - p.y) > 3) continue;
        b.active = false;
        b.respawn = 3.5;
        if (!st.slot && st.roulette <= 0 && !car.progress.finished) {
          st.pending = this.roll(car);
          st.roulette = car.isPlayer ? 1.5 : 0.9 + this.rng.next() * 0.8;
        }
        this.events.pickup?.(car, b);
      }
    }
    this.stepMissiles(dt);
    this.stepSlicks(dt);
  }

  /** Uses the car's item. Returns false if there was nothing to use. */
  use(car: Car): boolean {
    const st = this.get(car);
    const item = st.slot;
    if (!item || st.roulette > 0 || car.physics.stunTime > 0) return false;
    st.slot = null;
    const ph = car.physics;
    switch (item) {
      case 'nitro':
        ph.boost(1.9, 17);
        break;
      case 'overdrive':
        ph.overdriveTime = 5.5;
        break;
      case 'shield':
        st.shield = 10;
        break;
      case 'oil': {
        const pos = ph.position.clone().addScaledVector(ph.forward, -4.2);
        pos.y = this.track.project(pos.x, pos.z).height;
        this.slicks.push({ owner: car, pos, life: 30, armed: 0.6, alive: true });
        if (this.slicks.length > 8) this.slicks.shift();
        break;
      }
      case 'missile': {
        const ahead = this.carAhead(car);
        const m: Missile = {
          owner: car,
          target: ahead,
          s: car.progress.proj.s + 3,
          lateral: car.progress.proj.lateral,
          life: 7,
          pos: new THREE.Vector3(),
          alive: true,
        };
        this.track.offsetPoint(m.s, m.lateral, m.pos);
        m.pos.y = ph.position.y + 0.8;
        if (ahead) this.get(ahead).targetedBy = m;
        this.missiles.push(m);
        break;
      }
      case 'emp': {
        for (const o of this.cars) {
          if (o === car || o.progress.finished) continue;
          if (o.physics.position.distanceTo(ph.position) < EMP_RADIUS) this.strike(o, car, 'emp');
        }
        this.events.emp?.(car, EMP_RADIUS);
        break;
      }
    }
    this.events.use?.(car, item);
    return true;
  }

  /** The car directly ahead in the standings (within missile range). */
  carAhead(car: Car): Car | null {
    let best: Car | null = null;
    let bestDs = 320;
    for (const o of this.cars) {
      if (o === car || o.progress.finished) continue;
      const d = o.progress.raceDistance - car.progress.raceDistance;
      if (d > 1 && d < bestDs) {
        bestDs = d;
        best = o;
      }
    }
    return best;
  }

  /** Applies an item hit (shields absorb it). */
  strike(target: Car, by: Car | null, item: ItemType): void {
    const st = this.get(target);
    if (st.shield > 0) {
      st.shield = 0;
      this.events.blocked?.(target, by, item);
      return;
    }
    const dur = item === 'missile' ? 1.5 : item === 'emp' ? 1.0 : 1.2;
    target.physics.stun(dur);
    this.events.hit?.(target, by, item);
  }

  private stepMissiles(dt: number): void {
    const t = this.track;
    for (const m of this.missiles) {
      if (!m.alive) continue;
      m.life -= dt;
      m.s = t.wrapS(m.s + MISSILE_SPEED * dt);
      let wantLat = t.halfWidth * 0;
      const tg = m.target;
      if (tg && !tg.progress.finished) {
        wantLat = tg.progress.proj.lateral;
        const ds = t.deltaS(m.s, tg.progress.proj.s);
        if (ds < 1.5 && ds > -4 && Math.abs(tg.progress.proj.lateral - m.lateral) < 2.2) {
          m.alive = false;
          this.get(tg).targetedBy = null;
          this.strike(tg, m.owner, 'missile');
          this.events.explode?.(tg.physics.position);
          continue;
        }
      }
      const k = 1 - Math.exp(-5 * dt);
      m.lateral += (wantLat - m.lateral) * k;
      t.offsetPoint(m.s, m.lateral, _v);
      const y = t.project(_v.x, _v.z).height + 0.8;
      m.pos.set(_v.x, y, _v.z);
      // Unguided missiles hit anyone they run into.
      if (!tg) {
        for (const o of this.cars) {
          if (o === m.owner) continue;
          if (o.physics.position.distanceToSquared(m.pos) < 2.2 * 2.2) {
            m.alive = false;
            this.strike(o, m.owner, 'missile');
            this.events.explode?.(m.pos);
            break;
          }
        }
      }
      if (m.alive && m.life <= 0) {
        m.alive = false;
        if (tg) this.get(tg).targetedBy = null;
        this.events.explode?.(m.pos);
      }
    }
    for (let i = this.missiles.length - 1; i >= 0; i--) if (!this.missiles[i].alive) this.missiles.splice(i, 1);
  }

  private stepSlicks(dt: number): void {
    for (const o of this.slicks) {
      if (!o.alive) continue;
      o.life -= dt;
      o.armed -= dt;
      if (o.life <= 0) {
        o.alive = false;
        continue;
      }
      for (const c of this.cars) {
        if (c.physics.stunTime > 0) continue;
        if (o.armed > 0 && c === o.owner) continue;
        const p = c.physics.position;
        const dx = p.x - o.pos.x;
        const dz = p.z - o.pos.z;
        if (dx * dx + dz * dz < 2.1 * 2.1 && c.physics.groundedWheels > 0) {
          o.alive = false;
          this.strike(c, o.owner === c ? null : o.owner, 'oil');
          break;
        }
      }
    }
    for (let i = this.slicks.length - 1; i >= 0; i--) if (!this.slicks[i].alive) this.slicks.splice(i, 1);
  }
}
