/**
 * The mayoral election, as arithmetic: who stands, how each resident votes,
 * and the count.
 *
 * Pure (plus the job table's keywords): the DB side — reading the town,
 * announcing, swapping the mayor through `changeJob` — is lib/townCalendar.ts.
 * Split out so candidacy, the ballots and the tally can be pinned with a
 * seeded RNG.
 *
 * Why these rules. The town had a mayor's job (data/jobs.ts) that only ever
 * changed hands when the mayor died. An election each season turns what the
 * sim already tracks into a public verdict on the candidates: every friendship
 * and grudge, reputation, whether someone's scandal has got out. Residents vote
 * for the person they like and trust, who thinks like them, who has a good
 * name, and who bothered to come and talk to them during the campaign (the
 * hidden support score the conversations fill in). A public scandal costs a
 * candidate with everyone; a private one only with those who know it. Nothing
 * here asks the LLM — the words were spent in the campaign's conversations.
 */
import { JOBS } from '../data/jobs';

export interface Profile {
  [axis: string]: number;
}

// ─── Candidacy ───────────────────────────────────────────────────────────────

export interface Hopeful {
  id: number;
  personality: Profile | null;
  /** Community reputation, -100..100 (lib/reputationEngine.ts). */
  reputation: number;
  /** Active life ambition's category ('power', 'justice', ...), if any. */
  ambitionType: string | null;
  ambitionText: string | null;
}

/** Most names on a ballot, the incumbent included. */
export const MAX_CANDIDATES = 3;
/** Below this, nobody feels called to stand. */
export const STAND_THRESHOLD = 30;

const MAYOR_WORDS = new RegExp(`\\b(?:${(JOBS.mayor.keywords ?? []).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');

/**
 * "Outgoing and liked": the town's stand-in for extraversion. The personality
 * model has no such axis; warmth (approachable) and vanity (wants to be seen)
 * together are what makes someone put their name forward.
 */
export function outgoing(p: Profile | null): number {
  return ((p?.warmth ?? 50) + (p?.vanity ?? 50)) / 2;
}

/** How strongly someone feels called to stand for mayor; 0 = not at all. */
export function candidacyScore(h: Hopeful): number {
  let score = 0;
  if (h.ambitionType === 'power') score += 55;
  else if (h.ambitionType === 'justice') score += 25;
  if (h.ambitionText && MAYOR_WORDS.test(h.ambitionText)) score += 55;
  const out = outgoing(h.personality);
  if (out >= 65 && h.reputation >= 10) score += 30 + (out - 65) * 0.5;
  score += Math.max(0, h.reputation) * 0.2;
  return score;
}

/**
 * The ballot: the incumbent (if any) plus the most eager challengers, up to
 * MAX_CANDIDATES. `drafted` are put forward whatever their eagerness — the
 * player's Kingmaker pick, talked into standing by the town — ahead of the
 * volunteers. A town with no mayor and no volunteer still gets its most
 * outgoing, best-liked resident on the ballot: somebody has to run the hall.
 */
export function pickCandidates(
  hopefuls: readonly Hopeful[],
  incumbentId: number | null,
  drafted: readonly number[] = [],
): number[] {
  const out: number[] = incumbentId != null ? [incumbentId] : [];
  const pool = hopefuls.filter((h) => h.id !== incumbentId);
  for (const id of drafted) {
    if (out.length >= MAX_CANDIDATES) break;
    if (!out.includes(id) && pool.some((h) => h.id === id)) out.push(id);
  }
  const eager = pool
    .map((h) => ({ id: h.id, score: candidacyScore(h) }))
    .filter((h) => h.score >= STAND_THRESHOLD && !out.includes(h.id))
    .sort((a, b) => b.score - a.score || a.id - b.id);
  for (const h of eager) {
    if (out.length >= MAX_CANDIDATES) break;
    out.push(h.id);
  }
  if (out.length === 0 && pool.length > 0) {
    const best = [...pool].sort((a, b) =>
      (outgoing(b.personality) + b.reputation) - (outgoing(a.personality) + a.reputation) || a.id - b.id)[0];
    out.push(best.id);
  }
  return out;
}

// ─── Voting ──────────────────────────────────────────────────────────────────

export interface Tie {
  /** How the voter feels about the candidate, -100..100. */
  friendship: number;
  trust: number;
}

export interface Scandal {
  subjectId: number;
  sensitivity: number;
  isPublic: boolean;
  knownBy: readonly number[];
}

export interface ElectionInput {
  candidates: ReadonlyArray<{ id: number; personality: Profile | null; reputation: number; incumbent: boolean }>;
  voters: ReadonlyArray<{ id: number; personality: Profile | null }>;
  /** Keyed `${voterId}>${candidateId}`; a missing pair is two strangers. */
  ties: ReadonlyMap<string, Tie>;
  /** Live secrets at sensitivity ≥ 2 (anything lower is harmless news). */
  secrets: readonly Scandal[];
  /** Campaign endorsement points, candidateId → voterId → points (-10..10). */
  support: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** Axes where thinking alike wins a vote: values, not temperament. */
const ALIGNMENT_AXES = ['morality', 'honesty', 'warmth', 'loyalty', 'aggression'] as const;
/** Sensitivity from which a secret is a scandal. */
export const SCANDAL_SENSITIVITY = 3;

export function tieKey(voterId: number, candidateId: number): string {
  return `${voterId}>${candidateId}`;
}

/** -10..10: how alike two people's values are. */
export function alignment(a: Profile | null, b: Profile | null): number {
  let diff = 0;
  for (const axis of ALIGNMENT_AXES) diff += Math.abs((a?.[axis] ?? 50) - (b?.[axis] ?? 50));
  return 10 - (diff / ALIGNMENT_AXES.length) / 5;
}

/**
 * One voter's opinion of one candidate. Friendship dominates (it is a small
 * town), then the candidate's good name, trust, values and the campaign.
 */
export function voteScore(voterId: number, voterPersonality: Profile | null, c: ElectionInput['candidates'][number], input: ElectionInput): number {
  const tie = input.ties.get(tieKey(voterId, c.id)) ?? { friendship: 0, trust: 0 };
  let score = tie.friendship * 0.5 + tie.trust * 0.2 + c.reputation * 0.3;
  score += alignment(voterPersonality, c.personality);
  score += (input.support[String(c.id)]?.[String(voterId)] ?? 0) * 3;
  if (c.incumbent) score += 3;
  let complicity = 0;
  for (const s of input.secrets) {
    if (s.subjectId === c.id && s.sensitivity >= SCANDAL_SENSITIVITY) {
      // Out in the open it costs everyone's vote; kept quiet, only the
      // voters who know. The worse the secret, the worse the cost.
      if (s.isPublic) score -= 8 * s.sensitivity;
      else if (s.knownBy.includes(voterId)) score -= 5 * s.sensitivity;
    } else if (!s.isPublic && s.subjectId !== voterId && s.subjectId !== c.id
      && s.knownBy.includes(voterId) && s.knownBy.includes(c.id)) {
      // Keeping someone else's secret together: a quiet bond.
      complicity += 3;
    }
  }
  return score + Math.min(6, complicity);
}

/**
 * Every ballot: candidates vote for themselves, everyone else for the
 * candidate they score highest, plus a little noise (rng, drawn in voter id
 * order) so a dead heat doesn't always fall the same way.
 */
export function castVotes(input: ElectionInput, rng: () => number): Map<number, number> {
  const ballots = new Map<number, number>();
  const candidateIds = new Set(input.candidates.map((c) => c.id));
  for (const v of [...input.voters].sort((a, b) => a.id - b.id)) {
    if (candidateIds.has(v.id)) {
      ballots.set(v.id, v.id);
      continue;
    }
    let best: { id: number; score: number } | null = null;
    for (const c of input.candidates) {
      const score = voteScore(v.id, v.personality, c, input) + (rng() - 0.5) * 4;
      if (!best || score > best.score || (score === best.score && c.id < best.id)) best = { id: c.id, score };
    }
    if (best) ballots.set(v.id, best.id);
  }
  return ballots;
}

export interface Tally {
  winnerId: number;
  /** Candidates by votes, most first. */
  ranking: Array<{ id: number; votes: number }>;
  ballots: Map<number, number>;
}

/**
 * Count the ballots. A tie goes to the candidate with more campaign support,
 * then the incumbent, then the lower id — never to chance, so a replayed
 * count agrees with itself.
 */
export function tallyElection(input: ElectionInput, rng: () => number): Tally | null {
  if (input.candidates.length === 0) return null;
  const ballots = castVotes(input, rng);
  const votes = new Map<number, number>(input.candidates.map((c) => [c.id, 0]));
  for (const choice of ballots.values()) votes.set(choice, (votes.get(choice) ?? 0) + 1);
  const supportOf = (id: number) => Object.values(input.support[String(id)] ?? {}).reduce((s, v) => s + v, 0);
  const incumbent = (id: number) => input.candidates.find((c) => c.id === id)?.incumbent ?? false;
  const ranking = input.candidates
    .map((c) => ({ id: c.id, votes: votes.get(c.id) ?? 0 }))
    .sort((a, b) =>
      b.votes - a.votes
      || supportOf(b.id) - supportOf(a.id)
      || Number(incumbent(b.id)) - Number(incumbent(a.id))
      || a.id - b.id);
  return { winnerId: ranking[0].id, ranking, ballots };
}

/**
 * Campaign support one conversation earns a candidate with a voter: a pleasant
 * chat wins a little, a sour one loses some, and talking about the election
 * itself counts for more. Clamped per voter by the caller.
 */
export function endorsementDelta(sentiment: number, aboutElection: boolean): number {
  const s = Math.max(-1, Math.min(1, sentiment));
  return (0.8 + 2 * s) * (aboutElection ? 1.5 : 1);
}

/** Support per candidate per voter is kept within ±SUPPORT_CAP. */
export const SUPPORT_CAP = 10;
