/**
 * The town timeline: the activity log read back by GAME DAY instead of as a
 * fixed window of the latest rows.
 *
 * The live feed answers "what is happening", capped at a window. This answers
 * "what happened yesterday?" and "what has this resident been through?" — days
 * as sections, only the events that mattered, each day headed by that day's
 * Town Crier headline when the paper ran one (gazette.ts).
 */

import { and, asc, desc, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { activityLog, gazetteIssues } from '../db/schema';
import { CONFIG } from './constants';
import { MINUTES_PER_DAY } from './gameClock';

/** Same order as tick.ts `SEASONS`: the world's clock derives `time.season` from the day. */
const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;

/** Season of a game day, computed the way `advanceClock` does. */
export function seasonOfDay(day: number): string {
  return SEASONS[Math.floor(day / CONFIG.TIME.SEASON_LENGTH_DAYS) % 4];
}

export type ActivityRow = typeof activityLog.$inferSelect;

/**
 * "This resident is in this row": the initiator, the target, or anyone in
 * `agent_ids`.
 *
 * Filtering on `initiator_id` alone (what `getRecent` used to do) only found
 * what a resident DID. Being confronted, robbed, gifted or gossiped about logs
 * the resident as target or as a member of `agent_ids` — the things that
 * happened TO them, which are half of anyone's story. `agent_ids` is a JSON
 * array column, so membership goes through `json_each`; initiator/target are
 * checked directly because a few writers pass an explicit `agents` list that
 * leaves one of them out.
 */
export function involvesAgent(agentId: number): SQL {
  return sql`(${activityLog.initiator_id} = ${agentId} OR ${activityLog.target_id} = ${agentId} OR EXISTS (SELECT 1 FROM json_each(${activityLog.agent_ids}) WHERE json_each.value = ${agentId}))`;
}

export interface TimelineInput {
  /** Only this game day. */
  day?: number;
  /** Only rows this resident is part of (see `involvesAgent`). */
  agentId?: number;
  /** Rows below this importance are left out; 0.6 is "would make the paper". */
  minImportance?: number;
  categories?: string[];
  /** Row id of the oldest row already shown: the page continues below it. */
  cursor?: number;
  /** Rows per page (a page always ends on a day boundary, see below). */
  limit?: number;
  /**
   * Order INSIDE a day. `time` reads the day as a story (morning to night);
   * `importance` leads with what mattered, for a resident's "Story so far".
   * Days themselves are always newest first.
   */
  order?: 'time' | 'importance';
}

export interface TimelineDay {
  day: number;
  season: string;
  /** That day's Town Crier headline, when an edition was printed for it. */
  headline: string | null;
  events: ActivityRow[];
}

export interface TimelinePage {
  days: TimelineDay[];
  /** Pass back as `cursor` for older days; null once the log runs out. */
  nextCursor: number | null;
}

/**
 * Ceiling on the rows a page may grow by to finish its last day. Pages cut at
 * `limit` rows and then take the rest of the oldest day they touched, so the
 * client never shows half a day and then the other half after a scroll; this
 * only bites at minImportance 0 on a day with hundreds of rows.
 */
const MAX_DAY_COMPLETION = 500;

export function getTimeline(input: TimelineInput = {}): TimelinePage {
  const limit = Math.max(1, input.limit ?? 60);
  const order = input.order ?? 'time';

  // `game_minute IS NOT NULL`: a row with no clock stamp (logged with no world
  // row) can't be placed in a day. Startup backfills every old row.
  const conds: SQL[] = [
    sql`${activityLog.game_minute} IS NOT NULL`,
    gte(activityLog.importance, input.minImportance ?? 0.6),
  ];
  if (input.categories?.length) conds.push(inArray(activityLog.category, input.categories));
  if (input.agentId != null) conds.push(involvesAgent(input.agentId));
  if (input.day != null) {
    conds.push(gte(activityLog.game_minute, input.day * MINUTES_PER_DAY));
    conds.push(lt(activityLog.game_minute, (input.day + 1) * MINUTES_PER_DAY));
  }
  if (input.cursor != null) conds.push(lt(activityLog.id, input.cursor));

  // Paged on `id`, like getRecent: rows are only appended, so id order is
  // insert order is (nearly) game-minute order, and the rowid walk stops at the
  // limit instead of sorting. Day grouping happens after the fetch.
  let rows = db.select().from(activityLog).where(and(...conds)).orderBy(desc(activityLog.id)).limit(limit).all();

  if (rows.length === limit) {
    const oldest = rows[rows.length - 1];
    const oldestDay = Math.floor(oldest.game_minute! / MINUTES_PER_DAY);
    rows = rows.concat(
      db.select().from(activityLog)
        .where(and(...conds, lt(activityLog.id, oldest.id), gte(activityLog.game_minute, oldestDay * MINUTES_PER_DAY)))
        .orderBy(desc(activityLog.id))
        .limit(MAX_DAY_COMPLETION)
        .all(),
    );
  }

  const lastId = rows.length ? rows[rows.length - 1].id : null;
  const more = lastId != null
    && db.select({ id: activityLog.id }).from(activityLog)
      .where(and(...conds, lt(activityLog.id, lastId))).limit(1).get() != null;

  const byDay = new Map<number, ActivityRow[]>();
  for (const row of rows) {
    const day = Math.floor(row.game_minute! / MINUTES_PER_DAY);
    let list = byDay.get(day);
    if (!list) byDay.set(day, (list = []));
    list.push(row);
  }

  const dayNumbers = [...byDay.keys()].sort((a, b) => b - a);
  // A day can have several editions (the player may print one on demand); the
  // newest id wins, and the ascending read lets a later row overwrite an earlier one.
  const headlines = new Map<number, string>();
  if (dayNumbers.length) {
    const issues = db.select({ day: gazetteIssues.day, headline: gazetteIssues.headline })
      .from(gazetteIssues)
      .where(inArray(gazetteIssues.day, dayNumbers))
      .orderBy(asc(gazetteIssues.id))
      .all();
    for (const issue of issues) headlines.set(issue.day, issue.headline);
  }

  const byMinute = (a: ActivityRow, b: ActivityRow) => (a.game_minute! - b.game_minute!) || (a.id - b.id);
  const days = dayNumbers.map<TimelineDay>((day) => {
    const events = byDay.get(day)!;
    events.sort(order === 'importance' ? (a, b) => (b.importance - a.importance) || byMinute(a, b) : byMinute);
    return { day, season: seasonOfDay(day), headline: headlines.get(day) ?? null, events };
  });

  return { days, nextCursor: more ? lastId : null };
}
