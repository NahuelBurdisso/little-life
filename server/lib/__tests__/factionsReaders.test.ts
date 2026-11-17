import { describe, it, expect } from 'vitest';
import { FEUD_CAMP_BONUS, FEUD_CAMP_PENALTY, campLean, tallyElection, type ElectionInput } from '../election';
import { buildArcs } from '../chronicle';
import { feudItem } from '../brewing';

describe('a town feud, as the rest of the town reads it', () => {
  it('the election: a voter leans to a candidate of their own camp and away from the other', () => {
    const camps = [{ a: [1, 3], b: [2, 4] }];
    expect(campLean(3, 1, camps)).toBe(FEUD_CAMP_BONUS);
    expect(campLean(4, 1, camps)).toBe(-FEUD_CAMP_PENALTY);
    expect(campLean(9, 1, camps)).toBe(0);
    expect(campLean(3, 9, undefined)).toBe(0);
    // Two candidates otherwise alike: each camp votes its own.
    const input: ElectionInput = {
      candidates: [1, 2].map((id) => ({ id, personality: null, reputation: 0, incumbent: false })),
      voters: [1, 2, 3, 4, 5, 6].map((id) => ({ id, personality: null })),
      ties: new Map(), secrets: [], support: {},
      camps: [{ a: [1, 3, 5], b: [2, 4] }],
    };
    const t = tallyElection(input, () => 0.5)!;
    expect(t.ballots.get(3)).toBe(1);
    expect(t.ballots.get(4)).toBe(2);
    expect(t.ballots.get(5)).toBe(1);
  });

  it('the chronicle: a feud arc naming both sides, keyed on the two who fell out', () => {
    const agents = [1, 2, 3, 4, 5].map((id) => ({ id, name: ['Ana Gil', 'Ben Ruiz', 'Alma Sanz', 'Bea Cruz', 'Mia Vidal'][id - 1] }));
    const arcs = buildArcs({
      agents, relationships: [], events: [], secrets: [], adultContent: false,
      feuds: [{
        id: 7, aId: 1, bId: 2, sideA: [3], sideB: [4], town: true, causeText: 'a fight in public',
        log: [{ min: 100, text: 'Ana Gil and Ben Ruiz fell out over a fight in public.' }, { min: 200, text: 'It became a town feud.' }],
      }],
    }, 300);
    const arc = arcs.find((a) => a.kind === 'feud')!;
    expect(arc.id).toBe('feud:1-2');
    expect(arc.title).toBe('The Gil–Ruiz feud');
    expect(arc.summary).toBe('It began with a fight in public. Alma with Ana; Bea with Ben.');
    expect(arc.participants).toEqual([1, 2, 3, 4]);
    expect(arc.beats).toHaveLength(2);
    expect(arc.heat).toBeGreaterThanOrEqual(0.6);
  });

  it('the chronicle leaves out a falling-out nobody has taken sides in yet', () => {
    const arcs = buildArcs({
      agents: [{ id: 1, name: 'Ana Gil' }, { id: 2, name: 'Ben Ruiz' }], relationships: [], events: [], secrets: [], adultContent: false,
      feuds: [{ id: 7, aId: 1, bId: 2, sideA: [], sideB: [], town: false, causeText: 'x', log: [{ min: 1, text: 'x' }] }],
    }, 10);
    expect(arcs.some((a) => a.kind === 'feud')).toBe(false);
  });

  it('the Brewing tab: a card that warms with each person drawn in, never naming more than the cause', () => {
    const names = new Map([[1, 'Ana'], [2, 'Ben'], [3, 'Alma']]);
    const early = feudItem({ id: 1, aId: 1, bId: 2, sideA: [], sideB: [], deciding: 3, town: false, causeText: 'a loan never repaid' }, (id) => names.get(id))!;
    expect(early.text).toBe('Ana and Ben have fallen out over a loan never repaid, and their friends are taking sides — 3 still making up their minds');
    const later = feudItem({ id: 1, aId: 1, bId: 2, sideA: [3], sideB: [], deciding: 0, town: false, causeText: 'a loan never repaid' }, (id) => names.get(id))!;
    expect(later.heat).toBeGreaterThan(early.heat);
    expect(feudItem({ id: 1, aId: 1, bId: 2, sideA: [], sideB: [], deciding: 0, town: false, causeText: 'x' }, (id) => names.get(id))).toBeNull();
  });
});
