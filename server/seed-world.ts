/**
 * Re-initializes the running server's world as the setup wizard's Quick Start
 * does: the default cast and relationships, the default world/rules/worldgen,
 * and the default drama preset (so the opening hooks, lib/dramaHooks.ts, are
 * seeded too). Calls the running server's setup.initialize endpoint, which
 * replaces the world in whatever database that server has open.
 *
 * Run with: npx tsx server/seed-world.ts [--seed <seed>]
 *
 * It used to post `AGENT_SEEDS` with its own rules, 08:00 and no scenario — a
 * town no player ever gets from the wizard, with none of the starting drama.
 * The defaults are imported rather than restated (as scripts/soak.ts does) so
 * this follows the wizard when they change.
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client';
import type { AppRouter } from './router';
import WebSocket from 'ws';
import { getDefaultAgents, getDefaultRelationships } from '../src/components/setup/defaults';
import { DEFAULT_WORLD, DEFAULT_RULES, DEFAULT_WORLDGEN, DEFAULT_PRESET } from '../src/components/setup/types';

const seedArg = process.argv.indexOf('--seed');
// The wizard draws a fresh seed per visit; so does this, unless one is given.
const seed = seedArg >= 0 ? process.argv[seedArg + 1] : Math.random().toString(36).slice(2, 10);

const agents = getDefaultAgents();
const setupConfig = {
  agents,
  relationships: getDefaultRelationships(),
  world: DEFAULT_WORLD,
  rules: DEFAULT_RULES,
  worldgen: { ...DEFAULT_WORLDGEN, seed },
  scenario: { ...DEFAULT_PRESET.values, seed },
};

async function main() {
  console.log(`Seeding world with ${agents.length} agents (preset ${DEFAULT_PRESET.label}, seed ${seed})...`);

  const wsClient = createWSClient({
    url: process.env.VITE_WS_URL ?? 'ws://localhost:3001',
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  });

  const client = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });

  try {
    const result = await client.setup.initialize.mutate(setupConfig);
    console.log('Result:', result);
    console.log('\nAgents:', agents.map(a => `${a.name} (${a.jobTitle})`).join(', '));
  } catch (err) {
    console.error('Failed:', err instanceof Error ? err.message : err);
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
