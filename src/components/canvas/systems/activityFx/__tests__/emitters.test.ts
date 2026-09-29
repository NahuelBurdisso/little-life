import { describe, it, expect } from 'vitest';
import { agentPhase, crossedUp, inWindow, shotIndex, shotsBetween } from '../emitters';

describe('shotsBetween', () => {
  it('counts the shots of an every/offset schedule inside (from, to]', () => {
    // shots at 0.5, 2.5, 4.5...
    expect(shotsBetween(2, 0.5, 0, 0.4)).toBe(0);
    expect(shotsBetween(2, 0.5, 0, 0.5)).toBe(1);
    expect(shotsBetween(2, 0.5, 0.5, 2.4)).toBe(0);
    expect(shotsBetween(2, 0.5, 0.5, 2.5)).toBe(1);
    expect(shotsBetween(2, 0.5, 0, 10)).toBe(5);
  });

  it('adds up across frame boundaries: no shot is lost or doubled', () => {
    let total = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 30; i++) total += shotsBetween(1.7, 0.3, 1000 + i * dt, 1000 + (i + 1) * dt);
    expect(total).toBeGreaterThanOrEqual(17);
    expect(total).toBeLessThanOrEqual(18);
  });

  it('never fires for a stalled or backwards clock, or a bad period', () => {
    expect(shotsBetween(1, 0, 5, 5)).toBe(0);
    expect(shotsBetween(1, 0, 6, 5)).toBe(0);
    expect(shotsBetween(0, 0, 0, 10)).toBe(0);
    expect(shotsBetween(-1, 0, 0, 10)).toBe(0);
    expect(shotsBetween(1, 0, 0, NaN)).toBe(0);
  });
});

describe('shotIndex', () => {
  it('names the shot that fired last, so cycles rotate through their entries', () => {
    expect(shotIndex(9, 3, 3)).toBe(0);
    expect(shotIndex(9, 3, 11.9)).toBe(0);
    expect(shotIndex(9, 3, 12)).toBe(1);
    expect(shotIndex(9, 3, 21)).toBe(2);
  });
});

describe('inWindow', () => {
  const w = { period: 9, from: 0.12, to: 0.85 };
  it('is open only for the given slice of each period', () => {
    expect(inWindow(w, 0)).toBe(false);
    expect(inWindow(w, 0.12)).toBe(true);
    expect(inWindow(w, 0.84)).toBe(true);
    expect(inWindow(w, 0.85)).toBe(false);
    expect(inWindow(w, 9.5)).toBe(true);
    expect(inWindow(w, 8.9)).toBe(false);
  });
  it('handles negative clocks and no window', () => {
    expect(inWindow(w, -8.5)).toBe(true);
    expect(inWindow(undefined, 123)).toBe(true);
  });
});

describe('crossedUp', () => {
  it('fires once when the stroke rises through the line', () => {
    expect(crossedUp(0.5, 0.9, 0.85)).toBe(true);
    expect(crossedUp(0.9, 0.95, 0.85)).toBe(false);
    expect(crossedUp(0.95, 0.5, 0.85)).toBe(false);
    expect(crossedUp(0, 0, 0.85)).toBe(false);
  });
});

describe('agentPhase', () => {
  it('desynchronises neighbours and stays in 0..10', () => {
    const seen = new Set<number>();
    for (let id = 1; id <= 13; id++) {
      const p = agentPhase(id);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(10);
      seen.add(Math.round(p * 1000));
    }
    expect(seen.size).toBe(13);
  });
  it('accepts string ids and survives junk', () => {
    expect(agentPhase('4')).toBe(agentPhase(4));
    expect(agentPhase('abc')).toBe(0);
  });
});
