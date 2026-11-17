import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  activityLog, agents, agentStates, conversations, economy, locations, memories, needs, relationships,
} from '../../../db/schema';
import { simEvents } from '../../../lib/simEvents';
import { taskRunner } from '../../../ai/taskRunner';
import { createStatesTickContext } from '../states/context';
import { evaluateTriggers } from '../states/triggers';
import { processStateEffects } from '../states/effects';
import { NOW, PERSONALITY, freshTown, insertResident, relate } from '../../../lib/__tests__/populationFixtures';

/**
 * Small fixes in the states phase's trigger and effect handlers (states/triggers.ts,
 * states/effects.ts), each one a state change or memory that went missing.
 */

let homes: number[];
let emitted: Array<[string, unknown]>;

const agentRow = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;
const needsRow = (id: number) => db.select().from(needs).where(eq(needs.agent_id, id)).get()!;
const statesOf = (id: number) => db.select().from(agentStates).where(eq(agentStates.agent_id, id)).all();
const eventsNamed = (name: string) => emitted.filter(([n]) => n === name).map(([, payload]) => payload);

beforeEach(() => {
  homes = freshTown().homes;
  emitted = [];
  // Recorded, not delivered: the listeners (memories, cascades) are not what these tests measure.
  vi.spyOn(simEvents, 'emit').mockImplementation((name: string | symbol, payload?: unknown) => {
    emitted.push([String(name), payload]);
    return true;
  });
  // No dice: nothing random fires unless a test asks for it.
  vi.spyOn(Math, 'random').mockReturnValue(0.999);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('triggerStressed', () => {
  it('announces the new state once, like every other trigger', () => {
    const id = insertResident('Stressed Sue', homes[0], { personality: PERSONALITY });
    db.update(needs).set({ hunger: 10, energy: 10, comfort: 10 }).where(eq(needs.agent_id, id)).run();
    const ctx = createStatesTickContext();

    evaluateTriggers(agentRow(id), needsRow(id), new Set(), NOW, 'sunny', 'spring', [], [agentRow(id)], 1, ctx);

    expect(statesOf(id).map((s) => s.type)).toContain('stressed');
    expect(eventsNamed('state:triggered').filter((e) => (e as { state: string }).state === 'stressed'))
      .toEqual([{ agentId: id, state: 'stressed', cause: 'needs:multiple_low' }]);
  });
});

describe('stealItem', () => {
  /** A desperate thief alone in a baker's shop, and the roll that says whether anyone saw. */
  function steal(caughtRoll: number) {
    const town = freshTown();
    const owner = insertResident('Baker Bea', town.homes[0], {});
    db.update(locations).set({ owner }).where(eq(locations.id, town.bakery)).run();
    db.update(economy).set({ inventory: [{ itemId: 'bread', quantity: 3, acquiredAt: 0 }] })
      .where(eq(economy.agent_id, owner)).run();
    const thief = insertResident('Thief Tom', town.homes[1], {
      current_location: town.bakery,
      personality: { ...PERSONALITY, morality: 20 },
    });
    db.insert(agentStates).values({
      agent_id: thief, type: 'in_debt', severity: 0.5, started_at: NOW - 60, duration: 999999,
      source: 'test', metadata: {},
    }).run();

    // The theft roll passes, then the detection roll decides.
    vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(caughtRoll);
    const all = [agentRow(owner), agentRow(thief)];
    processStateEffects(agentRow(thief), statesOf(thief), all, NOW, 10_000, 1, createStatesTickContext());

    return eventsNamed('interaction:completed')
      .filter((e) => (e as { agentId: number }).agentId === thief) as Array<{ action: string }>;
  }

  it('an uncaught thief still remembers the theft, without "and got caught"', () => {
    const memories = steal(0.99);
    expect(memories).toHaveLength(1);
    expect(memories[0].action).toMatch(/^stole .* from The Bakery$/);
  });

  it('a caught thief remembers it once, with "and got caught"', () => {
    const memories = steal(0);
    expect(memories).toHaveLength(1);
    expect(memories[0].action).toMatch(/^stole .* from The Bakery and got caught$/);
  });
});

describe('effectConfident', () => {
  it('logs and announces confidence shattering into anger', () => {
    const vain = insertResident('Vain Val', homes[0], { personality: { ...PERSONALITY, vanity: 80 } });
    const critic = insertResident('Critic Cal', homes[1], {});
    db.insert(agentStates).values({
      agent_id: vain, type: 'confident', severity: 0.6, started_at: NOW - 60, duration: 600,
      source: 'test', metadata: null,
    }).run();
    db.insert(conversations).values({
      participants: [vain, critic], messages: [], location: null, trigger_reason: 'test',
      status: 'ended', started_at: Date.now(), ended_at: Date.now(), sentiment: -0.8, max_turns: 4,
    }).run();

    const all = [agentRow(vain), agentRow(critic)];
    processStateEffects(agentRow(vain), statesOf(vain), all, NOW, 10_000, 1, createStatesTickContext());

    expect(statesOf(vain).map((s) => s.type)).toEqual(['angry']);
    const feed = db.select().from(activityLog).where(eq(activityLog.initiator_id, vain)).all()
      .map((r) => [r.type, r.template_data.state]);
    expect(feed).toEqual(expect.arrayContaining([['state_lost', 'confident'], ['state_gained', 'angry']]));
    expect(eventsNamed('state:cleared')).toEqual([{ agentId: vain, state: 'confident' }]);
    expect(eventsNamed('state:triggered')).toEqual([{ agentId: vain, state: 'angry', cause: 'cascade:confident_vanity' }]);
  });
});

describe('effectHungover', () => {
  const TICK = 10_000;
  /** Hangover began 100 game minutes ago; at 1x that is 100 ticks. */
  const HANGOVER_STARTED = NOW - 100;

  let drinker: number;

  beforeEach(() => {
    vi.spyOn(taskRunner, 'generateEmbedding').mockImplementation(() => {});
    drinker = insertResident('Hungover Hal', homes[0], {});
    db.insert(agentStates).values({
      agent_id: drinker, type: 'hungover', severity: 0.5, started_at: HANGOVER_STARTED, duration: 300,
      source: 'cascade:drunk', metadata: null,
    }).run();
  });

  function friend(name: string): number {
    const id = insertResident(name, homes[1], {});
    relate(drinker, id, { friendship_ab: 60, friendship_ba: 60 });
    return id;
  }

  function talkedWith(otherId: number, createdAt: number) {
    db.insert(memories).values({
      agent_id: drinker, type: 'conversation', description: 'we talked', importance: 3,
      created_at: createdAt, last_accessed: createdAt, metadata: { related_agents: [otherId] },
    }).run();
  }

  function runEffects(others: number[]) {
    const all = [drinker, ...others].map(agentRow);
    processStateEffects(agentRow(drinker), statesOf(drinker), all, NOW, TICK, 1, createStatesTickContext());
  }

  const regrets = () => db.select().from(memories)
    .where(and(eq(memories.agent_id, drinker), eq(memories.type, 'emotional'))).all();
  const friendshipTowards = (otherId: number) => {
    const rel = db.select().from(relationships).where(or(
      and(eq(relationships.agent_a, drinker), eq(relationships.agent_b, otherId)),
      and(eq(relationships.agent_a, otherId), eq(relationships.agent_b, drinker)),
    )).get()!;
    return rel.agent_a === drinker ? rel.friendship_ab : rel.friendship_ba;
  };

  it('regrets only what was said before the hangover started, not sober talks since', () => {
    const drinkingBuddy = friend('Drinking Dan');
    const soberChat = friend('Sober Sam');
    talkedWith(drinkingBuddy, TICK - 150); // while drunk
    talkedWith(soberChat, TICK - 50); // during the hangover

    runEffects([drinkingBuddy, soberChat]);

    expect(regrets().map((m) => m.description)).toEqual([
      'I feel terrible about what I said to Drinking Dan while drunk.',
    ]);
    expect(friendshipTowards(drinkingBuddy)).toBe(55);
    expect(friendshipTowards(soberChat)).toBe(60);
  });

  it('regrets each friend once per hangover, however many talks there were', () => {
    const buddy = friend('Drinking Dan');
    talkedWith(buddy, TICK - 150);
    talkedWith(buddy, TICK - 160);
    talkedWith(buddy, TICK - 170);

    runEffects([buddy]);

    expect(regrets()).toHaveLength(1);
    expect(friendshipTowards(buddy)).toBe(55);
  });
});
