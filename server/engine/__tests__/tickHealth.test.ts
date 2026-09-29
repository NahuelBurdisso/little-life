import { describe, it, expect } from 'vitest';
import { LAG_MIN_SLOW_TICKS, TickHealth } from '../tickHealth';

describe('TickHealth', () => {
  it('ignores ticks inside the budget', () => {
    const h = new TickHealth(() => 0);
    expect(h.noteTick(900, 1000)).toBe(false);
    expect(h.snapshot()).toEqual({ lastTickOverrunMs: 0, slowTicksLastMinute: 0, lagging: false });
  });

  it('counts overruns and reports the newest', () => {
    let t = 0;
    const h = new TickHealth(() => t);
    expect(h.noteTick(1500, 1000)).toBe(true);
    t += 1000;
    h.noteTick(2400.4, 1000);
    expect(h.snapshot()).toMatchObject({ lastTickOverrunMs: 2400, slowTicksLastMinute: 2, lagging: false });
  });

  it('is lagging only after a run of overruns, not a lone slow tick (day changes are slow)', () => {
    let t = 0;
    const h = new TickHealth(() => t);
    for (let i = 0; i < LAG_MIN_SLOW_TICKS; i++) { h.noteTick(1200, 1000); t += 1000; }
    expect(h.snapshot().lagging).toBe(true);
  });

  it('forgets overruns after a minute', () => {
    let t = 0;
    const h = new TickHealth(() => t);
    for (let i = 0; i < LAG_MIN_SLOW_TICKS; i++) h.noteTick(1200, 1000);
    t += 61_000;
    expect(h.snapshot()).toEqual({ lastTickOverrunMs: 0, slowTicksLastMinute: 0, lagging: false });
  });
});
