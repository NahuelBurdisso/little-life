import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, agentStates, needs } from '../../../db/schema';
import { simEvents } from '../../../lib/simEvents';
import { createStatesTickContext } from '../states/context';
import { evaluateTriggers } from '../states/triggers';
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
