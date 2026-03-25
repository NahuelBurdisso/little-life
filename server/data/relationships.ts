import { AGENT_SEEDS } from './agents';

export interface RelationshipSeed {
  agent_a: number;
  agent_b: number;
  friendship_ab: number;
  friendship_ba: number;
  romance_ab: number;
  romance_ba: number;
  trust_ab: number;
  trust_ba: number;
  familiarity: number;
  interaction_count: number;
  last_interaction: number;
  average_interaction_sentiment: number;
  tags: string[];
  status: string;
  created_at: number;
  last_updated: number;
}

export function getRelationshipSeeds(
  agentMap: Map<string, number>
): RelationshipSeed[] {
  const now = 0; // game start tick, not wall-clock
  const createdPairs = new Set<string>();
  const results: RelationshipSeed[] = [];

  for (const seed of AGENT_SEEDS) {
    const agentId = agentMap.get(seed.name);
    if (agentId === undefined) continue;

    for (const rel of seed.initialRelationships) {
      const otherId = agentMap.get(rel.otherName);
      if (otherId === undefined) continue;

      // Normalize: agentA < agentB
      const [agentA, agentB] =
        agentId < otherId ? [agentId, otherId] : [otherId, agentId];
      const pairKey = `${agentA}:${agentB}`;

      if (createdPairs.has(pairKey)) continue;
      createdPairs.add(pairKey);

      // Determine directionality: if seed's agent maps to agentA, AB = seed->other
      const seedIsA = agentId === agentA;

      results.push({
        agent_a: agentA,
        agent_b: agentB,
        friendship_ab: seedIsA ? rel.friendshipAB : rel.friendshipBA,
        friendship_ba: seedIsA ? rel.friendshipBA : rel.friendshipAB,
        romance_ab: seedIsA ? rel.romanceAB : rel.romanceBA,
        romance_ba: seedIsA ? rel.romanceBA : rel.romanceAB,
        trust_ab: seedIsA ? rel.trustAB : rel.trustBA,
        trust_ba: seedIsA ? rel.trustBA : rel.trustAB,
        familiarity: rel.familiarity,
        interaction_count: Math.floor(rel.familiarity / 5),
        last_interaction: now,
        average_interaction_sentiment: 0.3,
        tags: rel.tags,
        status: rel.status,
        created_at: now,
        last_updated: now,
      });
    }
  }

  // Create default "strangers" relationships for any pairs without one
  const allAgentNames = Array.from(agentMap.keys());
  for (let i = 0; i < allAgentNames.length; i++) {
    for (let j = i + 1; j < allAgentNames.length; j++) {
      const idA = agentMap.get(allAgentNames[i])!;
      const idB = agentMap.get(allAgentNames[j])!;
      const [agentA, agentB] = idA < idB ? [idA, idB] : [idB, idA];
      const pairKey = `${agentA}:${agentB}`;

      if (createdPairs.has(pairKey)) continue;
      createdPairs.add(pairKey);

      results.push({
        agent_a: agentA,
        agent_b: agentB,
        friendship_ab: 15,
        friendship_ba: 15,
        romance_ab: 0,
        romance_ba: 0,
        trust_ab: 15,
        trust_ba: 15,
        familiarity: 20,
        interaction_count: 2,
        last_interaction: now,
        average_interaction_sentiment: 0.0,
        tags: ["townspeople"],
        status: "acquaintances",
        created_at: now,
        last_updated: now,
      });
    }
  }

  return results;
}
