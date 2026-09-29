import { describe, it, expect } from 'vitest';
import {
  PIN_MAX_S, PIN_MIN_S, TALK_MAX_S, TALK_MIN_S,
  arcBow, arcPoint, burstScale, coinCount, dotCount, dropBounce, fadeOut, flashAlpha, hopHeight,
  isTalking, perimeterPoint, pinDone, pulse, secretTravelSeconds, talkArcDone,
} from '../fxMath';

describe('talkArcDone', () => {
  it('stays up while the pair is apart and silent', () => {
    expect(talkArcDone({ elapsed: 10, dist: 300, talking: false })).toBe(false);
    expect(talkArcDone({ elapsed: TALK_MAX_S - 1, dist: 300, talking: false })).toBe(false);
  });
  it('ends when they are within ~2 tiles or talking, but not before the minimum', () => {
    expect(talkArcDone({ elapsed: TALK_MIN_S - 0.1, dist: 10, talking: true })).toBe(false);
    expect(talkArcDone({ elapsed: TALK_MIN_S, dist: 60, talking: false })).toBe(true);
    expect(talkArcDone({ elapsed: 5, dist: 200, talking: true })).toBe(true);
    expect(talkArcDone({ elapsed: 5, dist: 65, talking: false })).toBe(false);
  });
  it('gives up after the cap', () => {
    expect(talkArcDone({ elapsed: TALK_MAX_S, dist: 999, talking: false })).toBe(true);
  });
});

describe('pinDone', () => {
  it('waits for arrival, by location or by distance', () => {
    expect(pinDone({ elapsed: 10, atLocation: false, dist: 400 })).toBe(false);
    expect(pinDone({ elapsed: 10, atLocation: true, dist: 400 })).toBe(true);
    expect(pinDone({ elapsed: 10, atLocation: false, dist: 30 })).toBe(true);
  });
  it('shows for a minimum moment and gives up at the cap', () => {
    expect(pinDone({ elapsed: PIN_MIN_S - 0.1, atLocation: true, dist: 0 })).toBe(false);
    expect(pinDone({ elapsed: PIN_MAX_S, atLocation: false, dist: 999 })).toBe(true);
  });
});

describe('isTalking', () => {
  const convos = [
    { status: 'ended', participants: [1, 2] },
    { status: 'active', participants: [3, '4'] },
  ];
  it('needs an ACTIVE conversation holding both, ids number or string', () => {
    expect(isTalking(convos, 1, 2)).toBe(false);
    expect(isTalking(convos, 3, 4)).toBe(true);
    expect(isTalking(convos, 3, 9)).toBe(false);
    expect(isTalking(undefined, 1, 2)).toBe(false);
    expect(isTalking([{ status: 'active' }], 1, 2)).toBe(false);
  });
});

describe('arcPoint', () => {
  const out = { x: 0, y: 0 };
  it('starts at A, ends at B and rises by `bow` in the middle', () => {
    arcPoint(0, 100, 100, 100, 20, 0, out);
    expect(out).toEqual({ x: 0, y: 100 });
    arcPoint(0, 100, 100, 100, 20, 1, out);
    expect(out.x).toBeCloseTo(100); expect(out.y).toBeCloseTo(100);
    arcPoint(0, 100, 100, 100, 20, 0.5, out);
    expect(out.x).toBeCloseTo(50);
    expect(out.y).toBeCloseTo(80);
  });
  it('bow and dot count are clamped', () => {
    expect(arcBow(1)).toBe(8);
    expect(arcBow(1000)).toBe(28);
    expect(dotCount(10)).toBe(6);
    expect(dotCount(1000)).toBe(18);
    expect(dotCount(1000, 20)).toBe(20);
  });
  it('pulse stays in (0.35..1] and moves', () => {
    const seen = new Set<number>();
    for (let t = 0; t < 2; t += 0.1) {
      const p = pulse(0.3, t);
      expect(p).toBeGreaterThanOrEqual(0.35);
      expect(p).toBeLessThanOrEqual(1);
      seen.add(Math.round(p * 100));
    }
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe('motions', () => {
  it('fadeOut holds 1 then falls to 0', () => {
    expect(fadeOut(0, 2, 0.5)).toBe(1);
    expect(fadeOut(1.75, 2, 0.5)).toBeCloseTo(0.5);
    expect(fadeOut(2, 2, 0.5)).toBe(0);
    expect(fadeOut(3, 2, 0.5)).toBe(0);
  });
  it('dropBounce falls from the height, bounces smaller, rests at 0', () => {
    expect(dropBounce(0, 40)).toBe(40);
    expect(dropBounce(0.16, 40)).toBeLessThan(40);
    expect(dropBounce(0.32, 40)).toBeCloseTo(0);
    const b1 = dropBounce(0.32 + 0.11, 40);
    const b2 = dropBounce(0.32 + 0.22 + 0.065, 40);
    expect(b1).toBeGreaterThan(b2);
    expect(b2).toBeGreaterThan(0);
    expect(dropBounce(2, 40)).toBe(0);
  });
  it('hopHeight peaks mid-hop and is flat before and after the hops', () => {
    expect(hopHeight(-1, 0.4, 3, 6)).toBe(0);
    expect(hopHeight(0.2, 0.4, 3, 6)).toBeCloseTo(6);
    expect(hopHeight(0.4, 0.4, 3, 6)).toBeCloseTo(0, 5);
    expect(hopHeight(1.3, 0.4, 3, 6)).toBe(0);
  });
  it('coinCount grows with the amount, within 2..8', () => {
    expect(coinCount(1)).toBe(2);
    expect(coinCount(10)).toBe(4);
    expect(coinCount(100)).toBe(6);
    expect(coinCount(1e9)).toBe(8);
    expect(coinCount(NaN)).toBe(2);
  });
  it('a whisper takes longer over distance, within limits', () => {
    expect(secretTravelSeconds(10)).toBe(0.9);
    expect(secretTravelSeconds(225)).toBeCloseTo(1.5);
    expect(secretTravelSeconds(5000)).toBe(2);
  });
  it('flashAlpha swells fast and decays to nothing', () => {
    expect(flashAlpha(0, 0.2, 0.5)).toBe(0);
    expect(flashAlpha(0.08, 0.2, 0.5)).toBeCloseTo(0.2);
    expect(flashAlpha(0.3, 0.2, 0.5)).toBeLessThan(0.2);
    expect(flashAlpha(0.5, 0.2, 0.5)).toBe(0);
  });
});

describe('event burst geometry', () => {
  it('scales the 32px cell to the building, integer, 2..6', () => {
    expect(burstScale(32, 32)).toBe(2);
    expect(burstScale(96, 64)).toBe(3);
    expect(burstScale(400, 400)).toBe(6);
  });
  it('perimeterPoint walks the rectangle clockwise and wraps', () => {
    const o = { x: 0, y: 0 };
    perimeterPoint(10, 20, 100, 50, 0, o);
    expect(o).toEqual({ x: 10, y: 20 });
    perimeterPoint(10, 20, 100, 50, 100 / 300, o);
    expect(o.x).toBeCloseTo(110); expect(o.y).toBeCloseTo(20);
    perimeterPoint(10, 20, 100, 50, 0.5, o);          // 150 of 300: bottom edge, 100 along the top + 50 down
    expect(o.x).toBeCloseTo(110); expect(o.y).toBeCloseTo(70);
    perimeterPoint(10, 20, 100, 50, 1.25, o);         // wraps to 0.25
    perimeterPoint(10, 20, 100, 50, 0.25, o);
    expect(o.y).toBeCloseTo(20 + 0);                   // 75 along the top edge
    expect(o.x).toBeCloseTo(85);
  });
});
