import { db } from '../../db';
import { agents } from '../../db/schema';
import { isAdultContent } from '../worldRules';
import { getAgentStates, getEffectivePersonality } from '../states';
import { clamp } from '../utils';
import { isAdultAge } from './eligibility';
import {
  forEachAgentIntimacy, getAgentIntimacy, getLongingProcessedAt, setLongingProcessedAt, updateAgentIntimacy,
} from './state';

// ─── Longing ─────────────────────────────────────────────────────────────────
//
// The slow ache that pushes an adult toward a lover: it builds with the hours
// (faster for the sensual and for someone infatuated) and is spent by a kiss or
// a night together (`relieveLonging`). It belongs to the adult layer, so it
// exists only for adults and only while the `adultContent` rule is on; with the
// rule off everyone's value is forced to 0 rather than merely paused, so
// flipping it off mid-game never leaves a stored number lying in wait.

/** Longing per game hour for an average (sensuality 50), not infatuated adult. */
export const LONGING_PER_HOUR = 0.9;
/** An infatuated agent longs this much faster. */
export const INFATUATED_LONGING_FACTOR = 1.5;
export const LONGING_MAX = 100;

export interface LongingAgent {
  age: number;
  sensuality: number;
}

/**
 * Longing gained over `hours` game hours. Pure. 0 for anyone who is not a
 * (fail-closed) adult and whenever the adult layer is off.
 */
export function longingGrowth(
  agent: LongingAgent,
  hours: number,
  ctx: { infatuated: boolean; adultContent: boolean },
): number {
  if (!ctx.adultContent || !isAdultAge(agent.age)) return 0;
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  const sensuality = Number.isFinite(agent.sensuality) ? clamp(agent.sensuality, 0, 100) : 50;
  return hours * LONGING_PER_HOUR * (sensuality / 50) * (ctx.infatuated ? INFATUATED_LONGING_FACTOR : 1);
}

/** Spend longing (a kiss, a night together). Never below 0; a no-op for someone with none. */
export function relieveLonging(agentId: number, amount: number): void {
  if (!getAgentIntimacy(agentId) || !(amount > 0)) return;
  updateAgentIntimacy(agentId, (a) => { a.longing = clamp(a.longing - amount, 0, LONGING_MAX); });
}

/** Spend longing down to `level` (a night together leaves a little behind); never raises it. */
export function relieveLongingTo(agentId: number, level: number): void {
  const now = getAgentIntimacy(agentId)?.longing ?? 0;
  if (now > level) relieveLonging(agentId, now - level);
}

export interface LongingParty extends LongingAgent {
  id: number;
  infatuated: boolean;
}

/**
 * Apply the game time elapsed since the last processed minute. Game time, not
 * ticks: at 4x the clock steps four minutes per tick and the caller runs this
 * every ten game minutes, so what matters is `nowMinutes - last`. The first
 * call only records the minute (no elapsed time to bill), a clock that went
 * backwards (world replace, rolled-back load) re-anchors, and a repeat call for
 * the same minute changes nothing.
 *
 * With the rule off, every stored longing is forced to 0.
 */
export function applyLonging(nowMinutes: number, parties: readonly LongingParty[], adultContent: boolean): void {
  const last = getLongingProcessedAt();
  setLongingProcessedAt(nowMinutes);

  if (!adultContent) {
    forEachAgentIntimacy((_, a) => { a.longing = 0; });
    return;
  }
  if (last === null || nowMinutes <= last) return;

  const hours = (nowMinutes - last) / 60;
  for (const p of parties) {
    const gain = longingGrowth(p, hours, { infatuated: p.infatuated, adultContent });
    if (gain > 0) updateAgentIntimacy(p.id, (a) => { a.longing = clamp(a.longing + gain, 0, LONGING_MAX); });
  }
  // A minor's stored value (a stale row, a hand-edited checkpoint) never
  // survives the pass, and neither does anyone's who is no longer in town.
  const adults = new Set(parties.filter((p) => isAdultAge(p.age)).map((p) => p.id));
  forEachAgentIntimacy((id, a) => { if (!adults.has(id)) a.longing = 0; });
}

/** The DB-facing pass: living residents, their sensuality and whether they are infatuated. */
export function longingPass(nowMinutes: number): void {
  const adultContent = isAdultContent();
  const parties: LongingParty[] = adultContent
    ? db.select().from(agents).all()
      .filter((a) => a.is_active)
      .map((a) => ({
        id: a.id,
        age: a.age,
        // Drifted personality when the cache has it, the stored profile otherwise.
        sensuality: (getEffectivePersonality(a.id) ?? a.personality)?.sensuality ?? 50,
        infatuated: getAgentStates(a.id).includes('infatuated'),
      }))
    : [];
  applyLonging(nowMinutes, parties, adultContent);
}
