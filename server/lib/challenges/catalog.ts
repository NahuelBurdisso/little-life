/**
 * Optional player goals: the challenge catalog.
 *
 * A spectator game gives the player nothing to aim at unless they invent it.
 * Challenges are small, optional goals built from the live town ("marry Ada
 * and Tom within 14 days", "keep your hands off for two days") that turn the
 * god powers into tools for a purpose. They are opt-in: three offers wait in
 * the Journal's 🏆 tab, the player picks, and the hourly evaluator
 * (evaluate.ts) settles them.
 *
 * PURE: no DB, no Node. The client imports the types and the kind table
 * (icons, names, blurbs) straight from here, like it does `server/data/`.
 *
 * Every challenge is judged on the town's STATE (a snapshot of agents, pairs,
 * secrets and the player's last action), never on events. An event listener
 * misses whatever happens while the server is down or a phase rolls back; a
 * state check just looks again an hour later.
 */

import { firstName as givenName } from '../../ai/names';

export type ChallengeKind =
  | 'matchmaker'
  | 'peacemaker'
  | 'guardian'
  | 'scandal'
  | 'hands_off'
  | 'full_house'
  | 'first_engagement'
  | 'feud'
  | 'recluse'
  | 'first_baby'
  | 'kingmaker';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type ChallengeStatus = 'offered' | 'active' | 'completed' | 'failed' | 'expired' | 'abandoned';

/** How far along an active challenge is, for the progress bar. `value` may exceed `target`. */
export interface ChallengeProgress {
  value: number;
  target: number;
  /** One short line: "romance 34 / 70", "2 of 3 secrets today". */
  label: string;
}

/**
 * What the town looked like when the challenge was accepted, per kind. A state
 * check needs a "before" to know what is new: the deaths that had already
 * happened, the secrets that were already out, the friendships a feud may break.
 */
export interface ChallengeBaseline {
  /** guardian: residents already dead at the start. */
  deadIds?: number[];
  /** scandal: secrets already common knowledge at the start. */
  publicIds?: number[];
  /** scandal: game minute each NEW public secret was first seen, by fact id. */
  revealedAt?: Record<string, number>;
  /** feud: pairs (lo, hi) that were friends at the start. */
  friendPairs?: Array<[number, number]>;
  /** first_engagement: pairs (`lo-hi`) already engaged or married at the start. */
  engagedPairs?: string[];
  /** first_baby: children already born at the start. */
  childIds?: number[];
  /**
   * hands_off: the player-action marks at the start (see TownSnapshot). Marks,
   * not game minutes: the player can accept the challenge and then nudge while
   * the game is paused, all inside one game minute.
   */
  hands?: { actionId: number; handsOn: number };
}

/**
 * Where a challenge came from: one of the day's three `offer`s, or an `aim` the
 * player set for a pair from the pair dossier ("get them married"). An aim is
 * the same kind, evaluator and feedback as an offer; the tag only lets the
 * Journal say "your aim". Missing (a store written before aims) reads as an offer.
 */
export type ChallengeSource = 'offer' | 'aim';

/** What a player can aim a pair at, and the existing kind that judges each. */
export type PairAim = 'marry' | 'befriend' | 'sunder';

export const AIM_KINDS: Readonly<Record<PairAim, 'matchmaker' | 'peacemaker' | 'feud'>> = {
  marry: 'matchmaker',
  befriend: 'peacemaker',
  sunder: 'feud',
};

export interface Challenge {
  /** `c<n>`, unique within the world's store. */
  id: string;
  kind: ChallengeKind;
  /** See `ChallengeSource`. */
  source?: ChallengeSource;
  difficulty: Difficulty;
  /** The goal in one sentence with the residents' names: "Get Ada and Tom married". */
  goal: string;
  /** Residents the challenge is about (the Journal's focus buttons). */
  agentIds: number[];
  /** A number the kind needs: full_house's population target, kingmaker's election day. */
  target?: number;
  /** Game days from acceptance to the deadline. */
  durationDays: number;
  status: ChallengeStatus;
  /** Game minute the offer was built. */
  offeredAt: number;
  startedAt?: number;
  /** Game minute past which the challenge is settled either way. */
  deadline?: number;
  endedAt?: number;
  baseline?: ChallengeBaseline;
  progress?: ChallengeProgress;
  /** How it ended, for the history list and the feed row. */
  outcome?: string;
}

export interface ChallengeKindDef {
  icon: string;
  name: string;
  /** What the kind asks, without names (help text, tooltips). */
  blurb: string;
  /**
   * True when running out the clock IS the win: guardian and hands-off are
   * about something NOT happening, so the deadline passing cleanly completes
   * them instead of expiring them.
   */
  survive: boolean;
}

export const CHALLENGE_KINDS: Readonly<Record<ChallengeKind, ChallengeKindDef>> = {
  matchmaker: { icon: '💍', name: 'Matchmaker', blurb: 'Get two sweethearts married before the deadline.', survive: false },
  peacemaker: { icon: '🕊', name: 'Peacemaker', blurb: 'Turn two enemies into friends.', survive: false },
  guardian: { icon: '🛡', name: 'Guardian', blurb: 'Nobody dies before the season ends.', survive: true },
  scandal: { icon: '🗞', name: 'Scandal', blurb: 'Three secrets become common knowledge within one game day.', survive: false },
  hands_off: { icon: '🙌', name: 'Hands off', blurb: 'Two game days without meddling. Autoplay nudges count as yours.', survive: true },
  full_house: { icon: '🏘', name: 'Full house', blurb: 'Grow the town to a target population.', survive: false },
  first_engagement: { icon: '💌', name: 'Wedding bells', blurb: 'A new engagement anywhere in town.', survive: false },
  feud: { icon: '⚔', name: 'A feud', blurb: 'Two friends become rivals or worse.', survive: false },
  recluse: { icon: '🫂', name: 'The recluse', blurb: 'Get the loneliest resident a best friend.', survive: false },
  first_baby: { icon: '👶', name: 'First baby', blurb: 'A baby born anywhere in town.', survive: false },
  kingmaker: { icon: '👑', name: 'Kingmaker', blurb: 'Get a resident elected mayor at the next election.', survive: false },
};

// ─── Thresholds (the relationship ladder in engine/systems/relationships.ts) ──

/** Average friendship from which a pair counts as "friends" (the `friends` status). */
export const FRIENDS_AT = 40;
/** Average friendship at or below which a pair are rivals (the `rivals` status). */
export const RIVALS_AT = -40;
/** Average friendship at or below which a pair are enemies (the `enemies` status). */
export const ENEMIES_AT = -70;
/**
 * The recluse's "best friend": a close friendship (the `close_friends` status).
 * The ladder's own `best_friends` sits at 90, which a town of slow-moving ties
 * (a playtest save had none after three days, and three `friends` pairs)
 * reaches in weeks, not in a challenge's seven days.
 */
export const BEST_FRIEND_AT = 70;
/** Both romances past this (and friendship past 30) is `partners`. */
export const PARTNERS_ROMANCE = 70;
/** Matchmaker candidates: sweet on each other but not yet a couple. */
export const MATCH_ROMANCE_MIN = 20;
export const MATCH_ROMANCE_MAX = 40;
/** Scandal: how many secrets, and within what window. */
export const SCANDAL_SECRETS = 3;
export const SCANDAL_WINDOW_MINUTES = 24 * 60;
/** Full house: residents to add on top of today's population. */
export const FULL_HOUSE_EXTRA = 2;
/** Guardian never offers a season with fewer days left than this (it'd be a freebie). */
export const GUARDIAN_MIN_DAYS = 3;

export const MAX_ACTIVE_CHALLENGES = 3;
export const OFFER_COUNT = 3;
export const HISTORY_CAP = 30;

export const MINUTES_PER_DAY = 1440;

// ─── The town, as the evaluator and the offer builder see it ──────────────────

export interface SnapAgent {
  id: number;
  name: string;
  age: number;
  /** Still in town (alive and not removed). */
  active: boolean;
  /** Died (as opposed to having left): `current_action.type === 'dead'`. */
  dead: boolean;
  /** Social need 0–100, lower = lonelier; null without a needs row. */
  social: number | null;
}

export interface SnapPair {
  /** Normalised: a < b. */
  a: number;
  b: number;
  /** Average of the two directions. */
  friendship: number;
  romanceMax: number;
  romanceMin: number;
  status: string;
  tags: string[];
}

export interface TownSnapshot {
  nowMinute: number;
  /** Game day number (`time.day`). */
  day: number;
  season: string;
  /** Game minute the current season ends (the next day divisible by the season length). */
  seasonEndMinute: number;
  /** Game minute the season after this one ends. */
  nextSeasonEndMinute: number;
  agents: SnapAgent[];
  pairs: SnapPair[];
  /** Every secret that has become common knowledge (`shared_knowledge.is_public`). */
  publicSecretIds: number[];
  /** Live secrets that are still secret (sensitivity ≥ 2, not public). */
  hiddenSecretCount: number;
  /**
   * Newest activity-log id of a player ACTION row (a nudge, gift, event,
   * whisper... — not the outcome rows that report on them, nor challenge rows);
   * 0 when there is none. Ids only grow, so "a bigger id than at the start" is
   * "the player acted since", even while the clock stands still.
   */
  lastPlayerActionId: number;
  /**
   * Meddling that writes no player row: autoplay's auto-nudges and weather
   * changes (store.ts `recordHandsOn`). A counter for the same reason.
   */
  handsOnCount: number;
  /** The death rule (lib/worldRules.ts): Guardian is a freebie in a town where nobody can die. */
  deathEnabled: boolean;
  /**
   * The mayor now (economy.job), the running campaign's candidates and the last
   * count (lib/townCalendar.ts): Kingmaker's state. Optional so fixtures written
   * before it need no change.
   */
  mayorId?: number | null;
  candidates?: number[];
  lastElection?: { electionDay: number; winnerId: number } | null;
  /**
   * Children in town (lib/family.ts), for First baby. Optional so a snapshot
   * built by hand (the tests) without a family reads as a town with none.
   */
  children?: SnapChild[];
}

export interface SnapChild {
  id: number;
  name: string;
  motherId: number;
  fatherId: number | null;
}

export function pairKey(x: number, y: number): string {
  return x < y ? `${x}-${y}` : `${y}-${x}`;
}

/** The pair row for two residents, or a neutral stand-in when they have never met. */
export function pairOf(snap: TownSnapshot, x: number, y: number): SnapPair {
  const a = Math.min(x, y);
  const b = Math.max(x, y);
  return (
    snap.pairs.find((p) => p.a === a && p.b === b) ?? {
      a, b, friendship: 0, romanceMax: 0, romanceMin: 0, status: 'strangers', tags: [],
    }
  );
}

export function agentOf(snap: TownSnapshot, id: number): SnapAgent | undefined {
  return snap.agents.find((a) => a.id === id);
}

/** First name for goal text ("Ada Lovelace" → "Ada"). */
export function firstName(snap: TownSnapshot, id: number): string {
  const name = agentOf(snap, id)?.name ?? `#${id}`;
  return givenName(name);
}

/**
 * Where Guardian's "the season ends" lands: this season's end, or the next
 * one's when this season is nearly over (a two-day Guardian is a freebie).
 */
export function guardianDeadline(snap: TownSnapshot): number {
  return snap.seasonEndMinute - snap.nowMinute >= GUARDIAN_MIN_DAYS * MINUTES_PER_DAY
    ? snap.seasonEndMinute
    : snap.nextSeasonEndMinute;
}

/** Whole game days left before `deadline` (rounded up; 0 once it has passed). */
export function daysLeft(deadline: number | undefined, nowMinute: number): number {
  if (deadline == null) return 0;
  return Math.max(0, Math.ceil((deadline - nowMinute) / MINUTES_PER_DAY));
}

