import { describe, it, expect } from 'vitest';
import { applyDiminishing, deriveStatus } from '../relationships';
import { computeRelationshipDeltas } from '../../../lib/relationshipImpact';
import type { PersonalityProfile } from '../../../lib/personality';

/**
 * How many game days of conversations a pair needs to become `partners`,
 * through the real delta engine (computeRelationshipDeltas), the real
 * diminishing returns and the real status rule. Deterministic RNG, 200 runs.
 *
 * Playtest #3: nobody reached partners in five days (Lucia/Diego 60/72), so
 * proposals and weddings never triggered. Target: a devoted couple within
 * ~3-6 game days; warm friends and one-sided crushes never.
 */
const P = (sensuality: number): PersonalityProfile => ({
  honesty: 50, aggression: 30, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 60, morality: 50, sensuality, neuroticism: 40,
});

function rng(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}

interface Scenario { sensA: number; sensB: number; talksPerDay: number; romanticShare: number; sentiment: [number, number] }

/** Days to partners for each of 200 seeded runs (16 = not within 15 days). */
function daysToPartners(s: Scenario): number[] {
  const out: number[] = [];
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    let rAB = 10, rBA = 10, fAB = 30, fBA = 30;
    let day = 1;
    for (; day <= 15; day++) {
      for (let c = 0; c < s.talksPerDay; c++) {
        const sent = s.sentiment[0] + r() * (s.sentiment[1] - s.sentiment[0]);
        const d = computeRelationshipDeltas({
          overallSentiment: sent, turnCount: 6,
          topic: r() < s.romanticShare ? 'flirting' : 'catching up',
          personalityA: P(s.sensA), personalityB: P(s.sensB), compatibility: 1,
          existingFriendshipAB: fAB, existingFriendshipBA: fBA,
          existingRomanceAB: rAB, existingRomanceBA: rBA, isTemplate: false,
        });
        rAB = Math.min(100, rAB + applyDiminishing(rAB, d.romanceAB));
        rBA = Math.min(100, rBA + applyDiminishing(rBA, d.romanceBA));
        fAB = Math.min(100, fAB + applyDiminishing(fAB, d.friendshipAB));
        fBA = Math.min(100, fBA + applyDiminishing(fBA, d.friendshipBA));
      }
      if (deriveStatus(fAB, fBA, rAB, rBA, 50, 50) === 'partners') break;
    }
    out.push(day);
  }
  return out.sort((a, b) => a - b);
}
const median = (xs: number[]) => xs[Math.floor(xs.length / 2)];

describe('romance growth vs the partners threshold (playtest #3)', () => {
  it('a devoted couple becomes partners within ~3-6 game days', () => {
    // Uneven sensualities, two or three warm talks a day, a third of them romantic.
    const two = daysToPartners({ sensA: 70, sensB: 45, talksPerDay: 2, romanticShare: 0.35, sentiment: [0.3, 0.8] });
    const three = daysToPartners({ sensA: 70, sensB: 45, talksPerDay: 3, romanticShare: 0.4, sentiment: [0.3, 0.8] });
    expect(median(two)).toBeLessThanOrEqual(6);
    expect(median(three)).toBeGreaterThanOrEqual(3);
    expect(median(three)).toBeLessThanOrEqual(5);
  });

  it('not everyone: warm friends and one-sided crushes never get there', () => {
    const friends = daysToPartners({ sensA: 60, sensB: 50, talksPerDay: 1, romanticShare: 0.05, sentiment: [0.1, 0.6] });
    const oneSided = daysToPartners({ sensA: 70, sensB: 25, talksPerDay: 3, romanticShare: 0.4, sentiment: [0.3, 0.8] });
    expect(friends.every((d) => d > 15)).toBe(true);
    expect(oneSided.every((d) => d > 15)).toBe(true);
  });

  it('a casual flirtation takes more than a week', () => {
    const casual = daysToPartners({ sensA: 70, sensB: 45, talksPerDay: 2, romanticShare: 0.2, sentiment: [0.2, 0.7] });
    expect(median(casual)).toBeGreaterThan(7);
  });

  it('reciprocity only lifts a side that is already warming, never from nothing', () => {
    const base = {
      overallSentiment: 0.6, turnCount: 6, topic: 'catching up', compatibility: 1,
      existingFriendshipAB: 40, existingFriendshipBA: 40, isTemplate: false,
    };
    const lagging = computeRelationshipDeltas({ ...base, personalityA: P(45), personalityB: P(70), existingRomanceAB: 40, existingRomanceBA: 75 });
    const even = computeRelationshipDeltas({ ...base, personalityA: P(45), personalityB: P(70), existingRomanceAB: 40, existingRomanceBA: 40 });
    expect(lagging.romanceAB).toBeGreaterThan(even.romanceAB);
    // No sensuality (<= 30): still nothing, however loved.
    const cold = computeRelationshipDeltas({ ...base, personalityA: P(20), personalityB: P(70), existingRomanceAB: 0, existingRomanceBA: 90 });
    expect(cold.romanceAB).toBe(0);
  });
});
