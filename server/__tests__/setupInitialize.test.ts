import { describe, it, expect } from 'vitest';
import { db } from '../db';
import { locations, worldState } from '../db/schema';
import { generateWorld } from '../lib/worldgen';

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
 * router's mutation handler to avoid spinning up a full tRPC context. Since
 * initialize only calls clearAllTables() + seedWorld() (no side-effects beyond
 * SQLite writes for this path), this is safe.
 */
describe('initialize DB determinism', () => {
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
