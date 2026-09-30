import type { Challenge, PairAim } from '../../server/lib/challenges/catalog';

/**
 * The pair dossier's "Set a goal" menu and the goal it shows once one runs.
 * Pure, so the wording and the matching are tested without React.
 */

export interface AimOption {
  aim: PairAim;
  label: string;
  /** A caution shown next to the label, or null. */
  hint: string | null;
}

/**
 * The three things a player can ask for a pair. "Married" carries a hint:
 * partners → a proposal → a wedding is a long road, and the goal's 14 days
 * are often short for it. The player may still try; the hint only sets
 * expectations.
 */
export const AIM_OPTIONS: readonly AimOption[] = [
  { aim: 'marry', label: 'Get them married', hint: 'long shot' },
  { aim: 'befriend', label: 'Make them friends', hint: null },
  { aim: 'sunder', label: 'Tear them apart', hint: null },
];

/**
 * The running challenge that is about exactly this pair (an aim, or an offer
 * the player accepted that names the same two), or null. Order-insensitive.
 */
export function goalForPair(active: readonly Challenge[], a: number, b: number): Challenge | null {
  return (
    active.find((c) => c.agentIds.length === 2 && c.agentIds.includes(a) && c.agentIds.includes(b) && a !== b) ?? null
  );
}
