import type { TrackDefinition } from './types';

export const tracks: TrackDefinition[] = [
  {
    id: 'sunset-circuit',
    name: 'Sunset Circuit',
    location: 'Valle Dorado',
    description:
      'A flowing 2.7 km circuit carved into golden hills: a long pit straight, a climbing esses section, ' +
      'a fast crest, a tight chicane and a heavy-braking infield hairpin.',
    laps: 3,
    // Clockwise loop. First point sits on the start/finish line.
    controlPoints: [
      { x: -60, z: 0, y: 0 },
      { x: 80, z: 0, y: 0 },
      { x: 170, z: 0, y: 0.5 },
      { x: 245, z: 6, y: 1 },
      // Turn 1 — fast right
      { x: 300, z: 38, y: 2 },
      { x: 325, z: 95, y: 3 },
      { x: 330, z: 160, y: 5 },
      // Climbing esses
      { x: 300, z: 215, y: 7 },
      { x: 310, z: 270, y: 9 },
      { x: 345, z: 320, y: 10 },
      // Turn 5 — right onto the back straight
      { x: 340, z: 385, y: 11 },
      { x: 290, z: 420, y: 12 },
      // Back straight over the crest
      { x: 200, z: 425, y: 13 },
      { x: 100, z: 420, y: 14 },
      { x: 20, z: 420, y: 12 },
      // Chicane
      { x: -40, z: 405, y: 10 },
      { x: -80, z: 430, y: 9 },
      { x: -140, z: 425, y: 8 },
      // Downhill run to the west end
      { x: -250, z: 420, y: 6 },
      { x: -340, z: 400, y: 5 },
      { x: -385, z: 350, y: 4 },
      { x: -380, z: 290, y: 4 },
      // Infield
      { x: -340, z: 258, y: 4 },
      { x: -250, z: 249, y: 4 },
      { x: -178, z: 248, y: 4 },
      // Hairpin
      { x: -141.6, z: 240.4, y: 4 },
      { x: -134, z: 222, y: 4 },
      { x: -141.6, z: 203.6, y: 4 },
      { x: -162, z: 196, y: 4 },
      { x: -260, z: 199, y: 3 },
      // Final sweepers
      { x: -310, z: 150, y: 2.5 },
      { x: -325, z: 90, y: 1.5 },
      { x: -320, z: 35, y: 0.5 },
      { x: -280, z: 5, y: 0 },
      { x: -170, z: 0, y: 0 },
    ],
    roadWidth: 14,
    barrierOffset: 16,
    checkpointCount: 8,
    curbCurvature: 1 / 170,
    gridSpacing: 9,
    theme: 'sunset-hills',
    environment: {
      sunElevation: 9,
      sunAzimuth: 235,
      fogColor: 0xe7b58f,
      fogNear: 250,
      fogFar: 1600,
      turbidity: 4.5,
      rayleigh: 2.2,
      exposure: 0.62,
    },
    terrain: { seed: 7, hilliness: 1, size: 1800 },
    scenery: { treeCount: 1700, rockCount: 260, seed: 42 },
    difficulty: 3,
  },
];

export function getTrack(id: string): TrackDefinition {
  const t = tracks.find((tr) => tr.id === id);
  if (!t) throw new Error(`Unknown track: ${id}`);
  return t;
}
