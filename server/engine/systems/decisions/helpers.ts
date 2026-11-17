/**
 * Small lookups and scoring helpers shared by the decision steps.
 */

import { CONFIG } from '../../../lib/constants';
import { distance } from '../../../lib/utils';
import type { LocationRow, RelRow } from './types';

// --- Helpers ---

export function nearestLocation(
  agentPos: { x: number; y: number },
  locs: LocationRow[],
  typeFilter: string | string[],
): LocationRow | null {
  const types = Array.isArray(typeFilter) ? typeFilter : [typeFilter];
  const candidates = locs.filter((l) => types.includes(l.type));
  if (candidates.length === 0) return null;

  let best: LocationRow | null = null;
  let bestDist = Infinity;
  for (const loc of candidates) {
    const d = distance(agentPos, loc.entry_point);
    if (d < bestDist) {
      bestDist = d;
      best = loc;
    }
  }
  return best;
}

export function getRelationshipValues(
  rels: RelRow[],
  agentId: number,
  otherId: number,
): { friendship: number; romance: number; trust: number } | null {
  for (const r of rels) {
    if (r.agent_a === agentId && r.agent_b === otherId) {
      return { friendship: r.friendship_ab, romance: r.romance_ab, trust: r.trust_ab };
    }
    if (r.agent_b === agentId && r.agent_a === otherId) {
      return { friendship: r.friendship_ba, romance: r.romance_ba, trust: r.trust_ba };
    }
  }
  return null;
}

export function addNoise(score: number): number {
  const noise = 1 + (Math.random() * 2 - 1) * CONFIG.DECISIONS.NOISE_FACTOR;
  return score * noise;
}

/** Crowd size past which a venue is "busy" and extra bodies stop mattering. */
const GATHERING_SATURATION = 4;
/** Score added to a saturated venue for an agent of average warmth. */
const GATHERING_MAX_BONUS = 22;

/**
 * How much more inviting a social venue looks for already having people in it.
 *
 * Venue scores were computed as if the town were empty, so every agent picked
 * independently and the square never accumulated anyone — it read as abandoned
 * even at peak hours. The pull also applies to agents already there, which is
 * what makes a gathering last instead of dissolving on the next decision tick.
 *
 * Square-root falloff keeps a packed tavern from outranking everything else,
 * and the warmth scaling means recluses are nudged, not herded.
 */
export function gatheringBonus(occupants: number, warmth: number): number {
  if (occupants <= 0) return 0;
  const crowd = Math.min(occupants, GATHERING_SATURATION) / GATHERING_SATURATION;
  const sociability = 0.4 + (Math.max(0, Math.min(100, warmth)) / 100) * 1.2;
  return GATHERING_MAX_BONUS * Math.sqrt(crowd) * sociability;
}

export function isEvening(hour: number): boolean {
  return hour >= 17 && hour < 22;
}
