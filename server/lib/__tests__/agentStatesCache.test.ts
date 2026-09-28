import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, sqlite } from '../../db';
import { agentStates } from '../../db/schema';
import { cacheAllAgentStates, clearAgentStatesCache, getAgentStates } from '../states';

/**
 * B8 regression: the tick-level state cache is built right after the `states`
 * phase, but later phases (conversations, decisions, gossip, cascade...) still
 * insert and end states. Every getAgentStates() after such a write used to read
 * the pre-write snapshot for the rest of the tick.
 */

// Far above any seeded id so the rows can't collide with what other files left.
const AGENT = 990_001;

function insertState(type: string): number {
  return db.insert(agentStates).values({
    agent_id: AGENT,
    type,
    severity: 0.8,
    started_at: 0,
    duration: 600,
    target_agent_id: null,
    source: 'test',
    metadata: null,
  }).returning({ id: agentStates.id }).get().id;
}

describe('tick-level agent states cache (B8)', () => {
  // The rows only need an agent id; a full agent row needs a home location too.
  beforeAll(() => { sqlite.pragma('foreign_keys = OFF'); });
  afterAll(() => { sqlite.pragma('foreign_keys = ON'); });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAgentStatesCache();
    db.delete(agentStates).where(eq(agentStates.agent_id, AGENT)).run();
  });

  it('sees a state inserted by a later phase in the same tick', () => {
    cacheAllAgentStates(); // end of the states phase
    expect(getAgentStates(AGENT)).toEqual([]);

    // e.g. conversations.ts affair discovery, inside its own phase transaction
    db.transaction(() => { insertState('heartbroken'); });

    expect(getAgentStates(AGENT)).toEqual(['heartbroken']);
  });

  it('sees a state ended by a later phase', () => {
    const id = insertState('drunk');
    cacheAllAgentStates();
    expect(getAgentStates(AGENT)).toEqual(['drunk']);

    db.delete(agentStates).where(eq(agentStates.id, id)).run();

    expect(getAgentStates(AGENT)).toEqual([]);
  });

  it('catches raw-SQL writers too, not just drizzle builders', () => {
    cacheAllAgentStates();
    db.run(sql`INSERT INTO agent_states (agent_id, type, severity, started_at, duration, source)
               VALUES (${AGENT}, 'arrested', 1, 0, 60, 'test')`);
    expect(getAgentStates(AGENT)).toEqual(['arrested']);
  });

  it('sees a state whose type was rewritten', () => {
    const id = insertState('angry');
    cacheAllAgentStates();
    db.update(agentStates).set({ type: 'jealous' }).where(eq(agentStates.id, id)).run();
    expect(getAgentStates(AGENT)).toEqual(['jealous']);
  });

  it('keeps serving reads from memory — one rebuild per write, not a query per read', () => {
    insertState('stressed');
    cacheAllAgentStates();
    const select = vi.spyOn(db, 'select');

    for (let i = 0; i < 50; i++) getAgentStates(AGENT + (i % 5));
    expect(select).not.toHaveBeenCalled();

    // Metadata/severity updates don't change which states exist: no rebuild.
    db.update(agentStates).set({ severity: 0.1, metadata: { note: 1 } }).where(eq(agentStates.agent_id, AGENT)).run();
    getAgentStates(AGENT);
    expect(select).not.toHaveBeenCalled();

    insertState('lonely');
    for (let i = 0; i < 50; i++) getAgentStates(AGENT + (i % 5));
    expect(select).toHaveBeenCalledTimes(1);
    expect(getAgentStates(AGENT).sort()).toEqual(['lonely', 'stressed']);
  });

  it('falls back to direct reads once the tick clears the cache', () => {
    cacheAllAgentStates();
    clearAgentStatesCache();
    insertState('sick');
    expect(getAgentStates(AGENT)).toEqual(['sick']);
  });
});
