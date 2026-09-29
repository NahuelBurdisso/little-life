/**
 * Starting ties: the relationships a town has simply because of who lives and
 * works where, before any scenario or authored backstory is layered on.
 *
 * Why this exists (B16 / E7). `setup.initialize` used to seed only the rows the
 * wizard posted — six authored pairs in the default cast — plus whatever the
 * drama sliders added. Everyone else started as a stranger, including people who
 * share a house or a workplace. That starved the first days in two ways:
 *   - decisions.ts only scores a *non co-located* agent as a social target when
 *     the pair has friendship or romance above ~10, so an agent with no seeded
 *     ties had nobody to go and find; conversations piled onto the six authored
 *     pairs and everybody else drained social until the loneliness state fired;
 *   - friendship had to be built from zero by chance encounters, so the town
 *     only reached its steady social level around day 4, when proximity and
 *     encounters had finally produced enough "friendship > 10" edges.
 *
 * Pure (no DB, no Node): `seedWorld` stages these BEFORE the authored rows and
 * the scenario, so an explicit relationship always wins on values and the trust
 * slider still calibrates the whole graph.
 */

export type StartingTieKind = 'housemate' | 'coworker' | 'neighbor';

export interface StartingTieAgent {
  name: string;
  homeName: string;
  workplaceName?: string | null;
  /** 0-100; tilts each direction a little so ties aren't perfectly symmetric. */
  personality?: { warmth?: number } | null;
}

export interface StartingTie {
  /** Names, in the order the cast lists them (a before b). */
  a: string;
  b: string;
  kind: StartingTieKind;
  /** a's feeling toward b, and b's toward a. */
  friendshipAB: number;
  friendshipBA: number;
  trustAB: number;
  trustBA: number;
  familiarity: number;
  status: string;
  tags: string[];
}

/**
 * Baselines per kind. The friendship values sit on the right side of
 * thresholds the engine reads:
 *   - above 10 (every kind): decisions.ts:674 counts the pair as a social
 *     target even when they are not in the same building — the whole point;
 *   - at most 40 (every kind, warmth tilt included): `friendship > 40` is where
 *     a pair stops being "acquaintances" and starts costing LLM calls and other
 *     friend-only behaviour — decisions.ts:1966 and :2060 upgrade a template
 *     chat to an LLM one, decisions.ts:1889 (money gifts), states.ts:1757,
 *     ai/prompts.ts:193 (friend framing) — and `deriveStatus` calls it
 *     "friends". A structural tie is not a friendship; those thresholds stay
 *     reserved for authored and earned ones, so seeding ties adds no LLM load.
 *     (40 itself reaches ai/templates.ts:40's `>= 40` friendly greeting, which
 *     is template text only.) The grieving and "+15 friend" bands (> 50) are
 *     out of reach for the same reason;
 *   - familiarity ≥ 5 means a first chat is not escalated to an LLM "first
 *     meeting" — they already know each other, and the housemates' 70 is what
 *     "know each other well" means here.
 * The strongest kind wins when a pair qualifies twice (housemates who also
 * work together are housemates, tagged with both). Tags reuse the authored
 * vocabulary (`coworkers`, as in server/data/agents.ts).
 */
export const STARTING_TIE_BASELINES: Record<StartingTieKind, {
  friendship: number; trust: number; familiarity: number; status: string; tag: string;
}> = {
  housemate: { friendship: 36, trust: 40, familiarity: 70, status: 'acquaintances', tag: 'housemate' },
  coworker: { friendship: 22, trust: 20, familiarity: 45, status: 'acquaintances', tag: 'coworkers' },
  neighbor: { friendship: 14, trust: 10, familiarity: 25, status: 'acquaintances', tag: 'neighbor' },
};

/** Ceiling for any structural tie's friendship (see STARTING_TIE_BASELINES). */
export const STARTING_TIE_MAX_FRIENDSHIP = 40;

const KIND_RANK: Record<StartingTieKind, number> = { housemate: 3, coworker: 2, neighbor: 1 };

/**
 * Warmth 50 is neutral; each 10 points either way moves that agent's feeling by
 * 2, so a warm agent (70) likes their housemate at 40 and a cold one (30) at 32.
 * Kept between the "social target" floor of 11 and STARTING_TIE_MAX_FRIENDSHIP.
 */
function tilt(base: number, warmth: number | undefined): number {
  const w = typeof warmth === 'number' ? warmth : 50;
  return Math.min(STARTING_TIE_MAX_FRIENDSHIP, Math.max(11, Math.round(base + (w - 50) / 5)));
}

/**
 * Every structural tie in the cast.
 *
 * @param homeDoors door tile of each home by name (from the generated world).
 *   Each household counts its single nearest other household as neighbours
 *   (and is counted by theirs), so every home has at least one neighbour pair
 *   without the whole street befriending the whole street. Homes missing from
 *   the map (or a map not passed) just get no neighbour ties.
 */
export function buildStartingTies(
  cast: ReadonlyArray<StartingTieAgent>,
  homeDoors?: ReadonlyMap<string, { x: number; y: number }>,
): StartingTie[] {
  const index = new Map<string, number>();
  cast.forEach((c, i) => { if (!index.has(c.name)) index.set(c.name, i); });
  const members = [...index.keys()].map((n) => cast[index.get(n)!]);

  const kinds = new Map<string, Set<StartingTieKind>>();
  const pairKey = (x: StartingTieAgent, y: StartingTieAgent) =>
    index.get(x.name)! < index.get(y.name)! ? `${x.name}\u0000${y.name}` : `${y.name}\u0000${x.name}`;
  const add = (x: StartingTieAgent, y: StartingTieAgent, kind: StartingTieKind) => {
    if (x.name === y.name) return;
    const key = pairKey(x, y);
    let set = kinds.get(key);
    if (!set) kinds.set(key, (set = new Set()));
    set.add(kind);
  };

  const byHome = new Map<string, StartingTieAgent[]>();
  for (const m of members) byHome.set(m.homeName, [...(byHome.get(m.homeName) ?? []), m]);

  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const x = members[i], y = members[j];
      if (x.homeName === y.homeName) add(x, y, 'housemate');
      if (x.workplaceName && x.workplaceName === y.workplaceName) add(x, y, 'coworker');
    }
  }

  if (homeDoors) {
    const homes = [...byHome.keys()].filter((h) => homeDoors.has(h));
    for (const h of homes) {
      const p = homeDoors.get(h)!;
      let best: string | null = null;
      let bestD = Infinity;
      for (const o of homes) {
        if (o === h) continue;
        const q = homeDoors.get(o)!;
        const d = Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
        // Ties broken by name so the result doesn't depend on Map order.
        if (d < bestD || (d === bestD && best !== null && o < best)) { best = o; bestD = d; }
      }
      if (best === null) continue;
      for (const x of byHome.get(h)!) for (const y of byHome.get(best)!) add(x, y, 'neighbor');
    }
  }

  const ties: StartingTie[] = [];
  for (const [key, set] of kinds) {
    const [aName, bName] = key.split('\u0000');
    const a = cast[index.get(aName)!], b = cast[index.get(bName)!];
    const ordered = [...set].sort((k1, k2) => KIND_RANK[k2] - KIND_RANK[k1]);
    const kind = ordered[0];
    const base = STARTING_TIE_BASELINES[kind];
    ties.push({
      a: aName,
      b: bName,
      kind,
      friendshipAB: tilt(base.friendship, a.personality?.warmth),
      friendshipBA: tilt(base.friendship, b.personality?.warmth),
      trustAB: base.trust,
      trustBA: base.trust,
      familiarity: base.familiarity,
      status: base.status,
      tags: ordered.map((k) => STARTING_TIE_BASELINES[k].tag),
    });
  }
  // Cast order, so seeding is stable across runs.
  ties.sort((t1, t2) => index.get(t1.a)! - index.get(t2.a)! || index.get(t1.b)! - index.get(t2.b)!);
  return ties;
}

/** The fields of a canonical (`agent_a < agent_b`) relationship row a tie writes. */
export interface TieRow {
  agent_a: number;
  agent_b: number;
  friendship_ab: number;
  friendship_ba: number;
  trust_ab: number;
  trust_ba: number;
  familiarity: number;
  tags: string[];
  status: string;
}

/**
 * Fold ties into rows that are about to be inserted, the way `setup.initialize`
 * stages them: an authored pair keeps its values and only gains the structural
 * tags; any other row for the pair (a filler "strangers" row, as
 * `getRelationshipSeeds` emits for every unordered pair) takes the tie's values;
 * a pair with no row gets one from `makeRow`. Rows are edited in place and
 * appended to, so the caller inserts each pair exactly once —
 * `idx_relationships_pair` is unique.
 *
 * @param authoredKeys `${lo}:${hi}` of the pairs someone actually wrote.
 * @returns how many rows took a tie's values (created or overwritten).
 */
export function foldStartingTies<T extends TieRow>(
  rows: T[],
  ties: ReadonlyArray<StartingTie>,
  idOf: (name: string) => number | undefined,
  authoredKeys: ReadonlySet<string>,
  makeRow: (lo: number, hi: number) => T,
): number {
  const byKey = new Map(rows.map((r) => [`${r.agent_a}:${r.agent_b}`, r]));
  let applied = 0;
  for (const tie of ties) {
    const aId = idOf(tie.a);
    const bId = idOf(tie.b);
    if (aId === undefined || bId === undefined || aId === bId) continue;
    const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
    const key = `${lo}:${hi}`;
    let row = byKey.get(key);
    if (row && authoredKeys.has(key)) {
      row.tags = [...new Set([...row.tags, ...tie.tags])];
      continue;
    }
    if (!row) {
      row = makeRow(lo, hi);
      rows.push(row);
      byKey.set(key, row);
    }
    const aIsLo = aId === lo;
    row.friendship_ab = aIsLo ? tie.friendshipAB : tie.friendshipBA;
    row.friendship_ba = aIsLo ? tie.friendshipBA : tie.friendshipAB;
    row.trust_ab = aIsLo ? tie.trustAB : tie.trustBA;
    row.trust_ba = aIsLo ? tie.trustBA : tie.trustAB;
    row.familiarity = tie.familiarity;
    row.status = tie.status;
    row.tags = [...tie.tags];
    applied++;
  }
  return applied;
}
