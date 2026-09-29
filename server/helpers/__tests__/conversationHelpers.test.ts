import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { conversations } from '../../db/schema';
import { addMessage, goalPromptLines } from '../conversationHelpers';

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

  it('refuses a line past max_turns (a wrapped-up transcript is closed)', () => {
    // conversationsTick pins max_turns to the transcript length when it closes a
    // wrapped-up conversation with a farewell; a late LLM reply must not follow it.
    const id = insertConversation('active');
    db.update(conversations).set({ max_turns: 1 }).where(eq(conversations.id, id)).run();
    expect(addMessage(id, 1, 'Goodbye!', 0.2, [], Date.now())).toEqual({ messageCount: 1, maxTurns: 1 });

    expect(addMessage(id, 2, 'Wait, one more thing', 0, [], Date.now())).toBeNull();
    const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
    expect(row?.messages).toHaveLength(1);
  });
});

describe('goalPromptLines', () => {
  const names: Record<number, string> = { 7: 'Dr. Sofia Petrov' };
  const nameOf = (id: number) => names[id] ?? `Agent#${id}`;

  it('turns a backfilled registry key into prose instead of a bare verb (playtest #3)', () => {
    const lines = goalPromptLines([
      { type: 'investigate', description: "Keep a watchful eye on the Constable's temperament.", target_id: null },
      { type: 'protect', description: 'protect', target_id: null },
    ], nameOf);
    expect(lines).toEqual(["Keep a watchful eye on the Constable's temperament", 'looking after someone']);
    // Joined as the prompt does: no ".;" and no dangling "protect".
    expect(lines.join('; ')).not.toMatch(/\.;|; protect$/);
  });

  it("names a keyed goal's target by first name", () => {
    expect(goalPromptLines([{ type: 'seduce', description: 'seduce', target_id: 7 }], nameOf))
      .toEqual(['winning Sofia over']);
    expect(goalPromptLines([{ type: 'protect', description: 'protect', target_id: 7 }], nameOf))
      .toEqual(['looking after Sofia']);
  });

  it('keeps LLM-written goals as written, skips empty ones and caps at three', () => {
    const lines = goalPromptLines([
      { type: 'x', description: '', target_id: null },
      { type: 'seduce', description: 'Win someone back.', target_id: 7 },
      { type: 'x', description: 'Save money', target_id: null },
      { type: 'x', description: 'Find out who stole the ledger...', target_id: null },
      { type: 'x', description: 'A fourth goal', target_id: null },
    ], nameOf);
    expect(lines).toEqual(['Win someone back', 'Save money', 'Find out who stole the ledger…']);
  });
});
