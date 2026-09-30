import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  activityLog, agents, agentStates, conversations, locations, needs, relationshipEvents, relationships, shared_knowledge,
  worldEvents, worldState,
} from '../../../db/schema';
import {
  BOLD_IMPULSIVENESS, DATE_FACTOR, FIRST_KISS_CHANCE, KISSED_BEFORE_CHANCE, KISSED_TAG, PRIVACY_FACTOR,
  ROMANCE_BOOST_FACTOR, isDateHour, kissChance, onKissConversationEnded, pickKissInitiator,
  type KissChanceCtx, type KissParty,
} from '../kiss';
import { clearIntimacy, ensureAgentIntimacy, getAgentIntimacy, getPairIntimacy } from '../state';
import { simEvents } from '../../simEvents';
import { gameMinutes } from '../../gameClock';
import { MARRIED_TAG } from '../../marriage';
import { renderMessage } from '../../activityMessage';
import { ROMANTIC_EVENTS, isPivotalEvent } from '../../storyBeats';

/**
 * The kiss: a pure chance function (every input injected) and the listener that
 * applies it. An injected rng makes the outcome deterministic; a chance of 0 must
 * hold even for rng() === 0, which is what the minor and orientation tests pin.
 */

// ─── Pure rules ──────────────────────────────────────────────────────────────

const party = (over: Partial<KissParty> = {}): KissParty => ({
  id: 1, age: 30, gender: 'female', orientation: 'straight', is_active: true,
  romance: 70, impulsiveness: 50, states: [], ...over,
});
const ctx = (over: Partial<KissChanceCtx> = {}): KissChanceCtx => ({
  initiator: party({ id: 1, gender: 'female' }),
  receiver: party({ id: 2, gender: 'male', romance: 60 }),
  sentiment: 0.6, kissedBefore: false, isDate: false, romanceBoost: false, thirdPresent: false, kissedToday: false,
  ...over,
});

describe('kissChance', () => {
  it('is 0.30 for a first kiss and 0.55 once they have kissed', () => {
    expect(kissChance(ctx())).toBeCloseTo(FIRST_KISS_CHANCE);
    expect(kissChance(ctx({ kissedBefore: true }))).toBeCloseTo(KISSED_BEFORE_CHANCE);
  });

  it('a date, a romance-boost event and an audience scale it', () => {
    expect(kissChance(ctx({ isDate: true }))).toBeCloseTo(FIRST_KISS_CHANCE * DATE_FACTOR);
    expect(kissChance(ctx({ romanceBoost: true }))).toBeCloseTo(FIRST_KISS_CHANCE * ROMANCE_BOOST_FACTOR);
    expect(kissChance(ctx({ isDate: true, romanceBoost: true }))).toBeCloseTo(FIRST_KISS_CHANCE * DATE_FACTOR * ROMANCE_BOOST_FACTOR);
    expect(kissChance(ctx({ thirdPresent: true }))).toBeCloseTo(FIRST_KISS_CHANCE * PRIVACY_FACTOR);
  });

  it('an impulsive initiator ignores the audience, a merely bold one does not', () => {
    const bold = ctx({ thirdPresent: true, initiator: party({ impulsiveness: BOLD_IMPULSIVENESS + 1 }) });
    expect(kissChance(bold)).toBeCloseTo(FIRST_KISS_CHANCE);
    const edge = ctx({ thirdPresent: true, initiator: party({ impulsiveness: BOLD_IMPULSIVENESS }) });
    expect(kissChance(edge)).toBeCloseTo(FIRST_KISS_CHANCE * PRIVACY_FACTOR);
  });

  it('never exceeds 1', () => {
    expect(kissChance(ctx({ kissedBefore: true, isDate: true, romanceBoost: true }))).toBeLessThanOrEqual(1);
  });

  it('needs a warm conversation and a keen initiator', () => {
    expect(kissChance(ctx({ sentiment: 0.3 }))).toBe(0);
    expect(kissChance(ctx({ sentiment: -0.5 }))).toBe(0);
    expect(kissChance(ctx({ initiator: party({ romance: 44 }) }))).toBe(0);
    expect(kissChance(ctx({ initiator: party({ romance: 45 }) }))).toBeGreaterThan(0);
  });

  it('is 0 for heartbreak, grief, sickness or an arrest on either side, and after a kiss today', () => {
    for (const state of ['heartbroken', 'grieving', 'sick', 'arrested']) {
      expect(kissChance(ctx({ initiator: party({ states: [state] }) })), state).toBe(0);
      expect(kissChance(ctx({ receiver: party({ id: 2, gender: 'male', states: [state] }) })), state).toBe(0);
    }
    expect(kissChance(ctx({ initiator: party({ states: ['happy', 'tired'] }) }))).toBeGreaterThan(0);
    expect(kissChance(ctx({ kissedToday: true }))).toBe(0);
  });

  it('is 0 unless both are adults drawn to each other, however keen', () => {
    expect(kissChance(ctx({ initiator: party({ age: 17 }) }))).toBe(0);
    expect(kissChance(ctx({ receiver: party({ id: 2, gender: 'male', age: 15 }) }))).toBe(0);
    expect(kissChance(ctx({ initiator: party({ age: undefined as unknown as number }) }))).toBe(0);
    // two straight women
    expect(kissChance(ctx({ receiver: party({ id: 2, gender: 'female' }) }))).toBe(0);
    // ... but a gay pair is fine
    expect(kissChance(ctx({
      initiator: party({ orientation: 'gay' }), receiver: party({ id: 2, gender: 'female', orientation: 'gay' }),
    }))).toBeGreaterThan(0);
  });
});

describe('pickKissInitiator / isDateHour', () => {
  it('the keener side leans in; ties go to the lower id', () => {
    expect(pickKissInitiator({ id: 1, romance: 50 }, { id: 2, romance: 80 }).initiator.id).toBe(2);
    expect(pickKissInitiator({ id: 5, romance: 80 }, { id: 2, romance: 50 }).initiator.id).toBe(5);
    expect(pickKissInitiator({ id: 5, romance: 60 }, { id: 2, romance: 60 }).initiator.id).toBe(2);
    expect(pickKissInitiator({ id: 2, romance: 60 }, { id: 5, romance: 60 }).initiator.id).toBe(2);
  });

  it('evenings are dates', () => {
    expect(isDateHour(17)).toBe(false);
    expect(isDateHour(18)).toBe(true);
    expect(isDateHour(22)).toBe(true);
    expect(isDateHour(23)).toBe(false);
  });
});

describe('how kisses read and are kept', () => {
  const names = { agent1: 'Ada', agent2: 'Bruno' };
  const at = (type: string) => renderMessage({ type, template_data: names, timestamp: 0 });

  it('feed wording stays discreet', () => {
    expect(at('first_kiss')).toBe('Ada and Bruno shared a first kiss.');
    expect(at('kiss')).toBe('Ada and Bruno kissed.');
    expect(at('kiss_rebuffed')).toBe("Bruno turned away from Ada's kiss.");
  });

  it('only the first kiss (and first night) is pivotal, so routine ones can be pruned', () => {
    expect(ROMANTIC_EVENTS.has('first_kiss')).toBe(true);
    expect(ROMANTIC_EVENTS.has('first_tryst')).toBe(true);
    expect(ROMANTIC_EVENTS.has('kiss')).toBe(false);
    expect(ROMANTIC_EVENTS.has('tryst')).toBe(false);
    expect(isPivotalEvent('first_kiss', 0)).toBe(true);
    expect(isPivotalEvent('kiss', 0.5 - 0.01)).toBe(false);
  });
});

// ─── Against the DB ──────────────────────────────────────────────────────────

const TIME = { day: 40, hour: 12, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);
const DAY = 24 * 60;

let homeId: number;
const made: number[] = [];
const rng0 = () => 0;
const rng1 = () => 0.999999;

function setClock(dayOffset = 0, hour = TIME.hour): void {
  const time = { ...TIME, day: TIME.day + dayOffset, hour, totalTicks: TIME.totalTicks + dayOffset * DAY };
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time, day_phase: 'afternoon', weather: 'sunny', weather_duration: 120, tick_speed: 1,
    is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
    pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
  }).run();
}

function insertAgent(name: string, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  db.insert(needs).values({
    agent_id: id, hunger: 60, energy: 60, social: 40, comfort: 50, fun: 40, mood: 55, stress: 20,
    decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
    thresholds: { critical: 10, low: 30, satisfied: 70 }, mood_modifiers: [], last_updated: 0,
  }).run();
  return id;
}

/**
 * A man and a woman. `a` (the lower id) feels `romanceA` toward `b`, who feels
 * `romanceB` back; both warm friends, nothing else on the row.
 */
function pair(opts: {
  romanceA?: number; romanceB?: number; tags?: string[]; aOver?: Partial<typeof agents.$inferInsert>;
  bOver?: Partial<typeof agents.$inferInsert>;
} = {}) {
  const a = insertAgent(`Kisser ${made.length}`, { gender: 'female', ...opts.aOver });
  const b = insertAgent(`Kissed ${made.length}`, { gender: 'male', ...opts.bOver });
  const relId = db.insert(relationships).values({
    agent_a: a, agent_b: b,
    friendship_ab: 70, friendship_ba: 70, romance_ab: opts.romanceA ?? 70, romance_ba: opts.romanceB ?? 60,
    trust_ab: 60, trust_ba: 60, familiarity: 80, interaction_count: 40,
    last_interaction: 0, last_interaction_minute: NOW, average_interaction_sentiment: 0.5,
    tags: opts.tags ?? ['partner'], status: 'romantic_interest', status_since_minute: NOW - DAY,
    created_at: 0, last_updated: 0,
  }).returning({ id: relationships.id }).get().id;
  return { a, b, relId };
}

const rel = (id: number) => db.select().from(relationships).where(eq(relationships.id, id)).get()!;
const feed = (type: string, id: number) => db.select().from(activityLog)
  .where(eq(activityLog.type, type)).all().filter((r) => (r.agent_ids as number[]).includes(id));
const events = (id: number) => db.select().from(relationshipEvents)
  .where(or(eq(relationshipEvents.agent_a, id), eq(relationshipEvents.agent_b, id))).all();
const moods = (id: number) => db.select().from(needs).where(eq(needs.agent_id, id)).get()!.mood_modifiers;
const warm = (agentId: number, other: number, conversationId = 1) =>
  ({ agentId, perpetratorId: other, conversationId, sentiment: 0.7 });

describe('the kiss against the DB', () => {
  beforeAll(() => {
    setClock();
    homeId = db.insert(locations).values({
      name: 'Kiss Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 20, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
  });

  beforeEach(() => {
    clearIntimacy();
    // Everyone a previous test made is out of the world, so nobody lingers in the room as a witness.
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
    setClock();
    db.update(worldEvents).set({ is_active: false }).run();
  });

  afterAll(() => {
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, made), inArray(shared_knowledge.target_id, made))).run();
    db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, made), inArray(relationshipEvents.agent_b, made))).run();
    db.delete(activityLog).where(inArray(activityLog.type, ['first_kiss', 'kiss', 'kiss_rebuffed'])).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, made)).run();
    db.delete(needs).where(inArray(needs.agent_id, made)).run();
    db.delete(agents).where(inArray(agents.id, made)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
    clearIntimacy();
    vi.restoreAllMocks();
  });

  it('an eligible pair kisses: tag, first_kiss event, feed row, memories, longing relieved', () => {
    const { a, b, relId } = pair({ romanceA: 70, romanceB: 60 });
    ensureAgentIntimacy(a).longing = 40;
    ensureAgentIntimacy(b).longing = 5;
    const kisses: unknown[] = [];
    const memories: Array<{ agentId: number; description: string; relatedAgentId: number }> = [];
    const onKiss = (p: unknown) => kisses.push(p);
    const onMemory = (p: { agentId: number; description: string; relatedAgentId: number }) => memories.push(p);
    simEvents.on('intimacy:kiss', onKiss);
    simEvents.on('life:milestone', onMemory);
    try {
      onKissConversationEnded(warm(a, b), rng0);
    } finally {
      simEvents.off('intimacy:kiss', onKiss);
      simEvents.off('life:milestone', onMemory);
    }

    expect(rel(relId).tags).toContain(KISSED_TAG);
    const ev = events(a).filter((e) => e.event_type === 'first_kiss');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ agent_a: a, agent_b: b, romance_delta_ab: 6, romance_delta_ba: 6, processed: false });

    const row = feed('first_kiss', a);
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ initiator_id: a, target_id: b, category: 'relationship' });
    expect(row[0].metadata).toMatchObject({ beat: 'kiss' });
    expect(feed('kiss', a)).toHaveLength(0);

    expect(kisses).toEqual([{ a, b, first: true, witnessIds: [] }]);
    const mine = memories.filter((m) => [a, b].includes(m.agentId));
    expect(mine).toHaveLength(2);
    expect(mine.find((m) => m.agentId === a)?.description).toMatch(/I kissed .* for the first time/);
    expect(mine.find((m) => m.agentId === b)?.relatedAgentId).toBe(a);

    expect(getPairIntimacy(a, b)).toMatchObject({ kisses: 1, firstKissAt: NOW, lastKissAt: NOW });
    expect(getAgentIntimacy(a)?.longing).toBe(30);
    expect(getAgentIntimacy(b)?.longing).toBe(0);
  });

  it('the keener side is the initiator even when it is the higher id', () => {
    const { a, b } = pair({ romanceA: 50, romanceB: 85 });
    // a's own copy of the event is ignored (b would lean in)...
    onKissConversationEnded(warm(a, b), rng0);
    expect(feed('first_kiss', a)).toHaveLength(0);
    // ... b's is the one that acts.
    onKissConversationEnded(warm(b, a), rng0);
    expect(feed('first_kiss', a)).toHaveLength(1);
    expect(feed('first_kiss', a)[0].initiator_id).toBe(b);
  });

  it('only two-person conversations: a group chat never ends in a kiss', () => {
    const { a, b } = pair();
    const third = insertAgent(`Third ${made.length}`, { gender: 'female' });
    const row = (participants: number[]) => db.insert(conversations).values({
      participants, messages: [], trigger_reason: 'test', topic: 'party', status: 'ended', started_at: 0, ended_at: 1,
      sentiment: 0.8, max_turns: 6,
    }).returning({ id: conversations.id }).get().id;
    const group = row([a, b, third]);
    // The event of every participant of a group chat, whoever "the other" is.
    onKissConversationEnded(warm(a, b, group), rng0);
    onKissConversationEnded(warm(b, a, group), rng0);
    onKissConversationEnded(warm(a, third, group), rng0);
    expect(feed('first_kiss', a)).toHaveLength(0);
    expect(getPairIntimacy(a, b)).toBeUndefined();

    // The same pair alone: they kiss.
    onKissConversationEnded(warm(a, b, row([a, b])), rng0);
    expect(feed('first_kiss', a)).toHaveLength(1);
    db.delete(conversations).where(eq(conversations.trigger_reason, 'test')).run();
  });

  it('a conversation heard from both sides makes one kiss, not two', () => {
    const { a, b, relId } = pair();
    onKissConversationEnded(warm(a, b, 77), rng0);
    onKissConversationEnded(warm(b, a, 77), rng0);
    // Even a duplicate from the initiator's own side: once a game day.
    onKissConversationEnded(warm(a, b, 77), rng0);
    expect(feed('first_kiss', a)).toHaveLength(1);
    expect(feed('kiss', a)).toHaveLength(0);
    expect(events(a).filter((e) => e.event_type.includes('kiss'))).toHaveLength(1);
    expect(getPairIntimacy(a, b)?.kisses).toBe(1);
    expect(rel(relId).tags.filter((t) => t === KISSED_TAG)).toHaveLength(1);
  });

  it('later kisses are routine: a `kiss` event and row, no memory, and a `kissed` tag that stays', () => {
    const { a, b, relId } = pair({ tags: ['partner', KISSED_TAG] });
    const memories: unknown[] = [];
    const onMemory = (p: unknown) => memories.push(p);
    simEvents.on('life:milestone', onMemory);
    try {
      onKissConversationEnded(warm(a, b), rng0);
    } finally {
      simEvents.off('life:milestone', onMemory);
    }
    expect(events(a).filter((e) => e.event_type === 'kiss')).toEqual([
      expect.objectContaining({ romance_delta_ab: 2, romance_delta_ba: 2 }),
    ]);
    expect(events(a).filter((e) => e.event_type === 'first_kiss')).toHaveLength(0);
    expect(feed('kiss', a)).toHaveLength(1);
    expect(feed('kiss', a)[0].metadata).toMatchObject({ beat: 'kiss' });
    expect(feed('first_kiss', a)).toHaveLength(0);
    expect(memories).toHaveLength(0);
    expect(rel(relId).tags).toContain(KISSED_TAG);
  });

  it('never twice on the same game day, but again the next one', () => {
    const { a, b } = pair();
    onKissConversationEnded(warm(a, b, 1), rng0);
    onKissConversationEnded(warm(a, b, 2), rng0);
    expect(getPairIntimacy(a, b)?.kisses).toBe(1);

    setClock(1);
    onKissConversationEnded(warm(a, b, 3), rng0);
    expect(getPairIntimacy(a, b)?.kisses).toBe(2);
    expect(feed('kiss', a)).toHaveLength(1);
  });

  it('the rng decides a chance that is neither 0 nor 1', () => {
    const { a, b } = pair();
    onKissConversationEnded(warm(a, b), rng1);
    expect(getPairIntimacy(a, b)).toBeUndefined();
    onKissConversationEnded(warm(a, b), rng0);
    expect(getPairIntimacy(a, b)?.kisses).toBe(1);
  });

  it('a minor never kisses, even at rng 0 and with adoring feelings', () => {
    const young = pair({ romanceA: 100, romanceB: 100, aOver: { age: 17 } });
    onKissConversationEnded(warm(young.a, young.b), rng0);
    onKissConversationEnded(warm(young.b, young.a), rng0);
    const both = pair({ romanceA: 100, romanceB: 100, aOver: { age: 15 }, bOver: { age: 16 } });
    onKissConversationEnded(warm(both.a, both.b), rng0);
    onKissConversationEnded(warm(both.b, both.a), rng0);
    for (const p of [young, both]) {
      expect(feed('first_kiss', p.a)).toHaveLength(0);
      expect(feed('kiss_rebuffed', p.a)).toHaveLength(0);
      expect(events(p.a)).toHaveLength(0);
      expect(rel(p.relId).tags).not.toContain(KISSED_TAG);
      expect(getPairIntimacy(p.a, p.b)).toBeUndefined();
    }
  });

  it('a straight same-gender pair never kisses; a gay one does', () => {
    const straight = pair({ aOver: { gender: 'male' } });
    onKissConversationEnded(warm(straight.a, straight.b), rng0);
    onKissConversationEnded(warm(straight.b, straight.a), rng0);
    expect(feed('first_kiss', straight.a)).toHaveLength(0);
    expect(getPairIntimacy(straight.a, straight.b)).toBeUndefined();

    const gay = pair({
      aOver: { gender: 'male', orientation: 'gay' }, bOver: { gender: 'male', orientation: 'gay' },
    });
    onKissConversationEnded(warm(gay.a, gay.b), rng0);
    expect(feed('first_kiss', gay.a)).toHaveLength(1);
  });

  it('a cool conversation, or a heartbroken suitor, does not kiss', () => {
    const cool = pair();
    onKissConversationEnded({ ...warm(cool.a, cool.b), sentiment: 0.2 }, rng0);
    expect(getPairIntimacy(cool.a, cool.b)).toBeUndefined();

    const sad = pair();
    db.insert(agentStates).values({
      agent_id: sad.a, type: 'heartbroken', severity: 1, started_at: NOW, duration: 600, source: 'test',
    }).run();
    onKissConversationEnded(warm(sad.a, sad.b), rng0);
    expect(getPairIntimacy(sad.a, sad.b)).toBeUndefined();
  });

  it('is turned away when the other feels little: mood, romance both ways, a feed row, no tag', () => {
    const { a, b, relId } = pair({ romanceA: 70, romanceB: 20 });
    onKissConversationEnded(warm(a, b), rng0);

    expect(rel(relId).tags).not.toContain(KISSED_TAG);
    expect(feed('first_kiss', a)).toHaveLength(0);
    const rows = feed('kiss_rebuffed', a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ initiator_id: a, target_id: b });
    expect(rows[0].metadata).toMatchObject({ beat: 'kiss_rebuffed' });
    expect(rows[0].importance).toBeCloseTo(0.5);

    const ev = events(a).filter((e) => e.event_type === 'kiss_rebuffed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ romance_delta_ab: -5, romance_delta_ba: -5 });
    // A turning point of the pair's story: kept past the daily prune, and a beat the chronicle can show.
    expect(isPivotalEvent('kiss_rebuffed', ev[0].sentiment)).toBe(true);
    const mood = moods(a).find((m) => m.source === 'kiss_rebuffed');
    expect(mood).toMatchObject({ value: -10, expiresAt: NOW + 4 * 60 });
    expect(moods(b)).toHaveLength(0);
    expect(getPairIntimacy(a, b)).toBeUndefined();
  });

  it('a refused suitor does not try again the same day', () => {
    const { a, b } = pair({ romanceA: 70, romanceB: 20 });
    onKissConversationEnded(warm(a, b, 1), rng0);
    onKissConversationEnded(warm(a, b, 2), rng0);
    expect(feed('kiss_rebuffed', a)).toHaveLength(1);
    // Past the day's window (the same clock hour a day later would still be inside it).
    setClock(1, 13);
    onKissConversationEnded(warm(a, b, 3), rng0);
    expect(feed('kiss_rebuffed', a)).toHaveLength(2);
  });

  it('an unknown pair (no relationship row) does nothing', () => {
    const a = insertAgent('Stranger A', { gender: 'female' });
    const b = insertAgent('Stranger B', { gender: 'male' });
    onKissConversationEnded(warm(a, b), rng0);
    expect(feed('first_kiss', a)).toHaveLength(0);
  });

  it('a romance-boost event raises the odds enough to tip an rng just above the base', () => {
    const { a, b } = pair();
    // 0.30 base, 0.39 with the boost: an rng of 0.35 fails without it, passes with it.
    const rng = () => 0.35;
    onKissConversationEnded(warm(a, b, 1), rng);
    expect(getPairIntimacy(a, b)).toBeUndefined();
    db.insert(worldEvents).values({
      type: 'festival', name: 'Fair', description: 'x', started_at: NOW, duration: 600,
      effects: { romance_boost: 10 }, location_id: null, triggered_by: 'test', is_active: true,
    }).run();
    onKissConversationEnded(warm(a, b, 2), rng);
    expect(getPairIntimacy(a, b)?.kisses).toBe(1);
  });

  describe('witnesses and affairs', () => {
    it('a witness in the room lowers the odds unless the initiator is impulsive', () => {
      const { a, b } = pair();
      const watcher = insertAgent('Watcher', { gender: 'female' });
      // 0.30 alone, 0.09 with an audience: rng 0.2 passes alone, fails watched.
      onKissConversationEnded(warm(a, b, 1), () => 0.2);
      expect(getPairIntimacy(a, b)).toBeUndefined();
      db.update(agents).set({ personality: {
        honesty: 50, aggression: 30, warmth: 60, impulsiveness: 90, vanity: 40,
        curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
      } }).where(eq(agents.id, a)).run();
      onKissConversationEnded(warm(a, b, 2), () => 0.2);
      expect(getPairIntimacy(a, b)?.kisses).toBe(1);
      expect(watcher).toBeGreaterThan(0);
    });

    it('a child in the room is no witness, but nobody kisses in front of one either', () => {
      const { a, b } = pair();
      const child = insertAgent('Little Watcher', { gender: 'female', age: 9 });
      const seen: Array<{ witnessIds: number[] }> = [];
      const onKiss = (p: { witnessIds: number[] }) => seen.push(p);
      simEvents.on('intimacy:kiss', onKiss);
      try {
        // 0.30 alone, 0.09 with anyone at all present: rng 0.2 passes alone, fails watched.
        onKissConversationEnded(warm(a, b, 1), () => 0.2);
        expect(getPairIntimacy(a, b)).toBeUndefined();
        // Same room, same odds at rng 0: it does happen, and the child is never a knower.
        onKissConversationEnded(warm(a, b, 2), rng0);
      } finally {
        simEvents.off('intimacy:kiss', onKiss);
      }
      expect(seen).toHaveLength(1);
      expect(seen[0].witnessIds).toEqual([]);
      const facts = db.select().from(shared_knowledge)
        .where(or(inArray(shared_knowledge.subject_id, [a, b]), inArray(shared_knowledge.target_id, [a, b]))).all();
      for (const f of facts) expect(f.known_by as number[]).not.toContain(child);
    });

    it('sleeping, absent or distant people are not witnesses', () => {
      const { a, b } = pair({ aOver: { personality: {
        honesty: 50, aggression: 30, warmth: 60, impulsiveness: 90, vanity: 40,
        curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
      } } });
      const awake = insertAgent('Awake Neighbour', { gender: 'female' });
      insertAgent('Asleep Neighbour', { current_action: { type: 'sleeping' } });
      insertAgent('Elsewhere', { current_location: null, position: { x: 900, y: 900 } });
      const seen: Array<{ witnessIds: number[] }> = [];
      const onKiss = (p: { witnessIds: number[] }) => seen.push(p);
      simEvents.on('intimacy:kiss', onKiss);
      try {
        onKissConversationEnded(warm(a, b), rng0);
      } finally {
        simEvents.off('intimacy:kiss', onKiss);
      }
      expect(seen).toHaveLength(1);
      expect(seen[0].witnessIds).toEqual([awake]);
    });

    it('outdoors, only people out in the open and within talking range see it', () => {
      const bold = { honesty: 50, aggression: 30, warmth: 60, impulsiveness: 90, vanity: 40,
        curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40 };
      const open = { current_location: null, position: { x: 500, y: 500 } };
      const { a, b } = pair({ aOver: { ...open, personality: bold }, bOver: { ...open, position: { x: 510, y: 500 } } });
      const near = insertAgent('Near Stroller', { current_location: null, position: { x: 530, y: 500 } });
      insertAgent('Far Stroller', { current_location: null, position: { x: 700, y: 500 } });
      insertAgent('Indoors Sitter', { position: { x: 505, y: 500 } });
      const seen: Array<{ witnessIds: number[] }> = [];
      const onKiss = (p: { witnessIds: number[] }) => seen.push(p);
      simEvents.on('intimacy:kiss', onKiss);
      try {
        onKissConversationEnded(warm(a, b), rng0);
      } finally {
        simEvents.off('intimacy:kiss', onKiss);
      }
      expect(seen[0].witnessIds).toEqual([near]);
    });

    it('a kiss involving someone spoken for seeds an affair fact known to the two and the witnesses', () => {
      const bold = { honesty: 50, aggression: 30, warmth: 60, impulsiveness: 90, vanity: 40,
        curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40 };
      const { a, b } = pair({ aOver: { personality: bold } });
      const spouse = insertAgent('Wronged Spouse', { gender: 'male' });
      db.update(agents).set({ current_location: null, position: { x: 800, y: 800 } }).where(eq(agents.id, spouse)).run();
      const witness = insertAgent('Neighbour Witness', { gender: 'female' });
      // a is married to `spouse`, not to b.
      db.insert(relationships).values({
        agent_a: a, agent_b: spouse, friendship_ab: 50, friendship_ba: 50, romance_ab: 60, romance_ba: 60,
        trust_ab: 50, trust_ba: 50, familiarity: 50, interaction_count: 5, last_interaction: 0,
        average_interaction_sentiment: 0, tags: [MARRIED_TAG], status: 'partners', created_at: 0, last_updated: 0,
      }).run();

      onKissConversationEnded(warm(a, b), rng0);

      const facts = db.select().from(shared_knowledge).where(eq(shared_knowledge.type, 'affair')).all()
        .filter((f) => f.subject_id === a || f.target_id === a);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ subject_id: a, target_id: b, sensitivity: 4, source: 'observed' });
      expect((facts[0].known_by as number[]).sort()).toEqual([a, b, witness].sort());
      // The wronged spouse is not told.
      expect(facts[0].known_by as number[]).not.toContain(spouse);
    });

    it('a kiss with someone who has an (unmarried) partner elsewhere seeds an affair at sensitivity 3', () => {
      const bold = { honesty: 50, aggression: 30, warmth: 60, impulsiveness: 90, vanity: 40,
        curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40 };
      const { a, b } = pair({ aOver: { personality: bold } });
      const partner = insertAgent('Steady Partner', { gender: 'male' });
      db.update(agents).set({ current_location: null, position: { x: 800, y: 800 } }).where(eq(agents.id, partner)).run();
      db.insert(relationships).values({
        agent_a: a, agent_b: partner, friendship_ab: 50, friendship_ba: 50, romance_ab: 60, romance_ba: 60,
        trust_ab: 50, trust_ba: 50, familiarity: 50, interaction_count: 5, last_interaction: 0,
        average_interaction_sentiment: 0, tags: ['partner'], status: 'partners', created_at: 0, last_updated: 0,
      }).run();

      onKissConversationEnded(warm(a, b), rng0);

      const facts = db.select().from(shared_knowledge).where(eq(shared_knowledge.type, 'affair')).all()
        .filter((f) => f.subject_id === a || f.target_id === a);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ subject_id: a, target_id: b, sensitivity: 3 });
    });

    it('a kiss between two free people seeds no affair', () => {
      const { a, b } = pair();
      onKissConversationEnded(warm(a, b), rng0);
      const facts = db.select().from(shared_knowledge).where(eq(shared_knowledge.type, 'affair')).all()
        .filter((f) => f.subject_id === a || f.target_id === a);
      expect(facts).toHaveLength(0);
    });
  });
});

