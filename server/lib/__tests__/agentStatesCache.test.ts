import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, sqlite } from '../../db';
import { agentStates } from '../../db/schema';
import { AgentStateRowsSnapshot, cacheAllAgentStates, clearAgentStatesCache, getAgentStates } from '../states';
import { runSystemPhase } from '../../engine/tick';

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

  it('drops a state whose phase rolled back after it was read', async () => {
    cacheAllAgentStates();
    let seenInsidePhase: string[] = [];
    const ok = await runSystemPhase(
      {
        name: 'phantom',
        run: () => {
          insertState('drunk');
          // A read between the write and the rollback rebuilds from the
          // uncommitted row — no trigger will fire when it is undone.
          seenInsidePhase = [...getAgentStates(AGENT)];
          throw new Error('phase blew up');
        },
      },
      {} as Parameters<typeof runSystemPhase>[1],
      99,
    );

    expect(ok).toBe(false);
    expect(seenInsidePhase).toEqual(['drunk']);
    expect(db.select().from(agentStates).where(eq(agentStates.agent_id, AGENT)).all()).toEqual([]);
    expect(getAgentStates(AGENT)).toEqual([]);
  });

  it('reinstalls the write triggers at the next tick if they went missing', () => {
    const triggerCount = () =>
      (sqlite.prepare(`SELECT count(*) AS n FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'll_agent_states_%'`).get() as { n: number }).n;
    cacheAllAgentStates();
    expect(triggerCount()).toBe(4);

    // What a drop-and-recreate of agent_states does to TEMP triggers.
    for (const t of ['ll_agent_states_ai', 'll_agent_states_ad', 'll_agent_states_au', 'll_agent_states_au_row']) {
      sqlite.exec(`DROP TRIGGER temp.${t}`);
    }
    insertState('sick'); // unseen: nothing counts it any more

    cacheAllAgentStates(); // next tick
    expect(triggerCount()).toBe(4);
    expect(getAgentStates(AGENT)).toEqual(['sick']);

    insertState('lonely'); // and mid-tick writes are seen again
    expect(getAgentStates(AGENT).sort()).toEqual(['lonely', 'sick']);
  });

  it('falls back to direct reads once the tick clears the cache', () => {
    cacheAllAgentStates();
    clearAgentStatesCache();
    insertState('sick');
    expect(getAgentStates(AGENT)).toEqual(['sick']);
  });
});

/**
 * The states phase answers its per-agent re-reads from one snapshot of whole
 * rows. It must see every write the per-agent query would have seen, including
 * updates that only change a row's content (severity, duration, metadata).
 */
describe('AgentStateRowsSnapshot', () => {
  beforeAll(() => { sqlite.pragma('foreign_keys = OFF'); });
  afterAll(() => { sqlite.pragma('foreign_keys = ON'); });
  afterEach(() => { db.delete(agentStates).where(eq(agentStates.agent_id, AGENT)).run(); });

  const direct = () => db.select().from(agentStates).where(eq(agentStates.agent_id, AGENT)).all();

  it('answers like the per-agent query, in the same order', () => {
    insertState('sick');
    insertState('angry');
    insertState('drunk');
    const snap = new AgentStateRowsSnapshot();
    expect(snap.forAgent(AGENT)).toEqual(direct());
    expect(snap.find(AGENT, 'angry')?.type).toBe('angry');
    expect(snap.find(AGENT, 'lonely')).toBeUndefined();
    expect(snap.forAgent(AGENT + 1)).toEqual([]);
  });

  it('re-reads only after a write', () => {
    insertState('sick');
    const snap = new AgentStateRowsSnapshot();
    const first = snap.forAgent(AGENT);
    expect(snap.forAgent(AGENT)).toBe(first); // no write: same array, no query

    const id = insertState('drunk');
    expect(snap.forAgent(AGENT).map((s) => s.type)).toEqual(['sick', 'drunk']);

    db.delete(agentStates).where(eq(agentStates.id, id)).run();
    expect(snap.forAgent(AGENT).map((s) => s.type)).toEqual(['sick']);
    // The array a caller was iterating is left alone.
    expect(first.map((s) => s.type)).toEqual(['sick']);
  });

  it('sees content-only updates the type cache ignores', () => {
    const id = insertState('sick');
    const snap = new AgentStateRowsSnapshot();
    expect(snap.find(AGENT, 'sick')?.severity).toBe(0.8);

    db.update(agentStates).set({ severity: 0.3, metadata: { coloc_2: 4 } }).where(eq(agentStates.id, id)).run();

    expect(snap.find(AGENT, 'sick')).toMatchObject({ severity: 0.3, metadata: { coloc_2: 4 } });
  });
});
