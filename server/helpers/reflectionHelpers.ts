import { db } from '../db';
import { agents, needs, economy, memories, worldState } from '../db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import { CONFIG } from '../lib/constants';

export function getReflectionContext(agentId: number) {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent) return null;

  const agentNeeds = db.select().from(needs).where(eq(needs.agent_id, agentId)).get();
  const agentEconomy = db.select().from(economy).where(eq(economy.agent_id, agentId)).get();

  const world = db.select().from(worldState).get();
  if (!world) return null;

  const cutoffTick = world.time.totalTicks - 1440;
  const recentMemories = db
    .select()
    .from(memories)
    .where(and(eq(memories.agent_id, agentId), gte(memories.timestamp, cutoffTick)))
    .orderBy(desc(memories.timestamp))
    .limit(20)
    .all();

  return { agent, needs: agentNeeds, economy: agentEconomy, world, recentMemories };
}

export function insertReflectionMemory(agentId: number, content: string, timestamp: number) {
  const result = db
    .insert(memories)
    .values({
      agent_id: agentId,
      content,
      type: 'emotional',
      importance: CONFIG.AI.REFLECTION_IMPORTANCE,
      emotional_valence: 0,
      embedding: null,
      related_agents: [],
      related_location: null,
      tags: ['reflection', 'daily'],
      timestamp,
      access_count: 0,
      last_accessed: timestamp,
    })
    .returning()
    .get();

  return result.id;
}
