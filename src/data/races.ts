import type { RaceDefinition } from './types';
import { aiProfiles } from './aiProfiles';
import { getTrack } from './tracks';

export interface QuickRaceOptions {
  trackId: string;
  playerCarId: string;
  laps?: number;
  opponents: number;
}

/** Builds a single-race definition. Tournaments will call this once per event. */
export function createQuickRace(opts: QuickRaceOptions): RaceDefinition {
  const track = getTrack(opts.trackId);
  const count = Math.max(0, Math.min(opts.opponents, aiProfiles.length));
  // Slower drivers start at the front so the field has to fight its way through.
  const field = aiProfiles.slice(0, count).sort((a, b) => a.skill - b.skill);
  // Opponents all drive the balanced Falcon R (the racing line is tuned for it); the player's
  // car choice changes their own strengths and weaknesses.
  const ai = field.map((p) => ({ carId: 'falcon-r', aiProfileId: p.id, color: p.color, name: p.driverName }));
  // Player starts at the back of the grid to make the race interesting.
  return {
    trackId: track.id,
    laps: opts.laps ?? track.laps,
    participants: [...ai, { carId: opts.playerCarId, aiProfileId: null, name: 'YOU' }],
  };
}
