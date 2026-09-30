/**
 * Chronicle — derives named story arcs from what the simulation already wrote
 * down. Pure read layer: no tables, no columns, no tick-loop participation. The
 * town produces plenty of drama; the raw activity feed just presents it as a
 * flat list of unrelated lines, so an arc that took an hour to unfold reads as
 * noise. This groups those lines back into "Mara vs Jonas" and "the fall of
 * Edda" so the player can follow a thread.
 *
 * Beats come from `relationship_events.description` and `shared_knowledge
 * .content`, both of which are stored pre-rendered. The activity log is
 * deliberately *not* a source: its rows hold `template_key` + `template_data`
 * and are rendered client-side, so pulling them in here would mean a second
 * copy of that renderer, free to drift from the first.
 */

import { db } from '../db';
import { agents, relationships, relationshipEvents, shared_knowledge, worldState } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { gameMinutes, MINUTES_PER_DAY } from './gameClock';
import { ENGAGED_TAG, MARRIED_TAG } from './marriage';
import {
  HOSTILE_EVENTS,
  LOVERS_TAG,
  MEND_EVENT,
  PIVOTAL_EVENT_SQL,
  ROMANTIC_EVENTS,
  isPivotalEvent,
} from './storyBeats';

export type ArcKind =
  | 'romance'
  | 'rivalry'
  | 'reconciliation'
  | 'love_triangle'
  | 'downfall'
  | 'scandal';

export interface ArcBeat {
  /**
   * Game minute of the beat (`relationship_events.game_minute`), so the UI can
   * say "2d ago" in game days. Null for undated beats — a scandal's synthesised
   * beat, whose secret may have been planted as backstory.
   */
  gameMinute: number | null;
  eventType: string;
  description: string;
  /** 0..1, drives both beat ordering ties and the arc's heat. */
  weight: number;
}

export interface StoryArc {
  /** Stable across recomputes so the UI can keep a row expanded. */
  id: string;
  kind: ArcKind;
  title: string;
  summary: string;
  participants: number[];
  participantNames: string[];
  beats: ArcBeat[];
  /** 0..1 — recency-weighted (game time) sum of beat weights. Sorts the list. */
  heat: number;
  /** Game minute of the newest dated beat; 0 when none is dated. */
  lastActivity: number;
  /**
   * A thread the town does not know about: the player, who watches everything, sees it, but
   * the Town Crier must not print it (lib/gazette.ts drops these). Set on the arcs that would
   * give a hidden couple away: lovers who are spoken for elsewhere (or a same-sex pair, in
   * 1900) until somebody beyond the two holds the secret. Absent (never `false`) otherwise.
   */
  secret?: true;
}

/** Recomputing on every feed invalidation would re-scan five tables per poll. */
const CACHE_TTL_MS = 3000;
/**
 * Rows loaded per pair: its newest events of any kind (what is happening now)
 * plus its newest pivotal ones (what the story is about).
 *
 * This replaced "the newest 600 events across the whole town", which let a busy
 * afternoon of small talk elsewhere push a pair's fight — the beat its whole
 * rivalry rests on — out of the window, so the arc vanished while both of them
 * were still enemies. Per-pair selection bounds the scan by the number of pairs
 * instead of by town-wide activity, so an old arc can never be crowded out.
 */
const RECENT_EVENTS_PER_PAIR = 12;
const PIVOTAL_EVENTS_PER_PAIR = 24;
const MAX_ARCS = 12;
const MAX_BEATS = 8;
/** The newest beats always shown, however slight, so an arc says where it stands now. */
const LATEST_BEATS_SHOWN = 2;
/**
 * A beat contributes half as much heat every time this much GAME time elapses.
 *
 * Game time, not wall-clock: on the old 15-real-minute half-life a paused game
 * cooled every story, and one left paused overnight came back with all its arcs
 * at zero. A game day lets yesterday's fight still rank as live drama and last
 * week's fade behind it without disappearing.
 */
const HEAT_HALF_LIFE_GAME_MINUTES = MINUTES_PER_DAY;

/** Fewer holders than this and a sensitive secret is not yet a scandal; some types are one from the start. */
const SCANDAL_MIN_HOLDERS: Record<string, number> = { illegitimate_pregnancy: 1 };

const ROMANTIC_STATUSES = new Set(['partners', 'romantic_interest', 'complicated']);
const HOSTILE_STATUSES = new Set(['enemies', 'rivals', 'estranged']);

/** Order-independent key for a pair of agent ids. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function beatWeight(sentiment: number, eventType: string): number {
  // Strong feeling in either direction is what makes a beat memorable, so the
  // sign is dropped. Named turning points get a floor: a reconciliation logged
  // at sentiment 0.1 is still the moment the arc pivots. The floor equals
  // PIVOTAL_SENTIMENT, so "pivotal" (what retention keeps forever) is exactly
  // "weight >= 0.5".
  return Math.min(1, Math.max(isPivotalEvent(eventType, 0) ? 0.5 : 0.1, Math.abs(sentiment)));
}

function heatOf(beats: ArcBeat[], nowMinute: number): number {
  let heat = 0;
  for (const beat of beats) {
    const age = Math.max(0, nowMinute - (beat.gameMinute ?? nowMinute));
    heat += beat.weight * 0.5 ** (age / HEAT_HALF_LIFE_GAME_MINUTES);
  }
  return Math.min(1, heat);
}

type EventRow = typeof relationshipEvents.$inferSelect;

/**
 * Newest-first rows in, chronological beats out, capped at `MAX_BEATS`.
 *
 * Which rows make the cut: the newest `LATEST_BEATS_SHOWN` (where the arc
 * stands now), then the heaviest of the rest, newer first on ties. Taking the
 * newest N outright let a couple's twenty small chats bury the confession their
 * romance began with; weighting keeps the turning points in view however much
 * small talk followed them.
 *
 * `nowMinute` dates the rare row the insert trigger left unstamped: it can only
 * be one written moments ago (the prune pass stamps stragglers daily).
 */
function toBeats(rows: EventRow[], nowMinute: number): ArcBeat[] {
  const beats = rows.map((row, index) => ({
    index,
    beat: {
      gameMinute: row.game_minute ?? nowMinute,
      eventType: row.event_type,
      description: row.description,
      weight: beatWeight(row.sentiment, row.event_type),
    },
  }));
  const latest = beats.slice(0, LATEST_BEATS_SHOWN);
  const rest = beats
    .slice(LATEST_BEATS_SHOWN)
    .sort((x, y) => y.beat.weight - x.beat.weight || x.index - y.index)
    .slice(0, Math.max(0, MAX_BEATS - latest.length));
  // Input is newest-first, so descending index is chronological.
  return [...latest, ...rest]
    .sort((x, y) => y.index - x.index)
    .map((b) => b.beat);
}

/** Newest first by game minute (unstamped rows are the newest), then by id. */
function newestFirst(x: EventRow, y: EventRow): number {
  const mx = x.game_minute ?? Number.POSITIVE_INFINITY;
  const my = y.game_minute ?? Number.POSITIVE_INFINITY;
  if (mx !== my) return mx < my ? 1 : -1;
  return y.id - x.id;
}

interface CacheEntry {
  at: number;
  arcs: StoryArc[];
}

let cache: CacheEntry | null = null;

/** Drops the memo. Called on world replace (worldCaches) and by tests. */
export function resetChronicleCache() {
  cache = null;
}

export function detectStoryArcs(): StoryArc[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.arcs;

  const world = db.select({ time: worldState.time }).from(worldState).get();
  if (!world) return [];

  // Per pair (order-independent: gifts and confrontations are stored giver ->
  // receiver, most other writers a < b): its newest events, plus its newest
  // pivotal ones however old. See RECENT_EVENTS_PER_PAIR.
  const pair = sql.raw('MIN(agent_a, agent_b), MAX(agent_a, agent_b)');
  const pivotal = sql.raw(PIVOTAL_EVENT_SQL);
  const order = sql.raw('game_minute DESC NULLS FIRST, id DESC');
  const selected = sql`${relationshipEvents.id} IN (
    SELECT id FROM (
      SELECT id, ${pivotal} AS pivotal,
        ROW_NUMBER() OVER (PARTITION BY ${pair} ORDER BY ${order}) AS recent_rank,
        ROW_NUMBER() OVER (PARTITION BY ${pair}, ${pivotal} ORDER BY ${order}) AS pivotal_rank
      FROM relationship_events
    )
    WHERE recent_rank <= ${RECENT_EVENTS_PER_PAIR}
       OR (pivotal AND pivotal_rank <= ${PIVOTAL_EVENTS_PER_PAIR})
  )`;

  const arcs = buildArcs(
    {
      agents: db
        .select({ id: agents.id, name: agents.name, gender: agents.gender })
        .from(agents)
        .where(eq(agents.is_active, true))
        .all(),
      relationships: db.select().from(relationships).all(),
      events: db.select().from(relationshipEvents).where(selected).all(),
      secrets: db
        .select()
        .from(shared_knowledge)
        .where(eq(shared_knowledge.is_active, true))
        .all(),
    },
    gameMinutes(world.time),
  );
  cache = { at: now, arcs };
  return arcs;
}

export interface ChronicleInput {
  /**
   * Living agents only — arcs about the departed aren't current stories. `gender` is optional
   * (fixtures need not say): it only matters for telling a hidden same-sex couple.
   */
  agents: { id: number; name: string; gender?: string | null }[];
  relationships: typeof relationships.$inferSelect[];
  /** Any order; sorted newest-first (by game minute) in `buildArcs`. */
  events: EventRow[];
  secrets: typeof shared_knowledge.$inferSelect[];
}

/**
 * The detector proper, split from the queries so it can be exercised on
 * fixtures instead of against the live sqlite file. `now` is the current GAME
 * minute: heat and beat ages never read the wall clock, so a paused game's
 * stories hold still.
 */
export function buildArcs(input: ChronicleInput, now: number): StoryArc[] {
  const agentRows = input.agents;
  if (agentRows.length === 0) return [];

  const nameOf = new Map<number, string>(agentRows.map((a) => [a.id, a.name]));
  const genderOf = new Map<number, string | null>(agentRows.map((a) => [a.id, a.gender ?? null]));
  const relationshipRows = input.relationships;
  const eventRows = [...input.events].sort(newestFirst);

  // Newest-first within each pair, inherited from the caller's ordering.
  const eventsByPair = new Map<string, EventRow[]>();
  for (const row of eventRows) {
    const key = pairKey(row.agent_a, row.agent_b);
    const bucket = eventsByPair.get(key);
    if (bucket) bucket.push(row);
    else eventsByPair.set(key, [row]);
  }

  // --- Who is hiding what (lib/intimacy/) -----------------------------------
  // Same meaning as intimacy/committed.ts `committedTo`, over the rows already loaded: whom
  // `id` is with (married, then engaged, then an established partner) other than `except`.
  const committedElsewhere = (id: number, except: number): number | null => {
    let best: { id: number; rank: number } | null = null;
    for (const r of relationshipRows) {
      if (r.agent_a !== id && r.agent_b !== id) continue;
      const other = r.agent_a === id ? r.agent_b : r.agent_a;
      if (other === except || !nameOf.has(other)) continue;
      const rank = r.tags.includes(MARRIED_TAG) ? 3
        : r.tags.includes(ENGAGED_TAG) ? 2
          : r.status === 'partners' || r.tags.includes('partner') ? 1 : 0;
      if (rank > 0 && (!best || rank > best.rank)) best = { id: other, rank };
    }
    return best?.id ?? null;
  };
  /**
   * Whether a hidden pair's affair has got out: an `affair` or `tryst_seen` secret about
   * exactly the two, public or held by at least two people beyond them. One witness is a
   * rumour waiting to happen, not yet the town's business (the paper waits for the second).
   */
  const affairIsLoose = (x: number, y: number): boolean =>
    input.secrets.some((f) => {
      if (!f.is_active || (f.type !== 'affair' && f.type !== 'tryst_seen')) return false;
      const about = [f.subject_id, f.target_id];
      if (!about.includes(x) || !about.includes(y)) return false;
      if (f.is_public) return true;
      return (f.known_by ?? []).filter((id) => id !== x && id !== y).length >= 2;
    });
  const sameSex = (x: number, y: number): boolean => {
    const gx = genderOf.get(x);
    const gy = genderOf.get(y);
    return gx != null && gx === gy;
  };
  /** Lovers who must hide it (spoken for elsewhere, or a same-sex pair in 1900: tryst.ts `secret`) and have not been found out. */
  const isHiddenPair = (rel: { agent_a: number; agent_b: number; tags: string[] }): boolean =>
    rel.tags.includes(LOVERS_TAG)
    && !affairIsLoose(rel.agent_a, rel.agent_b)
    && (committedElsewhere(rel.agent_a, rel.agent_b) != null
      || committedElsewhere(rel.agent_b, rel.agent_a) != null
      || sameSex(rel.agent_a, rel.agent_b));

  const arcs: StoryArc[] = [];
  const seen = new Set<string>();

  const push = (arc: StoryArc) => {
    if (seen.has(arc.id)) return;
    seen.add(arc.id);
    arcs.push(arc);
  };

  const makeArc = (
    kind: ArcKind,
    participants: number[],
    title: string,
    summary: string,
    beats: ArcBeat[],
    /** Overrides the recency-decayed heat for arcs whose beats aren't dated. */
    heatOverride?: number,
  ): StoryArc | null => {
    if (beats.length === 0) return null;
    const dated = beats.filter((b) => b.gameMinute != null);
    return {
      id: `${kind}:${[...participants].sort((a, b) => a - b).join('-')}`,
      kind,
      title,
      summary,
      participants,
      participantNames: participants.map((id) => nameOf.get(id) ?? `#${id}`),
      beats,
      heat: heatOverride ?? heatOf(beats, now),
      lastActivity: dated.length > 0 ? dated[dated.length - 1].gameMinute! : 0,
    };
  };

  // --- Pair arcs: romance, rivalry, reconciliation -------------------------
  for (const rel of relationshipRows) {
    const a = rel.agent_a;
    const b = rel.agent_b;
    if (!nameOf.has(a) || !nameOf.has(b)) continue; // one of them left or died

    const pairEvents = eventsByPair.get(pairKey(a, b)) ?? [];
    if (pairEvents.length === 0) continue;

    const nameA = nameOf.get(a)!;
    const nameB = nameOf.get(b)!;

    const hostileCount = pairEvents.filter((e) => HOSTILE_EVENTS.has(e.event_type)).length;
    const romanticCount = pairEvents.filter(
      (e) => ROMANTIC_EVENTS.has(e.event_type) && e.romance_delta_ab + e.romance_delta_ba > 0,
    ).length;
    // Events are newest-first, so a mend that outranks the last hostile beat is
    // one with a *lower* index than it.
    const lastHostile = pairEvents.findIndex((e) => HOSTILE_EVENTS.has(e.event_type));
    const mendIndex = pairEvents.findIndex((e) => e.event_type === MEND_EVENT);
    const mended = mendIndex !== -1 && lastHostile !== -1 && mendIndex < lastHostile;

    // Precedence runs most-specific first: a pair that fought and then made up
    // is a reconciliation, not an ongoing rivalry, even though both patterns
    // match its history.
    let arc: StoryArc | null = null;
    if (mended) {
      arc = makeArc(
        'reconciliation',
        [a, b],
        `${nameA} and ${nameB} mend fences`,
        `After ${hostileCount} falling-out${hostileCount === 1 ? '' : 's'}, they patched things up.`,
        toBeats(pairEvents, now),
      );
    } else if (ROMANTIC_STATUSES.has(rel.status) || romanticCount >= 2) {
      // Engagement and marriage are tags on a `partners` row (lib/marriage.ts);
      // they outrank the plain "Together." once the couple has taken the step.
      const shape = rel.tags.includes(MARRIED_TAG)
        ? 'Married.'
        : rel.tags.includes(ENGAGED_TAG)
          ? 'Engaged.'
          : rel.status === 'partners'
            ? 'Together.'
            : rel.status === 'complicated'
              ? 'It is complicated.'
              : 'Something is starting.';
      arc = makeArc('romance', [a, b], `${nameA} & ${nameB}`, shape, toBeats(pairEvents, now));
    } else if (HOSTILE_STATUSES.has(rel.status) || hostileCount >= 2) {
      arc = makeArc(
        'rivalry',
        [a, b],
        `${nameA} vs ${nameB}`,
        `${hostileCount} clash${hostileCount === 1 ? '' : 'es'} and counting.`,
        toBeats(pairEvents.filter((e) => e.sentiment < 0 || HOSTILE_EVENTS.has(e.event_type)), now),
      );
    }
    // A couple the town must not read about yet stays on the player's page, marked for the paper.
    if (arc && arc.kind === 'romance' && isHiddenPair(rel)) arc.secret = true;
    if (arc) push(arc);
  }

  // --- Love triangles ------------------------------------------------------
  // A couple plus anyone still carrying a torch for one of them. Detected off
  // the relationship graph rather than events, because pining produces no
  // event of its own until it boils over.
  const romanceToward = new Map<number, { other: number; score: number }[]>();
  for (const rel of relationshipRows) {
    if (!nameOf.has(rel.agent_a) || !nameOf.has(rel.agent_b)) continue;
    if (rel.romance_ab > 40) {
      const list = romanceToward.get(rel.agent_b) ?? [];
      list.push({ other: rel.agent_a, score: rel.romance_ab });
      romanceToward.set(rel.agent_b, list);
    }
    if (rel.romance_ba > 40) {
      const list = romanceToward.get(rel.agent_a) ?? [];
      list.push({ other: rel.agent_b, score: rel.romance_ba });
      romanceToward.set(rel.agent_a, list);
    }
  }

  // Lovers first (their more specific arc wins the shared id): somebody who spent a night with
  // a person who is not their partner is a triangle whatever the romance numbers say, since
  // the act, not pining, is what started it. Fallen-out exes (`lovers` is sticky) are not.
  for (const lov of relationshipRows) {
    if (!lov.tags.includes(LOVERS_TAG) || HOSTILE_STATUSES.has(lov.status)) continue;
    if (!nameOf.has(lov.agent_a) || !nameOf.has(lov.agent_b)) continue;
    for (const [anchor, third] of [[lov.agent_a, lov.agent_b], [lov.agent_b, lov.agent_a]] as const) {
      const partner = committedElsewhere(anchor, third);
      if (partner == null) continue;
      const merged = [
        ...(eventsByPair.get(pairKey(anchor, partner)) ?? []),
        ...(eventsByPair.get(pairKey(anchor, third)) ?? []),
      ].sort(newestFirst);
      const arc = makeArc(
        'love_triangle',
        [anchor, partner, third],
        `${nameOf.get(third)}, ${nameOf.get(anchor)} and ${nameOf.get(partner)}`,
        `${nameOf.get(third)} and ${nameOf.get(anchor)} are involved, though ${nameOf.get(anchor)} is with ${nameOf.get(partner)}.`,
        toBeats(merged, now),
      );
      if (!arc) continue;
      if (!affairIsLoose(anchor, third)) arc.secret = true;
      push(arc);
    }
  }

  for (const rel of relationshipRows) {
    if (rel.status !== 'partners') continue;
    if (!nameOf.has(rel.agent_a) || !nameOf.has(rel.agent_b)) continue;

    for (const anchor of [rel.agent_a, rel.agent_b]) {
      const partner = anchor === rel.agent_a ? rel.agent_b : rel.agent_a;
      const suitors = (romanceToward.get(anchor) ?? [])
        .filter((s) => s.other !== partner)
        .sort((x, y) => y.score - x.score);
      const third = suitors[0];
      if (!third) continue;

      // Beats are the union of the couple's and the outsider's histories, so
      // the arc reads as one situation rather than two parallel ones.
      const merged = [
        ...(eventsByPair.get(pairKey(rel.agent_a, rel.agent_b)) ?? []),
        ...(eventsByPair.get(pairKey(anchor, third.other)) ?? []),
      ].sort(newestFirst);

      const arc = makeArc(
        'love_triangle',
        [anchor, partner, third.other],
        `${nameOf.get(third.other)}, ${nameOf.get(anchor)} and ${nameOf.get(partner)}`,
        `${nameOf.get(third.other)} still wants ${nameOf.get(anchor)}, who is with ${nameOf.get(partner)}.`,
        toBeats(merged, now),
      );
      if (arc) push(arc);
    }
  }

  // --- Downfalls -----------------------------------------------------------
  // Not "someone had a bad week" but "the town turned on them": repeated
  // hostility from several different people, which is what separates a feud
  // from a reputation collapse.
  const hostileBy = new Map<number, EventRow[]>();
  for (const row of eventRows) {
    if (row.sentiment > -0.2 && !HOSTILE_EVENTS.has(row.event_type)) continue;
    // The event is recorded a → b; b is the one it happened to.
    const list = hostileBy.get(row.agent_b) ?? [];
    list.push(row);
    hostileBy.set(row.agent_b, list);
  }
  for (const [victim, rows] of hostileBy) {
    if (!nameOf.has(victim)) continue;
    const aggressors = new Set(rows.map((r) => r.agent_a));
    if (rows.length < 3 || aggressors.size < 2) continue;
    const arc = makeArc(
      'downfall',
      [victim, ...aggressors].filter((id, i, all) => all.indexOf(id) === i),
      `The fall of ${nameOf.get(victim)}`,
      `${aggressors.size} people have turned on ${nameOf.get(victim)}.`,
      toBeats(rows, now),
    );
    if (arc) push(arc);
  }

  // --- Scandals ------------------------------------------------------------
  // A secret stops being a secret once enough people hold it. There is no event
  // stream for that, so the single beat is synthesised from the row itself, and
  // heat comes from how damaging and how widespread it is rather than from
  // recency: `created_at` is 0 for every secret the setup wizard plants, which
  // under the usual decay would bury the town's backstory permanently. The beat
  // is undated for the same reason, and because `created_at` isn't on the game
  // clock everywhere it is written, so it can't be shown as an age.
  for (const secret of input.secrets) {
    if (secret.sensitivity < 3) continue;
    const holders = secret.known_by?.length ?? 0;
    // An unwed pregnancy is only a fact once she shows and the town has been told (a `scandal`
    // feed row went out with it), so it is a scandal from the first person who holds it.
    if (holders < (SCANDAL_MIN_HOLDERS[secret.type] ?? 3)) continue;
    if (!nameOf.has(secret.subject_id)) continue;

    const participants = [secret.subject_id];
    if (secret.target_id != null && nameOf.has(secret.target_id)) {
      participants.push(secret.target_id);
    }
    const whispers = secret.type === 'illegitimate_pregnancy';
    const arc = makeArc(
      'scandal',
      participants,
      whispers ? `Whispers follow ${nameOf.get(secret.subject_id)}` : `${nameOf.get(secret.subject_id)}'s secret`,
      holders >= 3 || !whispers ? `${holders} people know. It will not stay quiet.` : 'The town is beginning to talk.',
      [
        {
          gameMinute: null,
          eventType: secret.type,
          description: secret.content,
          weight: Math.min(1, secret.sensitivity / 5),
        },
      ],
      Math.min(1, secret.sensitivity / 5 + holders / agentRows.length),
    );
    if (arc) push(arc);
  }

  return arcs.sort((x, y) => y.heat - x.heat || y.lastActivity - x.lastActivity).slice(0, MAX_ARCS);
}
