/**
 * What every gathering kind is built from: seeded dice, places, the people at
 * a venue, the one summary row. The person-level effects (mood, memories, a
 * relationship event, a favour, a gift) are the social calls' own (../socialCalls/effects.ts),
 * so nothing downstream — status logic, the memory stream, the favour ledger — is bypassed.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, agentStates, locations, relationships, worldEvents } from '../../db/schema';
import type { DramaBeat } from '../../data/dramaBeats';
import { logActivity } from '../activityLogger';
import { makeRng, stringToSeed } from '../worldgen/rng';
import { currentWorldSeed } from '../intimacy/worldSeed';
import type { Gathering } from './types';

// ─── Dice ────────────────────────────────────────────────────────────────────

let rngOverride: (() => number) | null = null;

/**
 * Tests only: every roll of the system draws from `fn` (null restores the seeded
 * source). Gatherings decide inside other phases' listeners and the decision
 * pass; a Math.random() draw there would shift the sequences those phases'
 * tests pin down, so every die here is seeded (world seed + a key).
 */
export function setGatheringRng(fn: (() => number) | null): void {
  rngOverride = fn;
}

export function rngFor(key: string): () => number {
  if (rngOverride) return rngOverride;
  const r = makeRng(stringToSeed(`${String(currentWorldSeed())}|gather|${key}`));
  return () => r.next();
}

// ─── Clock ───────────────────────────────────────────────────────────────────

export const HOUR = 60;
export const DAY = 24 * HOUR;

export function dayStartOf(min: number): number {
  return Math.floor(min / DAY) * DAY;
}

// ─── Places ──────────────────────────────────────────────────────────────────

type LocationRow = typeof locations.$inferSelect;

/** The lowest-id location of the first type present (a stable choice for "the square"). */
export function firstOfType(types: readonly string[]): LocationRow | null {
  const all = db.select().from(locations).all();
  for (const t of types) {
    const best = all.filter((l) => l.type === t).sort((a, b) => a.id - b.id)[0];
    if (best) return best;
  }
  return null;
}

/**
 * Where the town gathers for its dead and its leavers: worldgen has no church,
 * chapel or graveyard (lib/worldgen building types), so it is the square, as
 * for weddings and christenings.
 */
export function squareVenue(): LocationRow | null {
  return firstOfType(['town_square', 'market_square', 'park']);
}

export function tavernVenue(): LocationRow | null {
  return firstOfType(['tavern']);
}

export function locationName(id: number): string {
  return db.select({ name: locations.name }).from(locations).where(eq(locations.id, id)).get()?.name ?? 'the square';
}

/** "on the square" / "at the Tavern": how the summary row places it. */
export function atPlace(id: number): string {
  const loc = db.select({ name: locations.name, type: locations.type }).from(locations).where(eq(locations.id, id)).get();
  if (!loc) return 'in town';
  if (loc.type === 'town_square' || loc.type === 'market_square') return 'on the square';
  if (loc.type === 'park') return 'in the park';
  return `at ${loc.name}`;
}

// ─── People ──────────────────────────────────────────────────────────────────

export function isActive(id: number): boolean {
  return db.select({ a: agents.is_active }).from(agents).where(eq(agents.id, id)).get()?.a === true;
}

export function statesOf(id: number): string[] {
  return db.select({ t: agentStates.type }).from(agentStates).where(eq(agentStates.agent_id, id)).all().map((r) => r.t);
}

/**
 * A good reason to have missed it: ill, jailed, gone (dead or departed), or too
 * low to leave the house. Nobody holds these against anyone.
 */
export function excused(id: number): boolean {
  if (!isActive(id)) return true;
  return statesOf(id).some((s) => s === 'sick' || s === 'arrested' || s === 'depressed');
}

/** `from`'s friendship toward `to` (0 with no tie). */
export function regard(fromId: number, toId: number): number {
  const lo = Math.min(fromId, toId), hi = Math.max(fromId, toId);
  const rel = db.select().from(relationships).where(and(eq(relationships.agent_a, lo), eq(relationships.agent_b, hi))).get();
  if (!rel) return 0;
  return rel.agent_a === fromId ? rel.friendship_ab : rel.friendship_ba;
}

export function relRow(a: number, b: number) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return db.select().from(relationships).where(and(eq(relationships.agent_a, lo), eq(relationships.agent_b, hi))).get() ?? null;
}

/** "Ana, Tom and Bea" (and "and 3 others" past `max`). */
export function nameList(names: readonly string[], max = 4): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** The world event a gathering wraps has ended early (a fire put out). */
export function endWrappedEvent(g: Gathering): void {
  if (g.eventId == null) return;
  db.update(worldEvents).set({ is_active: false }).where(eq(worldEvents.id, g.eventId)).run();
}

// ─── The summary row ─────────────────────────────────────────────────────────

/**
 * The gathering's ONE feed row. `severity` lifts it from the `gathering` base
 * of 0.5 by 0.3 per unit (data/activityRegistry.ts): a funeral, a wake, a
 * send-off and a fire sit at 0.6 and up, so the soak's story-health table and
 * the Town Crier see them.
 */
export function gatheringFeed(g: Gathering, beat: DramaBeat, description: string, severity: number, agentIds: number[]): void {
  logActivity({
    type: 'gathering',
    ...(g.hostIds[0] != null ? { initiator: g.hostIds[0] } : g.subjectId != null ? { initiator: g.subjectId } : {}),
    agents: [...new Set([...g.hostIds, ...(g.subjectId != null ? [g.subjectId] : []), ...agentIds])].slice(0, 12),
    location: g.venueLocationId,
    severity,
    templateData: { description },
    metadata: { beat, gatheringKind: g.kind },
  });
}
