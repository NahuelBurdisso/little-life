import { db } from '../db';
import { memories } from '../db/schema';
import { eq } from 'drizzle-orm';

export function writeEmbedding(memoryId: number, embedding: Float32Array) {
  const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.update(memories).set({ embedding: buffer }).where(eq(memories.id, memoryId)).run();
}
