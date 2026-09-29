/**
 * Data-driven definitions. Everything the game needs to set up a race is described by
 * plain data objects so new cars, tracks, AI personalities and tournaments can be added
 * without touching gameplay code.
 */

export interface CarDefinition {
  id: string;
  name: string;
  manufacturer: string;
  description: string;
  /** Mass in kg. */
  mass: number;
  /** Peak engine power in kW (drives the power-limited part of the force curve). */
  powerKW: number;
  /** Longitudinal acceleration cap at low speed (m/s^2) — simulates traction limit. */
  acceleration: number;
  /** Top speed in km/h (drag is derived so that power and drag balance at this speed). */
  topSpeed: number;
  /** Braking deceleration in m/s^2. */
  braking: number;
  /** 0..1 — steering response speed and lock. */
  handling: number;
  /** Tyre friction coefficient (arcade — above 1 is normal here). */
  grip: number;
  /** Downforce coefficient (N per (m/s)^2). */
  downforce: number;
  /** Fraction of drive torque to the front axle (0 = RWD, 1 = FWD). */
  frontDriveBias: number;
  gearCount: number;
  redlineRPM: number;
  idleRPM: number;
  dimensions: {
    width: number;
    length: number;
    height: number;
    wheelBase: number;
    trackWidth: number;
    wheelRadius: number;
  };
  suspension: {
    restLength: number;
    /** Natural frequency in Hz. */
    frequency: number;
    /** Damping ratio (0..1). */
    damping: number;
    antiRoll: number;
  };
  /** Visual style hints for the procedural model. */
  style: {
    bodyColor: number;
    accentColor: number;
    rimColor: number;
    spoiler: 'wing' | 'ducktail' | 'none';
  };
  /** Stat bars for the garage screen (0..10). */
  stats: { speed: number; acceleration: number; handling: number; braking: number; drift: number; offroad: number };
  /** Arcade personality multipliers (default 1). */
  arcade?: {
    /** How tight drifts can turn. */
    driftTurn?: number;
    /** How fast drift charge builds. */
    driftCharge?: number;
    /** Boost thrust (pads, drift turbos, nitro). */
    boostPower?: number;
    /** Share of the off-road penalty felt (0 = none, 1 = full). */
    offroad?: number;
  };
  /** Player level needed to unlock (1 = from the start). */
  unlockLevel: number;
  /** Short playstyle tag for the garage. */
  role: string;
}

export interface TrackControlPoint {
  x: number;
  z: number;
  /** Elevation in meters. */
  y: number;
}

export type TimeOfDay = 'sunset' | 'night';

/** Everything that defines the look of a time of day: sky, key light, fog, trackside lights. */
export interface EnvironmentPreset {
  sky: 'physical' | 'night';
  /** Direction of the key light (sun, or the floodlights' dominant direction at night). */
  sunElevation: number;
  sunAzimuth: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  /** Physical sky parameters (sky: 'physical'). */
  turbidity: number;
  rayleigh: number;
  exposure: number;
  envIntensity: number;
  /** Distant mountain silhouettes: near and far ridge colours. */
  mountainColors: [number, number];
  /** Floodlight towers and car headlights switched on. */
  lightsOn: boolean;
  /** Night sky: moon direction. */
  moonElevation?: number;
  moonAzimuth?: number;
  /** Tint applied to smoke / dust sprites. */
  particleLight: number;
}

export type SceneryTheme = 'sunset-hills' | 'desert' | 'alpine' | 'city-night';

export interface TrackDefinition {
  id: string;
  name: string;
  location: string;
  description: string;
  /** Default number of laps. */
  laps: number;
  /** Closed loop of control points, first point is the start/finish line. */
  controlPoints: TrackControlPoint[];
  roadWidth: number;
  /** Distance from centreline to the barriers. */
  barrierOffset: number;
  /** Number of sector checkpoints (excluding the finish line). */
  checkpointCount: number;
  /** Curvature above which curbs are placed (1 / radius). */
  curbCurvature: number;
  /** Arc length (meters) of the grid slots behind the line. */
  gridSpacing: number;
  theme: SceneryTheme;
  /** Lighting presets per time of day (see EnvironmentPreset). */
  environments: Record<TimeOfDay, EnvironmentPreset>;
  terrain: {
    seed: number;
    hilliness: number;
    size: number;
  };
  scenery: {
    treeCount: number;
    rockCount: number;
    seed: number;
  };
  /** Nominal lap length for UI, computed at runtime anyway. */
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** Arcade gameplay features: boost pads, item boxes, shortcuts. */
  gameplay?: TrackGameplay;
}

/** A cut across the infield: leaves the road at `fromS`, rejoins at `toS`. */
export interface ShortcutDef {
  name: string;
  fromS: number;
  toS: number;
  /** Path width in meters. */
  width: number;
  /** Kicker ramp at fraction `at` of the path. */
  ramp?: { at: number; height: number; length: number };
  /** Tyre-stack gate at fraction `at`, leaving a `gap` wide opening. */
  gate?: { at: number; gap: number };
}

export interface TrackGameplay {
  boostPads: { s: number; lateral: number }[];
  /** Arc lengths of item box rows. */
  itemRows: number[];
  shortcuts: ShortcutDef[];
}

export interface AIProfile {
  id: string;
  driverName: string;
  /** 0..1 — how close to the theoretical cornering limit the AI drives. */
  skill: number;
  /** 0..1 — willingness to attempt overtakes and hold position. */
  aggression: number;
  /** 0..1 — lower values = more variation lap-to-lap and more mistakes. */
  consistency: number;
  /** Mistakes per minute on average. */
  mistakeRate: number;
  /** Reaction delay for starts in seconds. */
  reactionTime: number;
  /** Preferred lateral bias on the racing line (-1 inside .. 1 outside). */
  lineBias: number;
  color: number;
  /** 0..1 — appetite for shortcuts and risky item plays. */
  risk?: number;
  /** Personality label shown in the UI. */
  style?: 'aggressive' | 'defensive' | 'risky' | 'fast' | 'chaotic';
}

export interface RaceParticipantConfig {
  carId: string;
  /** Null for the human player. */
  aiProfileId: string | null;
  color?: number;
  name?: string;
}

export interface RaceDefinition {
  trackId: string;
  laps: number;
  participants: RaceParticipantConfig[];
}

export interface TournamentEvent {
  trackId: string;
  laps: number;
}

export interface TournamentDefinition {
  id: string;
  name: string;
  description: string;
  events: TournamentEvent[];
  /** Points for finishing positions: index 0 = 1st place. */
  pointsTable: number[];
  opponentProfileIds: string[];
  allowedCarIds: string[] | 'all';
}
