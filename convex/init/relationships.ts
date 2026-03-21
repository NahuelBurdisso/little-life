import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { AgentSeed } from "./agents";

export async function seedRelationships(
  ctx: MutationCtx,
  agentMap: Map<string, Id<"agents">>,
  seeds: AgentSeed[]
): Promise<void> {
  const now = Date.now();
  const createdPairs = new Set<string>();

  for (const seed of seeds) {
    const agentId = agentMap.get(seed.name);
    if (!agentId) continue;

    for (const rel of seed.initialRelationships) {
      const otherId = agentMap.get(rel.otherName);
      if (!otherId) continue;

      // Normalize: agentA < agentB (by string comparison of IDs)
      const [agentA, agentB] =
        agentId < otherId ? [agentId, otherId] : [otherId, agentId];
      const pairKey = `${agentA}:${agentB}`;

      if (createdPairs.has(pairKey)) continue;
      createdPairs.add(pairKey);

      // Determine directionality: if seed.name maps to agentA, AB = seed->other
      const seedIsA = agentId === agentA;

      await ctx.db.insert("relationships", {
        agentA,
        agentB,
        friendshipAB: seedIsA ? rel.friendshipAB : rel.friendshipBA,
        friendshipBA: seedIsA ? rel.friendshipBA : rel.friendshipAB,
        romanceAB: seedIsA ? rel.romanceAB : rel.romanceBA,
        romanceBA: seedIsA ? rel.romanceBA : rel.romanceAB,
        trustAB: seedIsA ? rel.trustAB : rel.trustBA,
        trustBA: seedIsA ? rel.trustBA : rel.trustAB,
        familiarity: rel.familiarity,
        interactionCount: Math.floor(rel.familiarity / 5),
        lastInteraction: now,
        averageInteractionSentiment: 0.3,
        tags: rel.tags,
        status: rel.status,
        createdAt: now,
        lastUpdated: now,
      });
    }
  }

  // Create default "strangers" relationships for any pairs that don't have one
  const allAgentNames = Array.from(agentMap.keys());
  for (let i = 0; i < allAgentNames.length; i++) {
    for (let j = i + 1; j < allAgentNames.length; j++) {
      const idA = agentMap.get(allAgentNames[i])!;
      const idB = agentMap.get(allAgentNames[j])!;
      const [agentA, agentB] = idA < idB ? [idA, idB] : [idB, idA];
      const pairKey = `${agentA}:${agentB}`;

      if (createdPairs.has(pairKey)) continue;
      createdPairs.add(pairKey);

      await ctx.db.insert("relationships", {
        agentA,
        agentB,
        friendshipAB: 15,
        friendshipBA: 15,
        romanceAB: 0,
        romanceBA: 0,
        trustAB: 15,
        trustBA: 15,
        familiarity: 20,
        interactionCount: 2,
        lastInteraction: now,
        averageInteractionSentiment: 0.0,
        tags: ["townspeople"],
        status: "acquaintances",
        createdAt: now,
        lastUpdated: now,
      });
    }
  }
}
