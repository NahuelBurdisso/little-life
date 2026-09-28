/**
 * Social home placement — who should live near whom.
 *
 * The homes stage picks plots by zoning and street frontage and then used to hand
 * them out as `Home 1..N` in the order the exponential race happened to draw
 * them, so which household lived next to which was pure chance. Distance is one
 * of the strongest levers the simulation has on who meets whom: agents walk at
 * half a tile per game minute, every non-home destination is scored by
 * 640 / (640 + d), a critical social need sends an agent to the *nearest*
 * friend, perception reaches only ~80 px, and neighbours share routes and
 * venues. So the relationship graph the player set up should decide the map:
 *   - rivals next door, so the grudge gets fed on the doorstep every morning;
 *   - friends and lovers nearby, so comfort visits are cheap enough to happen;
 *   - secret lovers across town, so every meeting is a trip someone can notice.
 *
 * This module is pure (the client imports worldgen). It has two halves:
 * `buildSocialEdges` turns the wizard's relationship rows plus the scenario the
 * drama sliders generate into a deduplicated list of named edges, and
 * `assignHomeLabels` solves the small label → plot assignment the homes stage
 * asks for.
 */
import type { RelationshipConfig } from '../../../src/components/setup/types';

export type SocialEdgeKind = 'rival' | 'secret_lovers' | 'lovers' | 'friends';

/** An undirected social tie between two agents, by name. `a < b` always. */
export interface SocialEdge {
  a: string;
  b: string;
  kind: SocialEdgeKind;
}

/**
 * The slice of `setupGenerator`'s `GenerationResult` this module reads, typed
 * structurally so worldgen does not import a module that pulls in the secret and
 * romance pools. Agent references are indices into the same `agents` array that
 * was handed to the generator.
 */
export interface SocialScenario {
  romanceThreads: ReadonlyArray<{
    template_id: string;
    romance_values: ReadonlyArray<{ from: number; to: number; value: number }>;
    friendship_deltas?: ReadonlyArray<{ from: number; to: number; delta: number }>;
  }>;
  rivalPairs: ReadonlyArray<readonly [number, number]>;
}

export type SocialRelationship = Pick<
  RelationshipConfig,
  'agentAName' | 'agentBName' | 'friendshipAB' | 'friendshipBA' | 'romanceAB' | 'romanceBA' | 'status' | 'tags'
>;

/** `rival` is what `seedWorld` writes for a scenario rival pair; `rivals` and
 *  `enemies` are the wizard's statuses. */
const RIVAL_STATUSES: ReadonlySet<string> = new Set(['rival', 'rivals', 'enemies']);
const RIVAL_TAGS: ReadonlySet<string> = new Set(['rival', 'grudge', 'antagonist']);
/**
 * The only romance templates that make a pair secret lovers: an affair the pair
 * has to hide. Deliberately *not* "any thread carrying a `secret` row" — nearly
 * every template attaches one (mutual_crush, unrequited, love_triangle,
 * jealousy_seed), but those secrets are about hidden feelings, not a hidden
 * relationship, and pushing a crush across town would starve exactly the
 * encounters the thread exists to produce. Those threads only contribute their
 * romance values and fall through to lovers / friends / rival like any pair.
 */
const SECRET_ROMANCE_TEMPLATES: ReadonlySet<string> = new Set(['secret_fling', 'forbidden']);
/** Both directions must reach this for a pair to count as friends. A one-sided
 *  feeling is not a reason to move a household. */
const FRIENDS_THRESHOLD = 50;
/**
 * Both directions must reach this for a pair to count as lovers. Lower than the
 * friendship bar because romance runs on a lower scale: at 50 the kind was
 * dead — no romance template reaches it both ways (mutual_crush is 50/45) and
 * the default cast's one couple, Lucia/Diego at 45/55, only registered as
 * friends. 40 takes both while still excluding the one-sided shapes
 * (unrequited 55/0, jealousy_seed 40/0) and the slow starters (emerging_tension
 * 15/10, slow_burn 8/5).
 */
const LOVERS_THRESHOLD = 40;

interface StagedPair {
  lo: string;
  hi: string;
  friendshipLoHi: number;
  friendshipHiLo: number;
  romanceLoHi: number;
  romanceHiLo: number;
  status: string;
  tags: string[];
  scenarioRival: boolean;
  secret: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Classify the relationship graph into home-placement edges.
 *
 * Mirrors how `seedWorld` (server/routers/setup.ts) merges the same inputs into
 * relationship rows — config rows first (a later row for the same pair replaces
 * an earlier one), then the scenario's romance threads overwrite romance values
 * and add friendship deltas, then rival pairs — so the edges describe the town
 * that will actually be seeded, not just the wizard's table. The trust delta is
 * ignored: no edge kind depends on trust.
 *
 * One kind per pair, by precedence secret_lovers > rival > lovers > friends. An
 * affair thread (`secret_fling` / `forbidden`) outranks a rivalry because the
 * generator draws rival pairs at random from the trust slider while a romance
 * thread is a deliberate story, and the story only works if the pair has to
 * cross town to meet; rivalry outranks
 * open affection because it is the tie with the most to gain from proximity.
 *
 * Pairs that share a home are dropped — housemates already share a door, and no
 * assignment can move them — as are self-pairs and names not in `agents`.
 * Output is sorted by (a, b) so the result is independent of input order.
 */
export function buildSocialEdges(
  relationships: ReadonlyArray<SocialRelationship>,
  scenario: SocialScenario | null | undefined,
  agents: ReadonlyArray<{ name: string; homeName: string }>,
): SocialEdge[] {
  const homeOf = new Map<string, string>();
  for (const a of agents) if (!homeOf.has(a.name)) homeOf.set(a.name, a.homeName);

  const staged = new Map<string, StagedPair>();
  const pairFor = (x: string, y: string): StagedPair | null => {
    if (x === y || !homeOf.has(x) || !homeOf.has(y)) return null;
    const [lo, hi] = x < y ? [x, y] : [y, x];
    const key = `${lo}\u0000${hi}`;
    let p = staged.get(key);
    if (!p) {
      p = {
        lo, hi,
        friendshipLoHi: 0, friendshipHiLo: 0, romanceLoHi: 0, romanceHiLo: 0,
        status: '', tags: [], scenarioRival: false, secret: false,
      };
      staged.set(key, p);
    }
    return p;
  };

  for (const r of relationships) {
    const p = pairFor(r.agentAName, r.agentBName);
    if (!p) continue;
    const aIsLo = r.agentAName === p.lo;
    p.friendshipLoHi = aIsLo ? r.friendshipAB : r.friendshipBA;
    p.friendshipHiLo = aIsLo ? r.friendshipBA : r.friendshipAB;
    p.romanceLoHi = aIsLo ? r.romanceAB : r.romanceBA;
    p.romanceHiLo = aIsLo ? r.romanceBA : r.romanceAB;
    p.status = r.status;
    p.tags = [...r.tags];
  }

  if (scenario) {
    const nameAt = (i: number): string | undefined => agents[i]?.name;
    for (const thread of scenario.romanceThreads) {
      const secret = SECRET_ROMANCE_TEMPLATES.has(thread.template_id);
      for (const rv of thread.romance_values) {
        const from = nameAt(rv.from), to = nameAt(rv.to);
        if (from === undefined || to === undefined) continue;
        const p = pairFor(from, to);
        if (!p) continue;
        const v = clamp(rv.value, 0, 100);
        if (from === p.lo) p.romanceLoHi = v; else p.romanceHiLo = v;
        if (secret) p.secret = true;
      }
      for (const fd of thread.friendship_deltas ?? []) {
        const from = nameAt(fd.from), to = nameAt(fd.to);
        if (from === undefined || to === undefined) continue;
        const p = pairFor(from, to);
        if (!p) continue;
        if (from === p.lo) p.friendshipLoHi = clamp(p.friendshipLoHi + fd.delta, -100, 100);
        else p.friendshipHiLo = clamp(p.friendshipHiLo + fd.delta, -100, 100);
      }
    }
    for (const [ai, bi] of scenario.rivalPairs) {
      const a = nameAt(ai), b = nameAt(bi);
      if (a === undefined || b === undefined) continue;
      const p = pairFor(a, b);
      if (p) p.scenarioRival = true;
    }
  }

  const edges: SocialEdge[] = [];
  for (const p of staged.values()) {
    if (homeOf.get(p.lo) === homeOf.get(p.hi)) continue; // housemates
    const kind = classify(p);
    if (kind) edges.push({ a: p.lo, b: p.hi, kind });
  }
  edges.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return edges;
}

function classify(p: StagedPair): SocialEdgeKind | null {
  if (p.secret) return 'secret_lovers';
  if (p.scenarioRival || RIVAL_STATUSES.has(p.status) || p.tags.some((t) => RIVAL_TAGS.has(t))) {
    return 'rival';
  }
  if (Math.min(p.romanceLoHi, p.romanceHiLo) >= LOVERS_THRESHOLD) return 'lovers';
  if (Math.min(p.friendshipLoHi, p.friendshipHiLo) >= FRIENDS_THRESHOLD) return 'friends';
  return null;
}

// ─── Assignment ──────────────────────────────────────────────────────────────

/**
 * Cost weights, per tile of Manhattan door-to-door distance.
 *
 * Rivals pull hardest (3): proximity is the whole point of the edge and there
 * are only ever a handful of them, so they should win against the friend web
 * when the two disagree. Lovers (1.5) and friends (1) pull more gently — they
 * already seek each other out through the social need, so distance only changes
 * how cheap that visit is — and there are many more friend edges, which summed
 * would otherwise swamp the rival term.
 *
 * Secret lovers are *rewarded* for distance (3 per tile) but only up to
 * SECRET_CAP tiles. Uncapped, the term would keep paying for every extra tile and
 * pin affairs to opposite map corners at the expense of every other edge; past
 * ~40 tiles (an 80-minute walk, well above the ~27-tile median home-pair
 * distance of the default 13-agent town) the pair is already "across town" and
 * further gains are not worth trading anything for. Measured on the default
 * cast plus a secret fling between two well-connected agents over 60 seeds: a
 * 30-tile cap left the affair above the median pair distance in 52/60 worlds —
 * the lovers' friend edges pulled them back in — while 40 did in 60/60, with
 * the rival pair unchanged (below the median in 60/60 either way).
 *
 * Workplace pull (0.25 per resident) is a tie-breaker, not a driver: it nudges a
 * household toward its commute when the social terms are indifferent, but a
 * single friend edge outweighs four residents' commutes.
 */
export const SOCIAL_WEIGHTS = {
  rival: 3,
  lovers: 1.5,
  friends: 1,
  secretLovers: 3,
  secretCap: 40,
  workplace: 0.25,
} as const;

/** Swap passes are bounded; in practice the climb converges in 2-4. */
const MAX_PASSES = 32;

export interface TilePoint { x: number; y: number }

/** Aggregated tie between two home labels. `near` is paid per tile of
 *  distance, `far` is refunded per tile up to `SOCIAL_WEIGHTS.secretCap`. */
export interface LabelPair { u: number; v: number; near: number; far: number }

export interface HomeAssignmentProblem {
  /** Door tile of each chosen plot, by plot index. */
  plotDoors: ReadonlyArray<TilePoint>;
  /** Label ↔ label ties; labels index the same range as `plotDoors`. */
  pairs: ReadonlyArray<LabelPair>;
  /** Per label: workplace doors its residents commute to, with weights. */
  anchors: ReadonlyArray<ReadonlyArray<TilePoint & { weight: number }>>;
}

const manhattan = (a: TilePoint, b: TilePoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Aggregate named edges into label pairs. `labelOf` maps an agent name to its
 * home label, or undefined for an agent without a generated home. Edges whose
 * endpoints share a label are dropped (housemates). Output order is by (u, v).
 */
export function edgesToLabelPairs(
  edges: ReadonlyArray<SocialEdge>,
  labelOf: (name: string) => number | undefined,
): LabelPair[] {
  const byKey = new Map<string, LabelPair>();
  for (const e of edges) {
    const la = labelOf(e.a), lb = labelOf(e.b);
    if (la === undefined || lb === undefined || la === lb) continue;
    const u = Math.min(la, lb), v = Math.max(la, lb);
    const key = `${u}:${v}`;
    let p = byKey.get(key);
    if (!p) { p = { u, v, near: 0, far: 0 }; byKey.set(key, p); }
    switch (e.kind) {
      case 'rival': p.near += SOCIAL_WEIGHTS.rival; break;
      case 'lovers': p.near += SOCIAL_WEIGHTS.lovers; break;
      case 'friends': p.near += SOCIAL_WEIGHTS.friends; break;
      case 'secret_lovers': p.far += SOCIAL_WEIGHTS.secretLovers; break;
    }
  }
  return [...byKey.values()].sort((a, b) => a.u - b.u || a.v - b.v);
}

/**
 * Total cost of a label → plot assignment. Exported for tests and diagnostics.
 */
export function assignmentCost(problem: HomeAssignmentProblem, perm: ReadonlyArray<number>): number {
  const { plotDoors, pairs, anchors } = problem;
  let cost = 0;
  for (const p of pairs) {
    const d = manhattan(plotDoors[perm[p.u]], plotDoors[perm[p.v]]);
    cost += p.near * d - p.far * Math.min(d, SOCIAL_WEIGHTS.secretCap);
  }
  for (let u = 0; u < anchors.length; u++) {
    for (const a of anchors[u]) cost += a.weight * manhattan(plotDoors[perm[u]], a);
  }
  return cost;
}

/**
 * Choose which plot each home label gets. Returns `perm` with `perm[label] =
 * plotIndex`, starting from and falling back to the identity.
 *
 * Pairwise-swap hill climbing: sweep every label pair (i < j) in index order,
 * swap their plots when that strictly lowers the cost, and repeat until a full
 * pass makes no swap (or MAX_PASSES). With n plots for n labels a swap is the
 * complete move set, n ≤ 32 keeps a pass under ~500 swap evaluations, and the
 * sweep order is fixed, so the result is a pure function of the input — no rng
 * is drawn, which is what keeps the homes stage's own stream (and therefore the
 * description shuffle after it) byte-identical to a world without social input.
 *
 * The starting point is the identity, i.e. the plots in the random order the
 * selection race drew them, so the local optimum the climb lands in still varies
 * with the seed rather than always favouring, say, the north-west corner.
 */
export function assignHomeLabels(problem: HomeAssignmentProblem): number[] {
  const n = problem.plotDoors.length;
  const perm = Array.from({ length: n }, (_, i) => i);
  if (problem.pairs.length === 0) return perm;

  // Per-label adjacency so a swap is evaluated from the terms it touches only.
  const adj: Array<Array<{ other: number; near: number; far: number }>> =
    Array.from({ length: n }, () => []);
  for (const p of problem.pairs) {
    adj[p.u].push({ other: p.v, near: p.near, far: p.far });
    adj[p.v].push({ other: p.u, near: p.near, far: p.far });
  }
  const doors = problem.plotDoors;
  const labelCost = (u: number): number => {
    const at = doors[perm[u]];
    let c = 0;
    for (const e of adj[u]) {
      const d = manhattan(at, doors[perm[e.other]]);
      c += e.near * d - e.far * Math.min(d, SOCIAL_WEIGHTS.secretCap);
    }
    for (const a of problem.anchors[u] ?? []) c += a.weight * manhattan(at, a);
    return c;
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        // Two labels with no ties and no anchors are interchangeable.
        if (adj[i].length === 0 && adj[j].length === 0 &&
            !(problem.anchors[i]?.length) && !(problem.anchors[j]?.length)) continue;
        const before = labelCost(i) + labelCost(j);
        [perm[i], perm[j]] = [perm[j], perm[i]];
        const after = labelCost(i) + labelCost(j);
        // The i–j term is counted in both sums on both sides and cancels. The
        // epsilon keeps float noise from ping-ponging a swap of equal cost.
        if (after < before - 1e-9) {
          improved = true;
        } else {
          [perm[i], perm[j]] = [perm[j], perm[i]];
        }
      }
    }
    if (!improved) break;
  }
  return perm;
}
