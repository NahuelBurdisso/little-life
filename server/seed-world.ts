/**
 * Re-initializes the game world with the full 12-character cast.
 * Calls the running server's setup.initialize endpoint.
 * Run with: npx tsx server/seed-world.ts
 */
import { AGENT_SEEDS } from './data/agents';
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client';
import type { AppRouter } from './router';
import WebSocket from 'ws';

const agents = AGENT_SEEDS.map((seed, i) => ({
  id: `agent-${i + 1}`,
  name: seed.name,
  age: seed.age,
  gender: seed.gender,
  bio: seed.bio,
  traits: seed.traits,
  job: seed.job,
  jobTitle: seed.jobTitle,
  salary: seed.salary,
  homeName: seed.homeName,
  workplaceName: seed.workplaceName,
  schedule: seed.schedule,
  personality: seed.personality,
  backstoryMemories: seed.backstoryMemories,
  aspiration: getAspiration(seed),
}));

function getAspiration(seed: typeof AGENT_SEEDS[0]) {
  const p = seed.personality;
  if (p.vanity > 60) return { type: 'legacy', intensity: 0.7 };
  if (p.sensuality > 70) return { type: 'love', intensity: 0.8 };
  if (p.curiosity > 70) return { type: 'knowledge', intensity: 0.7 };
  if (p.impulsiveness > 60) return { type: 'freedom', intensity: 0.6 };
  if (p.loyalty > 70) return { type: 'love', intensity: 0.6 };
  return { type: 'legacy', intensity: 0.5 };
}

// Build relationships (deduplicated)
const relationships: any[] = [];
const seenPairs = new Set<string>();
for (const seed of AGENT_SEEDS) {
  for (const rel of seed.initialRelationships) {
    const key = [seed.name, rel.otherName].sort().join('|');
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    relationships.push({
      agentAName: seed.name,
      agentBName: rel.otherName,
      friendshipAB: rel.friendshipAB,
      friendshipBA: rel.friendshipBA,
      romanceAB: rel.romanceAB,
      romanceBA: rel.romanceBA,
      trustAB: rel.trustAB,
      trustBA: rel.trustBA,
      familiarity: rel.familiarity,
      status: rel.status,
      tags: rel.tags,
    });
  }
}

const setupConfig = {
  agents,
  relationships,
  world: {
    season: 'spring' as const,
    weather: 'sunny' as const,
    startHour: 8,
    startDay: 1,
  },
  rules: {
    deathEnabled: true,
    sicknessRate: 'low',
    contagionRate: 'low',
    dramaIntensity: 'high',
    tickSpeed: 1,
    startingMoney: 50,
  },
  worldgen: {
    sizeTier: 'auto' as const,
    overrides: {},
  },
};

async function main() {
  console.log(`Seeding world with ${agents.length} agents, ${relationships.length} relationships...`);

  const wsClient = createWSClient({
    url: 'ws://localhost:3001',
    WebSocket: WebSocket as any,
  });

  const client = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });

  try {
    const result = await client.setup.initialize.mutate(setupConfig);
    console.log('Result:', result);
    console.log('\nAgents:', agents.map(a => `${a.name} (${a.jobTitle})`).join(', '));
  } catch (err: any) {
    console.error('Failed:', err.message || err);
    wsClient.close();
    process.exit(1);
  }

  wsClient.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err?.message || err);
  process.exit(1);
});
