import { AGENT_SEEDS } from './agents';

export interface MemorySeed {
  agent_id: number;
  type: string;
  description: string;
  importance: number;
  emotional_valence: number;
  depth: number;
  created_at: number;
  last_accessed: number;
  embedding: null;
  metadata: Record<string, unknown>;
  is_active: number;
  parent_ids: number[];
}

export function getMemorySeeds(
  agentMap: Map<string, number>
): MemorySeed[] {
  // Use game tick 0 (start of simulation) — NOT Date.now() which is real milliseconds.
  const now = 0;
  const results: MemorySeed[] = [];

  for (const seed of AGENT_SEEDS) {
    const agentId = agentMap.get(seed.name);
    if (agentId === undefined) continue;

    // Backstory memories (importance 8)
    for (let i = 0; i < seed.backstoryMemories.length; i++) {
      results.push({
        agent_id: agentId,
        type: "experience",
        description: seed.backstoryMemories[i],
        importance: 8,
        emotional_valence: 0.3,
        depth: 0,
        created_at: now - (seed.backstoryMemories.length - i) * 1000,
        last_accessed: now,
        embedding: null,
        metadata: { tags: ["backstory"] },
        is_active: 1,
        parent_ids: [],
      });
    }

    // Relationship backstory memories (importance 6)
    for (const rel of seed.initialRelationships) {
      const otherId = agentMap.get(rel.otherName);
      if (otherId === undefined) continue;

      results.push({
        agent_id: agentId,
        type: "opinion",
        description: rel.backstoryMemory,
        importance: 6,
        emotional_valence:
          rel.friendshipAB > 40 ? 0.5 : rel.friendshipAB > 20 ? 0.2 : -0.2,
        depth: 0,
        created_at: now - 500,
        last_accessed: now,
        embedding: null,
        metadata: { related_agents: [otherId], tags: ["backstory", "relationship"] },
        is_active: 1,
        parent_ids: [],
      });
    }
  }

  return results;
}
