/**
 * Which relationship events are turning points in a story.
 *
 * Shared by the chronicle (which weighs beats and names arcs by them) and the
 * relationship-event retention (which keeps them when it prunes everything
 * else). Both must agree: an event the chronicle treats as the moment an arc
 * pivots but retention treats as small talk would be deleted after a few game
 * days, and the arc would lose the very beat that defines it — which is how
 * every rivalry and romance used to fall off the Stories tab overnight.
 *
 * Pure data, no DB: the SQL predicate below is built from these same sets so the
 * two definitions can't drift.
 */

/** Clashes. Any of these between a pair is what makes it a rivalry. */
export const HOSTILE_EVENTS: ReadonlySet<string> = new Set([
  'fight',
  'confrontation',
  'confrontation_escalated',
  'theft_caught',
  'arrested',
]);

/** Advances. Counted toward a romance when they carry a positive romance delta. */
export const ROMANTIC_EVENTS: ReadonlySet<string> = new Set(['confession', 'seduction', 'gift']);

/** The mend that turns a rivalry into a reconciliation arc. */
export const MEND_EVENT = 'reconciliation';

/**
 * Strong feeling in either direction makes an otherwise ordinary event (a
 * conversation that turned into a bitter argument, a deep bonding talk) a beat
 * worth remembering. Matches the chronicle's weight floor for named turning
 * points, so "pivotal" is exactly "beat weight ≥ 0.5".
 */
export const PIVOTAL_SENTIMENT = 0.5;

const PIVOTAL_TYPES: ReadonlySet<string> = new Set([...HOSTILE_EVENTS, ...ROMANTIC_EVENTS, MEND_EVENT]);

export function isPivotalEvent(eventType: string, sentiment: number): boolean {
  return PIVOTAL_TYPES.has(eventType) || Math.abs(sentiment) >= PIVOTAL_SENTIMENT;
}

/**
 * `isPivotalEvent` as a SQL predicate over `relationship_events` columns. Built
 * from constants only (no caller input), so inlining the literals is safe.
 */
export const PIVOTAL_EVENT_SQL =
  `(event_type IN (${[...PIVOTAL_TYPES].map((t) => `'${t}'`).join(', ')}) ` +
  `OR ABS(sentiment) >= ${PIVOTAL_SENTIMENT})`;
