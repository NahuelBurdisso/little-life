import { describe, it, expect } from 'vitest';
import { buildStartingTies, foldStartingTies, STARTING_TIE_BASELINES } from '../startingTies';
import { getRelationshipSeeds } from '../../data/relationships';
import { getDefaultAgents, getDefaultRelationships } from '../../../src/components/setup/defaults';
import { AGENT_SEEDS } from '../../data/agents';

const agent = (name: string, homeName: string, workplaceName: string | null = null, warmth = 50) =>
  ({ name, homeName, workplaceName, personality: { warmth } });

describe('buildStartingTies', () => {
  it('ties housemates as friends and coworkers as acquaintances', () => {
    const ties = buildStartingTies([
      agent('Ann', 'Home 1', 'Farm'),
      agent('Bob', 'Home 1', 'Shop'),
      agent('Cat', 'Home 2', 'Farm'),
      agent('Dan', 'Home 3', null),
    ]);
    const find = (a: string, b: string) => ties.find((t) => t.a === a && t.b === b);

    expect(find('Ann', 'Bob')).toMatchObject({ kind: 'housemate', status: 'friends', tags: ['housemate'] });
    expect(find('Ann', 'Cat')).toMatchObject({ kind: 'coworker', status: 'acquaintances', tags: ['coworker'] });
    // Unemployed, lives alone, no map → no ties at all.
    expect(ties.some((t) => t.a === 'Dan' || t.b === 'Dan')).toBe(false);
    expect(ties).toHaveLength(2);
  });

  it('keeps the strongest kind and every tag when a pair qualifies twice', () => {
    const [tie] = buildStartingTies([agent('Ann', 'Home 1', 'Farm'), agent('Bob', 'Home 1', 'Farm')]);
    expect(tie.kind).toBe('housemate');
    expect(tie.tags).toEqual(['housemate', 'coworker']);
    expect(tie.familiarity).toBe(STARTING_TIE_BASELINES.housemate.familiarity);
  });

  it('every tie clears the social-target floor (friendship > 10) and stays out of the grief band', () => {
    // decisions.ts only scores a non co-located agent as a social target above
    // friendship 10; grieving and the "+15 friend" bonus start above 50.
    const ties = buildStartingTies(
      [agent('Warm', 'Home 1', 'Farm', 100), agent('Cold', 'Home 1', 'Farm', 0), agent('Mid', 'Home 2', 'Farm', 50)],
      new Map([['Home 1', { x: 0, y: 0 }], ['Home 2', { x: 5, y: 0 }]]),
    );
    for (const t of ties) {
      for (const f of [t.friendshipAB, t.friendshipBA]) {
        expect(f).toBeGreaterThan(10);
        expect(f).toBeLessThanOrEqual(50);
      }
    }
    // Warmth tilts each direction: the warm housemate likes the cold one more than vice versa.
    const wc = ties.find((t) => t.a === 'Warm' && t.b === 'Cold')!;
    expect(wc.friendshipAB).toBeGreaterThan(wc.friendshipBA);
  });

  it('acquaints each household with its nearest other household only', () => {
    const doors = new Map([
      ['Home 1', { x: 0, y: 0 }],
      ['Home 2', { x: 3, y: 0 }],
      ['Home 3', { x: 40, y: 0 }],
      ['Home 4', { x: 44, y: 0 }],
    ]);
    const ties = buildStartingTies(
      [agent('A', 'Home 1'), agent('B', 'Home 2'), agent('C', 'Home 3'), agent('D', 'Home 4')],
      doors,
    );
    const pairs = ties.map((t) => `${t.a}-${t.b}:${t.kind}`).sort();
    // 1↔2 and 3↔4 are mutual nearest; nobody reaches across the gap.
    expect(pairs).toEqual(['A-B:neighbor', 'C-D:neighbor']);
  });

  it('is deterministic and in cast order', () => {
    const cast = getDefaultAgents();
    const doors = new Map(cast.map((c, i) => [c.homeName, { x: (i * 7) % 23, y: (i * 5) % 17 }]));
    const a = buildStartingTies(cast, doors);
    const b = buildStartingTies(cast, doors);
    expect(a).toEqual(b);
    const order = new Map(cast.map((c, i) => [c.name, i]));
    for (const t of a) expect(order.get(t.a)!).toBeLessThan(order.get(t.b)!);
  });

  it('gives every default housemate and coworker pair a tie', () => {
    const cast = getDefaultAgents();
    const ties = buildStartingTies(cast);
    const has = (x: string, y: string) => ties.some((t) => (t.a === x && t.b === y) || (t.a === y && t.b === x));
    // Housemates the old 6-row wizard default left as strangers.
    expect(has('Thomas Park', 'Priya Sharma')).toBe(true);
    // Coworkers ditto.
    expect(has('Rosa Chen', 'Lucia Fernandez')).toBe(true);
    expect(has('Marco Rivera', 'Diego Santos')).toBe(true);
  });
});

describe('foldStartingTies (db:seed path)', () => {
  it('fills stranger rows, keeps authored values, and never duplicates a pair', () => {
    const agentMap = new Map(AGENT_SEEDS.map((s, i) => [s.name, i + 1]));
    const rows = getRelationshipSeeds(agentMap);
    const before = new Map(rows.map((r) => [`${r.agent_a}:${r.agent_b}`, { ...r, tags: [...r.tags] }]));
    // getRelationshipSeeds emits a filler row for every unordered pair, which is
    // why inserting the ties beside it never ran (every pair looked "taken").
    const n = AGENT_SEEDS.length;
    expect(rows).toHaveLength((n * (n - 1)) / 2);

    const authored = new Set<string>();
    for (const s of AGENT_SEEDS) for (const r of s.initialRelationships) {
      const x = agentMap.get(s.name)!, y = agentMap.get(r.otherName)!;
      authored.add(`${Math.min(x, y)}:${Math.max(x, y)}`);
    }
    // Homes on a line, one tile apart per number: every household neighbours the next.
    const doors = new Map(AGENT_SEEDS.map((s) => [s.homeName, { x: Number(s.homeName.replace(/\D/g, '')) * 10, y: 0 }]));
    const ties = buildStartingTies(AGENT_SEEDS, doors);
    const applied = foldStartingTies(rows, ties, (name) => agentMap.get(name), authored, () => {
      throw new Error('every pair already has a row');
    });

    expect(applied).toBeGreaterThan(0);
    expect(rows).toHaveLength((n * (n - 1)) / 2);
    for (const tie of ties) {
      const x = agentMap.get(tie.a)!, y = agentMap.get(tie.b)!;
      const key = `${Math.min(x, y)}:${Math.max(x, y)}`;
      const row = rows.find((r) => `${r.agent_a}:${r.agent_b}` === key)!;
      const old = before.get(key)!;
      for (const tag of tie.tags) expect(row.tags).toContain(tag);
      if (authored.has(key)) {
        expect(row.friendship_ab).toBe(old.friendship_ab);
        expect(row.friendship_ba).toBe(old.friendship_ba);
        expect(row.status).toBe(old.status);
      } else {
        expect(row.friendship_ab).toBeGreaterThan(10);
        expect(row.status).toBe(tie.status);
      }
    }
  });

  it('creates a row for a pair that has none', () => {
    const rows: any[] = [];
    const ties = buildStartingTies([agent('Ann', 'Home 1'), agent('Bob', 'Home 1')]);
    const ids = new Map([['Ann', 2], ['Bob', 1]]);
    const applied = foldStartingTies(rows, ties, (n) => ids.get(n), new Set(), (lo, hi) => ({
      agent_a: lo, agent_b: hi, friendship_ab: 0, friendship_ba: 0, trust_ab: 0, trust_ba: 0,
      familiarity: 0, tags: [], status: 'strangers',
    }));
    expect(applied).toBe(1);
    expect(rows).toMatchObject([{ agent_a: 1, agent_b: 2, status: 'friends', tags: ['housemate'] }]);
  });
});

describe('getDefaultRelationships', () => {
  it('lists every authored AGENT_SEEDS pair once', () => {
    const rows = getDefaultRelationships();
    const key = (a: string, b: string) => [a, b].sort().join('|');
    const expected = new Set(AGENT_SEEDS.flatMap((s) => s.initialRelationships.map((r) => key(s.name, r.otherName))));
    const got = rows.map((r) => key(r.agentAName, r.agentBName));
    expect(new Set(got).size).toBe(got.length);
    expect(new Set(got)).toEqual(expected);
    // The old hand-kept copy had 6 of these.
    expect(rows.length).toBeGreaterThan(6);
  });

  it('only names agents that exist in the default cast', () => {
    const names = new Set(getDefaultAgents().map((a) => a.name));
    for (const r of getDefaultRelationships()) {
      expect(names.has(r.agentAName)).toBe(true);
      expect(names.has(r.agentBName)).toBe(true);
    }
  });
});
