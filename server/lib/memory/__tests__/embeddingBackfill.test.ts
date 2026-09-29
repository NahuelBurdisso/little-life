import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../../../db';
import { memories } from '../../../db/schema';
import { CONFIG } from '../../constants';
import { backfillEmbeddings } from '../embeddingBackfill';
import { EMBEDDING_DIMENSIONS } from '../constants';

const ai = CONFIG.AI as { EMBEDDING_MODEL: string };
const shippedModel = ai.EMBEDDING_MODEL;

function mockEmbed() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { input } = JSON.parse((init as RequestInit).body as string) as { input: string[] };
    return new Response(JSON.stringify({ embeddings: input.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.5)) }), { status: 200 });
  });
}

let agentId: number;

beforeEach(() => {
  sqlite.exec('DELETE FROM app_meta');
  db.delete(memories).run();
  // The backfill never reads the agent; skip building a full agents row.
  agentId = 987654;
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const insert = (description: string, embedding: Buffer | null) =>
    db.insert(memories).values({
      agent_id: agentId, type: 'observation', description, importance: 5, created_at: 0,
      last_accessed: 0, emotional_valence: 0, metadata: {}, embedding, is_active: 1,
    } as never).run();
  insert('I grew up by the river.', null);
  insert('Marco owes me money.', Buffer.alloc(EMBEDDING_DIMENSIONS * 4));
  sqlite.exec('PRAGMA foreign_keys = ON');
});

afterEach(() => {
  db.delete(memories).where(eq(memories.agent_id, agentId)).run();
  vi.restoreAllMocks();
  ai.EMBEDDING_MODEL = shippedModel;
});

describe('backfillEmbeddings', () => {
  it('embeds memories that have no vector and records the model', async () => {
    ai.EMBEDDING_MODEL = 'mxbai-embed-large';
    const fetchSpy = mockEmbed();
    expect(await backfillEmbeddings()).toEqual({ embedded: 1, reembeddedAll: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const rows = db.select().from(memories).where(eq(memories.agent_id, agentId)).all();
    expect(rows.every((r) => r.embedding != null)).toBe(true);
    // Nothing left to do on the next run.
    expect(await backfillEmbeddings()).toEqual({ embedded: 0, reembeddedAll: false });
  });

  it('re-embeds everything after the embedding model changed', async () => {
    ai.EMBEDDING_MODEL = 'qwen3-embedding:0.6b';
    mockEmbed();
    expect(await backfillEmbeddings()).toEqual({ embedded: 2, reembeddedAll: true });
    expect(await backfillEmbeddings()).toEqual({ embedded: 0, reembeddedAll: false });
  });

  it('keeps the old marker when the model call fails, so it retries', async () => {
    ai.EMBEDDING_MODEL = 'qwen3-embedding:0.6b';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 500 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await backfillEmbeddings()).toBeNull();
    mockEmbed();
    expect(await backfillEmbeddings()).toEqual({ embedded: 2, reembeddedAll: true });
  });
});
