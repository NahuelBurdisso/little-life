import { describe, it, expect, afterAll } from 'vitest';
import { db } from '../db';
import { agents, relationships, shared_knowledge } from '../db/schema';
import { stopTickLoopAndWait } from '../engine/tick';

/**
 * The adults-only rule at seed time. The wizard lets the player type any romance
 * for any pair and give any agent an age from 16; the drama sliders draw romance
 * threads and secrets from the whole cast. None of it may leave a minor with a
 * crush, a partner, a romantic status or an affair.
 */

const SCHEDULE = { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: ['park'] };
const PERSONALITY = {
  honesty: 50, aggression: 20, warmth: 60, impulsiveness: 30, vanity: 25,
  curiosity: 55, loyalty: 65, morality: 70, sensuality: 85, neuroticism: 40,
};

function makeAgent(n: number, age: number, gender: string) {
  return {
    id: `agent-${n}`, name: `Seed Agent ${n}`, age, gender, bio: `Bio ${n}`, traits: ['friendly'],
    job: 'laborer', jobTitle: 'Laborer', salary: 20, homeName: `Home ${n}`, workplaceName: null,
    schedule: SCHEDULE, personality: PERSONALITY, backstoryMemories: [],
  };
}

// Agent 1 is 16, agent 2 is 30; 3..6 are adults.
const CAST = [
  makeAgent(1, 16, 'female'), makeAgent(2, 30, 'male'), makeAgent(3, 28, 'female'),
  makeAgent(4, 33, 'male'), makeAgent(5, 25, 'female'), makeAgent(6, 40, 'male'),
];

const ROMANTIC = ['crush', 'partner', 'romantic', 'engaged', 'married', 'kissed', 'lovers'];

function config(extra: object = {}) {
  return {
    agents: CAST,
    relationships: [
      {
        agentAName: 'Seed Agent 1', agentBName: 'Seed Agent 2',
        friendshipAB: 60, friendshipBA: 60, romanceAB: 80, romanceBA: 80,
        trustAB: 50, trustBA: 50, familiarity: 60, status: 'partners',
        tags: ['crush', 'partner', 'lovers', 'coworker'],
      },
      {
        agentAName: 'Seed Agent 3', agentBName: 'Seed Agent 4',
        friendshipAB: 60, friendshipBA: 60, romanceAB: 80, romanceBA: 80,
        trustAB: 50, trustBA: 50, familiarity: 60, status: 'partners', tags: ['partner'],
      },
    ],
    world: { season: 'spring' as const, weather: 'sunny' as const, startHour: 9, startDay: 1 },
    rules: { startingMoney: 50, tickSpeed: 1 },
    worldgen: { sizeTier: 'auto' as const, overrides: {}, seed: 'seed-adults' },
    ...extra,
  };
}

function relOf(nameA: string, nameB: string) {
  const ids = new Map(db.select({ id: agents.id, name: agents.name }).from(agents).all().map((a) => [a.name, a.id]));
  const x = ids.get(nameA)!;
  const y = ids.get(nameB)!;
  return db.select().from(relationships).all()
    .find((r) => r.agent_a === Math.min(x, y) && r.agent_b === Math.max(x, y));
}

describe('setup.initialize and the adults-only rule', () => {
  afterAll(async () => {
    await stopTickLoopAndWait();
  });

  it('a wizard romance of 80 between a 16-year-old and a 30-year-old is stored as no romance', async () => {
    const { setupRouter } = await import('../routers/setup');
    await setupRouter.createCaller({}).initialize(config());

    const rel = relOf('Seed Agent 1', 'Seed Agent 2')!;
    expect(rel.romance_ab).toBeLessThanOrEqual(0);
    expect(rel.romance_ba).toBeLessThanOrEqual(0);
    for (const tag of ROMANTIC) expect(rel.tags).not.toContain(tag);
    expect(['romantic_interest', 'partners', 'complicated']).not.toContain(rel.status);
    // The rest of what the player typed survives.
    expect(rel.tags).toContain('coworker');
    expect(rel.friendship_ab).toBe(60);
  });

  it('an adult pair keeps the romance the wizard gave it', async () => {
    const rel = relOf('Seed Agent 3', 'Seed Agent 4')!;
    expect(rel.romance_ab).toBe(80);
    expect(rel.romance_ba).toBe(80);
    expect(rel.status).toBe('partners');
  });

  it('the romance sliders never cast the minor in a thread or a romantic secret', async () => {
    const { setupRouter } = await import('../routers/setup');
    const caller = setupRouter.createCaller({});
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      await caller.initialize(config({
        relationships: [],
        scenario: { drama: 100, romance: 100, crime: 0, trust: 50, seed },
      }));

      const minor = db.select().from(agents).all().find((a) => a.age < 18)!;
      for (const r of db.select().from(relationships).all()) {
        if (r.agent_a !== minor.id && r.agent_b !== minor.id) continue;
        expect(r.romance_ab).toBeLessThanOrEqual(0);
        expect(r.romance_ba).toBeLessThanOrEqual(0);
        for (const tag of ROMANTIC) expect(r.tags).not.toContain(tag);
      }
      const romanticTypes = ['affair', 'crush', 'romantic', 'secret_fling', 'forbidden'];
      for (const k of db.select().from(shared_knowledge).all()) {
        if (!romanticTypes.includes(k.type)) continue;
        expect(k.subject_id).not.toBe(minor.id);
        expect(k.target_id).not.toBe(minor.id);
      }
    }
  });
});
