/**
 * What every living resident is to one person: the DB half of pickCallers.ts.
 *
 * Ties, from the tables that hold them:
 *   spouse / fiance  — the `married` / `engaged` tag on the pair's row;
 *   partner          — status `partners` without either tag;
 *   family           — the other parent of one of their children (`children`);
 *   housemate        — same home;
 *   best_friend / friend / acquaintance — the candidate's own friendship toward them (>= 70 / >= 40 / >= 20);
 *   coworker         — same workplace;
 *   clique           — same clique (lib/cliques.ts);
 *   neighbour        — one of the NEIGHBOURS homes nearest theirs (a different house);
 *   townsfolk        — everyone (a newcomer's welcome is the one kind that reaches this far).
 */
import { and, eq, or } from 'drizzle-orm';
import { db } from '../../db';
import { agents, children, economy, locations, relationships } from '../../db/schema';
import { getAgentStates, getEffectivePersonality } from '../states';
import { cliqueIdOf } from '../cliques';
import { ENGAGED_TAG, MARRIED_TAG } from '../marriage';
import type { PersonalityProfile } from '../personality';
import { callOf } from './engine';
import type { CallerCandidate, TieKind } from './pickCallers';

export const BEST_FRIEND_LEVEL = 70;
export const FRIEND_LEVEL = 40;
/**
 * The soaks' towns sit mostly between 20 and 40 (8% of pairs are friends both
 * ways at day 12), so friends alone left most birthdays with no possible caller.
 */
export const ACQUAINTANCE_LEVEL = 20;
/** Houses nearest the target's that count as neighbours. */
const NEIGHBOURS = 3;
const HOSTILE_STATUSES = new Set(['rivals', 'enemies', 'estranged']);
/** In no state to go and see anyone (sick callers would only carry it in). */
const UNAVAILABLE_STATES = new Set(['arrested', 'sick', 'depressed']);

type AgentRow = typeof agents.$inferSelect;

/**
 * Every living resident but the target, with their ties to them. The target is
 * normally living too; a funeral (lib/gatherings) asks the ties of someone who
 * has just died, so `opts.anyTarget` reads the target whether or not they are active.
 */
export function gatherCandidates(targetId: number, opts: { anyTarget?: boolean } = {}): CallerCandidate[] {
  const living = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const target = living.find((a) => a.id === targetId)
    ?? (opts.anyTarget ? db.select().from(agents).where(eq(agents.id, targetId)).get() : undefined);
  if (!target) return [];
  const rels = db.select().from(relationships)
    .where(or(eq(relationships.agent_a, targetId), eq(relationships.agent_b, targetId))).all();
  const relWith = new Map(rels.map((r) => [r.agent_a === targetId ? r.agent_b : r.agent_a, r]));
  const coParents = coParentsOf(targetId);
  const neighbours = nearestNeighbours(target, living);
  const money = new Map(db.select({ id: economy.agent_id, money: economy.money }).from(economy).all().map((e) => [e.id, e.money]));
  const targetClique = cliqueIdOf(targetId);

  return living.filter((a) => a.id !== targetId).map((a) => {
    const rel = relWith.get(a.id);
    // The candidate's own regard for the target: `_ab` is how agent_a feels.
    const friendship = rel ? (rel.agent_a === a.id ? rel.friendship_ab : rel.friendship_ba) : 0;
    const ties: TieKind[] = [];
    if (rel?.tags.includes(MARRIED_TAG)) ties.push('spouse');
    else if (rel?.tags.includes(ENGAGED_TAG)) ties.push('fiance');
    else if (rel?.status === 'partners') ties.push('partner');
    if (coParents.has(a.id)) ties.push('family');
    if (a.home != null && a.home === target.home) ties.push('housemate');
    if (friendship >= BEST_FRIEND_LEVEL) ties.push('best_friend');
    else if (friendship >= FRIEND_LEVEL) ties.push('friend');
    else if (friendship >= ACQUAINTANCE_LEVEL) ties.push('acquaintance');
    if (a.workplace != null && a.workplace === target.workplace) ties.push('coworker');
    if (targetClique != null && cliqueIdOf(a.id) === targetClique) ties.push('clique');
    if (neighbours.has(a.id)) ties.push('neighbour');
    ties.push('townsfolk');
    const p = getEffectivePersonality(a.id) ?? (a.personality as PersonalityProfile | null);
    const states = getAgentStates(a.id) as string[];
    return {
      id: a.id,
      ties,
      friendship,
      hostile: (rel != null && HOSTILE_STATUSES.has(rel.status)) || friendship < -10,
      unavailable: states.some((s) => UNAVAILABLE_STATES.has(s)) || (a.current_action as { type?: string } | null)?.type === 'dead',
      busy: callOf(a.id) != null,
      warmth: p?.warmth ?? 50,
      loyalty: p?.loyalty ?? 50,
      morality: p?.morality ?? 50,
      curiosity: p?.curiosity ?? 50,
      money: money.get(a.id) ?? 0,
      age: a.age,
    };
  });
}

/** The other parent of each of `agentId`'s children. */
function coParentsOf(agentId: number): Set<number> {
  const rows = db.select({ m: children.mother_id, f: children.father_id }).from(children)
    .where(and(eq(children.alive, true), or(eq(children.mother_id, agentId), eq(children.father_id, agentId)))).all();
  const out = new Set<number>();
  for (const r of rows) for (const id of [r.m, r.f]) if (id != null && id !== agentId) out.add(id);
  return out;
}

/** Residents of the NEIGHBOURS houses nearest the target's (not their own). */
function nearestNeighbours(target: AgentRow, living: AgentRow[]): Set<number> {
  if (target.home == null) return new Set();
  const homes = new Map(db.select({ id: locations.id, position: locations.position }).from(locations).all()
    .map((l) => [l.id, l.position as { x: number; y: number }]));
  const mine = homes.get(target.home);
  if (!mine) return new Set();
  const otherHomes = [...new Set(living.map((a) => a.home).filter((h): h is number => h != null && h !== target.home))]
    .filter((h) => homes.has(h))
    .sort((x, y) => dist(homes.get(x)!, mine) - dist(homes.get(y)!, mine) || x - y)
    .slice(0, NEIGHBOURS);
  const near = new Set(otherHomes);
  return new Set(living.filter((a) => a.home != null && near.has(a.home)).map((a) => a.id));
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
