import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, agentStates, economy, locations, needs } from '../../../db/schema';
import { simEvents } from '../../../lib/simEvents';
import { createStatesTickContext } from '../states/context';
import { evaluateTriggers } from '../states/triggers';
import { processStateEffects } from '../states/effects';
import { NOW, PERSONALITY, freshTown, insertResident } from '../../../lib/__tests__/populationFixtures';

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
