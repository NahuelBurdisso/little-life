import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { conversations } from '../../db/schema';
import { addMessage } from '../conversationHelpers';

function insertConversation(status: string) {
  return db.insert(conversations).values({
    participants: [1, 2],
    messages: [],
    trigger_reason: 'test',
    status,
    started_at: Date.now(),
    sentiment: 0,
    max_turns: 6,
  }).returning({ id: conversations.id }).get().id;
}

describe('addMessage', () => {
  it('appends to an active conversation', () => {
    const id = insertConversation('active');

    const result = addMessage(id, 1, 'Morning!', 0.3, [], Date.now());

    expect(result).toEqual({ messageCount: 1, maxTurns: 6 });
  });

  it('refuses to append to a conversation that was force-ended', () => {
    // A timeout force-end marks the row ended while taskRunner is still mid-turn;
    // the in-flight reply must not keep growing the ended transcript.
    const id = insertConversation('ended');

    const result = addMessage(id, 1, 'Late reply', 0.1, [], Date.now());

    expect(result).toBeNull();
    const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
    expect(row?.messages).toEqual([]);
  });
});
