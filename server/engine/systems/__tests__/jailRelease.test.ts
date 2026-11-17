import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agentStates, shared_knowledge, worldState } from '../../../db/schema';
import { statesTick } from '../states';
import { simEvents } from '../../../lib/simEvents';
import { createFact } from '../../../lib/gossip';
import { memoryService } from '../../../lib/memory/instance';
import { NOW, TIME, freshTown, insertLocation, insertResident } from '../../../lib/__tests__/populationFixtures';

/**
 * A release from jail said in a comment that "the sentence becomes a gossip
 * fact", but nothing made one and nothing was emitted: the town never heard
 * that its prisoner was back on the street.
 */

type Emitted = { name: string; payload: Record<string, unknown> };
let emitted: Emitted[];

beforeEach(() => {
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
});

describe('a sentence served', () => {
  it('becomes a fact the constable and those who knew of the arrest share, and an event', () => {
    const town = freshTown();
    const prison = insertLocation('The Jail', 'prison', 6, { x: 34, y: 24 });
    const constable = insertResident('Constable Cole', town.homes[0], {}, { job: 'constable' });
    const prisoner = insertResident('Crook', town.homes[1], { current_location: prison });
    const gossip = insertResident('Gossip', town.homes[2]);
    const unaware = insertResident('Unaware', town.homes[2]);
    createFact('arrest', prisoner, constable, 2, [constable, prisoner, gossip], 'witnessed');
    db.insert(agentStates).values({
      agent_id: prisoner, type: 'arrested', severity: 0.2, started_at: NOW - 600, duration: 480,
      target_agent_id: constable, source: 'arrest', metadata: { prison_id: prison, sentence: 480 },
    }).run();
    db.update(worldState).set({ time: { ...TIME }, pending_transitions: [] }).run();

    statesTick();

    expect(db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, prisoner), eq(agentStates.type, 'arrested'))).get()).toBeUndefined();
    const fact = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.type, 'released'), eq(shared_knowledge.subject_id, prisoner))).get();
    expect(fact?.content).toBe('Crook served 8 hours in jail and is out again');
    const knowers = fact?.known_by as number[];
    expect(knowers).toEqual(expect.arrayContaining([constable, prisoner, gossip]));
    expect(knowers).not.toContain(unaware);
    expect(emitted.find((e) => e.name === 'crime:released')?.payload).toEqual({ agentId: prisoner, locationId: prison });
  });
});
