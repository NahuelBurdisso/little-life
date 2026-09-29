import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, getTableWriteVersion, sqlite, verifyWriteHooks } from '../../db';
import { goals } from '../../db/schema';
import { RowsByAgentSnapshot } from '../rowsByAgentSnapshot';

/**
 * The goals and states phases answer per-agent re-reads from a snapshot keyed
 * on a table write counter. The snapshot is only as good as the counter: every
 * insert, update and delete has to move it, and it has to survive its TEMP
 * triggers being dropped with the table.
 */

// Far above any seeded id so the rows can't collide with what other files left.
const AGENT = 990_101;

function insertGoal(status = 'active'): number {
  return db.insert(goals).values({
    agent_id: AGENT,
    type: 'befriend',
    motivation: 'test',
    priority: 0.5,
    status,
    created_at: 0,
  }).returning({ id: goals.id }).get().id;
}

function snapshot() {
  return new RowsByAgentSnapshot(
    () => getTableWriteVersion('goals'),
    () => db.select().from(goals).orderBy(goals.id).all(),
    (row) => row.agent_id,
  );
}

describe('table write counters + RowsByAgentSnapshot', () => {
  afterEach(() => { db.delete(goals).where(eq(goals.agent_id, AGENT)).run(); });

  it('moves on insert, update and delete', () => {
    const v0 = getTableWriteVersion('goals');
    const id = insertGoal();
    const v1 = getTableWriteVersion('goals');
    expect(v1).toBeGreaterThan(v0);
    db.update(goals).set({ progress: 0.4 }).where(eq(goals.id, id)).run();
    const v2 = getTableWriteVersion('goals');
    expect(v2).toBeGreaterThan(v1);
    db.delete(goals).where(eq(goals.id, id)).run();
    expect(getTableWriteVersion('goals')).toBeGreaterThan(v2);
    // A read is not a write.
    const v3 = getTableWriteVersion('goals');
    db.select().from(goals).all();
    expect(getTableWriteVersion('goals')).toBe(v3);
  });

  it('re-reads only after a write, and sees content-only updates', () => {
    const id = insertGoal();
    const snap = snapshot();
    const first = snap.forAgent(AGENT);
    expect(first.map((g) => g.id)).toEqual([id]);
    expect(snap.forAgent(AGENT)).toBe(first); // nothing written: same array

    db.update(goals).set({ progress: 0.7 }).where(eq(goals.id, id)).run();
    expect(snap.forAgent(AGENT)[0].progress).toBe(0.7);

    const second = insertGoal('abandoned');
    expect(snap.forAgent(AGENT).map((g) => g.id)).toEqual([id, second]);
    expect(snap.forAgent(AGENT + 1)).toEqual([]);
  });

  it('reinstalls dropped triggers at the next verify', () => {
    snapshot().forAgent(AGENT); // installs the hook
    for (const t of ['ll_goals_ai', 'll_goals_ad', 'll_goals_au']) sqlite.exec(`DROP TRIGGER temp.${t}`);

    const snap = snapshot();
    expect(snap.forAgent(AGENT)).toEqual([]);
    insertGoal(); // unseen: nothing counts it any more
    verifyWriteHooks(); // next tick (cacheAllAgentStates)
    expect(snap.forAgent(AGENT)).toHaveLength(1);

    insertGoal(); // and writes are counted again
    expect(snap.forAgent(AGENT)).toHaveLength(2);
  });
});
