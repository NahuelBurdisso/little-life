import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  agents,
  conversations,
  locations,
  relationshipEvents,
  relationships,
  shared_knowledge,
  worldState,
} from '../../db/schema';
import { applyDiminishing } from '../../engine/systems/relationships';
import { resetChronicleCache } from '../chronicle';
import {
  conversationMinute,
  DOSSIER_CONVERSATIONS,
  getPairDossier,
  reconstructSeries,
  undoDelta,
} from '../pairDossier';

/**
 * Against the test DB for the queries (orientation, json_each membership,
 * disclosure) and on plain numbers for the sparkline maths.
 */

const DAY = 1440;
const NOW = 10 * DAY + 600;
const NOW_MS = 1_800_000_000_000;

let a = 0;
let b = 0;
let c = 0;
let d = 0;

function insertAgent(name: string, locId: number, active = true): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality: null,
    age: 30,
    gender: 'female',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 0, y: 0 },
    current_location: locId,
    current_action: { type: 'idle' },
    action_started: 0,
    action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: locId,
    created_at: 0,
    is_active: active,
  }).returning({ id: agents.id }).get().id;
}

function setClock(totalMinutes: number, tickSpeed = 1): void {
  const time = {
    day: Math.floor(totalMinutes / DAY),
    hour: Math.floor((totalMinutes % DAY) / 60),
    minute: totalMinutes % 60,
    totalTicks: totalMinutes,
    seasonDay: 1,
    season: 'spring',
  };
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, tick_speed: tickSpeed, is_paused: true }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time,
    day_phase: 'morning',
    weather: 'sunny',
    weather_duration: 120,
    tick_speed: tickSpeed,
    is_paused: true,
    last_tick_completed: 0,
    current_tick_phase: 0,
    tick_id: 'test',
    pending_transitions: [],
    tax_pool: 0,
    map_width: 40,
    map_height: 30,
    collision_grid: '',
  }).run();
}

interface EventOpts {
  minute: number;
  type?: string;
  sentiment?: number;
  processed?: boolean;
  /** Deltas in the direction of the row (from -> to). */
  f?: [number, number];
  r?: [number, number];
  timestamp?: number;
}

function logEvent(from: number, to: number, o: EventOpts): void {
  db.insert(relationshipEvents).values({
    agent_a: from,
    agent_b: to,
    event_type: o.type ?? 'conversation',
    description: `${o.type ?? 'conversation'} ${from}->${to}`,
    friendship_delta_ab: o.f?.[0] ?? 0,
    friendship_delta_ba: o.f?.[1] ?? 0,
    romance_delta_ab: o.r?.[0] ?? 0,
    romance_delta_ba: o.r?.[1] ?? 0,
    trust_delta_ab: 0,
    trust_delta_ba: 0,
    sentiment: o.sentiment ?? 0,
    processed: o.processed ?? true,
    timestamp: o.timestamp ?? NOW_MS,
    game_minute: o.minute,
  }).run();
}

/** `lo`/`hi` are stored normalised, as the engine keeps them. */
function relate(x: number, y: number, v: { fAB: number; fBA: number; rAB?: number; rBA?: number; status?: string }): void {
  db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y),
    friendship_ab: v.fAB, friendship_ba: v.fBA,
    romance_ab: v.rAB ?? 0, romance_ba: v.rBA ?? 0,
    trust_ab: 0, trust_ba: 0,
    familiarity: 40, interaction_count: 5, last_interaction: 0,
    average_interaction_sentiment: 0, tags: ['grudge'], status: v.status ?? 'friends',
    created_at: 0, last_updated: 0,
  }).run();
}

function insertConversation(participants: number[], o: {
  endedAt: number;
  status?: string;
  topic?: string;
  messages?: Array<Record<string, unknown>>;
}): number {
  return db.insert(conversations).values({
    participants,
    messages: o.messages ?? [],
    location: null,
    trigger_reason: 'test',
    topic: o.topic ?? 'weather',
    status: o.status ?? 'ended',
    started_at: o.endedAt - 20_000,
    ended_at: o.endedAt,
    sentiment: 0.1,
    max_turns: 4,
  }).returning({ id: conversations.id }).get().id;
}

function insertFact(o: {
  subject: number;
  target?: number | null;
  sensitivity: number;
  active?: boolean;
  knownBy?: number[];
  content?: string;
  isPublic?: boolean;
}): number {
  return db.insert(shared_knowledge).values({
    type: 'secret',
    subject_id: o.subject,
    target_id: o.target ?? null,
    content: o.content ?? `secret ${o.subject}/${o.target ?? '-'}`,
    sensitivity: o.sensitivity,
    known_by: o.knownBy ?? [o.subject],
    created_at: 0,
    is_active: o.active ?? true,
    source: 'test',
    is_public: o.isPublic ?? false,
  }).returning({ id: shared_knowledge.id }).get().id;
}

describe('getPairDossier', () => {
  beforeAll(() => {
    const locId = db.insert(locations).values({
      name: 'Dossier Square',
      type: 'town_square',
      position: { x: 0, y: 0, width: 10, height: 10 },
      entry_point: { x: 0, y: 0 },
      capacity: 10,
      current_occupants: [],
      services: [],
      description: 'test',
    }).returning({ id: locations.id }).get().id;
    a = insertAgent('Mara', locId);
    b = insertAgent('Jonas', locId);
    c = insertAgent('Edda', locId);
    d = insertAgent('Piet', locId, false);
  });

  beforeEach(() => {
    db.delete(relationshipEvents).run();
    db.delete(relationships).run();
    db.delete(conversations).run();
    db.delete(shared_knowledge).run();
    setClock(NOW);
    resetChronicleCache();
  });

  afterEach(() => resetChronicleCache());

  describe('relationship, both directions', () => {
    it('reports each side from the first argument’s point of view', () => {
      // Stored normalised (lo -> hi): the lower id likes the higher one a lot,
      // the higher one is lukewarm.
      const lo = Math.min(a, b);
      relate(a, b, { fAB: 70, fBA: 10, rAB: 40, rBA: 0, status: 'close_friends' });

      const fromA = getPairDossier(a, b, NOW_MS)!;
      const fromB = getPairDossier(b, a, NOW_MS)!;
      const [aIsLo, bIsLo] = [a === lo, b === lo];

      expect(fromA.relationship!.aToB.friendship).toBe(aIsLo ? 70 : 10);
      expect(fromA.relationship!.bToA.friendship).toBe(aIsLo ? 10 : 70);
      expect(fromA.relationship!.aToB.romance).toBe(aIsLo ? 40 : 0);
      // The mirror image, from B's side.
      expect(fromB.relationship!.aToB.friendship).toBe(bIsLo ? 70 : 10);
      expect(fromB.relationship!.aToB).toEqual(fromA.relationship!.bToA);
      expect(fromB.relationship!.bToA).toEqual(fromA.relationship!.aToB);
      expect(fromA.relationship).toMatchObject({ status: 'close_friends', tags: ['grudge'], interactionCount: 5 });
      expect(fromA.a).toEqual({ id: a, name: 'Mara' });
      expect(fromB.a).toEqual({ id: b, name: 'Jonas' });
      expect(fromA.nowMinute).toBe(NOW);
    });

    it('has a null relationship for two who have not met, and null for a non-resident', () => {
      expect(getPairDossier(a, b, NOW_MS)!.relationship).toBeNull();
      expect(getPairDossier(a, 999_999, NOW_MS)).toBeNull();
      expect(getPairDossier(a, a, NOW_MS)).toBeNull();
    });
  });

  describe('events', () => {
    it('finds events recorded in either direction and re-reads their deltas from A’s side', () => {
      relate(a, b, { fAB: 0, fBA: 0 });
      // a -> b: a warmed to b by 10, b to a by 4.
      logEvent(a, b, { minute: NOW - 300, f: [10, 4] });
      // b -> a (a gift, giver -> receiver): b's delta first.
      logEvent(b, a, { minute: NOW - 100, type: 'gift', f: [6, 2], r: [3, 1] });
      // Someone else's business.
      logEvent(a, c, { minute: NOW - 50, f: [9, 9] });

      const dossier = getPairDossier(a, b, NOW_MS)!;
      expect(dossier.events).toHaveLength(2);
      const [first, second] = dossier.events;
      expect(first).toMatchObject({ gameMinute: NOW - 300, friendshipAToB: 10, friendshipBToA: 4, actorId: a });
      // Stored b -> a, so from A's side the deltas swap.
      expect(second).toMatchObject({
        gameMinute: NOW - 100,
        eventType: 'gift',
        friendshipAToB: 2,
        friendshipBToA: 6,
        romanceAToB: 1,
        romanceBToA: 3,
        actorId: b,
        pivotal: true,
      });
      expect(first.pivotal).toBe(false);
    });

    it('lists the timeline oldest first and keeps unprocessed events out of the history but in the story', () => {
      relate(a, b, { fAB: 30, fBA: 30 });
      logEvent(a, b, { minute: NOW - 400, f: [10, 10] });
      logEvent(a, b, { minute: NOW - 5, f: [20, 20], processed: false });

      const dossier = getPairDossier(a, b, NOW_MS)!;
      expect(dossier.events.map((e) => [e.gameMinute, e.processed])).toEqual([
        [NOW - 400, true],
        [NOW - 5, false],
      ]);
      // The unprocessed +20 was never added to the row, so it must not be
      // subtracted back out: the +10 landed with diminishing returns (x + 10(1 - 0.6x/100) = 30), so it started at 21.28.
      const friendship = dossier.history.friendship;
      expect(friendship[0].aToB).toBeCloseTo(21.2766, 3);
      expect(friendship[friendship.length - 1].aToB).toBe(30);
    });
  });

  describe('conversations between them', () => {
    it('lists only conversations both took part in, whatever the participant order', () => {
      relate(a, b, { fAB: 0, fBA: 0 });
      const ab = insertConversation([a, b], { endedAt: NOW_MS - 3000, topic: 'ab' });
      const ba = insertConversation([b, a], { endedAt: NOW_MS - 2000, topic: 'ba' });
      const group = insertConversation([a, c, b], { endedAt: NOW_MS - 1000, topic: 'group' });
      insertConversation([a, c], { endedAt: NOW_MS - 500, topic: 'a-c' });
      insertConversation([b, c], { endedAt: NOW_MS - 400, topic: 'b-c' });
      insertConversation([c, d], { endedAt: NOW_MS - 300, topic: 'c-d' });
      // Still going: not part of the record yet.
      insertConversation([a, b], { endedAt: NOW_MS - 100, topic: 'live', status: 'active' });

      const convos = getPairDossier(a, b, NOW_MS)!.conversations;
      expect(convos.map((x) => x.id)).toEqual([group, ba, ab]);
      expect(convos[0].otherParticipants).toBe(1);
      expect(convos[1].otherParticipants).toBe(0);
    });

    it('matches ids exactly, not by substring', () => {
      // json_each compares values, so participant 1 must not match 11 or 21.
      relate(a, b, { fAB: 0, fBA: 0 });
      const other = insertConversation([a + 1000, b + 1000], { endedAt: NOW_MS - 1000 });
      expect(other).toBeGreaterThan(0);
      expect(getPairDossier(a, b, NOW_MS)!.conversations).toHaveLength(0);
    });

    it('keeps the newest ten', () => {
      relate(a, b, { fAB: 0, fBA: 0 });
      for (let i = 0; i < DOSSIER_CONVERSATIONS + 5; i++) {
        insertConversation([a, b], { endedAt: NOW_MS - (100 - i) * 1000, topic: `t${i}` });
      }
      const convos = getPairDossier(a, b, NOW_MS)!.conversations;
      expect(convos).toHaveLength(DOSSIER_CONVERSATIONS);
      expect(convos[0].topic).toBe(`t${DOSSIER_CONVERSATIONS + 4}`);
    });

    it('reports turns and a charged quote, and no quote for small talk', () => {
      relate(a, b, { fAB: 0, fBA: 0 });
      insertConversation([a, b], {
        endedAt: NOW_MS - 2000,
        topic: 'feelings',
        messages: [
          { speakerId: a, text: 'Lovely weather we are having today.', sentiment: 0.1, topics: [], timestamp: 0 },
          { speakerId: b, text: "I'm sorry, I never meant to hurt you, and I forgive you.", sentiment: -0.7, topics: [], timestamp: 0 },
        ],
      });
      insertConversation([a, b], {
        endedAt: NOW_MS - 1000,
        messages: [{ speakerId: a, text: 'Nice weather, how are you doing today friend?', sentiment: 0.1, topics: [], timestamp: 0 }],
      });

      const [smallTalk, charged] = getPairDossier(a, b, NOW_MS)!.conversations;
      expect(smallTalk.quote).toBeNull();
      expect(charged.turns).toBe(2);
      expect(charged.quote).toMatchObject({ speakerId: b, speakerName: 'Jonas' });
      expect(charged.quote!.text).toContain('sorry');
    });
  });

  describe('secrets: the same disclosure level as the secret network', () => {
    it('shows active facts of sensitivity 2+ about either of them, and hides the rest', () => {
      relate(a, b, { fAB: 0, fBA: 0 });
      const between = insertFact({ subject: a, target: b, sensitivity: 3, knownBy: [a, b, c, d] });
      const aboutA = insertFact({ subject: a, target: c, sensitivity: 2, knownBy: [a] });
      const aboutB = insertFact({ subject: c, target: b, sensitivity: 4, knownBy: [c], isPublic: true });
      // Trivia: below the secret network's floor.
      insertFact({ subject: a, target: b, sensitivity: 1 });
      // Retired.
      insertFact({ subject: a, target: b, sensitivity: 5, active: false });
      // Nothing to do with this pair.
      insertFact({ subject: c, target: d, sensitivity: 5 });

      const secrets = getPairDossier(a, b, NOW_MS)!.secrets;
      // Between them first, then by sensitivity.
      expect(secrets.map((s) => s.id)).toEqual([between, aboutB, aboutA]);
      expect(secrets.map((s) => s.scope)).toEqual(['between', 'about_b', 'about_a']);
      expect(secrets[1].isPublic).toBe(true);
    });

    it('lists only living residents as knowers, like the secret network', () => {
      relate(a, b, { fAB: 0, fBA: 0 });
      insertFact({ subject: a, target: b, sensitivity: 3, knownBy: [a, b, c, d] });
      const [secret] = getPairDossier(a, b, NOW_MS)!.secrets;
      expect(secret.knownByNames.sort()).toEqual(['Edda', 'Jonas', 'Mara']);
      expect(secret.subjectName).toBe('Mara');
      expect(secret.targetName).toBe('Jonas');
    });

    it('treats a fact whose subject is one of them and target is nobody as about that one', () => {
      relate(a, b, { fAB: 0, fBA: 0 });
      insertFact({ subject: b, target: null, sensitivity: 2 });
      expect(getPairDossier(a, b, NOW_MS)!.secrets[0].scope).toBe('about_b');
      // Same fact from the other orientation reads as about A.
      expect(getPairDossier(b, a, NOW_MS)!.secrets[0].scope).toBe('about_a');
    });
  });

  describe('story arcs', () => {
    it('includes arcs that involve both, and none for another pair', () => {
      relate(a, b, { fAB: -60, fBA: -60, status: 'enemies' });
      relate(c, a, { fAB: 50, fBA: 50 });
      logEvent(a, b, { minute: NOW - 200, type: 'fight', sentiment: -0.8 });
      logEvent(b, a, { minute: NOW - 100, type: 'confrontation', sentiment: -0.6 });

      const arcs = getPairDossier(a, b, NOW_MS)!.arcs;
      expect(arcs).toHaveLength(1);
      expect(arcs[0]).toMatchObject({ kind: 'rivalry', title: 'Mara vs Jonas' });
      expect(arcs[0].beats.map((beat) => beat.eventType)).toEqual(['fight', 'confrontation']);
      expect(getPairDossier(a, c, NOW_MS)!.arcs).toHaveLength(0);
    });
  });

  describe('conversation clock', () => {
    it('dates a conversation by the pair event written at its end', () => {
      relate(a, b, { fAB: 0, fBA: 0 });
      const endedAt = NOW_MS - 60_000;
      insertConversation([a, b], { endedAt });
      logEvent(a, b, { minute: NOW - 77, timestamp: endedAt + 1200 });
      // A far-off event must not steal the match.
      logEvent(a, b, { minute: NOW - 3000, timestamp: endedAt - 3_600_000 });

      const [convo] = getPairDossier(a, b, NOW_MS)!.conversations;
      expect(convo.gameMinute).toBe(NOW - 77);
      expect(convo.gameMinuteApproximate).toBe(false);
    });

    it('estimates from wall-clock age x tick speed when no event survives, clamped to the clock', () => {
      const clock = { nowMinute: NOW, nowMs: NOW_MS, tickSpeed: 4 };
      const recent = conversationMinute({ started_at: NOW_MS - 40_000, ended_at: NOW_MS - 30_000 }, [], clock);
      expect(recent).toEqual({ minute: NOW - 30 * 4, approximate: true });
      // Server off for a week: never earlier than day 0.
      const ancient = conversationMinute({ started_at: 1, ended_at: 2 }, [], clock);
      expect(ancient).toEqual({ minute: 0, approximate: true });
      // Paused clock (speed 0) falls back to 1x rather than dividing by nothing.
      expect(conversationMinute({ started_at: NOW_MS - 20_000, ended_at: NOW_MS - 10_000 }, [], { ...clock, tickSpeed: 0 }).minute).toBe(NOW - 10);
    });

    it('ignores events with no game minute', () => {
      const r = conversationMinute(
        { started_at: NOW_MS - 20_000, ended_at: NOW_MS - 10_000 },
        [{ timestamp: NOW_MS - 10_000, game_minute: null }],
        { nowMinute: NOW, nowMs: NOW_MS, tickSpeed: 1 },
      );
      expect(r.approximate).toBe(true);
    });
  });

  describe('history series on the dossier', () => {
    it('reconstructs friendship in A’s orientation whichever way the events were recorded', () => {
      // Current: a -> b 40, b -> a 25 (in normalised storage, orientation-agnostic).
      const lo = Math.min(a, b);
      relate(a, b, a === lo ? { fAB: 40, fBA: 25 } : { fAB: 25, fBA: 40 });
      // One +5 for each side, recorded b -> a.
      logEvent(b, a, { minute: NOW - 200, f: [5, 5] });

      const series = getPairDossier(a, b, NOW_MS)!.history.friendship;
      expect(series[series.length - 1]).toEqual({ minute: NOW, aToB: 40, bToA: 25 });
      expect(series[0].minute).toBe(NOW - 200);
      // Both were lower before the +5s.
      expect(series[0].aToB).toBeLessThan(40);
      expect(series[0].bToA).toBeLessThan(25);
    });

    it('is empty without events or without a relationship', () => {
      expect(getPairDossier(a, b, NOW_MS)!.history.friendship).toEqual([]);
      relate(a, b, { fAB: 10, fBA: 10 });
      expect(getPairDossier(a, b, NOW_MS)!.history.romance).toEqual([]);
    });
  });
});

describe('sparkline maths', () => {
  /** The engine's own step (relationships.ts), so the test can't drift from it. */
  const step = (v: number, delta: number) => Math.max(-100, Math.min(100, v + applyDiminishing(v, delta)));

  it('undoDelta inverts the engine step, with and without diminishing returns', () => {
    const cases: Array<[number, number]> = [
      [10, 8], [60, 12], [90, 10], [-40, -15], [-80, -20], [-10, 25], [30, -35], [0, 5], [0, -5],
    ];
    for (const [before, delta] of cases) {
      expect(undoDelta(step(before, delta), delta)).toBeCloseTo(before, 6);
    }
  });

  it('undoDelta stays in range when the step was clamped', () => {
    expect(undoDelta(100, 30)).toBeLessThanOrEqual(100);
    expect(undoDelta(100, 30)).toBeGreaterThanOrEqual(-100);
    expect(undoDelta(-100, -30)).toBeGreaterThanOrEqual(-100);
  });

  it('rebuilds the exact path of a walk from its endpoint', () => {
    const deltas: Array<[number, number]> = [[12, -4], [15, 6], [-30, 9], [20, 20], [8, -25], [40, 3]];
    let ab = 35;
    let ba = -20;
    const truth: Array<{ aToB: number; bToA: number }> = [{ aToB: ab, bToA: ba }];
    const events = deltas.map(([dab, dba], i) => {
      ab = step(ab, dab);
      ba = step(ba, dba);
      truth.push({ aToB: ab, bToA: ba });
      return { id: i + 1, minute: 100 + i * 10, aToB: dab, bToA: dba };
    });

    const series = reconstructSeries({ aToB: ab, bToA: ba }, events, 500);
    // start + one point per event + the closing "now" point
    expect(series).toHaveLength(deltas.length + 2);
    expect(series.map((p) => p.minute)).toEqual([100, 100, 110, 120, 130, 140, 150, 500]);
    truth.forEach((t, i) => {
      expect(series[i].aToB).toBeCloseTo(t.aToB, 6);
      expect(series[i].bToA).toBeCloseTo(t.bToA, 6);
    });
    expect(series[series.length - 1]).toEqual({ minute: 500, aToB: ab, bToA: ba });
    // Chronological.
    for (let i = 1; i < series.length; i++) expect(series[i].minute).toBeGreaterThanOrEqual(series[i - 1].minute);
  });

  it('skips events that did not move this value', () => {
    const series = reconstructSeries(
      { aToB: 20, bToA: 20 },
      [
        { id: 1, minute: 10, aToB: 0, bToA: 0 },
        { id: 2, minute: 20, aToB: 5, bToA: 0 },
      ],
      30,
    );
    expect(series).toHaveLength(3);
    expect(series[0]).toMatchObject({ minute: 20 });
    expect(reconstructSeries({ aToB: 1, bToA: 1 }, [{ id: 1, minute: 1, aToB: 0, bToA: 0 }], 5)).toEqual([]);
    expect(reconstructSeries({ aToB: 1, bToA: 1 }, [], 5)).toEqual([]);
  });
});
