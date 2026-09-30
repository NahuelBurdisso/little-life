import { eq, or } from 'drizzle-orm';
import { db } from '../db';
import { agents, relationships } from '../db/schema';

/**
 * Marriage as relationship tags.
 *
 * `partners` is the highest status the threshold ladder in
 * engine/systems/relationships.ts can derive. Engagement and marriage are life
 * events, not thresholds, so they live as custom tags on the pair's row:
 * `updateTags` only ever adds or removes its own six derived tags, so these
 * survive every relationship pass untouched (like `estranged`, `coworkers`...).
 *
 * Kept apart from lib/milestonesEngine.ts (which writes them) so readers such
 * as the gossip module and the relationship phase can ask "is this person
 * married?" without importing the engine and its listeners — the engine
 * imports gossip, and gossip importing it back would be a cycle.
 */

export const ENGAGED_TAG = 'engaged';
export const MARRIED_TAG = 'married';

/** Tags a real breakup must strip, so the pair stops being treated as a couple-to-be or a couple. */
export const MILESTONE_TAGS: readonly string[] = [ENGAGED_TAG, MARRIED_TAG];

export function isMarriedTags(tags: readonly string[] | null | undefined): boolean {
  return !!tags && tags.includes(MARRIED_TAG);
}

/** `tags` without the engagement and marriage tags (a breakup or estrangement). */
export function withoutMilestoneTags(tags: readonly string[]): string[] {
  return tags.filter((t) => !MILESTONE_TAGS.includes(t));
}

/**
 * Living spouse of `agentId`, or null. A widow's tag stays on the row with the
 * deceased, so only an active partner counts.
 */
export function spouseOf(agentId: number): number | null {
  const rows = db.select({ a: relationships.agent_a, b: relationships.agent_b, tags: relationships.tags })
    .from(relationships)
    .where(or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId)))
    .all();
  for (const r of rows) {
    if (!isMarriedTags(r.tags)) continue;
    const other = r.a === agentId ? r.b : r.a;
    const alive = db.select({ active: agents.is_active }).from(agents).where(eq(agents.id, other)).get();
    if (alive?.active) return other;
  }
  return null;
}

/** Whether `agentId` is engaged or married to someone other than `except` (living). */
export function isSpokenFor(agentId: number, except?: number): boolean {
  const rows = db.select({ a: relationships.agent_a, b: relationships.agent_b, tags: relationships.tags })
    .from(relationships)
    .where(or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId)))
    .all();
  for (const r of rows) {
    const other = r.a === agentId ? r.b : r.a;
    if (other === except) continue;
    if (!r.tags?.some((t) => MILESTONE_TAGS.includes(t))) continue;
    const alive = db.select({ active: agents.is_active }).from(agents).where(eq(agents.id, other)).get();
    if (alive?.active) return true;
  }
  return false;
}

/**
 * Whom `agentId` is engaged or married to (living), other than `except`; a
 * spouse before a fiancé(e) when somehow both exist. The betrayed party of an
 * affair: `isSpokenFor` says THAT someone is, this says WHO.
 */
export function betrothedTo(agentId: number, except?: number): number | null {
  const rows = db.select({ a: relationships.agent_a, b: relationships.agent_b, tags: relationships.tags })
    .from(relationships)
    .where(or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId)))
    .all();
  let fiance: number | null = null;
  for (const r of rows) {
    const other = r.a === agentId ? r.b : r.a;
    if (other === except) continue;
    if (!r.tags?.some((t) => MILESTONE_TAGS.includes(t))) continue;
    const alive = db.select({ active: agents.is_active }).from(agents).where(eq(agents.id, other)).get();
    if (!alive?.active) continue;
    if (isMarriedTags(r.tags)) return other;
    fiance ??= other;
  }
  return fiance;
}

/**
 * Sensitivity for an affair secret. An affair was always a sensitivity-3
 * secret; one that betrays a marriage is the worst thing the town can learn
 * about someone, so it goes a step past every other secret. Readers compare
 * with `>=` (gossip gates, exposure mood hit per point, UI colouring), so 4
 * simply lands on the far side of each of them.
 */
export const MARRIED_AFFAIR_SENSITIVITY = 4;

export function affairSensitivity(base: number, involvesMarriedResident: boolean): number {
  return involvesMarriedResident ? Math.max(base, MARRIED_AFFAIR_SENSITIVITY) : base;
}

/**
 * Whether an affair between `subjectId` and `targetId` betrays a marriage:
 * either of them is married to someone else. (Two people married to each
 * other are not having an affair, whatever an observer thinks.)
 */
export function affairInvolvesMarriage(subjectId: number, targetId: number | null): boolean {
  for (const id of [subjectId, targetId]) {
    if (id == null) continue;
    const spouse = spouseOf(id);
    if (spouse != null && spouse !== subjectId && spouse !== targetId) return true;
  }
  return false;
}

/**
 * `world_events.triggered_by` of a couple's wedding. Same shape as the
 * funeral's `death:<id>`: the client parses it to find the newlyweds
 * (townEvents/eventDecor.ts `weddingCouple`, beats/beatDetect.ts) and the
 * decisions phase to send them to their own ceremony.
 */
export function weddingTriggeredBy(a: number, b: number): string {
  return `wedding:${Math.min(a, b)}-${Math.max(a, b)}`;
}

/** The couple of a wedding event, or null for anything else (e.g. an old random wedding). */
export function parseWeddingTrigger(triggeredBy: string | null | undefined): [number, number] | null {
  const m = /^wedding:(\d+)-(\d+)$/.exec(triggeredBy ?? '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}
