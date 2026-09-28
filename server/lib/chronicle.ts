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
import { agents, relationships, relationshipEvents, shared_knowledge } from '../db/schema';
import { desc, eq } from 'drizzle-orm';

export type ArcKind =
  | 'romance'
  | 'rivalry'
  | 'reconciliation'
  | 'love_triangle'
  | 'downfall'
  | 'scandal';

export interface ArcBeat {
  /** Real (wall-clock) ms, which is what `relationship_events.timestamp` holds. */
  timestamp: number;
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
  /** 0..1 — recency-weighted sum of beat weights. Sorts the list. */
  heat: number;
  /** Real ms of the newest beat. */
  lastActivity: number;
}

/** Recomputing on every feed invalidation would re-scan five tables per poll. */
const CACHE_TTL_MS = 3000;
/** Newest N relationship events scanned. Older ones can't be "current" stories. */
const EVENT_WINDOW = 600;
const MAX_ARCS = 12;
const MAX_BEATS = 8;
/** A beat contributes half as much heat every time this elapses. */
const HEAT_HALF_LIFE_MS = 15 * 60 * 1000;

const ROMANTIC_STATUSES = new Set(['partners', 'romantic_interest', 'complicated']);
const HOSTILE_STATUSES = new Set(['enemies', 'rivals', 'estranged']);
const HOSTILE_EVENTS = new Set([
  'fight',
  'confrontation',
  'confrontation_escalated',
  'theft_caught',
  'arrested',
]);
const ROMANTIC_EVENTS = new Set(['confession', 'seduction', 'gift']);

/** Order-independent key for a pair of agent ids. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function beatWeight(sentiment: number, eventType: string): number {
  // Strong feeling in either direction is what makes a beat memorable, so the
  // sign is dropped. Named turning points get a floor: a reconciliation logged
  // at sentiment 0.1 is still the moment the arc pivots.
  const pivotal =
    HOSTILE_EVENTS.has(eventType) ||
    ROMANTIC_EVENTS.has(eventType) ||
    eventType === 'reconciliation';
  return Math.min(1, Math.max(pivotal ? 0.5 : 0.1, Math.abs(sentiment)));
}

function heatOf(beats: ArcBeat[], now: number): number {
  let heat = 0;
  for (const beat of beats) {
    const age = Math.max(0, now - beat.timestamp);
    heat += beat.weight * 0.5 ** (age / HEAT_HALF_LIFE_MS);
  }
  return Math.min(1, heat);
}

type EventRow = typeof relationshipEvents.$inferSelect;

/**
 * Newest-first rows in, chronological beats out, capped at `MAX_BEATS`. The cap
 * is applied before the flip so a long-running feud shows its latest turns
 * rather than its opening shots.
 */
function toBeats(rows: EventRow[]): ArcBeat[] {
  return rows
    .slice(0, MAX_BEATS)
    .map((row) => ({
      timestamp: row.timestamp,
      eventType: row.event_type,
      description: row.description,
      weight: beatWeight(row.sentiment, row.event_type),
    }))
    .reverse();
}

interface CacheEntry {
  at: number;
  arcs: StoryArc[];
}

let cache: CacheEntry | null = null;

/** Drops the memo. Only tests need this — production just waits out the TTL. */
export function resetChronicleCache() {
  cache = null;
}

export function detectStoryArcs(): StoryArc[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.arcs;

  const arcs = buildArcs(
    {
      agents: db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.is_active, true))
        .all(),
      relationships: db.select().from(relationships).all(),
      events: db
        .select()
        .from(relationshipEvents)
        .orderBy(desc(relationshipEvents.timestamp), desc(relationshipEvents.id))
        .limit(EVENT_WINDOW)
        .all(),
      secrets: db
        .select()
        .from(shared_knowledge)
        .where(eq(shared_knowledge.is_active, true))
        .all(),
    },
    now,
  );
  cache = { at: now, arcs };
  return arcs;
}

export interface ChronicleInput {
  /** Living agents only — arcs about the departed aren't current stories. */
  agents: { id: number; name: string }[];
  relationships: typeof relationships.$inferSelect[];
  /** Newest first. */
  events: EventRow[];
  secrets: typeof shared_knowledge.$inferSelect[];
}

/**
 * The detector proper, split from the queries so it can be exercised on
 * fixtures instead of against the live sqlite file.
 */
export function buildArcs(input: ChronicleInput, now: number): StoryArc[] {
  const agentRows = input.agents;
  if (agentRows.length === 0) return [];

  const nameOf = new Map<number, string>(agentRows.map((a) => [a.id, a.name]));
  const relationshipRows = input.relationships;
  const eventRows = input.events;

  // Newest-first within each pair, inherited from the caller's ordering.
  const eventsByPair = new Map<string, EventRow[]>();
  for (const row of eventRows) {
    const key = pairKey(row.agent_a, row.agent_b);
    const bucket = eventsByPair.get(key);
    if (bucket) bucket.push(row);
    else eventsByPair.set(key, [row]);
  }

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
    return {
      id: `${kind}:${[...participants].sort((a, b) => a - b).join('-')}`,
      kind,
      title,
      summary,
      participants,
      participantNames: participants.map((id) => nameOf.get(id) ?? `#${id}`),
      beats,
      heat: heatOverride ?? heatOf(beats, now),
      lastActivity: beats[beats.length - 1].timestamp,
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
    const mendIndex = pairEvents.findIndex((e) => e.event_type === 'reconciliation');
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
        toBeats(pairEvents),
      );
    } else if (ROMANTIC_STATUSES.has(rel.status) || romanticCount >= 2) {
      const shape =
        rel.status === 'partners'
          ? 'Together.'
          : rel.status === 'complicated'
            ? 'It is complicated.'
            : 'Something is starting.';
      arc = makeArc('romance', [a, b], `${nameA} & ${nameB}`, shape, toBeats(pairEvents));
    } else if (HOSTILE_STATUSES.has(rel.status) || hostileCount >= 2) {
      arc = makeArc(
        'rivalry',
        [a, b],
        `${nameA} vs ${nameB}`,
        `${hostileCount} clash${hostileCount === 1 ? '' : 'es'} and counting.`,
        toBeats(pairEvents.filter((e) => e.sentiment < 0 || HOSTILE_EVENTS.has(e.event_type))),
      );
    }
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
      ].sort((x, y) => y.timestamp - x.timestamp);

      const arc = makeArc(
        'love_triangle',
        [anchor, partner, third.other],
        `${nameOf.get(third.other)}, ${nameOf.get(anchor)} and ${nameOf.get(partner)}`,
        `${nameOf.get(third.other)} still wants ${nameOf.get(anchor)}, who is with ${nameOf.get(partner)}.`,
        toBeats(merged),
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
      toBeats(rows),
    );
    if (arc) push(arc);
  }

  // --- Scandals ------------------------------------------------------------
  // A secret stops being a secret once enough people hold it. There is no event
  // stream for that, so the single beat is synthesised from the row itself, and
  // heat comes from how damaging and how widespread it is rather than from
  // recency: `created_at` is 0 for every secret the setup wizard plants, which
  // under the usual decay would bury the town's backstory permanently.
  for (const secret of input.secrets) {
    if (secret.sensitivity < 3) continue;
    const holders = secret.known_by?.length ?? 0;
    if (holders < 3) continue;
    if (!nameOf.has(secret.subject_id)) continue;

    const participants = [secret.subject_id];
    if (secret.target_id != null && nameOf.has(secret.target_id)) {
      participants.push(secret.target_id);
    }
    const arc = makeArc(
      'scandal',
      participants,
      `${nameOf.get(secret.subject_id)}'s secret`,
      `${holders} people know. It will not stay quiet.`,
      [
        {
          timestamp: secret.created_at,
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
