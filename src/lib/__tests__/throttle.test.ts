import { describe, it, expect } from 'vitest';
import { throttle } from '../throttle';

/** A manual clock and timer queue, so the window arithmetic is what's under test. */
function harness() {
  let t = 1000;
  const queue: Array<{ id: number; at: number; cb: () => void }> = [];
  let nextId = 1;
  const timers = {
    set: (cb: () => void, ms: number) => { const id = nextId++; queue.push({ id, at: t + ms, cb }); return id; },
    clear: (h: unknown) => { const i = queue.findIndex((q) => q.id === h); if (i >= 0) queue.splice(i, 1); },
  };
  return {
    now: () => t,
    timers,
    advance(ms: number) {
      t += ms;
      for (const due of queue.filter((q) => q.at <= t).sort((a, b) => a.at - b.at)) {
        queue.splice(queue.indexOf(due), 1);
        due.cb();
      }
    },
    pending: () => queue.length,
  };
}

describe('throttle (leading + trailing)', () => {
  it('runs the first call at once and collapses a burst into one trailing run', () => {
    const h = harness();
    let runs = 0;
    const f = throttle(() => { runs++; }, 3000, h.now, h.timers);

    f();
    expect(runs).toBe(1);
    f(); f(); f();
    expect(runs).toBe(1);
    expect(h.pending()).toBe(1);

    h.advance(2999);
    expect(runs).toBe(1);
    h.advance(1);
    expect(runs).toBe(2);
    expect(h.pending()).toBe(0);
  });

  it('runs a call after a quiet window immediately', () => {
    const h = harness();
    let runs = 0;
    const f = throttle(() => { runs++; }, 3000, h.now, h.timers);
    f();
    h.advance(3000);
    f();
    expect(runs).toBe(2);
  });

  it('spaces sustained calls at least `ms` apart', () => {
    const h = harness();
    const stamps: number[] = [];
    const f = throttle(() => { stamps.push(h.now()); }, 3000, h.now, h.timers);
    for (let i = 0; i < 20; i++) { f(); h.advance(500); }
    h.advance(3000);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(3000);
    expect(stamps.length).toBe(5); // 13 s of calls, one run per 3 s window
  });

  it('cancel drops the pending trailing run', () => {
    const h = harness();
    let runs = 0;
    const f = throttle(() => { runs++; }, 3000, h.now, h.timers);
    f(); f();
    f.cancel();
    h.advance(5000);
    expect(runs).toBe(1);
  });
});
