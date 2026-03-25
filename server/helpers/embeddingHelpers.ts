import { db } from '../db';
import { memories } from '../db/schema';
import { eq } from 'drizzle-orm';
import { vectorStore } from '../lib/vectors';

export function writeEmbedding(memoryId: number, embedding: Float32Array) {
  const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.update(memories).set({ embedding: buffer }).where(eq(memories.id, memoryId)).run();

  const mem = db.select({ agentId: memories.agent_id }).from(memories).where(eq(memories.id, memoryId)).get();
  if (mem) {
    vectorStore.add(memoryId, mem.agentId, embedding);
  }
}
