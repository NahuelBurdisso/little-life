import { describe, it, expect } from 'vitest';
import {
  buildSocialEdges,
  assignHomeLabels,
  assignmentCost,
  edgesToLabelPairs,
  type SocialRelationship,
  type SocialScenario,
} from '../social';
import { generateWorld } from '../pipeline';
import { AGENT_SEEDS } from '../../../data/agents';
import type { GenResult } from '../types';

function rel(
  a: string,
  b: string,
  over: Partial<SocialRelationship> = {},
): SocialRelationship {
  return {
    agentAName: a, agentBName: b,
    friendshipAB: 0, friendshipBA: 0, romanceAB: 0, romanceBA: 0,
    status: 'acquaintances', tags: [],
    ...over,
  };
}

const CAST = [
  { name: 'Ann', homeName: 'Home 1' },
  { name: 'Bob', homeName: 'Home 2' },
  { name: 'Cat', homeName: 'Home 3' },
  { name: 'Dan', homeName: 'Home 3' },
  { name: 'Eve', homeName: 'Home 4' },
];

describe('buildSocialEdges — classification', () => {
  it.each([
    ['status rivals', { status: 'rivals' }],
    ['status enemies', { status: 'enemies' }],
    ['tag rival', { tags: ['rival'] }],
    ['tag grudge', { tags: ['grudge'] }],
    ['tag antagonist', { tags: ['antagonist'] }],
  ])('%s → rival', (_label, over) => {
    expect(buildSocialEdges([rel('Ann', 'Bob', over)], null, CAST))
      .toEqual([{ a: 'Ann', b: 'Bob', kind: 'rival' }]);
  });

  it('scenario rival pair → rival', () => {
    const scenario: SocialScenario = { romanceThreads: [], rivalPairs: [[4, 0]] };
    expect(buildSocialEdges([], scenario, CAST)).toEqual([{ a: 'Ann', b: 'Eve', kind: 'rival' }]);
  });

  it.each(['secret_fling', 'forbidden'])('%s thread → secret_lovers', (template_id) => {
    const scenario: SocialScenario = {
      romanceThreads: [{ template_id, romance_values: [{ from: 1, to: 4, value: 30 }] }],
      rivalPairs: [],
    };
    expect(buildSocialEdges([], scenario, CAST)).toEqual([{ a: 'Bob', b: 'Eve', kind: 'secret_lovers' }]);
  });

  it('any thread carrying a secret → secret_lovers, even with high mutual romance', () => {
    const scenario: SocialScenario = {
      romanceThreads: [{
        template_id: 'mutual_crush',
        romance_values: [{ from: 0, to: 1, value: 80 }, { from: 1, to: 0, value: 80 }],
        secret: { content: 'Ann has a crush on Bob' },
      }],
      rivalPairs: [],
    };
    expect(buildSocialEdges([], scenario, CAST)).toEqual([{ a: 'Ann', b: 'Bob', kind: 'secret_lovers' }]);
  });

  it('a non-secret thread only sets romance; mutual ≥ 50 makes lovers', () => {
    const scenario: SocialScenario = {
      romanceThreads: [{
        template_id: 'slow_burn',
        romance_values: [{ from: 0, to: 1, value: 60 }, { from: 1, to: 0, value: 55 }],
      }],
      rivalPairs: [],
    };
    expect(buildSocialEdges([], scenario, CAST)).toEqual([{ a: 'Ann', b: 'Bob', kind: 'lovers' }]);
  });

  it('mutual romance ≥ 50 → lovers; one-sided romance is not', () => {
    expect(buildSocialEdges([rel('Ann', 'Bob', { romanceAB: 50, romanceBA: 70 })], null, CAST))
      .toEqual([{ a: 'Ann', b: 'Bob', kind: 'lovers' }]);
    expect(buildSocialEdges([rel('Ann', 'Bob', { romanceAB: 90, romanceBA: 49 })], null, CAST))
      .toEqual([]);
  });

  it('mutual friendship ≥ 50 → friends; below it, nothing', () => {
    expect(buildSocialEdges([rel('Ann', 'Bob', { friendshipAB: 50, friendshipBA: 60 })], null, CAST))
      .toEqual([{ a: 'Ann', b: 'Bob', kind: 'friends' }]);
    expect(buildSocialEdges([rel('Ann', 'Bob', { friendshipAB: 49, friendshipBA: 90 })], null, CAST))
      .toEqual([]);
  });

  it('thread friendship deltas count toward friends', () => {
    const scenario: SocialScenario = {
      romanceThreads: [{
        template_id: 'rebound',
        romance_values: [],
        friendship_deltas: [{ from: 0, to: 1, delta: 20 }],
      }],
      rivalPairs: [],
    };
    const rels = [rel('Ann', 'Bob', { friendshipAB: 40, friendshipBA: 55 })];
    expect(buildSocialEdges(rels, null, CAST)).toEqual([]);
    expect(buildSocialEdges(rels, scenario, CAST)).toEqual([{ a: 'Ann', b: 'Bob', kind: 'friends' }]);
  });

  it('precedence: secret_lovers > rival > lovers > friends', () => {
    const all = { status: 'rivals', romanceAB: 80, romanceBA: 80, friendshipAB: 80, friendshipBA: 80 };
    const secret: SocialScenario = {
      romanceThreads: [{ template_id: 'forbidden', romance_values: [{ from: 0, to: 1, value: 35 }] }],
      rivalPairs: [],
    };
    expect(buildSocialEdges([rel('Ann', 'Bob', all)], secret, CAST)[0].kind).toBe('secret_lovers');
    expect(buildSocialEdges([rel('Ann', 'Bob', all)], null, CAST)[0].kind).toBe('rival');
    expect(buildSocialEdges([rel('Ann', 'Bob', { ...all, status: 'partners' })], null, CAST)[0].kind)
      .toBe('lovers');
  });

  it('drops housemates, self-pairs and unknown agents', () => {
    const rels = [
      rel('Cat', 'Dan', { status: 'rivals' }),     // both Home 3
      rel('Ann', 'Ann', { status: 'rivals' }),
      rel('Ann', 'Zed', { status: 'rivals' }),
    ];
    expect(buildSocialEdges(rels, null, CAST)).toEqual([]);
  });

  it('dedupes a pair listed both ways (the later row wins, as in seedWorld)', () => {
    const rels = [
      rel('Ann', 'Bob', { status: 'rivals' }),
      rel('Bob', 'Ann', { friendshipAB: 60, friendshipBA: 70 }),
    ];
    expect(buildSocialEdges(rels, null, CAST)).toEqual([{ a: 'Ann', b: 'Bob', kind: 'friends' }]);
  });

  it('output is sorted and independent of input order', () => {
    const rels = [
      rel('Eve', 'Bob', { status: 'rivals' }),
      rel('Cat', 'Ann', { friendshipAB: 60, friendshipBA: 60 }),
      rel('Bob', 'Ann', { status: 'enemies' }),
    ];
    const fwd = buildSocialEdges(rels, null, CAST);
    const rev = buildSocialEdges([...rels].reverse(), null, CAST);
    expect(fwd).toEqual(rev);
    expect(fwd.map((e) => `${e.a}-${e.b}`)).toEqual(['Ann-Bob', 'Ann-Cat', 'Bob-Eve']);
  });
});

describe('assignHomeLabels', () => {
  // Five plots on a line, 10 tiles apart.
  const line = [0, 10, 20, 30, 40].map((x) => ({ x, y: 0 }));
  const noAnchors = line.map(() => []);

  it('is the identity with no pairs, even with anchors', () => {
    const anchors = line.map(() => [{ x: 40, y: 0, weight: 1 }]);
    expect(assignHomeLabels({ plotDoors: line, pairs: [], anchors })).toEqual([0, 1, 2, 3, 4]);
  });

  it('pulls rivals next door and pushes secret lovers apart', () => {
    const pairs = edgesToLabelPairs(
      [
        { a: 'A', b: 'E', kind: 'rival' },
        { a: 'B', b: 'C', kind: 'secret_lovers' },
      ],
      (n) => ({ A: 0, B: 1, C: 2, D: 3, E: 4 } as Record<string, number>)[n],
    );
    const perm = assignHomeLabels({ plotDoors: line, pairs, anchors: noAnchors });
    const d = (u: number, v: number) => Math.abs(line[perm[u]].x - line[perm[v]].x);
    expect(d(0, 4)).toBe(10);
    expect(d(1, 2)).toBeGreaterThanOrEqual(30);
    expect([...perm].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(assignmentCost({ plotDoors: line, pairs, anchors: noAnchors }, perm))
      .toBeLessThan(assignmentCost({ plotDoors: line, pairs, anchors: noAnchors }, [0, 1, 2, 3, 4]));
  });

  it('aggregates edges between the same two homes and drops same-home edges', () => {
    const labelOf = (n: string) => ({ A: 0, B: 1, C: 1 } as Record<string, number>)[n];
    const pairs = edgesToLabelPairs(
      [
        { a: 'A', b: 'B', kind: 'rival' },
        { a: 'A', b: 'C', kind: 'friends' },
        { a: 'B', b: 'C', kind: 'rival' },
        { a: 'A', b: 'Z', kind: 'rival' },
      ],
      labelOf,
    );
    expect(pairs).toEqual([{ u: 0, v: 1, near: 4, far: 0 }]);
  });
});

// ─── Pipeline-level: the default cast ─────────────────────────────────────────

const DEFAULT_AGENTS = AGENT_SEEDS.map((a) => ({
  name: a.name, homeName: a.homeName, workplaceName: a.workplaceName,
}));
const DEFAULT_RELS: SocialRelationship[] = AGENT_SEEDS.flatMap((a) =>
  a.initialRelationships.map((r) => rel(a.name, r.otherName, {
    friendshipAB: r.friendshipAB, friendshipBA: r.friendshipBA,
    romanceAB: r.romanceAB, romanceBA: r.romanceBA,
    status: r.status, tags: r.tags,
  })));
const idx = (name: string) => DEFAULT_AGENTS.findIndex((a) => a.name === name);
// A secret fling between two well-connected agents (Marco: Home 2, Lucia: Home
// 7), so their friend edges pull against the push apart.
const FLING: SocialScenario = {
  romanceThreads: [{
    template_id: 'secret_fling',
    romance_values: [
      { from: idx('Marco Rivera'), to: idx('Lucia Fernandez'), value: 30 },
      { from: idx('Lucia Fernandez'), to: idx('Marco Rivera'), value: 25 },
    ],
  }],
  rivalPairs: [],
};
const EDGES = buildSocialEdges(DEFAULT_RELS, FLING, DEFAULT_AGENTS);
const CFG = (seed: string) => ({ seed, sizeTier: 'auto' as const, overrides: {} });

const doorOf = (w: GenResult, name: string) => {
  const h = w.locations.find((l) => l.name === name)!;
  return { x: Math.floor(h.entry_point.x / 32), y: Math.floor(h.entry_point.y / 32) };
};
const dist = (w: GenResult, a: string, b: string) => {
  const p = doorOf(w, a), q = doorOf(w, b);
  return Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

describe('social placement in the pipeline (default cast)', () => {
  it('classifies the default cast as expected', () => {
    // Housemates (Elena/James, Rosa/Yuki, Sofia/Omar, Thomas/Priya) are absent.
    expect(EDGES).toContainEqual({ a: 'Carlos Mendez', b: 'Ray Kowalski', kind: 'rival' });
    expect(EDGES).toContainEqual({ a: 'Lucia Fernandez', b: 'Marco Rivera', kind: 'secret_lovers' });
    expect(EDGES.some((e) => e.a === 'Rosa Chen' && e.b === 'Yuki Tanaka')).toBe(false);
  });

  it('puts rivals closer, and secret lovers farther, than the median home pair', () => {
    const SEEDS = 30;
    let rivalsNear = 0, loversFar = 0;
    for (let i = 0; i < SEEDS; i++) {
      const w = generateWorld(CFG(`social-${i}`), DEFAULT_AGENTS.length, {
        agents: DEFAULT_AGENTS, social: { edges: EDGES },
      });
      const homes = w.locations.filter((l) => l.type === 'home').map((h) => h.name);
      const ds: number[] = [];
      for (let a = 0; a < homes.length; a++) {
        for (let b = a + 1; b < homes.length; b++) ds.push(dist(w, homes[a], homes[b]));
      }
      const m = median(ds);
      if (dist(w, 'Home 6', 'Home 9') < m) rivalsNear++;   // Carlos / Ray
      if (dist(w, 'Home 2', 'Home 7') > m) loversFar++;    // Marco / Lucia
    }
    // Measured over 60 seeds: 60/60 and 60/60. The same worlds without social
    // placement: 29/60 and 21/60 — i.e. chance.
    expect(rivalsNear).toBeGreaterThanOrEqual(0.8 * SEEDS);
    expect(loversFar).toBeGreaterThanOrEqual(0.8 * SEEDS);
  });

  it('only relabels: same plots, same descriptions per plot, same home count', () => {
    for (let i = 0; i < 10; i++) {
      const base = generateWorld(CFG(`relabel-${i}`), DEFAULT_AGENTS.length, { agents: DEFAULT_AGENTS });
      const soc = generateWorld(CFG(`relabel-${i}`), DEFAULT_AGENTS.length, {
        agents: DEFAULT_AGENTS, social: { edges: EDGES },
      });
      const key = (l: GenResult['locations'][number]) => `${l.position.x},${l.position.y}|${l.description}`;
      const bh = base.locations.filter((l) => l.type === 'home');
      const sh = soc.locations.filter((l) => l.type === 'home');
      expect(sh.map((h) => h.name)).toEqual(bh.map((h) => h.name));
      expect(new Set(sh.map(key))).toEqual(new Set(bh.map(key)));
      // Everything but the homes is untouched.
      expect(soc.locations.filter((l) => l.type !== 'home'))
        .toEqual(base.locations.filter((l) => l.type !== 'home'));
      expect(soc.collisionGrid).toBe(base.collisionGrid);
      expect(soc.terrainTiles).toEqual(base.terrainTiles);
    }
  });

  it('housemates still share one home', () => {
    const w = generateWorld(CFG('housemates'), DEFAULT_AGENTS.length, {
      agents: DEFAULT_AGENTS, social: { edges: EDGES },
    });
    const names = new Set(w.locations.map((l) => l.name));
    for (const a of DEFAULT_AGENTS) expect(names.has(a.homeName)).toBe(true);
    expect(w.locations.filter((l) => l.type === 'home')).toHaveLength(9);
  });

  it('is deterministic', () => {
    const run = () => generateWorld(CFG('social-det'), DEFAULT_AGENTS.length, {
      agents: DEFAULT_AGENTS, social: { edges: EDGES },
    });
    expect(run()).toEqual(run());
  });

  it('actually moves households in some seeds', () => {
    let moved = 0;
    for (let i = 0; i < 10; i++) {
      const base = generateWorld(CFG(`moved-${i}`), DEFAULT_AGENTS.length, { agents: DEFAULT_AGENTS });
      const soc = generateWorld(CFG(`moved-${i}`), DEFAULT_AGENTS.length, {
        agents: DEFAULT_AGENTS, social: { edges: EDGES },
      });
      if (JSON.stringify(base.locations) !== JSON.stringify(soc.locations)) moved++;
    }
    expect(moved).toBeGreaterThan(5);
  });

  it('no edges → identical GenResult to a world without social input', () => {
    for (const seed of ['empty-a', 'empty-b', 'empty-c']) {
      const base = generateWorld(CFG(seed), DEFAULT_AGENTS.length, { agents: DEFAULT_AGENTS });
      expect(generateWorld(CFG(seed), DEFAULT_AGENTS.length, {
        agents: DEFAULT_AGENTS, social: { edges: [] },
      })).toEqual(base);
    }
  });

  it('housemate-only edges → identical GenResult (workplace pull alone never relabels)', () => {
    const base = generateWorld(CFG('mates'), DEFAULT_AGENTS.length, { agents: DEFAULT_AGENTS });
    const soc = generateWorld(CFG('mates'), DEFAULT_AGENTS.length, {
      agents: DEFAULT_AGENTS,
      social: { edges: [{ a: 'Elena Voss', b: "James O'Brien", kind: 'rival' }] },
    });
    expect(soc).toEqual(base);
  });

  it('socialPlacement: false → identical GenResult despite edges', () => {
    for (const seed of ['off-a', 'off-b', 'off-c']) {
      const base = generateWorld(CFG(seed), DEFAULT_AGENTS.length, { agents: DEFAULT_AGENTS });
      const off = generateWorld({ ...CFG(seed), socialPlacement: false }, DEFAULT_AGENTS.length, {
        agents: DEFAULT_AGENTS, social: { edges: EDGES },
      });
      expect(off).toEqual(base);
    }
  });

  it('pinned home positions are never relabelled', () => {
    const base = generateWorld(CFG('pins'), DEFAULT_AGENTS.length, { agents: DEFAULT_AGENTS });
    const homePositions = base.locations
      .filter((l) => l.type === 'home')
      .map((h) => ({ x: h.position.x, y: h.position.y }));
    const cfg = { ...CFG('pins'), overrides: { homePositions } };
    const pinned = generateWorld(cfg, DEFAULT_AGENTS.length, {
      agents: DEFAULT_AGENTS, social: { edges: EDGES },
    });
    expect(pinned.locations.filter((l) => l.type === 'home').map((h) => h.position))
      .toEqual(base.locations.filter((l) => l.type === 'home').map((h) => h.position));
  });
});
