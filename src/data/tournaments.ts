import type { TournamentDefinition } from './types';

/**
 * Tournament data. Not playable yet — the menu shows "coming soon" — but the structure is in
 * place: a tournament is an ordered list of events (track + laps) with a points table.
 * Additional tracks just need to be added to `tracks.ts` and referenced here.
 */
export const tournaments: TournamentDefinition[] = [
  {
    id: 'golden-cup',
    name: 'Golden Hour Cup',
    description: 'A four-round championship across the Valle Dorado region.',
    events: [
      { trackId: 'sunset-circuit', laps: 3 },
      { trackId: 'sunset-circuit', laps: 4 },
      { trackId: 'sunset-circuit', laps: 5 },
      { trackId: 'sunset-circuit', laps: 3 },
    ],
    pointsTable: [25, 18, 15, 12, 10, 8, 6, 4],
    opponentProfileIds: ['vega', 'kowalski', 'tanaka', 'okafor', 'lindqvist'],
    allowedCarIds: 'all',
  },
];
