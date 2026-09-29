import * as THREE from 'three';
import type { RaceDefinition } from '../data/types';
import { RaceManager } from './RaceManager';
import type { TrackScene } from './TrackScene';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { SURFACES } from '../physics/PhysicsWorld';
import { CarVisual } from '../car/CarVisual';
import { PlayerController } from '../car/PlayerController';
import { AIController } from '../ai/AIController';
import type { Input } from '../core/Input';
import type { AudioManager } from '../audio/AudioManager';
import type { ParticleManager } from '../effects/ParticleManager';
import type { SkidMarks } from '../effects/SkidMarks';
import type { ChaseCamera } from '../camera/ChaseCamera';
import type { Car } from '../car/Car';
import { CarGroundFx } from '../effects/CarGroundFx';
import { StyleTracker, type StylePopup } from '../gameplay/Style';
import { GameplayVisuals } from '../gameplay/GameplayVisuals';
import { ITEM_INFO } from '../gameplay/Items';

export interface SessionServices {
  scene: THREE.Scene;
  physics: PhysicsWorld;
  trackScene: TrackScene;
  input: Input;
  audio: AudioManager;
  particles: ParticleManager;
  skids: SkidMarks;
  camera: ChaseCamera;
}

export interface SessionUIHooks {
  countdown(value: number): void;
  go(): void;
  toast(text: string, sub?: string): void;
  playerFinished(position: number): void;
  raceComplete(): void;
  popup(p: StylePopup, combo: number): void;
  banner(text: string, sub: string, color: string): void;
}

const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const _n = new THREE.Vector3();
const _pt = { x: 0, y: 0, z: 0 };
const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();

interface CarFx {
  lastGear: number;
  smokeAcc: number;
  exhaustAcc: number;
  lastImpact: number;
}

/**
 * One race: owns the RaceManager and the per-car visuals, and wires race events to
 * audio, particles, camera shake and the UI.
 */
export class RaceSession {
  readonly rm: RaceManager;
  private visuals: CarVisual[] = [];
  private groundFx: CarGroundFx;
  private fx = new Map<Car, CarFx>();
  private unsubscribe: () => void;
  private time = 0;
  private otherA = { rpm: 0, load: 0, distance: 0, pan: 0 };
  private otherB = { rpm: 0, load: 0, distance: 0, pan: 0 };
  private othersBuf: { rpm: number; load: number; distance: number; pan: number }[] = [];
  readonly style: StyleTracker | null = null;
  private gfx: GameplayVisuals;
  private lastBoost = new Map<Car, number>();
  private sparkAcc = 0;
  private prevSinceLanding = 99;

  constructor(
    private readonly svc: SessionServices,
    race: RaceDefinition,
    aiPace: number,
    ui: SessionUIHooks,
  ) {
    const ts = svc.trackScene;
    this.rm = new RaceManager(svc.physics, ts.track, ts.layout, race, ts.line);
    this.rm.cars.forEach((car, i) => {
      if (car.isPlayer) car.controller = new PlayerController(svc.input);
      else if (car.controller instanceof AIController) car.controller.paceScale = aiPace;
      this.visuals.push(new CarVisual(car, svc.scene, car.isPlayer ? 7 : i + 11));
      this.fx.set(car, { lastGear: 1, smokeAcc: 0, exhaustAcc: 0, lastImpact: 0 });
    });
    ts.scenery.setStartLights(0, false);
    this.gfx = new GameplayVisuals(this.rm.items, svc.particles);
    svc.scene.add(this.gfx.group);
    if (this.rm.player) {
      const style = new StyleTracker(this.rm.player, this.rm);
      style.onPopup = (p) => {
        ui.popup(p, style.combo);
        svc.audio.popup(p.tier, style.combo);
        if (p.tier === 'epic') svc.input.rumble(0.4, 0.6, 180);
      };
      style.onComboBanked = (mult, bonus) => {
        ui.banner(`COMBO x${mult.toFixed(1).replace('.0', '')}`, `+${bonus.toLocaleString('en-US')}`, '#ffc53d');
        svc.audio.comboBanked(mult);
      };
      style.onComboLost = () => {
        ui.banner('COMBO BROKEN', '', '#ff3b2f');
        svc.audio.comboLost();
      };
      this.style = style;
    }
    this.wireGameplay(ui);
    this.groundFx = new CarGroundFx(this.rm.cars);
    svc.scene.add(this.groundFx.group);

    const byCollider = new Map(this.rm.cars.map((c) => [c.physics.collider.handle, c]));
    const barriers = ts.colliders.barrierHandles;
    this.unsubscribe = svc.physics.onContactForce((e) => {
      const a = byCollider.get(e.colliderA);
      const b = byCollider.get(e.colliderB);
      if (!a && !b) return;
      const wall = barriers.has(e.colliderA) || barriers.has(e.colliderB);
      if (!wall && !(a && b)) return; // ground contacts are handled by suspension
      const car = (a ?? b)!;
      this.onImpact(car, a && b ? (car === a ? b : a) : null, e.force, e.colliderA, e.colliderB, wall);
    });

    this.rm.events = {
      countdown: (v) => {
        ts.scenery.setStartLights(Math.round(((4 - v) * 5) / 3), false);
        svc.audio.countdownBeep(false);
        ui.countdown(v);
      },
      go: () => {
        ts.scenery.setStartLights(0, true);
        svc.audio.countdownBeep(true);
        ui.go();
      },
      lap: (car, t, best) => {
        if (!car.isPlayer) return;
        svc.audio.lap();
        const lapNo = car.progress.lapsCompleted;
        if (best && lapNo > 1) ui.toast('Best Lap', formatLap(t));
        else ui.toast(`Lap ${lapNo + 1}`, formatLap(t));
      },
      finalLap: (car) => {
        if (car.isPlayer) setTimeout(() => ui.toast('Final Lap', 'Push!'), 1200);
      },
      finish: (car, pos) => {
        if (!car.isPlayer) return;
        svc.audio.finish(pos === 1);
        ui.playerFinished(pos);
      },
      complete: () => ui.raceComplete(),
      reset: (car) => {
        // Soft re-acquire: the camera glides to the new position instead of cutting.
        if (car.isPlayer) svc.camera.snap();
      },
    };
  }

  /** Items, boost pads and shortcuts -> sound, particles, camera, score, UI. */
  private wireGameplay(ui: SessionUIHooks): void {
    const { audio, particles, camera, input } = this.svc;
    const near = (c: Car, r = 70) => c.isPlayer || camera.camera.position.distanceTo(c.physics.position) < r;
    const style = () => this.style;
    this.rm.items.events = {
      pickup: (car, box) => {
        if (near(car, 40)) particles.coloredSparks(box.pos, car.physics.velocity.clone().multiplyScalar(0.3), 1, 0.8, 0.3, 14, 6, 0.4, 0.1);
        if (car.isPlayer) audio.itemPickup();
      },
      ready: (car) => {
        if (car.isPlayer) audio.itemReady();
      },
      use: (car, item) => {
        const pl = car.isPlayer;
        const vol = pl ? 1 : Math.max(0, 1 - camera.camera.position.distanceTo(car.physics.position) / 60);
        if (vol <= 0) return;
        if (item === 'nitro') audio.boost(1.2 * vol);
        else if (item === 'missile') audio.missile();
        else if (item === 'shield') audio.shield();
        else if (item === 'oil') audio.oil();
        else if (item === 'overdrive') audio.overdrive();
        else if (item === 'emp') audio.emp();
        if (pl && (item === 'nitro' || item === 'overdrive')) {
          camera.shake(0.12);
          input.rumble(0.3, 0.8, 300);
        }
      },
      hit: (target, by, item) => {
        if (near(target)) particles.explosion(target.physics.position);
        if (near(target, 90)) audio.explosion(target.isPlayer ? 1 : 0.5);
        if (target.isPlayer) {
          camera.shake(0.7);
          input.rumble(1, 0.8, 450);
          ui.banner('SPUN OUT!', `${ITEM_INFO[item].name}${by ? ' · ' + by.name : ''}`, '#ff3b2f');
          style()?.crash();
        } else if (by?.isPlayer) {
          const st = style();
          st?.stats && st.stats.hits++;
          st?.add(item === 'missile' ? 'DIRECT HIT' : item === 'emp' ? 'EMP SHOCK' : 'OIL SPIN', item === 'missile' ? 400 : 300, 'great');
        }
      },
      blocked: (target) => {
        if (near(target)) audio.shieldBlock();
        if (target.isPlayer) {
          const st = style();
          if (st) st.stats.blocks++;
          st?.add('BLOCKED', 200, 'good');
        }
      },
      explode: (pos) => {
        if (camera.camera.position.distanceTo(pos) < 90) particles.explosion(pos);
      },
      emp: (car, radius) => this.gfx.ring(car.physics.position, radius),
    };
    this.rm.features.events = {
      boostPad: (car, pad) => {
        if (near(car, 50)) particles.coloredSparks(pad.pos, car.physics.velocity.clone().multiplyScalar(0.4), 0.4, 0.9, 1, 18, 5, 0.35, 0.09);
        if (car.isPlayer) {
          audio.boost(0.7);
          input.rumble(0.2, 0.5, 200);
          const st = style();
          if (st) st.stats.pads++;
          st?.add('BOOST', 50, 'small');
        }
      },
      shortcut: (car) => {
        if (!car.isPlayer) return;
        const st = style();
        if (st) st.stats.shortcuts++;
        st?.add('SHORTCUT!', 750, 'epic');
      },
    };
  }

  /** Player pressed the item button. */
  useItem(): void {
    const p = this.rm.player;
    if (p && this.rm.phase === 'racing') this.rm.items.use(p);
  }

  /** Scene-captured reflections on every car's glossy materials. */
  setEnvMap(env: THREE.Texture | null, intensity: number): void {
    for (const v of this.visuals) {
      v.parts.root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!(m instanceof THREE.MeshStandardMaterial)) continue;
          m.userData.baseEnv ??= m.envMapIntensity;
          m.envMap = env;
          m.envMapIntensity = m.userData.baseEnv * (env ? intensity : 1);
        }
      });
    }
  }

  /** Headlights on/off for every car (real spotlight only on the player's car). */
  setNight(on: boolean): void {
    for (const v of this.visuals) v.setNight(on, v.car.isPlayer);
    this.groundFx.setNight(on);
  }

  get player(): Car | null {
    return this.rm.player;
  }

  startCountdown(): void {
    this.rm.startCountdown();
  }

  fixedStep(dt: number): void {
    this.rm.step(dt);
    this.svc.physics.step();
    this.rm.postStep(dt);
  }

  private onImpact(car: Car, other: Car | null, force: number, ca: number, cb: number, wall: boolean): void {
    const f = this.fx.get(car);
    if (!f) return;
    if (this.time - f.lastImpact < 0.12) return;
    f.lastImpact = this.time;
    const strength = Math.min(1, force / (car.physics.def.mass * 90));
    if (strength < 0.04) return;
    const found = this.svc.physics.contactPoint(ca, cb, _pt);
    _p.set(_pt.x, _pt.y, _pt.z);
    if (!found) _p.copy(car.physics.position);
    // Spark direction: away from the barrier / other car, roughly along travel.
    _n.copy(car.physics.velocity).multiplyScalar(0.05);
    if (strength > 0.08) this.svc.particles.sparksAt(_p, _n, strength);
    const involvesPlayer = car.isPlayer || other?.isPlayer;
    if (this.style && car.isPlayer) {
      this.style.contact(other);
      if (wall && strength > 0.45) this.style.crash();
    } else if (this.style && other?.isPlayer) this.style.contact(car);
    // Shield bash: a shielded car knocks rivals into a spin.
    if (other && strength > 0.15) {
      const items = this.rm.items;
      for (const [a, b] of [[car, other], [other, car]] as const) {
        if (items.get(a).shield > 0 && items.get(b).shield <= 0 && b.physics.stunTime <= 0) {
          b.physics.stun(0.8);
          if (a.isPlayer) this.style?.add('SHIELD BASH', 300, 'great');
          if (b.isPlayer) this.svc.camera.shake(0.5);
        }
      }
    }
    if (car.physics.drifting && wall && strength > 0.3) car.physics.endDrift(false);
    const cam = this.svc.camera.camera.position;
    const dist = cam.distanceTo(_p);
    if (involvesPlayer) {
      this.svc.camera.shake(0.15 + strength * 0.6);
      this.svc.audio.impact(strength, wall);
    } else if (dist < 60) {
      this.svc.audio.impact(strength * (1 - dist / 60) * 0.6, wall);
    }
  }

  /** Per-frame (not per physics step) update: visuals, effects and audio. */
  frameUpdate(dt: number, alpha: number): void {
    this.time += dt;
    const { particles, skids, audio } = this.svc;
    if (dt > 0) {
      this.style?.update(dt);
      this.gfx.update(dt, this.rm.cars);
      this.arcadeFx(dt);
    }
    const racing = this.rm.phase !== 'grid';
    let playerSkid = 0;
    let playerRough = 0;
    for (const car of this.rm.cars) {
      car.visual?.sync(alpha, dt);
      const ph = car.physics;
      const f = this.fx.get(car)!;
      const near = this.svc.camera.camera.position.distanceToSquared(ph.position) < 160 * 160;
      let skidSum = 0;
      for (let i = 0; i < 4; i++) {
        const w = ph.wheels[i];
        if (!w.grounded) {
          skids.add(car.id * 4 + i, w.contact, _side, 0.12, 0);
          continue;
        }
        const surf = SURFACES[w.surface];
        // Only slides past the tyre's peak slip angle mark the road / smoke.
        const lat = Math.min(1, Math.max(0, w.slipRatio - 1.15) * 1.2) * Math.min(1, w.slipLateral / 3);
        const handbrake = ph.input.handbrake && !w.front && ph.speed > 3 && ph.enabled ? 0.6 : 0;
        const spin = Math.min(1, w.slipLong * 0.6);
        const intensity = Math.min(1, lat + handbrake + spin);
        // Wheel lateral axis (car right rotated by steer)
        _side.set(-1, 0, 0).applyQuaternion(ph.quaternion);
        if (w.front) _side.applyAxisAngle(ph.up, -ph.steerAngle);
        if (!surf.dust) {
          skids.add(car.id * 4 + i, w.contact, _side, 0.12, intensity > 0.2 ? intensity : 0);
          skidSum += intensity;
          if (near && intensity > 0.3) {
            f.smokeAcc += dt * intensity * 22;
            while (f.smokeAcc > 1) {
              f.smokeAcc -= 1;
              particles.tireSmoke(w.contact, ph.velocity, intensity);
            }
          }
        } else {
          skids.add(car.id * 4 + i, w.contact, _side, 0.12, 0);
          if (near && ph.speed > 4) {
            f.smokeAcc += dt * Math.min(1, ph.speed / 25) * 6;
            while (f.smokeAcc > 1) {
              f.smokeAcc -= 1;
              particles.dust(w.contact, ph.velocity, Math.min(1, ph.speed / 20));
            }
          }
          if (car.isPlayer) playerRough = Math.max(playerRough, surf.roughness);
        }
        if (car.isPlayer && w.surface === 'curb') playerRough = Math.max(playerRough, SURFACES.curb.roughness * 0.8);
      }
      if (car.isPlayer) playerSkid = Math.min(1, skidSum / 2);

      // Exhaust puffs and up-shift pops
      if (near && car.visual) {
        const vis = car.visual as CarVisual;
        f.exhaustAcc += dt * (4 + ph.engineLoad * 18);
        const shifted = ph.gear > f.lastGear && ph.gear > 1;
        _dir.copy(ph.forward).negate();
        for (const e of vis.parts.exhausts) {
          _v.copy(e).applyQuaternion(ph.quaternion).add(ph.position);
          if (f.exhaustAcc > 1) particles.exhaust(_v, _dir, 0.4 + ph.engineLoad);
          if (shifted && ph.engineLoad > 0.6) particles.flame(_v, _dir);
        }
        if (shifted && ph.engineLoad > 0.6 && car.isPlayer) audio.backfire();
        if (f.exhaustAcc > 1) f.exhaustAcc = 0;
      }
      f.lastGear = ph.gear;
    }
    skids.update();
    this.groundFx.update();

    // Audio mix
    const p = this.rm.player;
    if (p) {
      const cam = this.svc.camera.camera;
      const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion);
      // Two nearest opponents, found without allocating arrays every frame.
      let n0: Car | null = null;
      let n1: Car | null = null;
      let d0 = Infinity;
      let d1 = Infinity;
      for (const c of this.rm.cars) {
        if (c === p) continue;
        const d = c.physics.position.distanceTo(cam.position);
        if (d < d0) {
          n1 = n0;
          d1 = d0;
          n0 = c;
          d0 = d;
        } else if (d < d1) {
          n1 = c;
          d1 = d;
        }
      }
      const others = this.othersBuf;
      others.length = 0;
      this.fillOther(n0, d0, this.otherA, cam.position, right);
      this.fillOther(n1, d1, this.otherB, cam.position, right);
      audio.updateDriving({
        rpm: p.physics.rpm,
        load: p.physics.enabled ? p.physics.engineLoad : Math.min(1, this.svc.input.throttle),
        speed: p.physics.speed,
        skid: playerSkid,
        rough: playerRough,
        others,
        active: racing,
      });
    }
  }

  /** Boost flames, drift charge sparks, landing thumps, drift-release kicks. */
  private arcadeFx(dt: number): void {
    const { particles, audio, camera, input } = this.svc;
    this.sparkAcc += dt;
    const emitSparks = this.sparkAcc > 1 / 40;
    if (emitSparks) this.sparkAcc = 0;
    for (const car of this.rm.cars) {
      const ph = car.physics;
      const near = car.isPlayer || camera.camera.position.distanceToSquared(ph.position) < 90 * 90;
      // Boost start (drift release or pad/item) -> sound + kick
      const prev = this.lastBoost.get(car) ?? 0;
      if (ph.boostTime > prev + 0.25 && car.isPlayer) {
        camera.shake(0.08);
        if (prev <= 0) audio.boost(Math.min(1.3, ph.boostTime));
        input.rumble(0.2, 0.6, 220);
      }
      this.lastBoost.set(car, ph.boostTime);
      if (!near || !car.visual || !emitSparks) continue;
      const vis = car.visual as CarVisual;
      if (ph.boostTime > 0 || ph.overdriveTime > 0) {
        _dir.copy(ph.forward).negate();
        for (const e of vis.parts.exhausts) {
          _v.copy(e).applyQuaternion(ph.quaternion).add(ph.position);
          if (ph.boostTime > 0) particles.coloredSparks(_v, _p.copy(_dir).multiplyScalar(8).add(ph.velocity), 0.35, 0.75, 1, 3, 2, 0.18, 0.2);
          else particles.flame(_v, _dir);
        }
      }
      if (ph.drifting && ph.driftLevel > 0 && ph.groundedWheels > 0) {
        const c = [[1, 1, 1], [0.3, 0.65, 1], [1, 0.55, 0.12], [0.8, 0.35, 1]][ph.driftLevel];
        for (let i = 2; i < 4; i++) {
          const w = ph.wheels[i];
          if (w.grounded) particles.coloredSparks(w.contact, _p.copy(ph.velocity).multiplyScalar(0.3), c[0], c[1], c[2], 2 + ph.driftLevel, 4, 0.28, 0.06 + ph.driftLevel * 0.015);
        }
      }
    }
    const p = this.rm.player;
    if (p) {
      const since = p.physics.sinceLanding;
      if (since < this.prevSinceLanding) {
        camera.shake(0.25);
        audio.landing(0.6);
        input.rumble(0.6, 0.3, 160);
      }
      this.prevSinceLanding = since;
    }
  }

  private fillOther(c: Car | null, d: number, slot: { rpm: number; load: number; distance: number; pan: number }, camPos: THREE.Vector3, right: THREE.Vector3): void {
    if (!c) return;
    slot.rpm = c.physics.rpm;
    slot.load = c.physics.engineLoad;
    slot.distance = d;
    slot.pan = Math.max(-1, Math.min(1, _p.copy(c.physics.position).sub(camPos).normalize().dot(right)));
    this.othersBuf.push(slot);
  }

  dispose(): void {
    this.unsubscribe();
    this.gfx.dispose();
    this.groundFx.dispose();
    this.rm.dispose();
    this.visuals = [];
    this.svc.skids.clear();
    this.svc.trackScene.scenery.setStartLights(0, false);
  }
}

function formatLap(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
