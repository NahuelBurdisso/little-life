import type { AwarenessLevel } from './interactionConstants';
import { LOCATION_WITNESS_MODIFIERS, ACTION_AWARENESS } from './interactionConstants';

export interface WitnessResult {
  agent_id: number;
  awareness: AwarenessLevel;
}

export interface WitnessCandidate {
  id: number;
  current_action: { type?: string } | null;
  personality: { curiosity?: number } | null;
}

/**
 * Resolve which agents at the same location witnessed an interaction.
 * Returns list of witnesses with awareness levels.
 *
 * Formula (weighted sum, clamped):
 *   chance = clamp(
 *     visibility * 0.3 + locationMod * 0.3 + timeMod * 0.15 + curiosityFactor * 0.2 + actionAwareness * 0.25,
 *     0.05, 0.90
 *   )
 *
 * Awareness derived from roll margin:
 *   roll < chance * 0.5 → "saw"
 *   roll < chance * 0.8 → "heard"
 *   roll < chance       → "suspected"
 */
export function resolveWitnesses(
  visibility: number,
  locationType: string,
  participantIds: number[],
  candidates: WitnessCandidate[],
  isNight: boolean,
): WitnessResult[] {
  const witnesses: WitnessResult[] = [];

  const locationMod = LOCATION_WITNESS_MODIFIERS[locationType] ?? 0.8;
  const timeMod = isNight ? 0.7 : 1.0;

  for (const candidate of candidates) {
    // Skip participants
    if (participantIds.includes(candidate.id)) continue;

    const curiosity = candidate.personality?.curiosity ?? 50;
    const curiosityFactor = (curiosity / 100) * 0.2 + 0.5; // maps 0-100 to 0.5-0.7

    const actionType = (candidate.current_action as any)?.type ?? 'idle';
    const actionAwareness = ACTION_AWARENESS[actionType] ?? 0.7;

    // Weighted sum
    const rawChance = visibility * 0.3
      + locationMod * 0.3
      + timeMod * 0.15
      + curiosityFactor * 0.2
      + actionAwareness * 0.25;

    const chance = Math.min(0.90, Math.max(0.05, rawChance));

    const roll = Math.random();
    if (roll < chance) {
      let awareness: AwarenessLevel;
      if (roll < chance * 0.5) awareness = 'saw';
      else if (roll < chance * 0.8) awareness = 'heard';
      else awareness = 'suspected';

      witnesses.push({ agent_id: candidate.id, awareness });
    }
  }

  return witnesses;
}
