import type { AIProfile } from './types';

/** Opponent personalities. Different skill/consistency values make the field spread out naturally. */
export const aiProfiles: AIProfile[] = [
  { id: 'vega', driverName: 'M. Vega', skill: 0.95, aggression: 0.75, consistency: 0.9, mistakeRate: 0.35, reactionTime: 0.18, lineBias: 0, color: 0x1f6fe0 },
  { id: 'kowalski', driverName: 'J. Kowalski', skill: 0.92, aggression: 0.55, consistency: 0.85, mistakeRate: 0.5, reactionTime: 0.24, lineBias: 0.15, color: 0xf2b705 },
  { id: 'tanaka', driverName: 'R. Tanaka', skill: 0.9, aggression: 0.85, consistency: 0.75, mistakeRate: 0.8, reactionTime: 0.2, lineBias: -0.15, color: 0x1a1a1a },
  { id: 'okafor', driverName: 'D. Okafor', skill: 0.88, aggression: 0.45, consistency: 0.9, mistakeRate: 0.45, reactionTime: 0.3, lineBias: 0.1, color: 0x14a37f },
  { id: 'lindqvist', driverName: 'E. Lindqvist', skill: 0.86, aggression: 0.6, consistency: 0.7, mistakeRate: 0.9, reactionTime: 0.27, lineBias: -0.1, color: 0xf0f0f0 },
  { id: 'moreau', driverName: 'C. Moreau', skill: 0.84, aggression: 0.7, consistency: 0.65, mistakeRate: 1.0, reactionTime: 0.33, lineBias: 0.2, color: 0xe86a10 },
  { id: 'silva', driverName: 'A. Silva', skill: 0.82, aggression: 0.5, consistency: 0.8, mistakeRate: 0.7, reactionTime: 0.35, lineBias: 0, color: 0x7b2fd0 },
];

export function getAIProfile(id: string): AIProfile {
  const p = aiProfiles.find((a) => a.id === id);
  if (!p) throw new Error(`Unknown AI profile: ${id}`);
  return p;
}
