/**
 * Turning "who is this person to them" into invitation levels: the social
 * calls' tie reader (../../socialCalls/ties.ts), shared so a funeral, a
 * send-off and a wedding read ties exactly the way a sick visit does.
 */
import { gatherCandidates } from '../../socialCalls/ties';
import type { CallerCandidate, TieKind } from '../../socialCalls/pickCallers';
import { invite } from '../engine';
import type { Gathering, InviteLevel } from '../types';

/** Ties that make you family or as good as: their funeral is yours to attend. */
export const KIN: readonly TieKind[] = ['spouse', 'partner', 'fiance', 'family', 'housemate'];
/** Close friends: you should be there. */
export const FRIENDS: readonly TieKind[] = ['best_friend', 'friend'];

export interface TieInviteSpec {
  must?: readonly TieKind[];
  should?: readonly TieKind[];
  /** Everyone else qualifying (not hostile, old enough) is a `may`. */
  mayRest?: boolean;
  /** Youngest who comes on their own (default 12: children come to a funeral, not to a market). */
  minAge?: number;
  /** Offsets before the start at which each level sets off (default 45 / 30 / 15). */
  leadMin?: Partial<Record<InviteLevel, number>>;
  exclude?: ReadonlySet<number>;
}

/**
 * Invite `targetId`'s people to `g` by their ties, and return every candidate
 * read (so the kind can look at the hostile ones itself: a rival is never
 * invited by tie, only by their own roll).
 */
export function inviteByTies(g: Gathering, targetId: number, spec: TieInviteSpec, opts: { anyTarget?: boolean } = {}): CallerCandidate[] {
  const cands = gatherCandidates(targetId, opts);
  const minAge = spec.minAge ?? 12;
  const lead = { must: 45, should: 30, may: 15, ...(spec.leadMin ?? {}) };
  for (const c of cands) {
    if (c.hostile || c.age < minAge || spec.exclude?.has(c.id)) continue;
    const level: InviteLevel | null = spec.must?.some((t) => c.ties.includes(t)) ? 'must'
      : spec.should?.some((t) => c.ties.includes(t)) ? 'should'
        : spec.mayRest ? 'may' : null;
    if (level) invite(g, c.id, level, g.startMin - lead[level]);
  }
  return cands;
}

/** True when the candidate holds any of the ties. */
export function holds(c: Pick<CallerCandidate, 'ties'>, ties: readonly TieKind[]): boolean {
  return ties.some((t) => c.ties.includes(t));
}
