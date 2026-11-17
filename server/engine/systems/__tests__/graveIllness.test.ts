import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, agentStates } from '../../../db/schema';
import { simEvents } from '../../../lib/simEvents';
import { createStatesTickContext } from '../states/context';
import { processStateEffects } from '../states/effects';
import { NOW, freshTown, insertResident } from '../../../lib/__tests__/populationFixtures';

/**
 * An illness turning grave was only a feed line: nothing could react to it, and
 * goals.ts's `metadata.grave` (a grave illness brings friends at any severity)
 * was read but never written.
 */

let emitted: Array<{ name: string; payload: Record<string, unknown> }>;

beforeEach(() => {
  emitted = [];
  vi.spyOn(simEvents, 'emit').mockImplementation((name: string | symbol, payload?: unknown) => {
    emitted.push({ name: String(name), payload: payload as Record<string, unknown> });
    return true;
  });
  // Every roll passes: the illness worsens.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function worsenOnce(severity: number, worsened: number) {
  const town = freshTown();
  const id = insertResident('Patient Pat', town.homes[0]);
  db.insert(agentStates).values({
    agent_id: id, type: 'sick', severity, started_at: NOW - 60, duration: 1440,
    source: 'test', metadata: { worsened },
  }).run();
  const row = db.select().from(agents).where(eq(agents.id, id)).get()!;
  const states = db.select().from(agentStates).where(eq(agentStates.agent_id, id)).all();
  processStateEffects(row, states, [row], NOW, 10_000, 1, createStatesTickContext());
  const sick = db.select().from(agentStates).where(and(eq(agentStates.agent_id, id), eq(agentStates.type, 'sick'))).get()!;
  return { id, sick, graves: emitted.filter((e) => e.name === 'health:grave') };
}

describe('an untreated illness turning grave', () => {
  it('is flagged on the state and announced once', () => {
    const { id, sick, graves } = worsenOnce(0.6, 1); // home rest shaves a little off first
    expect((sick.metadata as { worsened?: number }).worsened).toBe(2);
    expect((sick.metadata as { grave?: boolean }).grave).toBe(true);
    expect(graves.map((e) => e.payload)).toEqual([{ agentId: id, severity: sick.severity }]);
  });

  it('a first turn for the worse is not grave yet', () => {
    const { sick, graves } = worsenOnce(0.3, 0);
    expect((sick.metadata as { grave?: boolean }).grave).toBeUndefined();
    expect(graves).toHaveLength(0);
  });
});
