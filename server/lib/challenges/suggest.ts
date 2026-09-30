import { ENGAGED_TAG, MARRIED_TAG } from '../marriage';
import { ELECTION, nextElectionDay } from '../../data/calendar';
import {
  BEST_FRIEND_AT, ENEMIES_AT, FRIENDS_AT, FULL_HOUSE_EXTRA, MATCH_ROMANCE_MAX, MATCH_ROMANCE_MIN, MINUTES_PER_DAY,
  OFFER_COUNT, RIVALS_AT, SCANDAL_SECRETS,
  agentOf, firstName, guardianDeadline,
  type Challenge, type ChallengeKind, type Difficulty, type SnapPair, type TownSnapshot,
} from './catalog';

/**
 * The three offers in the Journal's 🏆 tab, built from the live town.
 *
 * A challenge about people the player has never noticed ("marry #4 and #9")
 * or a pair that can't happen (two strangers, a married man) is noise, so every
 * named challenge starts from something already true: a matchmaker pair is
 * already sweet on each other (romance 20–40, not yet a couple), a peacemaker
 * pair are already rivals or enemies, the recluse is the resident whose best
 * tie is weakest. Kinds whose premise the town lacks (no secrets to spill, no
 * friendships to break, death switched off) are simply not offered.
 *
 * One offer per difficulty when the town allows it, so the choice is between
 * a quick win, a project and a long shot rather than three of a kind.
 *
 * Pure: the snapshot comes from snapshot.ts, randomness from `rng` (tests pass
 * a seeded one).
 */

export type Rng = () => number;

/** An offer before it has an id and a clock. */
export interface OfferDraft {
  kind: ChallengeKind;
  difficulty: Difficulty;
  goal: string;
  agentIds: number[];
  target?: number;
  durationDays: number;
}

const ADULT_AGE = 18;

/** Game days per kind (Guardian runs to the season's end, Kingmaker to its election). */
export const DURATION_DAYS: Readonly<Record<Exclude<ChallengeKind, 'guardian' | 'kingmaker'>, number>> = {
  matchmaker: 14,
  peacemaker: 8,
  scandal: 5,
  hands_off: 2,
  full_house: 5,
  first_engagement: 10,
  feud: 6,
  recluse: 7,
  // Married ≥ 3 days, a modest daily roll, then a week's pregnancy (lib/family.ts).
  first_baby: 16,
};

function pick<T>(items: readonly T[], rng: Rng): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

function isActive(snap: TownSnapshot, id: number): boolean {
  return agentOf(snap, id)?.active === true;
}

/** Engaged or married to someone (living) other than `except`. */
export function spokenFor(snap: TownSnapshot, id: number, except: number): boolean {
  return snap.pairs.some((p) => {
    if (p.a !== id && p.b !== id) return false;
    const other = p.a === id ? p.b : p.a;
    return other !== except && isActive(snap, other) && (p.tags.includes(ENGAGED_TAG) || p.tags.includes(MARRIED_TAG));
  });
}

function bothActive(snap: TownSnapshot, p: SnapPair): boolean {
  return isActive(snap, p.a) && isActive(snap, p.b);
}

function names(snap: TownSnapshot, p: { a: number; b: number }): string {
  return `${firstName(snap, p.a)} and ${firstName(snap, p.b)}`;
}

/** Every challenge the town can support right now, one draft per kind. */
export function candidateOffers(snap: TownSnapshot, rng: Rng): OfferDraft[] {
  const out: OfferDraft[] = [];

  const match = snap.pairs.filter((p) => {
    if (!bothActive(snap, p)) return false;
    if ((agentOf(snap, p.a)?.age ?? 0) < ADULT_AGE || (agentOf(snap, p.b)?.age ?? 0) < ADULT_AGE) return false;
    if (p.romanceMax < MATCH_ROMANCE_MIN || p.romanceMax > MATCH_ROMANCE_MAX) return false;
    if (p.status === 'partners' || p.status === 'estranged') return false;
    if (p.tags.includes(ENGAGED_TAG) || p.tags.includes(MARRIED_TAG)) return false;
    return !spokenFor(snap, p.a, p.b) && !spokenFor(snap, p.b, p.a);
  });
  const m = pick(match, rng);
  if (m) {
    out.push({
      kind: 'matchmaker', difficulty: 'hard', goal: `Get ${names(snap, m)} married`,
      agentIds: [m.a, m.b], durationDays: DURATION_DAYS.matchmaker,
    });
  }

  const hostile = snap.pairs.filter((p) => bothActive(snap, p) && p.friendship <= RIVALS_AT && p.status !== 'estranged');
  const h = pick(hostile, rng);
  if (h) {
    const enemies = h.friendship <= ENEMIES_AT;
    out.push({
      kind: 'peacemaker', difficulty: enemies ? 'hard' : 'medium',
      goal: `Make friends of ${names(snap, h)}, now ${enemies ? 'enemies' : 'rivals'}`,
      agentIds: [h.a, h.b], durationDays: DURATION_DAYS.peacemaker,
    });
  }

  if (snap.deathEnabled) {
    const deadline = guardianDeadline(snap);
    const season = deadline === snap.seasonEndMinute ? snap.season : 'the next season';
    out.push({
      kind: 'guardian', difficulty: 'hard',
      goal: season === 'the next season' ? 'Nobody dies before the end of the next season' : `Nobody dies before ${season} ends`,
      agentIds: [], durationDays: Math.max(1, Math.ceil((deadline - snap.nowMinute) / MINUTES_PER_DAY)),
    });
  }

  if (snap.hiddenSecretCount >= SCANDAL_SECRETS) {
    out.push({
      kind: 'scandal', difficulty: 'medium', goal: `${SCANDAL_SECRETS} secrets become common knowledge within one day`,
      agentIds: [], durationDays: DURATION_DAYS.scandal,
    });
  }

  out.push({
    kind: 'hands_off', difficulty: 'easy', goal: 'Keep your hands off the town for two game days',
    agentIds: [], durationDays: DURATION_DAYS.hands_off,
  });

  const population = snap.agents.filter((a) => a.active).length;
  if (population > 0) {
    const target = population + FULL_HOUSE_EXTRA;
    out.push({
      kind: 'full_house', difficulty: 'easy', goal: `Grow the town to ${target} residents`,
      agentIds: [], target, durationDays: DURATION_DAYS.full_house,
    });
  }

  // Only when someone could plausibly propose: a couple, or a pair well on the way.
  if (snap.pairs.some((p) => bothActive(snap, p) && p.romanceMax > MATCH_ROMANCE_MIN && !p.tags.includes(MARRIED_TAG))) {
    out.push({
      kind: 'first_engagement', difficulty: 'medium', goal: 'A new engagement anywhere in town',
      agentIds: [], durationDays: DURATION_DAYS.first_engagement,
    });
  }

  // Only once a couple is married: the baby needs parents to be on the way.
  if (snap.pairs.some((p) => bothActive(snap, p) && p.tags.includes(MARRIED_TAG))) {
    out.push({
      kind: 'first_baby', difficulty: 'hard', goal: 'A baby born anywhere in town',
      agentIds: [], durationDays: DURATION_DAYS.first_baby,
    });
  }

  if (snap.pairs.some((p) => bothActive(snap, p) && p.friendship >= FRIENDS_AT)) {
    out.push({
      kind: 'feud', difficulty: 'medium', goal: 'Turn two friends into rivals',
      agentIds: [], durationDays: DURATION_DAYS.feud,
    });
  }

  const king = kingmakerDraft(snap, rng);
  if (king) out.push(king);

  const recluse = loneliest(snap);
  if (recluse) {
    out.push({
      kind: 'recluse', difficulty: 'medium', goal: `Find ${firstName(snap, recluse.id)} a best friend`,
      agentIds: [recluse.id], durationDays: DURATION_DAYS.recluse,
    });
  }

  return out;
}

/** Candidates must be this old (lib/townCalendar.ts MIN_CANDIDATE_AGE). */
const CANDIDATE_AGE = 21;

/**
 * Kingmaker: a resident who isn't mayor, for the next election that can still
 * take them. Once a campaign is open its ballot is fixed, so the pick is one of
 * its challengers; before that, anyone grown — the campaign drafts the player's
 * pick onto the ballot (townCalendar `openCampaign`). An election already
 * counted, or one too close to campaign for, gives way to the next season's.
 */
export function kingmakerDraft(snap: TownSnapshot, rng: Rng): OfferDraft | null {
  const campaign = snap.candidates ?? [];
  let electionDay = nextElectionDay(snap.day);
  let pool: number[];
  if (campaign.length > 0 && snap.lastElection?.electionDay !== electionDay) {
    pool = campaign.filter((id) => id !== snap.mayorId && isActive(snap, id));
  } else {
    // No campaign running: this season's vote if its campaign is still to
    // open, else the next one.
    if (snap.lastElection?.electionDay === electionDay || electionDay - snap.day < ELECTION.campaignDays) {
      electionDay = nextElectionDay(electionDay + 1);
    }
    pool = snap.agents.filter((a) => a.active && a.age >= CANDIDATE_AGE && a.id !== snap.mayorId).map((a) => a.id);
  }
  const id = pick(pool, rng);
  if (id == null) return null;
  return {
    kind: 'kingmaker', difficulty: 'hard', goal: `Get ${firstName(snap, id)} elected mayor on day ${electionDay}`,
    agentIds: [id], target: electionDay, durationDays: Math.max(1, electionDay - snap.day + 1),
  };
}

/**
 * The resident whose strongest friendship is weakest (ties: the lower social
 * need), among those without a best friend already. Lonely by their ties, not
 * by their current mood: a social need dips every evening for everyone.
 */
export function loneliest(snap: TownSnapshot): { id: number; bestTie: number } | null {
  let best: { id: number; bestTie: number; social: number } | null = null;
  for (const a of snap.agents) {
    if (!a.active) continue;
    let tie = 0;
    for (const p of snap.pairs) {
      if (p.a !== a.id && p.b !== a.id) continue;
      if (!isActive(snap, p.a === a.id ? p.b : p.a)) continue;
      tie = Math.max(tie, p.friendship);
    }
    if (tie >= BEST_FRIEND_AT) continue;
    const social = a.social ?? 50;
    if (!best || tie < best.bestTie || (tie === best.bestTie && social < best.social)) {
      best = { id: a.id, bestTie: tie, social };
    }
  }
  return best ? { id: best.id, bestTie: best.bestTie } : null;
}

const TIERS: readonly Difficulty[] = ['easy', 'medium', 'hard'];

/**
 * Up to OFFER_COUNT drafts of different kinds: one per difficulty first, then
 * any others. `skip` are kinds the player is already running (a second
 * Guardian next to the first is the same challenge twice).
 */
export function chooseOffers(candidates: OfferDraft[], rng: Rng, skip: ReadonlySet<ChallengeKind> = new Set()): OfferDraft[] {
  const pool = candidates.filter((c) => !skip.has(c.kind));
  const chosen: OfferDraft[] = [];
  for (const tier of TIERS) {
    const d = pick(pool.filter((c) => c.difficulty === tier && !chosen.includes(c)), rng);
    if (d) chosen.push(d);
  }
  while (chosen.length < OFFER_COUNT) {
    const d = pick(pool.filter((c) => !chosen.includes(c)), rng);
    if (!d) break;
    chosen.push(d);
  }
  return chosen.slice(0, OFFER_COUNT);
}

/** The finished offers: ids from `nextId`, stamped with the snapshot's clock. */
export function buildOffers(
  snap: TownSnapshot,
  rng: Rng,
  nextId: () => string,
  skip: ReadonlySet<ChallengeKind> = new Set(),
): Challenge[] {
  return chooseOffers(candidateOffers(snap, rng), rng, skip).map((d) => ({
    ...d,
    id: nextId(),
    status: 'offered' as const,
    offeredAt: snap.nowMinute,
  }));
}
