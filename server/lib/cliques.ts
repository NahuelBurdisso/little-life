/**
 * Cliques — the town's informal social groups, derived from the friendship
 * graph by label propagation. Nothing in the schema records a group; every
 * relationship is dyadic, so "the tavern crowd" only exists as an emergent
 * property of who likes whom. Making it explicit lets the sim act on it:
 * agents socialise inside their circle, and gossip about a circle's members
 * lands harder with the rest of that circle.
 *
 * Derived and memoised, never persisted. A restart recomputes it from the same
 * relationships and lands on the same answer — the algorithm is deterministic.
 */

import { db } from '../db';
import { agents, relationships } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface Clique {
  /** Stable across recomputes: derived from the sorted member list. */
  id: string;
  name: string;
  members: number[];
  memberNames: string[];
  /** 0..1 — mean mutual friendship across all member pairs, non-edges included. */
  cohesion: number;
}

/** Below this mutual friendship the two aren't in each other's circle. */
const MIN_EDGE_WEIGHT = 25;
/** Two people are a pair, not a group. */
const MIN_CLIQUE_SIZE = 3;
/** Label propagation settles in a handful of passes on a graph this small. */
const MAX_ITERATIONS = 20;
const CACHE_TTL_MS = 5000;

/** Socialising bonus toward someone in the same circle. */
const IN_GROUP_BONUS = 14;
/**
 * Penalty toward someone in a *different* circle. The bonus alone would just
 * make everyone slightly more sociable; it's the out-group drag that actually
 * makes the groups visible in where people spend their time.
 */
const OUT_GROUP_PENALTY = -6;

export interface CliqueInput {
  agents: { id: number; name: string }[];
  relationships: typeof relationships.$inferSelect[];
}

/**
 * Label propagation over the friendship graph. Deterministic: nodes are visited
 * in ascending id order and ties are broken by the lowest label, so the same
 * graph always yields the same grouping.
 */
export function computeCliques(input: CliqueInput): Clique[] {
  const nameOf = new Map(input.agents.map((a) => [a.id, a.name]));
  const nodes = input.agents.map((a) => a.id).sort((a, b) => a - b);
  if (nodes.length < MIN_CLIQUE_SIZE) return [];

  const neighbours = new Map<number, { id: number; weight: number }[]>();
  for (const id of nodes) neighbours.set(id, []);

  for (const rel of input.relationships) {
    // The weaker direction, because a circle you aren't welcomed into isn't a
    // circle. Averaging instead would let one person's infatuation drag an
    // indifferent other into their group.
    const weight = Math.min(rel.friendship_ab, rel.friendship_ba);
    if (weight < MIN_EDGE_WEIGHT) continue;
    const a = neighbours.get(rel.agent_a);
    const b = neighbours.get(rel.agent_b);
    if (!a || !b) continue; // one of them is inactive
    a.push({ id: rel.agent_b, weight });
    b.push({ id: rel.agent_a, weight });
  }

  const labels = new Map<number, number>(nodes.map((id) => [id, id]));

  for (let pass = 0; pass < MAX_ITERATIONS; pass++) {
    let changed = false;
    for (const id of nodes) {
      const adj = neighbours.get(id)!;
      if (adj.length === 0) continue;

      const weightByLabel = new Map<number, number>();
      for (const edge of adj) {
        const label = labels.get(edge.id)!;
        weightByLabel.set(label, (weightByLabel.get(label) ?? 0) + edge.weight);
      }

      let best = labels.get(id)!;
      let bestWeight = -1;
      for (const [label, weight] of weightByLabel) {
        if (weight > bestWeight || (weight === bestWeight && label < best)) {
          best = label;
          bestWeight = weight;
        }
      }
      if (best !== labels.get(id)) {
        labels.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Edge lookup for cohesion and for picking the member at the centre.
  const weightBetween = new Map<string, number>();
  for (const [id, adj] of neighbours) {
    for (const edge of adj) {
      if (id < edge.id) weightBetween.set(`${id}-${edge.id}`, edge.weight);
    }
  }

  const byLabel = new Map<number, number[]>();
  for (const id of nodes) {
    const label = labels.get(id)!;
    const group = byLabel.get(label);
    if (group) group.push(id);
    else byLabel.set(label, [id]);
  }

  const cliques: Clique[] = [];
  for (const members of byLabel.values()) {
    if (members.length < MIN_CLIQUE_SIZE) continue;
    members.sort((a, b) => a - b);

    let total = 0;
    const pull = new Map<number, number>(members.map((id) => [id, 0]));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const w = weightBetween.get(`${members[i]}-${members[j]}`) ?? 0;
        total += w;
        pull.set(members[i], pull.get(members[i])! + w);
        pull.set(members[j], pull.get(members[j])! + w);
      }
    }
    const pairs = (members.length * (members.length - 1)) / 2;

    // The circle is named after whoever holds it together, so the label stays
    // put as long as that person does.
    let centre = members[0];
    for (const id of members) {
      if (pull.get(id)! > pull.get(centre)!) centre = id;
    }

    cliques.push({
      id: `clique:${members.join('-')}`,
      name: `${nameOf.get(centre) ?? `#${centre}`}'s circle`,
      members,
      memberNames: members.map((id) => nameOf.get(id) ?? `#${id}`),
      cohesion: Math.min(1, total / pairs / 100),
    });
  }

  return cliques.sort((a, b) => b.members.length - a.members.length || b.cohesion - a.cohesion);
}

interface CacheEntry {
  at: number;
  cliques: Clique[];
  /** agent id -> clique id, so the per-pair lookups below stay O(1). */
  membership: Map<number, string>;
}

let cache: CacheEntry | null = null;

/** Drops the memo. Tests need this; production just waits out the TTL. */
export function resetCliqueCache() {
  cache = null;
}

function current(): CacheEntry {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache;

  const cliques = computeCliques({
    agents: db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.is_active, true))
      .all(),
    relationships: db.select().from(relationships).all(),
  });

  const membership = new Map<number, string>();
  for (const clique of cliques) {
    for (const id of clique.members) membership.set(id, clique.id);
  }

  cache = { at: now, cliques, membership };
  return cache;
}

export function getCliques(): Clique[] {
  return current().cliques;
}

/** The clique id an agent belongs to, or null if they float between groups. */
export function cliqueIdOf(agentId: number): string | null {
  return current().membership.get(agentId) ?? null;
}

/**
 * Socialising score adjustment for one agent considering another. Unaffiliated
 * agents get nothing either way: a loner has no circle to prefer and no circle
 * to be shut out of, and penalising them would leave them permanently alone.
 */
export function cliqueSocialModifier(agentA: number, agentB: number): number {
  const { membership } = current();
  const a = membership.get(agentA);
  const b = membership.get(agentB);
  if (a == null || b == null) return 0;
  return a === b ? IN_GROUP_BONUS : OUT_GROUP_PENALTY;
}
