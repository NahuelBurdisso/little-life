import { describe, it, expect } from 'vitest';
import { motionAt, motionExtent, newMotionOut } from '../decorMotion';

describe('motionAt', () => {
  it('drifts a fall from rest to (dx,dy) over its period, then starts again', () => {
    const o = newMotionOut();
    const m = { kind: 'fall', dx: 10, dy: 60, period: 8 } as const;
    motionAt(m, 0, 0, 0, o);
    expect([o.dx, o.dy]).toEqual([0, 0]);
    motionAt(m, 4, 0, 0, o);
    expect(o.dx).toBeCloseTo(5);
    expect(o.dy).toBeCloseTo(30);
    motionAt(m, 8, 0, 0, o);
    expect(o.dy).toBeCloseTo(0);              // wrapped
    motionAt(m, 6, 0.25, 0, o);                // phase 0.25 = 2 s ahead: 8 s = one full lap
    expect(o.dy).toBeCloseTo(0);
  });

  it('fades a fall in and out at both ends and is opaque in the middle', () => {
    const o = newMotionOut();
    const m = { kind: 'fall', dx: 0, dy: 50, period: 10 } as const;
    motionAt(m, 0, 0, 0, o);
    expect(o.alpha).toBe(0);
    motionAt(m, 1, 0, 0, o);
    expect(o.alpha).toBeCloseTo(0.5);
    motionAt(m, 5, 0, 0, o);
    expect(o.alpha).toBe(1);
    motionAt(m, 9, 0, 0, o);
    expect(o.alpha).toBeCloseTo(0.5);
  });

  it('keeps a wander inside its radius and never stands still', () => {
    const o = newMotionOut();
    const m = { kind: 'wander', rx: 12, ry: 6, period: 5 } as const;
    let moved = false;
    let prev = -1;
    for (let t = 0; t < 30; t += 0.37) {
      motionAt(m, t, 0.3, 0, o);
      expect(Math.abs(o.dx)).toBeLessThanOrEqual(12 + 1e-9);
      expect(Math.abs(o.dy)).toBeLessThanOrEqual(6 + 1e-9);
      if (prev !== -1 && o.dx !== prev) moved = true;
      prev = o.dx;
      expect(o.alpha).toBe(1);
    }
    expect(moved).toBe(true);
  });

  it('brings an arrival to rest exactly at its spot, easing out, and reports when it stops', () => {
    const o = newMotionOut();
    const m = { kind: 'arrive', dx: 170, dy: -20, period: 6 } as const;
    motionAt(m, 999, 0, 0, o);
    expect([o.dx, o.dy]).toEqual([170, -20]);
    expect(o.moving).toBe(true);
    motionAt(m, 999, 0, 3, o);
    // Halfway in time is already most of the way there (ease-out): 1 - 0.5^3 = 87.5% covered.
    expect(o.dx).toBeCloseTo(170 * 0.125);
    expect(o.moving).toBe(true);
    motionAt(m, 999, 0, 6, o);
    expect(o.dx).toBe(0);
    expect(o.dy === 0).toBe(true);
    expect(o.moving).toBe(false);
    motionAt(m, 999, 0, 60, o);                // long after
    expect(o.dx).toBe(0);
    expect(o.moving).toBe(false);
    motionAt(m, 999, 0, -5, o);                // clock skew never runs it backwards
    expect(o.dx).toBe(170);
  });

  it('does not allocate: the same out object is returned filled in', () => {
    const o = newMotionOut();
    motionAt({ kind: 'fall', dx: 1, dy: 1, period: 1 }, 0.5, 0, 0, o);
    const dx = o.dx;
    motionAt({ kind: 'wander', rx: 3, ry: 3, period: 1 }, 0.3, 0, 0, o);
    expect(o.dx).not.toBe(dx);
  });
});

describe('motionExtent', () => {
  it('covers every position a motion can reach', () => {
    expect(motionExtent({ kind: 'fall', dx: -10, dy: 60, period: 5 })).toEqual({ x0: -10, x1: 0, y0: 0, y1: 60 });
    expect(motionExtent({ kind: 'wander', rx: 12, ry: 6, period: 5 })).toEqual({ x0: -12, x1: 12, y0: -6, y1: 6 });
    expect(motionExtent({ kind: 'arrive', dx: 170, dy: 0, period: 6 })).toEqual({ x0: 0, x1: 170, y0: 0, y1: 0 });
  });
});
