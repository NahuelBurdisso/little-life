import { describe, it, expect } from 'vitest';
import { generateFromSliders } from '../lib/setupGenerator';
import { forkRng } from '../lib/worldgen/rng';

/**
 * The drama sliders used to be decorative: the wizard previewed a scenario
 * built client-side from its own template list, and `initialize` seeded none of
 * it. These tests pin determinism from the scenario seed, which is what lets
 * the Preview step promise the town Start will actually build.
 *
 * The DB-level half lives in `setupInitialize.test.ts` — every test that calls
 * `initialize` wipes the shared `data/test.db`, and vitest runs test *files* in
 * parallel, so they all have to sit in one file to stay in one worker.
 */

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
    age: 28 + n,
    gender: 'neutral',
    bio: `Bio for agent ${n}`,
    traits: ['friendly'],
    job: 'laborer',
    jobTitle: 'Laborer',
    salary: 10 + n * 5,
    homeName: `Home ${n}`,
    workplaceName: null,
    schedule: MINIMAL_SCHEDULE,
    personality: MINIMAL_PERSONALITY,
    backstoryMemories: [],
  };
}

const MINIMAL_AGENTS = [1, 2, 3, 4, 5, 6].map(makeAgent);

/** Same 0-100 → 0-10 conversion `setup.buildScenario` applies. */
function run(seed: string) {
  const sliders = { drama: 80, romance: 70, crime: 80, trust: 20 };
  return generateFromSliders(
    {
      drama: sliders.drama / 10,
      romance: sliders.romance / 10,
      crime: sliders.crime / 10,
      trust: sliders.trust / 10,
    },
    MINIMAL_AGENTS.map(a => ({
      name: a.name,
      age: a.age,
      personality: a.personality as unknown as Record<string, number>,
      salary: a.salary,
      job: a.job,
    })),
    forkRng(seed, 'scenario').next,
  );
}

describe('scenario generator determinism', () => {
  it('same seed → identical scenario', () => {
    expect(run('seed-alpha')).toEqual(run('seed-alpha'));
  });

  it('different seed → different scenario', () => {
    // High sliders guarantee non-empty output, so a mismatch here is a real
    // divergence rather than two empty results comparing equal.
    const a = run('seed-alpha');
    const b = run('seed-beta');
    expect(a.secrets.length).toBeGreaterThan(0);
    expect(a).not.toEqual(b);
  });

  it('high crime widens the money spread, low crime flattens it', () => {
    const agentInput = MINIMAL_AGENTS.map(a => ({
      name: a.name,
      age: a.age,
      personality: a.personality as unknown as Record<string, number>,
      salary: a.salary,
    }));
    const rand = () => 0.5; // remove jitter so only the crime branch differs
    const spread = (crime: number) => {
      const money = Object.values(
        generateFromSliders({ drama: 5, romance: 5, crime, trust: 5 }, agentInput, rand)
          .economyAdjustments,
      );
      return Math.max(...money) - Math.min(...money);
    };
    expect(spread(9)).toBeGreaterThan(spread(1));
  });
});
