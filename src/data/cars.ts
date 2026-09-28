import type { CarDefinition } from './types';

export const cars: CarDefinition[] = [
  {
    id: 'falcon-r',
    name: 'Falcon R',
    manufacturer: 'Aurelian Motorworks',
    description: 'Mid-engined, rear-drive track weapon with a big rear wing and a hunger for apexes.',
    mass: 1250,
    powerKW: 420,
    acceleration: 8.6,
    topSpeed: 258,
    braking: 13.5,
    handling: 0.8,
    grip: 1.9,
    downforce: 1.1,
    frontDriveBias: 0.15,
    gearCount: 6,
    redlineRPM: 8200,
    idleRPM: 950,
    dimensions: {
      width: 1.96,
      length: 4.45,
      height: 1.16,
      wheelBase: 2.62,
      trackWidth: 1.66,
      wheelRadius: 0.34,
    },
    suspension: {
      restLength: 0.52,
      frequency: 1.9,
      damping: 0.45,
      antiRoll: 9000,
    },
    style: {
      bodyColor: 0xd81e2c,
      accentColor: 0x111111,
      rimColor: 0x9aa0a6,
      spoiler: 'wing',
    },
    stats: { speed: 8, acceleration: 8, handling: 7, braking: 7 },
  },
];

export function getCar(id: string): CarDefinition {
  const car = cars.find((c) => c.id === id);
  if (!car) throw new Error(`Unknown car: ${id}`);
  return car;
}
