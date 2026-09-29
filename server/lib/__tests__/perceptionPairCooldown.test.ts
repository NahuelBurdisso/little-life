import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agents, conversationQueue, locations, needs, relationships } from '../../db/schema';
import { simEvents } from '../simEvents';
import { PerceptionSystem, kindCooldownLifted, pairKey, KIND_COOLDOWN_ROMANCE_RESET } from '../perception/PerceptionSystem';
import type { PersonalityProfile } from '../personality';
import { CONFIG } from '../constants';

/**
 * The QA playtest saw the same two people flirt every ~30 game minutes all
 * evening in the tavern: the pair cooldown only covered observer→target (so
 * each half of the pair had its own clock), and nothing stopped the same kind
 * of conversation coming back as soon as the rule cooldown ran out.
 */

const SENSUAL: PersonalityProfile = {
  honesty: 50, aggression: 20, warmth: 50, impulsiveness: 60, vanity: 50,
  curiosity: 40, loyalty: 50, morality: 50, sensuality: 90, neuroticism: 40,
};

let locId = 0;
let a = 0;
let b = 0;
const T0 = 3 * 1440 + 19 * 60; // day 3, 19:00

const at = (m: number) => ({ time: { day: Math.floor(m / 1440), hour: Math.floor((m % 1440) / 60), minute: m % 60 } });

function insertAgent(name: string): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], personality: SENSUAL, age: 30, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x',
    // Far from anything other test files in this worker may have placed.
    position: { x: 90_000, y: 90_000 },
    current_destination: null, current_location: locId, current_action: { type: 'idle' },
    action_started: 0, action_duration: null, action_queue: [], current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: locId, workplace: null, created_at: Date.now(), is_active: true,
  }).returning({ id: agents.id }).get().id;
  db.insert(needs).values({
    agent_id: id, hunger: 70, energy: 70, social: 60, comfort: 60, fun: 60, mood: 50, stress: 20,
    decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES }, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
    mood_modifiers: [], last_updated: T0,
  }).run();
  return id;
}

function pairFlirts(): number {
  return db.select().from(conversationQueue).all()
    .filter((q) => {
      const p = q.participants as number[];
      return p.includes(a) && p.includes(b) && q.topic === 'flirting';
    }).length;
}

function consumeQueue(): void {
  const ids = db.select().from(conversationQueue).all()
    .filter((q) => (q.participants as number[]).includes(a))
    .map((q) => q.id);
  if (ids.length) db.delete(conversationQueue).where(inArray(conversationQueue.id, ids)).run();
}

function setRomance(romance: number, status = 'acquaintances'): void {
  db.update(relationships)
    .set({ romance_ab: romance, romance_ba: romance, status })
    .where(and(eq(relationships.agent_a, Math.min(a, b)), eq(relationships.agent_b, Math.max(a, b))))
    .run();
}

describe('perception pair cooldowns', () => {
  beforeAll(() => {
    locId = db.insert(locations).values({
      name: 'Cooldown Tavern', type: 'tavern', position: { x: 90_000, y: 90_000, width: 4, height: 4 },
      entry_point: { x: 90_001, y: 90_004 }, owner: null, capacity: 20, current_occupants: [],
      operating_hours: null, services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    a = insertAgent('Flirt Alpha');
    b = insertAgent('Flirt Beta');
    db.insert(relationships).values({
      agent_a: Math.min(a, b), agent_b: Math.max(a, b),
      friendship_ab: 0, friendship_ba: 0, romance_ab: 30, romance_ba: 30,
      trust_ab: 50, trust_ba: 50, familiarity: 30, interaction_count: 3,
      last_interaction: 0, last_interaction_minute: T0,
      average_interaction_sentiment: 0.2, tags: [], status: 'acquaintances',
      created_at: 0, last_updated: 0,
    }).run();
  });

  let observed: Array<{ agentId: number; targetName: string }> = [];
  const onObserved = (e: { agentId: number; targetName: string }) => { observed.push(e); };
  beforeEach(() => {
    consumeQueue();
    setRomance(30);
    observed = [];
    simEvents.on('perception:observed', onObserved);
  });
  afterEach(() => {
    simEvents.off('perception:observed', onObserved);
  });

  const pairObserved = () => observed.filter((o) =>
    (o.agentId === a && o.targetName === 'Flirt Beta') || (o.agentId === b && o.targetName === 'Flirt Alpha'));

  it('is symmetric: once A notices B, B does not notice A in the same window', () => {
    const p = new PerceptionSystem();
    p.scan(at(T0));
    expect(pairObserved()).toHaveLength(1);
    expect(pairFlirts()).toBe(1);
    p.scan(at(T0 + 15));
    expect(pairObserved()).toHaveLength(1);
  });

  it('does not start the same flirt again for a few game hours, then does', () => {
    const p = new PerceptionSystem();
    p.scan(at(T0));
    expect(pairFlirts()).toBe(1);
    consumeQueue(); // they had that conversation

    // Both the pair cooldown (30) and crush_spotted's own (20) have run out.
    for (const m of [31, 62, 120, 200]) {
      p.scan(at(T0 + m));
      expect(pairFlirts()).toBe(0);
    }
    p.scan(at(T0 + 241));
    expect(pairFlirts()).toBe(1);
  });

  it('lifts the flirt cooldown when the relationship moved in between', () => {
    const p = new PerceptionSystem();
    p.scan(at(T0));
    consumeQueue();
    setRomance(30 + KIND_COOLDOWN_ROMANCE_RESET);
    p.scan(at(T0 + 31));
    expect(pairFlirts()).toBe(1);
  });

  it('forgetPair (a player nudge on the pair) clears every clock between them', () => {
    const p = new PerceptionSystem();
    p.scan(at(T0));
    consumeQueue();
    p.forgetPair(b, a);
    p.scan(at(T0 + 1));
    expect(pairFlirts()).toBe(1);
  });

  it('pairKey and kindCooldownLifted', () => {
    expect(pairKey(7, 3)).toBe(pairKey(3, 7));
    const stamp = { at: 0, romance: 60, status: 'acquaintances' };
    expect(kindCooldownLifted(stamp, 65, 'acquaintances')).toBe(false);
    expect(kindCooldownLifted(stamp, 60, 'partners')).toBe(true);
    expect(kindCooldownLifted(stamp, 45, 'acquaintances')).toBe(true);
  });
});
