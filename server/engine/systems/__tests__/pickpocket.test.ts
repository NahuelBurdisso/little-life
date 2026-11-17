import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, economy } from '../../../db/schema';
import { simEvents } from '../../../lib/simEvents';
import { executeCrime } from '../decisions/crime';
import type { AgentTurn, DecisionTickContext } from '../decisions/context';
import { freshTown, insertResident } from '../../../lib/__tests__/populationFixtures';

/**
 * A pickpocket's take lands on the thief's balance as it is NOW. The thief's
 * row used to come from the snapshot loaded at the start of the decisions
 * tick, so `snapshot.money + stolen` overwrote whatever had changed it since.
 */

const agentRow = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;
const econRow = (id: number) => db.select().from(economy).where(eq(economy.agent_id, id)).get()!;

beforeEach(() => {
  vi.spyOn(simEvents, 'emit').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executeCrime: pickpocketing', () => {
  it('adds the take to the thief\'s current money, not to the tick-start snapshot', () => {
    const { homes } = freshTown();
    const thief = insertResident('Pickpocket Pip', homes[0], {}, { money: 10 });
    const victim = insertResident('Mark Mae', homes[1], {}, { money: 100 });

    const staleEcon = econRow(thief); // as the decisions tick loaded it
    // Earlier in the same tick the thief was paid: the DB moved on, the snapshot did not.
    db.update(economy).set({ money: 40 }).where(eq(economy.agent_id, thief)).run();

    // stolen = floor(5 + 0.5 * 10) = 10; 0.9 is not caught.
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.5).mockReturnValueOnce(0.9);
    const turn = { agent: agentRow(thief), agentEcon: staleEcon } as unknown as AgentTurn;
    const tick = { activeAgents: [agentRow(thief), agentRow(victim)], allLocations: [] } as unknown as DecisionTickContext;
    executeCrime(turn, { action: 'pickpocket', score: 1, source: 'pickpocket', targetAgentId: victim }, tick);

    expect(econRow(victim).money).toBe(90);
    expect(econRow(thief).money).toBe(50);
  });
});
