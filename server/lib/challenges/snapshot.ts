import { and, eq, inArray, gte, max, sql } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, needs, relationships, shared_knowledge, worldState } from '../../db/schema';
import { CONFIG } from '../constants';
import { gameMinutes } from '../gameClock';
import { isDeathEnabled } from '../worldRules';
import { MINUTES_PER_DAY, type SnapPair, type TownSnapshot } from './catalog';

/**
 * The town as the challenge checks see it, read in one go.
 *
 * Everything a challenge is judged on comes from here, so the evaluator and
 * the offer builder are pure functions of this object (and tests can hand them
 * one without a database).
 */

/**
 * Feed rows that ARE the player's hand, for "Hands off". Not `player_outcome` /
 * `player_nudge_expired` (they report on an earlier action, often days later)
 * nor the challenge rows themselves, which share the `player` category.
 */
export const PLAYER_ACTION_TYPES: readonly string[] = [
  'player_nudge', 'player_event', 'player_gift', 'player_introduce', 'player_remove',
  'player_whisper', 'player_rumor', 'player_stir',
];

export function readTownSnapshot(handsOnCount: number): TownSnapshot | null {
  const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  if (!world?.time) return null;
  const time = world.time;
  const nowMinute = gameMinutes(time);

  const seasonLen = CONFIG.TIME.SEASON_LENGTH_DAYS;
  const seasonEndDay = (Math.floor(time.day / seasonLen) + 1) * seasonLen;

  const socialById = new Map<number, number>();
  for (const n of db.select({ agent_id: needs.agent_id, social: needs.social }).from(needs).all()) {
    socialById.set(n.agent_id, n.social);
  }
  const agentRows = db
    .select({
      id: agents.id, name: agents.name, age: agents.age,
      is_active: agents.is_active, current_action: agents.current_action,
    })
    .from(agents)
    .all();

  const pairs: SnapPair[] = db.select().from(relationships).all().map((r) => ({
    a: Math.min(r.agent_a, r.agent_b),
    b: Math.max(r.agent_a, r.agent_b),
    friendship: (r.friendship_ab + r.friendship_ba) / 2,
    romanceMax: Math.max(r.romance_ab, r.romance_ba),
    romanceMin: Math.min(r.romance_ab, r.romance_ba),
    status: r.status,
    tags: Array.isArray(r.tags) ? r.tags : [],
  }));

  const publicSecretIds = db
    .select({ id: shared_knowledge.id })
    .from(shared_knowledge)
    .where(eq(shared_knowledge.is_public, true))
    .all()
    .map((f) => f.id);
  // The same bar gossipEngine's common-knowledge check uses (sensitivity ≥ 2):
  // a lower one can never "become common knowledge".
  const hidden = db
    .select({ n: sql<number>`count(*)` })
    .from(shared_knowledge)
    .where(and(
      eq(shared_knowledge.is_active, true),
      eq(shared_knowledge.is_public, false),
      gte(shared_knowledge.sensitivity, 2),
    ))
    .get();

  const lastAction = db
    .select({ id: max(activityLog.id) })
    .from(activityLog)
    .where(inArray(activityLog.type, [...PLAYER_ACTION_TYPES]))
    .get();

  return {
    nowMinute,
    day: time.day,
    season: time.season,
    seasonEndMinute: seasonEndDay * MINUTES_PER_DAY,
    nextSeasonEndMinute: (seasonEndDay + seasonLen) * MINUTES_PER_DAY,
    agents: agentRows.map((a) => ({
      id: a.id,
      name: a.name,
      age: a.age,
      active: Boolean(a.is_active),
      dead: !a.is_active && (a.current_action as { type?: string } | null)?.type === 'dead',
      social: socialById.get(a.id) ?? null,
    })),
    pairs,
    publicSecretIds,
    hiddenSecretCount: hidden?.n ?? 0,
    lastPlayerActionId: lastAction?.id ?? 0,
    handsOnCount,
    deathEnabled: isDeathEnabled(),
  };
}
