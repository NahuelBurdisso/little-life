import { describe, it, expect } from 'vitest';
import {
  ageGapFactor,
  chemistry,
  mayRomanceGrow,
  romanceGainMultiplier,
  type RomanceParty,
} from '../attraction';
import { computeRelationshipDeltas, type ConversationImpactContext } from '../../relationshipImpact';
import type { PersonalityProfile } from '../../personality';

const P = (sensuality: number): PersonalityProfile => ({
  honesty: 50, aggression: 30, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 60, morality: 50, sensuality, neuroticism: 40,
});

const person = (over: Partial<RomanceParty> & { id: number }): RomanceParty => ({
  age: 30,
  gender: 'male',
  orientation: 'straight',
  ...over,
});

/** A warm flirting chat, both sides sensual enough to gain romance. */
function flirtCtx(partyA: RomanceParty, partyB: RomanceParty, worldSeed: string | number = 7): ConversationImpactContext {
  return {
    overallSentiment: 0.7, turnCount: 6, topic: 'flirting',
    personalityA: P(70), personalityB: P(70), compatibility: 1,
    existingFriendshipAB: 20, existingFriendshipBA: 20,
    existingRomanceAB: 0, existingRomanceBA: 0, isTemplate: false,
    partyA, partyB, worldSeed,
  };
}

describe('chemistry', () => {
  it('is deterministic and symmetric for a pair', () => {
    expect(chemistry(3, 9, 42)).toBe(chemistry(3, 9, 42));
    expect(chemistry(3, 9, 42)).toBe(chemistry(9, 3, 42));
  });

  it('stays inside 0.6..1.4 and actually varies between pairs and worlds', () => {
    const seen = new Set<number>();
    for (let a = 1; a < 30; a++) {
      for (let b = a + 1; b < 30; b++) {
        const c = chemistry(a, b, 'seed');
        expect(c).toBeGreaterThanOrEqual(0.6);
        expect(c).toBeLessThanOrEqual(1.4);
        seen.add(Math.round(c * 100));
      }
    }
    expect(seen.size).toBeGreaterThan(20);
    expect(chemistry(1, 2, 'one')).not.toBe(chemistry(1, 2, 'two'));
  });
});

describe('ageGapFactor', () => {
  it('is 1 up to a ten-year gap', () => {
    expect(ageGapFactor(30, 30)).toBe(1);
    expect(ageGapFactor(30, 40)).toBe(1);
    expect(ageGapFactor(40, 30)).toBe(1);
  });

  it('falls linearly to 0.5 at thirty years and stays there', () => {
    expect(ageGapFactor(20, 40)).toBeCloseTo(0.75, 10);
    expect(ageGapFactor(20, 50)).toBe(0.5);
    expect(ageGapFactor(18, 80)).toBe(0.5);
  });
});

describe('mayRomanceGrow / romanceGainMultiplier', () => {
  const man = person({ id: 1, gender: 'male' });
  const woman = person({ id: 2, gender: 'female' });

  it('is 0 for a minor on either side, whatever the orientation', () => {
    for (const age of [0, 12, 17]) {
      const kid = person({ id: 3, age, gender: 'female', orientation: 'bi' });
      const grownBi = person({ id: 4, gender: 'male', orientation: 'bi' });
      expect(romanceGainMultiplier(kid, grownBi, 1)).toBe(0);
      expect(romanceGainMultiplier(grownBi, kid, 1)).toBe(0);
      expect(mayRomanceGrow(kid, grownBi)).toBe(false);
      expect(mayRomanceGrow(grownBi, kid)).toBe(false);
    }
  });

  it('fails closed on a missing age', () => {
    const unknown = { ...woman, age: undefined } as unknown as RomanceParty;
    expect(romanceGainMultiplier(man, unknown, 1)).toBe(0);
    expect(romanceGainMultiplier(unknown, man, 1)).toBe(0);
  });

  it('is 0 in the direction a person is not drawn, and positive in the other', () => {
    const gayMan = person({ id: 5, gender: 'male', orientation: 'gay' });
    expect(romanceGainMultiplier(man, gayMan, 1)).toBe(0);      // straight man -> gay man
    expect(romanceGainMultiplier(gayMan, man, 1)).toBeGreaterThan(0); // unrequited is allowed
    expect(romanceGainMultiplier(man, woman, 1)).toBeGreaterThan(0);
  });

  it('is chemistry times the age-gap factor for an eligible direction', () => {
    const older = person({ id: 2, gender: 'female', age: 60 });
    const younger = person({ id: 1, gender: 'male', age: 30 });
    expect(romanceGainMultiplier(younger, older, 9)).toBeCloseTo(chemistry(1, 2, 9) * 0.5, 10);
  });
});

describe('computeRelationshipDeltas with party context', () => {
  it('two straight men flirting: no romance either way, friendship and trust unchanged', () => {
    const a = person({ id: 1, gender: 'male' });
    const b = person({ id: 2, gender: 'male' });
    const withParties = computeRelationshipDeltas(flirtCtx(a, b));
    const { partyA: _a, partyB: _b, worldSeed: _s, ...bare } = flirtCtx(a, b);
    const without = computeRelationshipDeltas(bare);
    expect(without.romanceAB).toBeGreaterThan(0); // the chat itself was romantic
    expect(withParties.romanceAB).toBe(0);
    expect(withParties.romanceBA).toBe(0);
    expect(withParties.friendshipAB).toBe(without.friendshipAB);
    expect(withParties.friendshipBA).toBe(without.friendshipBA);
    expect(withParties.trustAB).toBe(without.trustAB);
    expect(withParties.trustBA).toBe(without.trustBA);
  });

  it('a minor on either side: no romance either way', () => {
    const kid = person({ id: 1, age: 16, gender: 'female', orientation: 'bi' });
    const adult = person({ id: 2, age: 30, gender: 'male', orientation: 'bi' });
    for (const [x, y] of [[kid, adult], [adult, kid]] as const) {
      const d = computeRelationshipDeltas(flirtCtx(x, y));
      expect(d.romanceAB).toBe(0);
      expect(d.romanceBA).toBe(0);
      expect(d.friendshipAB).toBeGreaterThan(0);
    }
  });

  it('an eligible pair gains, and a high-chemistry pair gains more than a low one', () => {
    // Find a high and a low chemistry pair under one world seed.
    let hi: [number, number] | null = null;
    let lo: [number, number] | null = null;
    for (let b = 2; b < 200 && !(hi && lo); b++) {
      const c = chemistry(1, b, 7);
      if (!hi && c > 1.3) hi = [1, b];
      if (!lo && c < 0.7) lo = [1, b];
    }
    expect(hi && lo).toBeTruthy();
    const gain = ([a, b]: [number, number]) => computeRelationshipDeltas(flirtCtx(
      person({ id: a, gender: 'male' }), person({ id: b, gender: 'female' }),
    ));
    const high = gain(hi!);
    const low = gain(lo!);
    expect(low.romanceAB).toBeGreaterThan(0);
    expect(high.romanceAB).toBeGreaterThan(low.romanceAB);
    expect(high.romanceBA).toBeGreaterThan(low.romanceBA);
  });

  it('does not touch negative romance (a bad chat still cools a crush)', () => {
    const d = computeRelationshipDeltas({
      ...flirtCtx(person({ id: 1, gender: 'male' }), person({ id: 2, gender: 'male' })),
      overallSentiment: -0.6, topic: 'argument',
    });
    expect(d.romanceAB).toBeLessThan(0);
    expect(d.romanceBA).toBeLessThan(0);
  });

  it('applies per direction: a one-sided pull gains on one side only', () => {
    const straightMan = person({ id: 1, gender: 'male' });
    const gayMan = person({ id: 2, gender: 'male', orientation: 'gay' });
    const d = computeRelationshipDeltas(flirtCtx(straightMan, gayMan));
    expect(d.romanceAB).toBe(0);
    expect(d.romanceBA).toBeGreaterThan(0);
  });
});
