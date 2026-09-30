import { describe, it, expect } from 'vitest';
import { FESTIVALS } from '../../data/calendar';
import { contestSkill, envyChance, judgeContest, TRADE_BONUS, type Entrant } from '../contest';
import {
  MAX_CANDIDATES, alignment, candidacyScore, endorsementDelta, pickCandidates, tallyElection, tieKey,
  type ElectionInput, type Hopeful,
} from '../election';
import { makeRng } from '../worldgen/rng';

const seeded = (seed: number) => { const r = makeRng(seed); return () => r.next(); };
const P = (over: Record<string, number> = {}) => ({
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50, ...over,
});
const pie = FESTIVALS.harvest_festival.contest;
const entrant = (id: number, hobbyLevel: number, job = 'farmhand', personality = P()): Entrant =>
  ({ id, name: `R${id}`, hobbyLevel, job, personality });

describe('festival contests', () => {
  it('rewards practice, the trade and temperament', () => {
    expect(contestSkill(entrant(1, 40), pie)).toBeGreaterThan(contestSkill(entrant(2, 10), pie));
    expect(contestSkill(entrant(1, 10, 'baker'), pie) - contestSkill(entrant(1, 10, 'shop_assistant'), pie)).toBe(TRADE_BONUS);
    const singer = FESTIVALS.midsummer.contest;
    expect(contestSkill(entrant(1, 0, 'x', P({ vanity: 90 })), singer)).toBeGreaterThan(contestSkill(entrant(1, 0, 'x', P({ vanity: 20 })), singer));
  });

  it('is deterministic for a seed, and a master beats a novice whatever the luck', () => {
    const field = [entrant(3, 5), entrant(1, 60, 'baker'), entrant(2, 20)];
    const a = judgeContest(field, pie, seeded(7));
    const b = judgeContest([...field].reverse(), pie, seeded(7));
    expect(a).toEqual(b);
    for (let seed = 0; seed < 30; seed++) expect(judgeContest(field, pie, seeded(seed))!.winnerId).toBe(1);
  });

  it('lets luck decide between equals, and needs two entrants', () => {
    const winners = new Set<number>();
    for (let seed = 0; seed < 40; seed++) winners.add(judgeContest([entrant(1, 20), entrant(2, 20)], pie, seeded(seed))!.winnerId);
    expect(winners).toEqual(new Set([1, 2]));
    expect(judgeContest([entrant(1, 20)], pie, seeded(1))).toBeNull();
  });

  it('makes the vain and anxious envious, a close friend much less', () => {
    const proud = P({ vanity: 90, neuroticism: 80, warmth: 30 });
    expect(envyChance(proud, 0)).toBeGreaterThan(envyChance(P(), 0));
    expect(envyChance(proud, 60)).toBeLessThan(envyChance(proud, 0));
    expect(envyChance(proud, -50)).toBeLessThanOrEqual(0.8);
    expect(envyChance(P({ warmth: 100 }), 80)).toBe(0);
  });
});

const hopeful = (id: number, over: Partial<Hopeful> = {}): Hopeful =>
  ({ id, personality: P(), reputation: 0, ambitionType: null, ambitionText: null, ...over });

describe('candidacy', () => {
  it('draws the ambitious and the outgoing, never more than three with the incumbent', () => {
    expect(candidacyScore(hopeful(1, { ambitionType: 'power' }))).toBeGreaterThanOrEqual(30);
    expect(candidacyScore(hopeful(1, { ambitionText: 'Run the town hall one day' }))).toBeGreaterThanOrEqual(30);
    expect(candidacyScore(hopeful(1, { personality: P({ warmth: 80, vanity: 80 }), reputation: 20 }))).toBeGreaterThanOrEqual(30);
    expect(candidacyScore(hopeful(1))).toBeLessThan(30);

    const pool = [
      hopeful(1), hopeful(2, { ambitionType: 'power' }), hopeful(3, { ambitionText: 'become mayor' }),
      hopeful(4, { personality: P({ warmth: 90, vanity: 90 }), reputation: 40 }), hopeful(5),
    ];
    const ballot = pickCandidates(pool, 9);
    expect(ballot[0]).toBe(9);
    expect(ballot).toHaveLength(MAX_CANDIDATES);
    expect(ballot).not.toContain(1);
    expect(ballot).not.toContain(5);
  });

  it('puts a drafted resident on the ballot ahead of volunteers, and finds someone for an empty chair', () => {
    const pool = [hopeful(1), hopeful(2, { ambitionType: 'power' }), hopeful(3, { ambitionType: 'power' })];
    expect(pickCandidates(pool, 7, [1])).toEqual([7, 1, 2]);
    const quiet = [hopeful(1), hopeful(2, { reputation: 30 })];
    expect(pickCandidates(quiet, null)).toEqual([2]);
  });
});

function town(): ElectionInput {
  const ties = new Map<string, { friendship: number; trust: number }>();
  // Voters 10–14; candidate 1 is liked by 10, 11, 12, candidate 2 by 13, 14.
  for (const v of [10, 11, 12]) ties.set(tieKey(v, 1), { friendship: 20, trust: 30 });
  for (const v of [13, 14]) ties.set(tieKey(v, 2), { friendship: 20, trust: 30 });
  return {
    candidates: [
      { id: 1, personality: P(), reputation: 10, incumbent: true },
      { id: 2, personality: P(), reputation: 10, incumbent: false },
    ],
    voters: [1, 2, 10, 11, 12, 13, 14].map((id) => ({ id, personality: P() })),
    ties,
    secrets: [],
    support: {},
  };
}

describe('the vote', () => {
  it('counts friends, candidates vote for themselves, and a seed replays the count', () => {
    const t = tallyElection(town(), seeded(3))!;
    expect(t.winnerId).toBe(1);
    expect(t.ranking).toEqual([{ id: 1, votes: 4 }, { id: 2, votes: 3 }]);
    expect(t.ballots.get(1)).toBe(1);
    expect(t.ballots.get(2)).toBe(2);
    expect(tallyElection(town(), seeded(3))).toEqual(t);
  });

  it('a public scandal costs a candidate the town; a private one only those who know', () => {
    const pub = town();
    pub.secrets = [{ subjectId: 1, sensitivity: 4, isPublic: true, knownBy: [] }];
    expect(tallyElection(pub, seeded(3))!.winnerId).toBe(2);
    const priv = town();
    priv.secrets = [{ subjectId: 1, sensitivity: 5, isPublic: false, knownBy: [10] }];
    const t = tallyElection(priv, seeded(3))!;
    expect(t.ballots.get(10)).toBe(2);
    expect(t.ballots.get(11)).toBe(1);
  });

  it('canvassing wins votes, and a tie goes to support, then the incumbent', () => {
    const won = town();
    won.support = { '2': { '10': 10, '11': 10 } };
    expect(tallyElection(won, seeded(3))!.winnerId).toBe(2);

    const tie: ElectionInput = { ...town(), voters: [1, 2].map((id) => ({ id, personality: P() })) };
    expect(tallyElection(tie, seeded(1))!.winnerId).toBe(1); // incumbent
    tie.support = { '2': { '99': 3 } };
    expect(tallyElection(tie, seeded(1))!.winnerId).toBe(2);
  });

  it('scores values and conversations sensibly', () => {
    expect(alignment(P(), P())).toBe(10);
    expect(alignment(P({ morality: 0, honesty: 0 }), P({ morality: 100, honesty: 100 }))).toBeLessThan(10);
    expect(endorsementDelta(1, true)).toBeGreaterThan(endorsementDelta(1, false));
    expect(endorsementDelta(-1, false)).toBeLessThan(0);
  });
});
