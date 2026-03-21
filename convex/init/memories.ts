import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { AgentSeed } from "./agents";

export async function seedMemories(
  ctx: MutationCtx,
  agentMap: Map<string, Id<"agents">>,
  seeds: AgentSeed[]
): Promise<void> {
  const now = Date.now();

  for (const seed of seeds) {
    const agentId = agentMap.get(seed.name);
    if (!agentId) continue;

    // Insert backstory memories (importance 8)
    for (let i = 0; i < seed.backstoryMemories.length; i++) {
      await ctx.db.insert("memories", {
        agentId,
        content: seed.backstoryMemories[i],
        type: "experience",
        importance: 8,
        emotional_valence: 0.3,
        embedding: [], // filled later by async embedding action
        relatedAgents: [],
        relatedLocation: null,
        tags: ["backstory"],
        timestamp: now - (seed.backstoryMemories.length - i) * 1000, // stagger timestamps
        accessCount: 0,
        lastAccessed: now,
      });
    }

    // Insert relationship backstory memories (importance 6)
    for (const rel of seed.initialRelationships) {
      const otherId = agentMap.get(rel.otherName);
      if (!otherId) continue;

      await ctx.db.insert("memories", {
        agentId,
        content: rel.backstoryMemory,
        type: "opinion",
        importance: 6,
        emotional_valence: rel.friendshipAB > 40 ? 0.5 : rel.friendshipAB > 20 ? 0.2 : -0.2,
        embedding: [], // filled later by async embedding action
        relatedAgents: [otherId],
        relatedLocation: null,
        tags: ["backstory", "relationship"],
        timestamp: now - 500, // slightly before current time
        accessCount: 0,
        lastAccessed: now,
      });
    }
  }
}
