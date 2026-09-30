import { describe, it, expect } from 'vitest';
import {
  CRUSH_MIN_ROMANCE, CRUSH_RECIPROCATED_AT, LEDGER_MAX_LONGING, LONGING_MIN, buildLedger,
  type LedgerAgent, type LedgerFact, type LedgerPair, type LedgerRelationship, type LedgerSnapshot,
} from '../ledger';

/**
 * The Hearts ledger is a pure fold: these walk every section, the two hard rules
 * (nobody under 18, adult layer only while the rule is on) and the wording.
 */

const adult = (id: number, name: string, over: Partial<LedgerAgent> = {}): LedgerAgent => ({ id, name, age: 30, is_active: true, ...over });
const rel = (a: number, b: number, over: Partial<LedgerRelationship> = {}): LedgerRelationship => ({
  a, b, status: 'friends', tags: [], romanceAB: 0, romanceBA: 0, statusSinceMinute: null, marriedSinceMinute: null, ...over,
});
const pair = (a: number, b: number, over: Partial<LedgerPair> = {}): LedgerPair => ({
  a, b, kisses: 0, trysts: 0, firstKissAt: null, firstTrystAt: null, secret: false, ...over,
});
const fact = (id: number, type: string, subjectId: number, targetId: number | null, over: Partial<LedgerFact> = {}): LedgerFact => ({
  id, type, subjectId, targetId, isPublic: false, knownBy: [], ...over,
});

function snap(over: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return {
    nowMinute: 5000, adultContent: true,
    agents: [adult(1, 'Ann Ash'), adult(2, 'Ben Birch'), adult(3, 'Cy Cole'), adult(4, 'Di Dale'), adult(5, 'Kit Kid', { age: 15 })],
    relationships: [], pairs: [], longing: {}, facts: [], events: [], ...over,
  };
}

const names = (l: ReturnType<typeof buildLedger>): string => JSON.stringify(l);

describe('couples', () => {
  it('lists married, engaged and partners, married first, with since-when', () => {
    const l = buildLedger(snap({
      relationships: [
        rel(1, 2, { status: 'partners', statusSinceMinute: 100 }),
        rel(3, 4, { tags: ['married'], statusSinceMinute: 50, marriedSinceMinute: 900 }),
      ],
    }));
    expect(l.couples.map((c) => [c.a.id, c.b.id, c.kind, c.sinceMinute])).toEqual([
      [3, 4, 'married', 900], [1, 2, 'partners', 100],
    ]);
  });

  it('a wedding the family module has no date for falls back to the relationship status date', () => {
    const l = buildLedger(snap({ relationships: [rel(1, 2, { tags: ['engaged'], statusSinceMinute: 70 })] }));
    expect(l.couples[0]).toMatchObject({ kind: 'engaged', sinceMinute: 70 });
    const m = buildLedger(snap({ relationships: [rel(1, 2, { tags: ['married'], statusSinceMinute: 70 })] }));
    expect(m.couples[0].sinceMinute).toBe(70);
  });

  it('ordinary friends and rivals are not couples', () => {
    expect(buildLedger(snap({ relationships: [rel(1, 2), rel(3, 4, { status: 'rivals' })] })).couples).toEqual([]);
  });

  it('stays even with the adult layer off (couples are not adult content)', () => {
    const l = buildLedger(snap({ adultContent: false, relationships: [rel(1, 2, { status: 'partners' })] }));
    expect(l.couples).toHaveLength(1);
  });
});

describe('lovers', () => {
  it('a pair with the lovers tag, or with nights, who are not married to each other', () => {
    const l = buildLedger(snap({
      relationships: [rel(1, 2, { tags: ['kissed', 'lovers'] }), rel(3, 4, { tags: ['married', 'lovers'] })],
      pairs: [pair(1, 2, { trysts: 3, kisses: 5, firstTrystAt: 400 }), pair(3, 4, { trysts: 9 }), pair(2, 3, { trysts: 1 })],
    }));
    const keys = l.lovers.map((x) => `${x.a.id}-${x.b.id}`);
    expect(keys).toEqual(['1-2', '2-3']);
    expect(l.lovers[0]).toMatchObject({ nights: 3, kisses: 5, firstNightMinute: 400, secret: false });
  });

  it('the player sees secrets: a secret pair is flagged and listed first', () => {
    const l = buildLedger(snap({
      relationships: [rel(1, 2, { tags: ['lovers'] }), rel(3, 4, { tags: ['lovers'] })],
      pairs: [pair(1, 2, { trysts: 5 }), pair(3, 4, { trysts: 1, secret: true })],
    }));
    expect(l.lovers.map((x) => [x.a.id, x.secret])).toEqual([[3, true], [1, false]]);
  });

  it('is empty with the adult layer off, even for a pair that has spent nights', () => {
    const l = buildLedger(snap({
      adultContent: false,
      relationships: [rel(1, 2, { tags: ['lovers'] })],
      pairs: [pair(1, 2, { trysts: 4, firstTrystAt: 10 })],
    }));
    expect(l.lovers).toEqual([]);
  });
});

describe('longing', () => {
  it('charts the ones who ache, most first, capped', () => {
    const agents = Array.from({ length: 12 }, (_, i) => adult(i + 1, `P${i + 1}`));
    const longing = Object.fromEntries(agents.map((a) => [a.id, 20 + a.id * 5]));
    const l = buildLedger(snap({ agents, longing }));
    expect(l.longing).toHaveLength(LEDGER_MAX_LONGING);
    expect(l.longing[0].person.id).toBe(12);
    expect(l.longing.map((x) => x.longing)).toEqual([...l.longing.map((x) => x.longing)].sort((x, y) => y - x));
  });

  it('leaves out background noise', () => {
    expect(buildLedger(snap({ longing: { 1: LONGING_MIN - 1, 2: LONGING_MIN } })).longing.map((x) => x.person.id)).toEqual([2]);
  });

  it('is hidden completely with the adult layer off', () => {
    expect(buildLedger(snap({ adultContent: false, longing: { 1: 90, 2: 80 } })).longing).toEqual([]);
  });
});

describe('crushes', () => {
  it('one-sided romance over 40 with no reciprocation, in the direction it points', () => {
    const l = buildLedger(snap({
      relationships: [rel(1, 2, { romanceAB: 55, romanceBA: 5 }), rel(3, 4, { romanceAB: 2, romanceBA: 61 })],
    }));
    expect(l.crushes.map((c) => [c.from.id, c.to.id, c.romance])).toEqual([[4, 3, 61], [1, 2, 55]]);
  });

  it('a reciprocated or weak feeling is not a crush, nor is a couple or a pair that already kissed', () => {
    const l = buildLedger(snap({
      relationships: [
        rel(1, 2, { romanceAB: 80, romanceBA: CRUSH_RECIPROCATED_AT }),
        rel(2, 3, { romanceAB: CRUSH_MIN_ROMANCE - 1, romanceBA: 0 }),
        rel(3, 4, { romanceAB: 90, romanceBA: 0, status: 'partners' }),
        rel(1, 4, { romanceAB: 90, romanceBA: 0, tags: ['kissed'] }),
      ],
    }));
    expect(l.crushes).toEqual([]);
  });

  it('stays with the adult layer off (a crush is chaste)', () => {
    const l = buildLedger(snap({ adultContent: false, relationships: [rel(1, 2, { romanceAB: 70, romanceBA: 0 })] }));
    expect(l.crushes).toHaveLength(1);
  });
});

describe('scandals', () => {
  const married = [rel(1, 2, { tags: ['married'] })];

  it('an unwed pregnancy is listed with discreet wording', () => {
    const l = buildLedger(snap({ facts: [fact(7, 'illegitimate_pregnancy', 3, 4)] }));
    expect(l.scandals).toHaveLength(1);
    expect(l.scandals[0]).toMatchObject({ factId: 7, kind: 'unwed_pregnancy', a: { id: 3 }, b: { id: 4 } });
    expect(l.scandals[0].text).toBe('Cy Cole is expecting, and the town is talking.');
  });

  it('an affair is listed when the betrayed knows, or when it is common knowledge; not while it is a secret', () => {
    const secret = fact(1, 'affair', 1, 3, { knownBy: [1, 3] });
    const betrayedKnows = fact(2, 'affair', 1, 3, { knownBy: [1, 3, 2] });
    const everyone = fact(3, 'affair', 3, 4, { isPublic: true, knownBy: [3, 4] });
    const l = buildLedger(snap({ relationships: married, facts: [secret, betrayedKnows, everyone] }));
    expect(l.scandals.map((s) => s.factId)).toEqual([3, 2]);
    expect(l.scandals.find((s) => s.factId === 2)!.text).toBe('Ben Birch knows about Ann Ash and Cy Cole.');
    expect(l.scandals.find((s) => s.factId === 3)!.text).toContain('everyone knows');
  });

  it('a kiss or a night seen counts only once it is common knowledge', () => {
    const l = buildLedger(snap({
      facts: [
        fact(1, 'kiss_seen', 1, 2, { knownBy: [3] }), fact(2, 'kiss_seen', 1, 2, { isPublic: true }),
        fact(3, 'tryst_seen', 3, 4, { knownBy: [1] }), fact(4, 'tryst_seen', 3, 4, { isPublic: true }),
      ],
    }));
    expect(l.scandals.map((s) => [s.factId, s.kind])).toEqual([[4, 'tryst_seen'], [2, 'kiss_seen']]);
  });

  it('with the adult layer off: no unwed pregnancy and no night seen, but kisses and affairs remain', () => {
    const l = buildLedger(snap({
      adultContent: false,
      relationships: married,
      facts: [
        fact(1, 'illegitimate_pregnancy', 3, 4), fact(2, 'tryst_seen', 3, 4, { isPublic: true }),
        fact(3, 'kiss_seen', 3, 4, { isPublic: true }), fact(4, 'affair', 1, 3, { knownBy: [2] }),
      ],
    }));
    expect(l.scandals.map((s) => s.kind).sort()).toEqual(['affair', 'kiss_seen']);
  });

  it('other fact types are not scandals', () => {
    expect(buildLedger(snap({ facts: [fact(1, 'theft', 1, 2, { isPublic: true }), fact(2, 'pregnancy', 1, null)] })).scandals).toEqual([]);
  });
});

describe('milestones', () => {
  it('first kisses and first nights, newest first, once per pair', () => {
    const l = buildLedger(snap({
      events: [
        { a: 1, b: 2, type: 'first_kiss', minute: 100 },
        { a: 3, b: 4, type: 'first_tryst', minute: 300 },
        { a: 3, b: 4, type: 'first_kiss', minute: 200 },
        { a: 1, b: 2, type: 'kiss', minute: 400 },
      ],
      pairs: [pair(1, 2, { firstKissAt: 100 })],
    }));
    expect(l.milestones.map((m) => [m.kind, m.a.id, m.b.id, m.minute])).toEqual([
      ['first_night', 3, 4, 300], ['first_kiss', 3, 4, 200], ['first_kiss', 1, 2, 100],
    ]);
  });

  it("a pair's own stamps fill in when the event log lost the row", () => {
    const l = buildLedger(snap({ pairs: [pair(1, 2, { firstKissAt: 55, firstTrystAt: 90 })] }));
    expect(l.milestones.map((m) => m.kind)).toEqual(['first_night', 'first_kiss']);
  });

  it('a first night is not listed with the adult layer off, a first kiss still is', () => {
    const l = buildLedger(snap({
      adultContent: false,
      events: [{ a: 1, b: 2, type: 'first_kiss', minute: 1 }, { a: 1, b: 2, type: 'first_tryst', minute: 2 }],
      pairs: [pair(1, 2, { firstTrystAt: 2 })],
    }));
    expect(l.milestones.map((m) => m.kind)).toEqual(['first_kiss']);
  });
});

describe('minors and the departed never appear', () => {
  // Every section fed a row that names the 15-year-old (id 5) or someone gone.
  const dirty = (over: Partial<LedgerSnapshot> = {}) => snap({
    agents: [
      adult(1, 'Ann Ash'), adult(2, 'Ben Birch'), adult(5, 'Kit Kid', { age: 15 }), adult(6, 'Gone Gus', { is_active: false }),
      adult(7, 'Nan NoAge', { age: undefined }), adult(8, 'Sam StringAge', { age: '30' }), adult(9, 'Ned NaN', { age: Number.NaN }),
      adult(10, 'Eve Eighteen', { age: 18 }), adult(11, 'Una Underage', { age: 17.9 }),
    ],
    relationships: [
      rel(1, 5, { status: 'partners', tags: ['married', 'kissed', 'lovers'], romanceAB: 90, romanceBA: 0 }),
      rel(2, 6, { status: 'partners' }), rel(1, 7, { status: 'partners' }), rel(1, 8, { status: 'partners' }),
      rel(1, 9, { status: 'partners' }), rel(2, 11, { status: 'partners', romanceAB: 90, romanceBA: 0 }),
      rel(5, 11, { status: 'partners' }),
    ],
    pairs: [pair(1, 5, { trysts: 3, firstKissAt: 1, firstTrystAt: 2 }), pair(2, 11, { trysts: 1 }), pair(1, 7, { trysts: 1 })],
    longing: { 5: 99, 6: 99, 7: 99, 8: 99, 9: 99, 11: 99, 1: 50 },
    facts: [
      fact(1, 'illegitimate_pregnancy', 5, 1), fact(2, 'illegitimate_pregnancy', 1, 5), fact(3, 'kiss_seen', 1, 5, { isPublic: true }),
      fact(4, 'affair', 1, 5, { isPublic: true }), fact(5, 'tryst_seen', 2, 11, { isPublic: true }),
      fact(6, 'illegitimate_pregnancy', 7, null),
    ],
    events: [{ a: 1, b: 5, type: 'first_kiss', minute: 1 }, { a: 2, b: 11, type: 'first_tryst', minute: 2 }],
    ...over,
  });

  it.each([true, false])('adultContent=%s: no section names a minor, someone gone, or someone whose age is unknown', (adultContent) => {
    const l = buildLedger(dirty({ adultContent }));
    const text = names(l);
    for (const banned of ['Kit Kid', 'Gone Gus', 'Nan NoAge', 'Sam StringAge', 'Ned NaN', 'Una Underage']) {
      expect(text, banned).not.toContain(banned);
    }
    expect(l.couples).toEqual([]);
    expect(l.lovers).toEqual([]);
    expect(l.crushes).toEqual([]);
    expect(l.scandals).toEqual([]);
    expect(l.milestones).toEqual([]);
    // The one adult in the fixture with longing is the only bar.
    expect(l.longing.map((x) => x.person.id)).toEqual(adultContent ? [1] : []);
  });

  it('the line is exactly 18', () => {
    const l = buildLedger(snap({
      agents: [adult(1, 'Ann Ash', { age: 18 }), adult(2, 'Ben Birch', { age: 18 })],
      relationships: [rel(1, 2, { status: 'partners' })],
    }));
    expect(l.couples).toHaveLength(1);
  });
});

describe('an empty town', () => {
  it('yields empty sections rather than failing', () => {
    const l = buildLedger(snap({ agents: [] }));
    expect(l).toMatchObject({ couples: [], lovers: [], longing: [], crushes: [], scandals: [], milestones: [], nowMinute: 5000 });
  });
});
