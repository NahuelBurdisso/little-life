import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, conversationQueue, locations, worldState } from '../../../db/schema';
import { RENDEZVOUS_TOPIC, SIM_ONLY_TOPICS, SUSPICION_TOPIC, isSimOnlyTopic, queuedTopic } from '../../../ai/prompts';
import { nudgeRouter } from '../../../routers/nudge';
import { RENDEZVOUS_TRIGGER } from '../rendezvous';
import { SUSPICION_TRIGGER } from '../suspicion';

/**
 * `RENDEZVOUS_TOPIC` and `SUSPICION_TOPIC` are plain phrases, and the prompt keys its
 * special scenes on the topic text alone. A player must not be able to type one into
 * `suggest_talk` (a minor and an adult would get the invitation scene, which only the
 * eligibility-gated rendezvous pass may ask for), and the scheduler only lets them ride
 * on their own producer's trigger reason.
 */

describe('sim-only topics', () => {
  it('know the producer that owns them', () => {
    expect(SIM_ONLY_TOPICS[RENDEZVOUS_TOPIC]).toBe(RENDEZVOUS_TRIGGER);
    expect(SIM_ONLY_TOPICS[SUSPICION_TOPIC]).toBe(SUSPICION_TRIGGER);
  });

  it('are recognised however they are typed', () => {
    for (const t of ['a private evening', 'A Private Evening', '  a   private evening  ', 'Where you were last night']) {
      expect(isSimOnlyTopic(t), t).toBe(true);
    }
    for (const t of ['flirting', 'a private matter', '', null, undefined]) expect(isSimOnlyTopic(t), String(t)).toBe(false);
  });

  it('a queue entry keeps one only on its own trigger reason', () => {
    expect(queuedTopic({ topic: RENDEZVOUS_TOPIC, trigger_reason: RENDEZVOUS_TRIGGER })).toBe(RENDEZVOUS_TOPIC);
    expect(queuedTopic({ topic: SUSPICION_TOPIC, trigger_reason: SUSPICION_TRIGGER })).toBe(SUSPICION_TOPIC);
    // A player's nudge, or a differently-cased copy, talks about nothing in particular.
    expect(queuedTopic({ topic: RENDEZVOUS_TOPIC, trigger_reason: 'player_nudge' })).toBeNull();
    expect(queuedTopic({ topic: 'A Private Evening', trigger_reason: RENDEZVOUS_TRIGGER })).toBeNull();
    expect(queuedTopic({ topic: SUSPICION_TOPIC, trigger_reason: RENDEZVOUS_TRIGGER })).toBeNull();
    // Everything else passes through untouched.
    expect(queuedTopic({ topic: 'flirting', trigger_reason: 'player_nudge' })).toBe('flirting');
    expect(queuedTopic({ topic: null, trigger_reason: 'player_nudge' })).toBeNull();
  });
});

describe('suggest_talk with a sim-only topic', () => {
  const made: number[] = [];
  let homeId: number;
  const caller = () => nudgeRouter.createCaller({} as never);

  function insertAgent(name: string, age: number, gender: string): number {
    const id = db.insert(agents).values({
      name, bio: 'test', traits: [], age, gender, orientation: 'straight',
      personality: {
        honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
        curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
      },
      sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
      current_action: { type: 'idle' }, action_started: 0, action_queue: [],
      schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
      home: homeId, current_location: homeId, created_at: 0, is_active: true,
    }).returning({ id: agents.id }).get().id;
    made.push(id);
    return id;
  }

  beforeAll(() => {
    if (!db.select().from(worldState).get()) {
      db.insert(worldState).values({
        time: { day: 1, hour: 9, minute: 0, totalTicks: 540, seasonDay: 1, season: 'spring' }, day_phase: 'morning',
        weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true, last_tick_completed: 0,
        current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
      }).run();
    }
    homeId = db.insert(locations).values({
      name: 'Topic Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 20, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
  });

  afterAll(() => {
    db.delete(conversationQueue).where(inArray(conversationQueue.trigger_reason, ['player_nudge'])).run();
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  const queuedFor = (a: number, b: number) => db.select().from(conversationQueue).all()
    .filter((q) => q.participants.includes(a) && q.participants.includes(b));

  it('a typed "a private evening" between a minor and an adult queues nothing', async () => {
    const teen = insertAgent('Topic Teen', 16, 'female');
    const man = insertAgent('Topic Man', 35, 'male');
    for (const topic of ['a private evening', 'A Private Evening', 'where you were last night']) {
      const r = await caller().execute({ action: { type: 'suggest_talk', agentA: man, agentB: teen, topic } });
      expect(r.success, topic).toBe(false);
      expect((r as { reason?: string }).reason).toMatch(/topic/);
    }
    expect(queuedFor(man, teen)).toHaveLength(0);
  });

  it('an ordinary topic still queues, and so does no topic at all', async () => {
    const a = insertAgent('Topic Ann', 30, 'female');
    const b = insertAgent('Topic Ben', 32, 'male');
    const r = await caller().execute({ action: { type: 'suggest_talk', agentA: a, agentB: b, topic: 'the harvest' } });
    expect(r.success).toBe(true);
    expect(queuedFor(a, b).map((q) => q.topic)).toEqual(['the harvest']);
    db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, 'player_nudge')).run();
  });
});
