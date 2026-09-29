import { db } from '../../db';
import { memories, agents } from '../../db/schema';
import { eq, and, desc, inArray } from 'drizzle-orm';
import type { Memory, MemoryType } from './types';

type InsertItem = {
  agentId: number;
  type: string;
  description: string;
  importance: number;
  emotional_valence: number;
  embedding: Buffer | null;
  metadata: Record<string, unknown>;
  currentTick: number;
  depth?: number;
  parentIds?: number[];
};

type MemoryRow = typeof memories.$inferSelect;

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    agent_id: row.agent_id,
    type: row.type as MemoryType,
    description: row.description,
    importance: row.importance,
    emotional_valence: row.emotional_valence,
    depth: row.depth,
    created_at: row.created_at,
    last_accessed: row.last_accessed,
    embedding: row.embedding ?? null,
    metadata: row.metadata as Record<string, unknown>,
    is_active: row.is_active,
    parent_ids: row.parent_ids as number[],
  };
}

export class MemoryStore {
  /** Which of these agent ids still have a row (memories reference agents by FK). */
  existingAgentIds(ids: number[]): Set<number> {
    if (ids.length === 0) return new Set();
    return new Set(
      db.select({ id: agents.id }).from(agents).where(inArray(agents.id, ids)).all().map((r) => r.id),
    );
  }

  /**
   * Batch insert memories in a single transaction. Returns inserted rows.
   */
  insertBatch(items: InsertItem[]): MemoryRow[] {
    if (items.length === 0) return [];

    const rows = db
      .insert(memories)
      .values(
        items.map((item) => ({
          agent_id: item.agentId,
          type: item.type,
          description: item.description,
          importance: item.importance,
          emotional_valence: item.emotional_valence,
          depth: item.depth ?? 0,
          created_at: item.currentTick,
          last_accessed: item.currentTick,
          embedding: item.embedding,
          metadata: item.metadata,
          is_active: 1,
          parent_ids: item.parentIds ?? [],
        })),
      )
      .returning()
      .all();

    return rows;
  }

  /**
   * Get full Memory objects by IDs.
   */
  hydrateByIds(ids: number[]): Memory[] {
    if (ids.length === 0) return [];
    const rows = db
      .select()
      .from(memories)
      .where(inArray(memories.id, ids))
      .all();
    return rows.map(rowToMemory);
  }

  /**
   * Get recent active memories for an agent.
   */
  getRecentByAgent(agentId: number, limit: number): Memory[] {
    const rows = db
      .select()
      .from(memories)
      .where(and(eq(memories.agent_id, agentId), eq(memories.is_active, 1)))
      .orderBy(desc(memories.created_at))
      .limit(limit)
      .all();
    return rows.map(rowToMemory);
  }

  /**
   * Get active memories by agent and type.
   */
  getByAgentAndType(agentId: number, type: string, limit: number): Memory[] {
    const rows = db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.agent_id, agentId),
          eq(memories.type, type),
          eq(memories.is_active, 1),
        ),
      )
      .orderBy(desc(memories.created_at))
      .limit(limit)
      .all();
    return rows.map(rowToMemory);
  }

  /**
   * Update last_accessed for retrieved memories.
   */
  touchMemories(ids: number[], tick: number): void {
    if (ids.length === 0) return;
    db.update(memories)
      .set({ last_accessed: tick })
      .where(inArray(memories.id, ids))
      .run();
  }

  /**
   * Load embeddings for cache init.
   * Returns id, importance, lastAccessed, and embedding Buffer.
   */
  loadEmbeddingsForAgent(
    agentId: number,
    limit: number,
  ): Array<{ id: number; importance: number; lastAccessed: number; embedding: Buffer }> {
    const rows = db
      .select({
        id: memories.id,
        importance: memories.importance,
        last_accessed: memories.last_accessed,
        embedding: memories.embedding,
      })
      .from(memories)
      .where(and(eq(memories.agent_id, agentId), eq(memories.is_active, 1)))
      .orderBy(desc(memories.last_accessed))
      .limit(limit)
      .all();

    return rows
      .filter((r) => r.embedding != null)
      .map((r) => ({
        id: r.id,
        importance: r.importance,
        lastAccessed: r.last_accessed,
        embedding: r.embedding as Buffer,
      }));
  }

  /**
   * Deactivate a memory (soft delete).
   *
   * The embedding goes with it. Every read path filters on `is_active = 1`, so
   * an inactive row's vector can never be retrieved again — but it is by far the
   * largest column, and consolidation deactivates far more rows than it keeps.
   * Left in place it grew to well over half the database. The text, importance
   * and metadata stay, so the row remains readable as history.
   */
  deactivate(id: number): void {
    db.update(memories).set({ is_active: 0, embedding: null }).where(eq(memories.id, id)).run();
  }

  /**
   * Deactivate multiple memories in a single query (batch soft delete).
   */
  deactivateBatch(ids: number[]): void {
    if (ids.length === 0) return;
    db.update(memories).set({ is_active: 0, embedding: null }).where(inArray(memories.id, ids)).run();
  }

  /**
   * Truncate all memories (for sim reset).
   */
  truncateAll(): void {
    db.delete(memories).run();
  }
}
