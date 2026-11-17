import { describe, it, expect } from 'vitest';
import { decideSide, isPeaceable, isTorn, type DeciderInput } from '../factions/decide';
import {
  FACTIONS, clearFactions, coolAllowance, feudSocialPenalty, maxActiveFeuds, noteCooled, noteSlight, startFeud,
  townSideMin, factionsSnapshotStore, activeFeuds, sideIn,
} from '../factions/store';

const base: DeciderInput = {
  towardA: { tie: 0.85, friendship: 70, trust: 40 },
  towardB: { tie: 0, friendship: -10, trust: 10 },
  warmth: 50, aggression: 50, loyalty: 70, morality: 50,
  knownCulprit: null,
};

describe('decideSide: where one person close to a falling-out stands', () => {
  it('a loyal best friend of one side backs them', () => {
    expect(decideSide(base, () => 0)).toEqual({ stance: 'a', torn: false });
  });

  it('the pull scales with the gap: a lukewarm acquaintance of both mostly stays out', () => {
    const lukewarm = { ...base, towardA: { tie: 0.4, friendship: 25, trust: 20 }, towardB: { tie: 0.4, friendship: 20, trust: 20 } };
    expect(decideSide(lukewarm, () => 0.01).stance).toBe('neutral');
  });

  it('a moral person who knows who was in the wrong holds it against them, even a close friend', () => {
    const knows = {
      ...base, morality: 95, knownCulprit: 'a' as const,
      towardA: { tie: 0.6, friendship: 45, trust: 30 }, towardB: { tie: 0.4, friendship: 30, trust: 30 },
    };
    expect(decideSide({ ...knows, knownCulprit: null }, () => 0).stance).toBe('a');
    expect(decideSide(knows, () => 0).stance).toBe('b');
  });

  it('close to both is torn; a peaceable one goes between them or keeps out of it', () => {
    const both = { ...base, warmth: 85, aggression: 20, towardB: { tie: 0.85, friendship: 70, trust: 40 } };
    expect(isTorn(both)).toBe(true);
    expect(isPeaceable(both)).toBe(true);
    expect(decideSide(both, () => 0)).toEqual({ stance: 'mediator', torn: true });
    expect(decideSide(both, () => 0.99)).toEqual({ stance: 'neutral', torn: true });
  });

  it('torn but not peaceable: picks only when one side clearly outweighs the other', () => {
    const torn = { ...base, aggression: 70, towardB: { tie: 0.6, friendship: 45, trust: 20 } };
    expect(decideSide(torn, () => 0)).toMatchObject({ torn: true });
    const even = { ...torn, towardA: { tie: 0.6, friendship: 45, trust: 20 } };
    expect(decideSide(even, () => 0).stance).toBe('neutral');
  });

  it('a peaceable person refuses to pick unless the gap is wide', () => {
    const mild = { ...base, warmth: 70, aggression: 20, towardA: { tie: 0.4, friendship: 25, trust: 20 }, towardB: { tie: 0, friendship: 5, trust: 0 } };
    expect(decideSide(mild, () => 0).stance).toBe('neutral');
  });
});

describe('the feud store: hard rules against a snowball', () => {
  it('caps feuds by population, cools a pair off after one, and counts slights', () => {
    clearFactions();
    expect(maxActiveFeuds(13)).toBe(2);
    expect(maxActiveFeuds(24)).toBe(4);
    expect(townSideMin(13)).toBe(2);
    expect(townSideMin(24)).toBe(3);
    const req = { cause: 'fight', causeText: 'a fight', culprit: null, culpritKnownBy: [], adultCause: false, nowMin: 0, population: 13 };
    expect(startFeud({ ...req, aId: 1, bId: 2 })).not.toBeNull();
    // The same pair again only freshens it.
    expect(startFeud({ ...req, aId: 2, bId: 1, nowMin: 50 })).toBeNull();
    expect(activeFeuds()[0].lastActivityMin).toBe(50);
    expect(startFeud({ ...req, aId: 3, bId: 4 })).not.toBeNull();
    expect(startFeud({ ...req, aId: 5, bId: 6 })).toBeNull();
    expect(noteSlight(7, 8, 0)).toBe(1);
    expect(noteSlight(8, 7, 100)).toBe(2);
    expect(noteSlight(8, 7, FACTIONS.SLIGHT_WINDOW_MIN + 50)).toBe(2);
  });

  it('no pair loses more than PAIR_COOL_CAP to side-taking, ever', () => {
    clearFactions();
    expect(coolAllowance(1, 2, 5)).toBe(5);
    noteCooled(1, 2, 5);
    noteCooled(1, 2, 5);
    expect(coolAllowance(1, 2, 5)).toBe(FACTIONS.PAIR_COOL_CAP - 10);
    noteCooled(1, 2, 2);
    expect(coolAllowance(1, 2, 5)).toBe(0);
  });

  it('opposite sides keep apart: harder in a town feud; the principals are left to their own feelings', () => {
    clearFactions();
    const f = startFeud({ aId: 1, bId: 2, cause: 'fight', causeText: 'a fight', culprit: null, culpritKnownBy: [], adultCause: false, nowMin: 0, population: 13 })!;
    f.stances.set(3, 'a');
    f.stances.set(4, 'b');
    f.stances.set(5, 'neutral');
    expect(sideIn(f, 1)).toBe('a');
    expect(feudSocialPenalty(1, 2)).toBe(0);
    expect(feudSocialPenalty(3, 2)).toBe(FACTIONS.SIDE_SOCIAL_PENALTY);
    expect(feudSocialPenalty(3, 4)).toBe(0);
    expect(feudSocialPenalty(5, 1)).toBe(0);
    f.townSinceMin = 10;
    expect(feudSocialPenalty(3, 4)).toBe(FACTIONS.TOWN_SOCIAL_PENALTY);
  });

  it('survives a checkpoint round trip', () => {
    clearFactions();
    const f = startFeud({ aId: 1, bId: 2, cause: 'loan_unpaid', causeText: 'a loan', culprit: 'b', culpritKnownBy: [1, 9], adultCause: false, nowMin: 5, population: 13 })!;
    f.stances.set(3, 'a');
    f.pending.set(4, 900);
    f.cooled.set(3, 5);
    f.log.push({ min: 5, text: 'x' });
    const data = JSON.parse(JSON.stringify(factionsSnapshotStore.serialize()));
    clearFactions();
    factionsSnapshotStore.restore(data);
    const back = activeFeuds()[0];
    expect(back).toMatchObject({ aId: 1, bId: 2, culprit: 'b', culpritKnownBy: [1, 9] });
    expect([...back.stances]).toEqual([[3, 'a']]);
    expect([...back.pending]).toEqual([[4, 900]]);
    expect(back.log).toEqual([{ min: 5, text: 'x' }]);
  });
});
