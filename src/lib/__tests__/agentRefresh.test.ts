import { describe, it, expect } from 'vitest';
import { createAgentRefresh, REFRESH_MS } from '../agentRefresh';

/**
 * A fake clock + timer queue, and a 4x session: `agents.all` flushes every
 * tick (250 ms), six mounted `useAgents` subscriptions each receive it, and a
 * relationship write lands every 20th tick (conversations + hourly decay).
 */
function simulate(seconds: number) {
  let t = 0;
  const timers: Array<{ at: number; cb: () => void; id: number }> = [];
  let nextId = 1;
  const timerApi = {
    set: (cb: () => void, ms: number) => { const id = nextId++; timers.push({ at: t + ms, cb, id }); return id; },
    clear: (h: unknown) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
  };
  const calls = { active: 0, details: 0, graph: 0, pair: 0 };
  const refresh = createAgentRefresh({
    active: () => calls.active++,
    details: () => calls.details++,
    graph: () => calls.graph++,
    pair: () => calls.pair++,
  }, () => t, timerApi);

  const TICK_MS = 250;
  const SUBSCRIBERS = 6;
  let flushes = 0;
  for (let tick = 0; tick < (seconds * 1000) / TICK_MS; tick++) {
    t = tick * TICK_MS;
    // Fire due timers first (trailing runs).
    for (const due of timers.filter((x) => x.at <= t)) { timerApi.clear(due.id); due.cb(); }
    for (let s = 0; s < SUBSCRIBERS; s++) refresh.onAgentsFlush(t);
    if (tick % 20 === 0) for (let s = 0; s < SUBSCRIBERS; s++) refresh.onRelationshipsFlush(t);
    flushes++;
  }
  return { calls, flushes };
}

describe('agentRefresh (playtest #3 client polling)', () => {
  it('cuts the per-flush refetches at 4x to the throttle rates', () => {
    const { calls, flushes } = simulate(60);
    // Before: getActive, getGraph and getAgentSummary each refetched once per
    // flush — 240 each in a real minute at 4x (the playtest's ~4.5/s).
    expect(flushes).toBe(240);
    expect(calls.active).toBeLessThanOrEqual(60_000 / REFRESH_MS.ACTIVE + 1); // ≤ 2/s
    expect(calls.details).toBeLessThanOrEqual(60_000 / REFRESH_MS.DETAIL + 1); // ≤ 0.5/s
    // The graph follows relationship writes only: 12 in the minute.
    expect(calls.graph).toBeLessThanOrEqual(12);
    expect(calls.pair).toBeLessThanOrEqual(12);
    // ...and nothing starves: every kind still refreshes.
    expect(calls.active).toBeGreaterThan(100);
    expect(calls.details).toBeGreaterThan(25);
    expect(calls.graph).toBeGreaterThan(5);
  });
});
