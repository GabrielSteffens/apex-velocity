import type { CarController } from './CarController';
import type { CarInput } from './CarPhysics';
import type { Input } from '../core/Input';

/** Maps player input (keyboard / gamepad) to car controls. */
export class PlayerController implements CarController {
  readonly kind = 'player' as const;
  constructor(private readonly input: Input) {}

  update(_dt: number, out: CarInput): void {
    out.throttle = this.input.throttle;
    out.brake = this.input.brake;
    out.steer = this.input.steer;
    out.handbrake = this.input.handbrake;
    out.drift = this.input.handbrake;
    out.analog = this.input.steerIsAnalog;
  }
}
