import { AGENT_SEEDS } from './agents';

export interface MemorySeed {
  agent_id: number;
  content: string;
  type: string;
  importance: number;
  emotional_valence: number;
  embedding: null;
  related_agents: number[];
  related_location: null;
  tags: string[];
  timestamp: number;
  access_count: number;
  last_accessed: number;
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
        content: seed.backstoryMemories[i],
        type: "experience",
        importance: 8,
        emotional_valence: 0.3,
        embedding: null,
        related_agents: [],
        related_location: null,
        tags: ["backstory"],
        timestamp: now - (seed.backstoryMemories.length - i) * 1000,
        access_count: 0,
        last_accessed: now,
      });
    }

    // Relationship backstory memories (importance 6)
    for (const rel of seed.initialRelationships) {
      const otherId = agentMap.get(rel.otherName);
      if (otherId === undefined) continue;

      results.push({
        agent_id: agentId,
        content: rel.backstoryMemory,
        type: "opinion",
        importance: 6,
        emotional_valence:
          rel.friendshipAB > 40 ? 0.5 : rel.friendshipAB > 20 ? 0.2 : -0.2,
        embedding: null,
        related_agents: [otherId],
        related_location: null,
        tags: ["backstory", "relationship"],
        timestamp: now - 500,
        access_count: 0,
        last_accessed: now,
      });
    }
  }

  return results;
}
