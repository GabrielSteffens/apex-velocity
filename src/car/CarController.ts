import type { CarInput } from './CarPhysics';

/** Anything that drives a car: the human player, the AI, a replay, a network peer... */
export interface CarController {
  readonly kind: 'player' | 'ai';
  /** Called every fixed physics step; must write into `input`. */
  update(dt: number, input: CarInput): void;
  /** Called when the car is teleported back onto the track. */
  onReset?(): void;
}
