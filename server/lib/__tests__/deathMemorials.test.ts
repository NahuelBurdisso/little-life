import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { agentStates } from '../../db/schema';
import { simEvents } from '../simEvents';
import { processAgentDeath, clearHungerTracking } from '../lifeEventsEngine';
import { clearVacancies } from '../vacancies';
import { clearPopulationFlow } from '../populationFlow';
import { memoryService } from '../memory/instance';
import { initMemoryObserver } from '../memory/MemoryObserver';
import type { MemoryService } from '../memory/MemoryService';
import { NOW, freshTown, insertResident, relate } from './populationFixtures';

/**
 * A death used to send `state:triggered` "grieving" to every living resident,
 * the dead man's enemies included, with no state row behind it: each stored
 * "I started feeling grieving." and got a dramatic replan, while the personal
 * line about the deceased sat unused in `cause`. Now only the mourners (the
 * ones who got the state) hear `state:triggered`, carrying their own line; the
 * rest of the town remembers the death in words that fit their tie.
 */

type Emitted = { name: string; payload: Record<string, unknown> };
let emitted: Emitted[];

beforeEach(() => {
  clearVacancies();
  clearPopulationFlow();
  clearHungerTracking();
  emitted = [];
  vi.spyOn(memoryService, 'record').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(simEvents, 'emit').mockImplementation((name: string | symbol, payload?: unknown) => {
    emitted.push({ name: String(name), payload: payload as Record<string, unknown> });
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearVacancies();
  clearPopulationFlow();
  clearHungerTracking();
});

function setUp() {
  const town = freshTown({ homes: [2, 2, 2, 2, 2] });
  const dead = insertResident('Old Tom', town.homes[0], {}, { job: 'bartender' });
  const friend = insertResident('Friend', town.homes[1], {}, { job: 'bartender' });
  const acquaintance = insertResident('Acquaintance', town.homes[2], {}, { job: 'bartender' });
  const rival = insertResident('Rival', town.homes[3], {}, { job: 'bartender' });
  const stranger = insertResident('Stranger', town.homes[4], {}, { job: 'bartender' });
  relate(dead, friend, { friendship_ab: 85, friendship_ba: 85, status: 'friends' });
  relate(dead, acquaintance, { friendship_ab: 30, friendship_ba: 30 });
  relate(dead, rival, { friendship_ab: -60, friendship_ba: -60, status: 'rivals' });
  return { dead, friend, acquaintance, rival, stranger };
}

describe('the town hears of a death', () => {
  it('only the residents who grieve get the grieving event, with their own line', () => {
    const { dead, friend } = setUp();
    processAgentDeath(dead, 'Old Tom', 'old_age', NOW);

    const grief = emitted.filter((e) => e.name === 'state:triggered' && e.payload.state === 'grieving');
    expect(grief.map((e) => e.payload.agentId)).toEqual([friend]);
    const row = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, friend), eq(agentStates.type, 'grieving'))).get();
    expect(row).toBeDefined();
    const memory = grief[0].payload.memory as { description: string };
    expect(memory.description).toContain('Old Tom');
    expect(memory.description).toMatch(/closest friends/);
  });

  it('everyone else remembers the death in words that fit their tie', () => {
    const { dead, acquaintance, rival, stranger } = setUp();
    processAgentDeath(dead, 'Old Tom', 'old_age', NOW);

    const line = (id: number) => emitted.find((e) => e.name === 'life:milestone' && e.payload.agentId === id)?.payload;
    for (const id of [acquaintance, rival, stranger]) {
      expect(line(id)?.description).toContain('Old Tom');
      expect(line(id)?.relatedAgentId).toBe(dead);
    }
    expect(line(acquaintance)?.description).toMatch(/miss seeing them/);
    expect(line(rival)?.description).toMatch(/never got along/);
    expect(line(stranger)?.description).toMatch(/barely knew/);
    // The rival's line is not a sad one.
    expect(line(rival)?.valence as number).toBeGreaterThan(line(acquaintance)?.valence as number);
  });
});

describe('MemoryObserver — a state that brings its own memory', () => {
  const record = vi.fn();
  beforeEach(() => {
    vi.restoreAllMocks();
    record.mockClear();
  });

  it('records the line the event carries instead of the generic one', () => {
    initMemoryObserver({ record } as unknown as MemoryService);
    simEvents.emit('state:triggered', {
      agentId: 3, state: 'grieving', cause: 'mourning Tom',
      memory: { description: 'Tom is gone.', valence: -0.8, importance: 9, relatedAgentId: 7 },
    });
    const call = record.mock.calls.find((c) => c[0] === 3);
    expect(call?.[2]).toBe('Tom is gone.');
    expect(call?.[3]).toMatchObject({ subtype: 'state', state: 'grieving', related_agents: [7] });
    expect(call?.[4]).toBe(-0.8);
    expect(call?.[5]).toBe(9);
  });
});
