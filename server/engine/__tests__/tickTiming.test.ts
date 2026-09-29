import { describe, it, expect, afterAll, vi } from 'vitest';

/**
 * `setTickTimingObserver` is what `scripts/soak.ts` reads its per-phase p50/p95 from. The
 * contract worth pinning: every completed tick reports the eleven phases in order and a
 * whole-tick time that covers them, and clearing the observer stops the reports.
 *
 * Like the other tests that call `setupRouter.initialize`, this one has to stop the tick
 * loop that `initialize` restarts, and the LLM is unreachable (the world is fresh, so the
 * first tick makes no calls anyway, but a stray one must fail fast, not hang).
 */
vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed (test: LLM disabled)'); });

import { gameTick, setTickTimingObserver, stopTickLoopAndWait, type TickTiming } from '../tick';

const agent = (n: number) => ({
  id: `a${n}`, name: `Timing Agent ${n}`, age: 30, gender: 'neutral', bio: 'bio', traits: ['friendly'],
  job: 'laborer', jobTitle: 'Laborer', salary: 20, homeName: `Home ${n}`, workplaceName: null,
  schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: ['park'] },
  personality: {
    honesty: 50, aggression: 20, warmth: 60, impulsiveness: 30, vanity: 25,
    curiosity: 55, loyalty: 65, morality: 70, sensuality: 35, neuroticism: 40,
  },
  backstoryMemories: [],
});

describe('setTickTimingObserver', () => {
  afterAll(async () => {
    setTickTimingObserver(null);
    await stopTickLoopAndWait();
  });

  it('reports each completed tick with its phases in order, then stops when cleared', async () => {
    const { setupRouter } = await import('../../routers/setup');
    await setupRouter.createCaller({} as any).initialize({
      agents: [agent(1), agent(2), agent(3)],
      relationships: [],
      world: { season: 'spring', weather: 'sunny', startHour: 9, startDay: 1 },
      rules: { startingMoney: 50, tickSpeed: 1 },
      worldgen: { sizeTier: 'auto', overrides: {}, seed: 'tick-timing' },
    } as any);
    await stopTickLoopAndWait();

    const seen: TickTiming[] = [];
    setTickTimingObserver((t) => seen.push(t));
    await gameTick();

    expect(seen).toHaveLength(1);
    expect(seen[0].phaseMs.map(([name]) => name)).toEqual([
      'needs', 'states', 'economy', 'relationships', 'conversations',
      'goals', 'decisions', 'movement', 'events', 'gossip', 'cascade',
    ]);
    const phaseSum = seen[0].phaseMs.reduce((s, [, ms]) => s + ms, 0);
    expect(seen[0].totalMs).toBeGreaterThanOrEqual(phaseSum);

    setTickTimingObserver(null);
    await gameTick();
    expect(seen).toHaveLength(1);
  });
});
