import { describe, it, expect, afterAll } from 'vitest';
import { db } from '../db';
import { economy, locations, relationships, shared_knowledge, worldState } from '../db/schema';
import { generateWorld } from '../lib/worldgen';
import { stopTickLoopAndWait } from '../engine/tick';

// ─── Minimal valid agent fixture ─────────────────────────────────────────────
// AgentConfigSchema requires: id, name, age, gender, bio, traits, job,
// jobTitle, salary, homeName, workplaceName, schedule, personality (10 fields),
// backstoryMemories. Aspiration is optional.

const MINIMAL_SCHEDULE = {
  wakeTime: 7,
  sleepTime: 22,
  workStart: 9,
  workEnd: 17,
  lunchTime: 12,
  freeTimePreferences: ['park'],
};

const MINIMAL_PERSONALITY = {
  honesty: 50,
  aggression: 20,
  warmth: 60,
  impulsiveness: 30,
  vanity: 25,
  curiosity: 55,
  loyalty: 65,
  morality: 70,
  sensuality: 35,
  neuroticism: 40,
};

function makeAgent(n: number) {
  return {
    id: `agent-${n}`,
    name: `Test Agent ${n}`,
    age: 30,
    gender: 'neutral',
    bio: `Bio for agent ${n}`,
    traits: ['friendly'],
    job: 'laborer',
    jobTitle: 'Laborer',
    salary: 20,
    homeName: `Home ${n}`,
    workplaceName: null,
    schedule: MINIMAL_SCHEDULE,
    personality: MINIMAL_PERSONALITY,
    backstoryMemories: [],
  };
}

const MINIMAL_AGENTS = [1, 2, 3, 4, 5].map(makeAgent);

/**
 * Tier 1 (pipeline-level): verify generateWorld determinism at the exact
 * boundary seedWorld consumes.
 */
describe('generateWorld determinism (pipeline boundary)', () => {
  it('produces identical locations with same seed + agents', () => {
    const cfg = { sizeTier: 'auto' as const, overrides: {}, seed: 'deterministic-xyz' };
    const agents = MINIMAL_AGENTS.map(a => ({ homeName: a.homeName }));
    const a = generateWorld(cfg, agents.length, { agents });
    const b = generateWorld(cfg, agents.length, { agents });
    expect(a.locations.length).toBe(b.locations.length);
    for (let i = 0; i < a.locations.length; i++) {
      expect(a.locations[i].name).toBe(b.locations[i].name);
      expect(a.locations[i].type).toBe(b.locations[i].type);
      expect(a.locations[i].position).toEqual(b.locations[i].position);
      expect(a.locations[i].entry_point).toEqual(b.locations[i].entry_point);
    }
    expect(a.dimensions).toEqual(b.dimensions);
    expect(a.collisionGrid).toBe(b.collisionGrid);
    expect(a.seed).toBe(b.seed);
  });

  it('produces different locations with different seeds', () => {
    const base = { sizeTier: 'auto' as const, overrides: {} };
    const a = generateWorld({ ...base, seed: 'alpha' }, 10);
    const b = generateWorld({ ...base, seed: 'beta' }, 10);
    const aHomes = a.locations.filter((l) => l.type === 'home');
    const bHomes = b.locations.filter((l) => l.type === 'home');
    const samePositions = aHomes.every((h, i) =>
      h.position.x === bHomes[i]?.position.x && h.position.y === bHomes[i]?.position.y);
    expect(samePositions).toBe(false);
  });
});

/**
 * Tier 2 (DB-level): call setupRouter.initialize twice with the same
 * worldgen.seed and assert the `locations` rows are identical.
 *
 * We call seedWorld indirectly by importing the router's underlying logic.
 * The `initialize` mutation clears all tables then calls seedWorld, so two
 * sequential calls with identical config + seed must produce identical rows.
 *
 * Note: we bypass the tRPC caller layer and invoke seedWorld directly via the
 * router's mutation handler to avoid spinning up a full tRPC context.
 *
 * `initialize` is NOT side-effect-free beyond SQLite: it routes through
 * `replaceWorld`, whose `finally` unconditionally calls `startTickLoop()`. The
 * world seeded below has `is_paused: false` and `tick_speed: 1`, so without the
 * teardown here the loop keeps ticking against the test DB (and issuing Ollama
 * calls) after the assertions land, and vitest never exits cleanly.
 *
 * `stopTickLoopAndWait` (not `stopTickLoop`) is required: the sync variant only
 * clears the pending `setTimeout`, so a `gameTick()` already in flight keeps
 * writing to the shared test DB after `afterAll` returns and pollutes whatever
 * test file vitest runs next in the same worker.
 */
describe('initialize DB determinism', () => {
  afterAll(async () => {
    await stopTickLoopAndWait();
  });

  function makeSetupConfig(seed: string) {
    return {
      agents: MINIMAL_AGENTS,
      relationships: [],
      world: { season: 'spring' as const, weather: 'sunny', startHour: 9, startDay: 1 },
      rules: { startingMoney: 50, tickSpeed: 1 },
      worldgen: { sizeTier: 'auto' as const, overrides: {}, seed },
    };
  }

  it('same seed → same locations rows across two initialize calls', async () => {
    // Import the router and build a minimal tRPC caller.
    const { setupRouter } = await import('../routers/setup');
    const caller = setupRouter.createCaller({} as any);
    const seed = 'integration-deterministic';

    await caller.initialize(makeSetupConfig(seed) as any);
    const first = db
      .select({
        name: locations.name,
        type: locations.type,
        position: locations.position,
        entry_point: locations.entry_point,
      })
      .from(locations)
      .all();

    await caller.initialize(makeSetupConfig(seed) as any);
    const second = db
      .select({
        name: locations.name,
        type: locations.type,
        position: locations.position,
        entry_point: locations.entry_point,
      })
      .from(locations)
      .all();

    expect(second).toEqual(first);

    const ws = db.select({ setup_config: worldState.setup_config }).from(worldState).get();
    expect((ws?.setup_config as any)?.worldgen?.seed).toBe(seed);
  });
});

/**
 * The drama sliders used to be decorative — the wizard previewed a scenario it
 * fabricated client-side and `initialize` seeded none of it. This covers the DB
 * half of the fix; the generator's determinism is pinned in
 * `setupScenario.test.ts`.
 *
 * It lives in this file because `initialize` clears every table and vitest runs
 * test *files* in parallel, so a second file calling it would race this one.
 */
describe('scenario seeding', () => {
  afterAll(async () => {
    await stopTickLoopAndWait();
  });

  it('persists secrets, rivalries and canonical relationship rows', async () => {
    const { setupRouter } = await import('../routers/setup');
    const caller = setupRouter.createCaller({} as any);

    await caller.initialize({
      agents: MINIMAL_AGENTS,
      relationships: [],
      world: { season: 'spring', weather: 'sunny', startHour: 9, startDay: 1 },
      rules: { startingMoney: 50, tickSpeed: 1 },
      worldgen: { sizeTier: 'auto', overrides: {}, seed: 'scenario-db' },
      // trust 20 (→ 2) falls in the `trust <= 3` branch, so rivals are seeded.
      scenario: { drama: 80, romance: 70, crime: 80, trust: 20, seed: 'scenario-db' },
    } as any);

    const facts = db.select().from(shared_knowledge).all();
    expect(facts.length).toBeGreaterThan(0);

    // `created_at: 0` would make every seeded secret older than any staleness
    // window, so gossip.ts deactivated them all on its first sweep.
    for (const f of facts) {
      expect(f.created_at).toBeGreaterThan(0);
      expect(f.known_by.length).toBe(new Set(f.known_by).size);
    }

    const rels = db.select().from(relationships).all();
    expect(rels.length).toBeGreaterThan(0);
    // idx_relationships_pair is on (agent_a, agent_b) in that order, so a
    // reversed row duplicates a pair instead of colliding with it.
    for (const r of rels) {
      expect(r.agent_a).toBeLessThan(r.agent_b);
    }
    expect(rels.some(r => r.status === 'rival')).toBe(true);

    // Money came from `economyAdjustments`, not one flat `startingMoney`.
    const money = db.select({ money: economy.money }).from(economy).all().map(r => r.money);
    expect(money.length).toBe(MINIMAL_AGENTS.length);
    expect(new Set(money).size).toBeGreaterThan(1);
  });
});
