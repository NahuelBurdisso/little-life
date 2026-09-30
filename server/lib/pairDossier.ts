/**
 * Pair dossier — everything the game knows about ONE pair of residents, on one
 * page: how each feels about the other, how it got there, and who else knows.
 *
 * Following who loves and hates whom, and why, is the heart of the game, but
 * the data was scattered: the graph showed a hover tooltip, the agent panel a
 * row of dots, the chronicle only the pairs whose story crossed a threshold,
 * the secret network only the secrets. Nothing answered "what happened between
 * Mara and Jonas?". This is a pure read layer over tables the engine already
 * writes (no columns, no tick participation), like `chronicle.ts`.
 *
 * Orientation: everything directional is returned from the CALLER's point of
 * view — `aToB` is how the first id feels about the second — because the
 * stored rows aren't consistent about it (`relationships` is normalised
 * `agent_a < agent_b`, `relationship_events` are written giver -> receiver by
 * gifts and confrontations and a < b by most others).
 */

import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  agents,
  conversations,
  relationshipEvents,
  relationships,
  shared_knowledge,
  worldState,
} from '../db/schema';
import { applyDiminishing } from '../engine/systems/relationships';
import { pickConversationGist } from './memory/conversationGist';
import { detectStoryArcs, type ArcBeat, type ArcKind } from './chronicle';
import { gameMinutes } from './gameClock';
import { isPivotalEvent } from './storyBeats';
import { CONFIG } from './constants';
import { clamp } from './utils';
import { childAgeDays, childrenOfAny } from './familyState';

/** How many past conversations the dossier lists. */
export const DOSSIER_CONVERSATIONS = 10;
/** Newest events returned for the timeline (the sparkline uses all of them). */
export const DOSSIER_EVENTS = 60;
/**
 * The secret network hides facts below this sensitivity (`knowledge
 * .getSecretNetwork`: `gte(sensitivity, 2)`). The dossier follows the same
 * disclosure level rather than inventing its own: what the player can already
 * read in the Secrets panel is exactly what may appear here, no more. Level 0-1
 * rows are ordinary trivia ("likes fishing"), not secrets.
 */
export const SECRET_DISCLOSURE_MIN_SENSITIVITY = 2;

/** A directional triple: how `from` feels toward `to`. */
export interface Feeling {
  friendship: number;
  romance: number;
  trust: number;
}

export interface DossierRelationship {
  status: string;
  tags: string[];
  familiarity: number;
  interactionCount: number;
  /** How A feels about B. */
  aToB: Feeling;
  /** How B feels about A. */
  bToA: Feeling;
}

export interface DossierEvent {
  id: number;
  /** Game minute; an unstamped row (the insert trigger missed it) reads as "now". */
  gameMinute: number;
  eventType: string;
  description: string;
  /** Raw event sentiment, -1..1. */
  sentiment: number;
  /** The isPivotalEvent verdict — the same one retention uses to keep the row. */
  pivotal: boolean;
  /** Who did it (events are recorded actor -> other). */
  actorId: number;
  /** Deltas from A's and B's point of view (before diminishing returns). */
  friendshipAToB: number;
  friendshipBToA: number;
  romanceAToB: number;
  romanceBToA: number;
  /** False while the relationship tick hasn't applied its deltas yet. */
  processed: boolean;
}

export interface DossierConversation {
  id: number;
  topic: string | null;
  sentiment: number;
  /** Messages in the transcript. */
  turns: number;
  triggerReason: string;
  /** Others in the room besides the pair (group chats); usually 0. */
  otherParticipants: number;
  gameMinute: number;
  /** True when `gameMinute` was estimated from wall-clock age (see `conversationMinute`). */
  gameMinuteApproximate: boolean;
  /** The most charged line, when one clears the gist heuristic. */
  quote: { speakerId: number; speakerName: string; text: string } | null;
}

export interface DossierSecret {
  id: number;
  type: string;
  content: string;
  sensitivity: number;
  isPublic: boolean;
  /**
   * `between`: subject and target are this pair. `about_a` / `about_b`: only
   * one of them is involved (the other party is someone else, or nobody).
   */
  scope: 'between' | 'about_a' | 'about_b';
  subjectName: string | null;
  targetName: string | null;
  /** Living residents who know it. */
  knownByNames: string[];
}

export interface DossierArc {
  id: string;
  kind: ArcKind;
  title: string;
  summary: string;
  participantNames: string[];
  heat: number;
  beats: ArcBeat[];
}

export interface HistoryPoint {
  /** Game minute. */
  minute: number;
  aToB: number;
  bToA: number;
}

export interface DossierChild {
  id: number;
  name: string;
  sex: string;
  ageDays: number;
  /** The pair are the mother and the rumoured (revealed) true father, not the husband. */
  rumoured: boolean;
}

export interface PairDossier {
  a: { id: number; name: string };
  b: { id: number; name: string };
  /** Current game minute, so the client can age everything on one clock. */
  nowMinute: number;
  /** Null until the pair has met (no relationship row). */
  relationship: DossierRelationship | null;
  /** Chronological, oldest first. */
  events: DossierEvent[];
  /** Newest first. */
  conversations: DossierConversation[];
  secrets: DossierSecret[];
  arcs: DossierArc[];
  /**
   * Children the two share (lib/family.ts): their own, or — once the town
   * knows — the one the paternity secret says is the other's. Eldest first.
   */
  children: DossierChild[];
  history: {
    friendship: HistoryPoint[];
    romance: HistoryPoint[];
    trust: HistoryPoint[];
  };
}

type EventRow = typeof relationshipEvents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

// --- Sparkline reconstruction ------------------------------------------------

/**
 * Undo one applied delta. The engine applies `v' = clamp(v + applyDiminishing(v,
 * d))` (relationships.ts), which is piecewise: with no resistance `v' = v + d`,
 * with resistance `v' = v + d(1 - f|v|/100)`. Both branches are linear in `v`,
 * so each has a closed-form inverse; the branch is whichever candidate is
 * consistent with the forward rule (its own sign condition holds and applying
 * the delta really lands on `after`). Plain subtraction ignored the resistance
 * and drifted a dozen points on a well-loved friend after a few gifts.
 *
 * When neither candidate round-trips (the value was clamped at +-100, or the
 * estrangement rule discarded a positive delta) the plain subtraction is the
 * best guess, clamped back into range.
 */
export function undoDelta(after: number, delta: number): number {
  if (delta === 0) return after;
  const f = CONFIG.RELATIONSHIPS.DIMINISHING_RETURNS_FACTOR;
  const forward = (before: number) => clamp(before + applyDiminishing(before, delta), -100, 100);
  const EPS = 1e-6;

  const plain = after - delta;
  if (Math.abs(forward(plain) - after) < EPS) return clamp(plain, -100, 100);

  const denom = 1 - (Math.abs(delta) * f) / 100;
  if (denom > EPS) {
    const resisted = (after - delta) / denom;
    if (Math.abs(forward(resisted) - after) < EPS) return clamp(resisted, -100, 100);
  }
  return clamp(plain, -100, 100);
}

interface SeriesEvent {
  id: number;
  minute: number;
  aToB: number;
  bToA: number;
}

/**
 * Rebuild a value's history backwards from where it stands now.
 *
 * Nothing stores the past values, but every change to them went through a
 * `relationship_events` row carrying its deltas, so walking those in reverse
 * from the current value recovers the path. It is an approximation, and says
 * so in the UI: ordinary events are pruned after three game days (so the far
 * past is flat, not unknown-then-known), and the daily decay and proximity
 * drift touch the values without an event — the reconstruction pins the END to
 * the true current value and absorbs those into the earlier points.
 *
 * `events` must be the PROCESSED ones only, in processing order (id ascending):
 * an unprocessed event's delta has not been added to the row yet, so undoing it
 * would subtract something that was never there.
 *
 * Events whose delta for this value is zero add no point (a small chat that
 * moved only trust shouldn't put a kink in the friendship line). Returns
 * oldest first, ending with a point at `nowMinute` holding the current value;
 * fewer than one event gives an empty series (a flat line tells nothing).
 */
export function reconstructSeries(
  current: { aToB: number; bToA: number },
  events: readonly SeriesEvent[],
  nowMinute: number,
): HistoryPoint[] {
  const moving = events.filter((e) => e.aToB !== 0 || e.bToA !== 0);
  if (moving.length === 0) return [];

  const points: HistoryPoint[] = [];
  let ab = current.aToB;
  let ba = current.bToA;
  for (let i = moving.length - 1; i >= 0; i--) {
    const e = moving[i];
    points.push({ minute: e.minute, aToB: ab, bToA: ba });
    ab = undoDelta(ab, e.aToB);
    ba = undoDelta(ba, e.bToA);
  }
  // Where it stood before the oldest recorded event, placed at that event's
  // minute so the line steps up rather than slanting from nowhere.
  points.push({ minute: moving[0].minute, aToB: ab, bToA: ba });
  points.reverse();

  // Game minutes can tie or, for events processed a tick late, run slightly out
  // of order; a stable sort keeps id order among equals.
  points.sort((x, y) => x.minute - y.minute);
  const last = points[points.length - 1];
  if (last.minute < nowMinute) {
    points.push({ minute: nowMinute, aToB: current.aToB, bToA: current.bToA });
  }
  return points;
}

// --- Conversation clock --------------------------------------------------------

/**
 * A conversation's game minute.
 *
 * `conversations` carries only wall-clock stamps (`started_at` / `ended_at` are
 * `Date.now()`), so game time has to be borrowed. The exact source is the pair's
 * relationship events: they are written when the conversation ends, stamped
 * with the world clock by the insert trigger, and `conversations.getImpact`
 * already matches them to a conversation by the same +-5 s window. Those rows
 * are pruned after three game days, though, so an older conversation falls back
 * to an estimate: wall-clock age x tick_speed, the same conversion the event
 * backfill uses (`relationshipEventClock.ts`), clamped to [0, now]. Server-off
 * time inflates that age, which is why the result is flagged approximate.
 */
export function conversationMinute(
  convo: Pick<ConversationRow, 'started_at' | 'ended_at'>,
  pairEvents: readonly Pick<EventRow, 'timestamp' | 'game_minute'>[],
  clock: { nowMinute: number; nowMs: number; tickSpeed: number },
): { minute: number; approximate: boolean } {
  const start = convo.started_at - 5000;
  const end = (convo.ended_at ?? convo.started_at) + 5000;
  const anchor = (convo.ended_at ?? convo.started_at);
  let best: (typeof pairEvents)[number] | null = null;
  for (const e of pairEvents) {
    if (e.game_minute == null || e.timestamp < start || e.timestamp > end) continue;
    if (!best || Math.abs(e.timestamp - anchor) < Math.abs(best.timestamp - anchor)) best = e;
  }
  if (best) return { minute: best.game_minute!, approximate: false };

  const speed = clock.tickSpeed > 0 ? clock.tickSpeed : 1;
  const ageMinutes = Math.floor((Math.max(0, clock.nowMs - anchor) / 1000) * speed);
  return {
    minute: clamp(clock.nowMinute - ageMinutes, 0, clock.nowMinute),
    approximate: true,
  };
}

// --- The dossier -------------------------------------------------------------------

/** Turns the caller's (a, b) into the value each stored direction means. */
function feelingOf(rel: typeof relationships.$inferSelect, from: number): Feeling {
  const fromIsA = rel.agent_a === from;
  return {
    friendship: fromIsA ? rel.friendship_ab : rel.friendship_ba,
    romance: fromIsA ? rel.romance_ab : rel.romance_ba,
    trust: fromIsA ? rel.trust_ab : rel.trust_ba,
  };
}

/**
 * The full picture for one pair, or null when either id isn't a resident.
 * Removed residents still resolve (their history is still part of the story).
 * `nowMs` is injectable so tests don't depend on the wall clock.
 */
export function getPairDossier(aId: number, bId: number, nowMs: number = Date.now()): PairDossier | null {
  if (aId === bId) return null;

  const people = db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(inArray(agents.id, [aId, bId]))
    .all();
  const a = people.find((p) => p.id === aId);
  const b = people.find((p) => p.id === bId);
  if (!a || !b) return null;

  const world = db.select({ time: worldState.time, tick_speed: worldState.tick_speed }).from(worldState).get();
  // No world row means no clock; there is nothing sensible to date things by.
  if (!world) return null;
  const nowMinute = gameMinutes(world.time);

  const lo = Math.min(aId, bId);
  const hi = Math.max(aId, bId);

  // --- Relationship, both directions --------------------------------------
  const relRow = db
    .select()
    .from(relationships)
    .where(and(eq(relationships.agent_a, lo), eq(relationships.agent_b, hi)))
    .get();
  const relationship: DossierRelationship | null = relRow
    ? {
        status: relRow.status,
        tags: relRow.tags ?? [],
        familiarity: relRow.familiarity,
        interactionCount: relRow.interaction_count,
        aToB: feelingOf(relRow, aId),
        bToA: feelingOf(relRow, bId),
      }
    : null;

  // --- Events (either recording direction) ----------------------------------
  const eventRows = db
    .select()
    .from(relationshipEvents)
    .where(
      or(
        and(eq(relationshipEvents.agent_a, aId), eq(relationshipEvents.agent_b, bId)),
        and(eq(relationshipEvents.agent_a, bId), eq(relationshipEvents.agent_b, aId)),
      ),
    )
    .orderBy(asc(relationshipEvents.id))
    .all();

  /** Deltas re-read from A's point of view: an event stored b -> a swaps them. */
  const orient = (e: EventRow) => {
    const forward = e.agent_a === aId;
    return {
      friendshipAToB: forward ? e.friendship_delta_ab : e.friendship_delta_ba,
      friendshipBToA: forward ? e.friendship_delta_ba : e.friendship_delta_ab,
      romanceAToB: forward ? e.romance_delta_ab : e.romance_delta_ba,
      romanceBToA: forward ? e.romance_delta_ba : e.romance_delta_ab,
      trustAToB: forward ? e.trust_delta_ab : e.trust_delta_ba,
      trustBToA: forward ? e.trust_delta_ba : e.trust_delta_ab,
    };
  };

  const minuteOf = (e: EventRow) => e.game_minute ?? nowMinute;

  // Timeline order is by when it happened; the sparkline below needs processing
  // order (id), so it walks `eventRows` as fetched.
  const timeline = [...eventRows]
    .sort((x, y) => minuteOf(x) - minuteOf(y) || x.id - y.id)
    .slice(-DOSSIER_EVENTS)
    .map((e): DossierEvent => {
      const o = orient(e);
      return {
        id: e.id,
        gameMinute: minuteOf(e),
        eventType: e.event_type,
        description: e.description,
        sentiment: e.sentiment,
        pivotal: isPivotalEvent(e.event_type, e.sentiment),
        actorId: e.agent_a,
        friendshipAToB: o.friendshipAToB,
        friendshipBToA: o.friendshipBToA,
        romanceAToB: o.romanceAToB,
        romanceBToA: o.romanceBToA,
        processed: e.processed,
      };
    });

  // --- Sparkline series ------------------------------------------------------
  const applied = eventRows.filter((e) => e.processed);
  const seriesFor = (
    pick: (o: ReturnType<typeof orient>) => [number, number],
    field: keyof Feeling,
  ): HistoryPoint[] => {
    if (!relationship) return [];
    return reconstructSeries(
      { aToB: relationship.aToB[field], bToA: relationship.bToA[field] },
      applied.map((e) => {
        const [ab, ba] = pick(orient(e));
        return { id: e.id, minute: minuteOf(e), aToB: ab, bToA: ba };
      }),
      nowMinute,
    );
  };
  const history = {
    friendship: seriesFor((o) => [o.friendshipAToB, o.friendshipBToA], 'friendship'),
    romance: seriesFor((o) => [o.romanceAToB, o.romanceBToA], 'romance'),
    trust: seriesFor((o) => [o.trustAToB, o.trustBToA], 'trust'),
  };

  // --- Conversations between them -----------------------------------------
  // `participants` is a JSON array column, so membership is a json_each probe.
  // It scans the table (no index can serve it), but only ended rows are
  // considered and the newest ten are all that is kept.
  const inParticipants = (id: number) =>
    sql`EXISTS (SELECT 1 FROM json_each(${conversations.participants}) WHERE json_each.value = ${id})`;
  const convoRows = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.status, 'ended'), inParticipants(aId), inParticipants(bId)))
    .orderBy(desc(conversations.ended_at), desc(conversations.id))
    .limit(DOSSIER_CONVERSATIONS)
    .all();

  const clock = { nowMinute, nowMs, tickSpeed: world.tick_speed };
  const nameById = new Map<number, string>([[aId, a.name], [bId, b.name]]);
  const dossierConversations = convoRows.map((c): DossierConversation => {
    const when = conversationMinute(c, eventRows, clock);
    const messages = (c.messages ?? []) as Array<{
      speakerId: number;
      text: string;
      sentiment?: number;
      fallback?: boolean;
    }>;
    const gist = pickConversationGist(messages, (id) => nameById.get(id));
    return {
      id: c.id,
      topic: c.topic,
      sentiment: c.sentiment ?? 0,
      turns: messages.length,
      triggerReason: c.trigger_reason,
      otherParticipants: (c.participants as number[]).filter((p) => p !== aId && p !== bId).length,
      gameMinute: when.minute,
      gameMinuteApproximate: when.approximate,
      quote: gist
        ? { speakerId: gist.speakerId, speakerName: nameById.get(gist.speakerId) ?? `#${gist.speakerId}`, text: gist.quote }
        : null,
    };
  });

  // --- Secrets ----------------------------------------------------------------------
  const livingNames = new Map(
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.is_active, true))
      .all()
      .map((p) => [p.id, p.name] as const),
  );
  const allNames = (id: number | null) => (id == null ? null : (livingNames.get(id) ?? nameById.get(id) ?? null));
  const secrets = db
    .select()
    .from(shared_knowledge)
    .where(eq(shared_knowledge.is_active, true))
    .all()
    .filter((f) => f.sensitivity >= SECRET_DISCLOSURE_MIN_SENSITIVITY)
    .flatMap((f): DossierSecret[] => {
      const involvesA = f.subject_id === aId || f.target_id === aId;
      const involvesB = f.subject_id === bId || f.target_id === bId;
      if (!involvesA && !involvesB) return [];
      const inPair = (id: number | null) => id === aId || id === bId;
      const between = inPair(f.subject_id) && inPair(f.target_id) && f.subject_id !== f.target_id;
      return [
        {
          id: f.id,
          type: f.type,
          content: f.content,
          sensitivity: f.sensitivity,
          isPublic: f.is_public,
          scope: between ? 'between' : involvesA ? 'about_a' : 'about_b',
          subjectName: allNames(f.subject_id),
          targetName: allNames(f.target_id),
          // Living knowers only, like the secret network: the departed are not
          // "who knows" any more.
          knownByNames: ((f.known_by ?? []) as number[])
            .filter((id) => livingNames.has(id))
            .map((id) => livingNames.get(id)!),
        },
      ];
    })
    .sort((x, y) => Number(y.scope === 'between') - Number(x.scope === 'between') || y.sensitivity - x.sensitivity || y.id - x.id);

  // --- Arcs involving both ----------------------------------------------------------
  const arcs = detectStoryArcs()
    .filter((arc) => arc.participants.includes(aId) && arc.participants.includes(bId))
    .map((arc): DossierArc => ({
      id: arc.id,
      kind: arc.kind,
      title: arc.title,
      summary: arc.summary,
      participantNames: arc.participantNames,
      heat: arc.heat,
      beats: arc.beats,
    }));

  // --- Children they share --------------------------------------------------------
  const pair = [aId, bId];
  const sharedChildren = childrenOfAny(pair)
    .flatMap((c): DossierChild[] => {
      const own = pair.includes(c.mother_id) && c.father_id != null && pair.includes(c.father_id);
      const rumoured = !own && c.paternity_revealed && pair.includes(c.mother_id)
        && c.true_father_id != null && pair.includes(c.true_father_id);
      if (!own && !rumoured) return [];
      return [{ id: c.id, name: c.name, sex: c.sex, ageDays: childAgeDays(c.birth_game_minute, nowMinute), rumoured }];
    });

  return {
    a,
    b,
    nowMinute,
    relationship,
    events: timeline,
    conversations: dossierConversations,
    secrets,
    arcs,
    children: sharedChildren,
    history,
  };
}
