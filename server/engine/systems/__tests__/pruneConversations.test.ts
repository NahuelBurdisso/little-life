import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { conversations } from '../../../db/schema';
import { pruneEndedConversations } from '../conversations';

function insert(status: string, endedAt: number | null) {
  return db.insert(conversations).values({
    participants: [1, 2],
    messages: [{ speakerId: 1, text: 'hi' }],
    trigger_reason: 'test',
    status,
    started_at: 0,
    ended_at: endedAt,
    sentiment: 0,
    max_turns: 4,
  }).returning({ id: conversations.id }).get().id;
}

describe('pruneEndedConversations', () => {
  beforeEach(() => {
    db.delete(conversations).run();
  });

  it('keeps only the newest ended conversations', () => {
    const ids = [100, 200, 300, 400, 500].map((t) => insert('ended', t));

    const deleted = pruneEndedConversations(2);

    expect(deleted).toBe(3);
    const left = db.select({ id: conversations.id }).from(conversations).all().map((r) => r.id);
    expect(left.sort()).toEqual([ids[3], ids[4]].sort());
  });

  it('never touches active conversations', () => {
    const active = insert('active', null);
    insert('ended', 100);
    insert('ended', 200);

    pruneEndedConversations(0);

    expect(db.select().from(conversations).where(eq(conversations.id, active)).get()).toBeDefined();
    expect(db.select().from(conversations).all()).toHaveLength(1);
  });

  it('is a no-op under the cap', () => {
    insert('ended', 100);
    expect(pruneEndedConversations(10)).toBe(0);
  });
});
