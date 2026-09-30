/**
 * Festival contests: who wins the ploughing match, the singing contest, the
 * pie contest (data/calendar.ts ContestDef).
 *
 * Pure: the DB side (who is at the festival, their hobby levels, what the win
 * does to the town) is in lib/townCalendar.ts. Split out so the judging can be
 * pinned with a seeded RNG.
 *
 * Why it is judged this way. The town already keeps score of practice —
 * hobby levels grow every time someone fishes, cooks, performs or jogs
 * (lib/hobbyEngine.ts) — and until now nothing ever asked who was best. A
 * contest makes those weeks of practice pay off in front of everyone, so the
 * skill is most of the score. The trade gives a head start (the baker should
 * usually win the baking), temperament leans it (vanity sings, nerves don't),
 * and a little luck keeps an underdog's win possible: a contest the favourite
 * always wins is not a story.
 */
import type { ContestDef } from '../data/calendar';

export interface Entrant {
  id: number;
  name: string;
  personality: Record<string, number> | null;
  /** Hobby level 0..100 for the contest's activity. */
  hobbyLevel: number;
  job: string;
}

export interface ContestResult {
  winnerId: number;
  /** Best first; ties broken by id so a result replays exactly. */
  ranking: Array<{ id: number; score: number }>;
}

/** Points for holding one of the contest's trades. */
export const TRADE_BONUS = 15;
/** Full weight of one personality axis at its extreme (0 or 100). */
export const TRAIT_WEIGHT = 12;
/** The most luck can add: enough to upset a close favourite, not a master. */
export const LUCK_SPAN = 18;

/** How well an entrant does before luck. */
export function contestSkill(e: Entrant, contest: ContestDef): number {
  let score = Math.max(0, Math.min(100, e.hobbyLevel));
  if (contest.jobs.includes(e.job)) score += TRADE_BONUS;
  for (const [axis, lean] of Object.entries(contest.traits)) {
    const v = e.personality?.[axis] ?? 50;
    score += (lean ?? 0) * ((v - 50) / 50) * TRAIT_WEIGHT;
  }
  return score;
}

/**
 * Judge a contest. `rng` draws each entrant's luck in id order, so the same
 * entrants and seed always give the same ranking. Null with fewer than two
 * entrants — one person alone has not won anything.
 */
export function judgeContest(entrants: readonly Entrant[], contest: ContestDef, rng: () => number): ContestResult | null {
  if (entrants.length < 2) return null;
  const ranking = [...entrants]
    .sort((a, b) => a.id - b.id)
    .map((e) => ({ id: e.id, score: contestSkill(e, contest) + rng() * LUCK_SPAN }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
  return { winnerId: ranking[0].id, ranking };
}

/**
 * The chance a loser comes away envious of the winner: vain and anxious people
 * take a defeat to heart, a close friend is glad for them. 0..0.8.
 */
export function envyChance(personality: Record<string, number> | null, friendshipToWinner: number): number {
  const vanity = personality?.vanity ?? 50;
  const nerves = personality?.neuroticism ?? 50;
  const warmth = personality?.warmth ?? 50;
  let p = 0.12;
  p += Math.max(0, vanity - 50) / 50 * 0.3;
  p += Math.max(0, nerves - 50) / 50 * 0.25;
  p -= Math.max(0, warmth - 50) / 50 * 0.15;
  if (friendshipToWinner >= 40) p -= 0.25;
  else if (friendshipToWinner <= -20) p += 0.2;
  return Math.max(0, Math.min(0.8, p));
}
