import { MARRIED_TAG } from '../marriage';
import { isAdultAge } from '../intimacy/eligibility';
import { mayRomanceGrow } from '../intimacy/attraction';
import {
  AIM_KINDS, ENEMIES_AT, FRIENDS_AT, RIVALS_AT,
  agentOf, firstName, pairOf,
  type PairAim, type TownSnapshot,
} from './catalog';
import { HOSTILE } from './evaluate';
import { DURATION_DAYS, spokenFor, type OfferDraft } from './suggest';

/**
 * "Set a goal" from the pair dossier: the player points at two residents and
 * says what they want for them. An aim is NOT a new kind of challenge. Each one
 * maps to a kind the evaluator already judges (marry → matchmaker, befriend →
 * peacemaker, sunder → feud), so the progress bar, the `challenge_*` feed rows,
 * the player-tier alerts and the fanfare all come for free.
 *
 * The offer builder (suggest.ts) only proposes what the town already supports
 * (a matchmaker pair is already sweet on each other). An aim is the player's
 * choice, so it is looser (a long shot is allowed), but it still refuses what
 * can never happen or is already true: two minors' wedding, a marriage that
 * exists, friends made friends, rivals made rivals. Every refusal is a sentence
 * the toast can show as it is.
 *
 * Pure: the town comes from snapshot.ts, and the two residents' gender and
 * orientation (which the snapshot does not carry) from `parties`.
 */

/** What `mayRomanceGrow` needs of a resident, read from the agents table by the service. */
export interface AimParty {
  id: number;
  age: number;
  gender: string;
  orientation?: string | null;
}

export type AimDraft = { ok: true; draft: OfferDraft } | { ok: false; reason: string };

const refuse = (reason: string): AimDraft => ({ ok: false, reason });

export function draftAim(snap: TownSnapshot, a: number, b: number, aim: PairAim, parties: readonly AimParty[]): AimDraft {
  if (a === b) return refuse('Pick two different residents');
  for (const id of [a, b]) {
    if (!agentOf(snap, id)?.active) return refuse(`${firstName(snap, id)} isn't in town any more`);
  }
  const p = pairOf(snap, a, b);
  // Named in the pair's own (lo, hi) order, so the same pair always reads the same however the player reached it.
  const names = `${firstName(snap, p.a)} and ${firstName(snap, p.b)}`;
  const base: Pick<OfferDraft, 'agentIds' | 'durationDays' | 'kind'> = {
    agentIds: [p.a, p.b], durationDays: DURATION_DAYS[AIM_KINDS[aim]], kind: AIM_KINDS[aim],
  };

  switch (aim) {
    case 'marry': {
      const pa = parties.find((x) => x.id === a);
      const pb = parties.find((x) => x.id === b);
      if (!pa || !pb) return refuse(`${names} can't be looked up`);
      for (const x of [pa, pb]) {
        if (!isAdultAge(x.age)) return refuse(`${firstName(snap, x.id)} is too young to marry`);
      }
      if (!mayRomanceGrow(pa, pb) || !mayRomanceGrow(pb, pa)) {
        return refuse(`${names} aren't drawn to each other that way, so romance can't grow between them`);
      }
      if (p.tags.includes(MARRIED_TAG)) return refuse(`${names} are already married`);
      for (const [x, y] of [[a, b], [b, a]]) {
        if (spokenFor(snap, x, y)) return refuse(`${firstName(snap, x)} is already engaged or married to someone else`);
      }
      if (p.status === 'estranged') return refuse(`${names} are estranged for good`);
      return {
        ok: true,
        draft: { ...base, difficulty: 'hard', goal: `Get ${names} married (your aim)` },
      };
    }
    case 'befriend': {
      if (p.friendship >= FRIENDS_AT) return refuse(`${names} are already friends`);
      return {
        ok: true,
        draft: {
          ...base,
          difficulty: p.friendship <= ENEMIES_AT ? 'hard' : p.friendship <= RIVALS_AT ? 'medium' : 'easy',
          goal: `Make ${names} friends (your aim)`,
        },
      };
    }
    case 'sunder': {
      if (p.friendship <= RIVALS_AT || HOSTILE.has(p.status)) return refuse(`${names} are already at odds`);
      return {
        ok: true,
        draft: {
          ...base,
          difficulty: p.friendship >= FRIENDS_AT ? 'hard' : 'medium',
          goal: `Turn ${names} against each other (your aim)`,
        },
      };
    }
  }
}
