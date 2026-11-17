/**
 * "Previously on…": a handful of human sentences about what happened in the
 * town between two game minutes, for a player coming back to the tab after a
 * while or waking up from a night skip.
 *
 * Pure: the router reads the activity rows and the Town Crier headlines for
 * the span and hands them in, so the ranking is tested without a database.
 *
 * What makes the cut, most important first:
 *   death > wedding > engagement > a pair turning partners / enemies / estranged
 *   > what the player's meddling came to > a first kiss > the biggest story beats of the span.
 *   A first kiss is the one romantic milestone that is not already a status flip; a routine
 *   kiss, an evening together and a refusal are below the importance bar on purpose (the Hearts
 *   ledger has them), and being seen or a scandal are beats. Every line is the feed's own
 *   discreet sentence.
 * The paper's headline for the span leads the card when there is one. Picked by
 * importance, then shown in the order it happened: a recap reads as a story.
 */

import { renderMessage } from './activityMessage';
import { endSentence, storyKey } from './factText';

/** The slice of an `activity_log` row the recap reads. */
export interface RecapRow {
  id: number;
  type: string;
  category: string;
  importance: number;
  game_minute: number | null;
  initiator_id?: number | null;
  target_id?: number | null;
  agent_ids?: number[] | null;
  template_data?: Record<string, string | number> | null;
  metadata?: { beat?: string; chainId?: string } | null;
}

export interface RecapHeadline {
  /** `gazette_issues.id`: the newest edition of a day wins. */
  id: number;
  day: number;
  headline: string;
}

export type RecapKind = 'paper' | 'death' | 'wedding' | 'engagement' | 'status' | 'player' | 'romance' | 'beat';

export interface RecapBullet {
  /** Stable React key: the row id, or `paper-<day>`. */
  key: string;
  kind: RecapKind;
  icon: string;
  text: string;
  /** Residents the line is about, first = the one a click focuses. */
  agentIds: number[];
  /** When it happened (the paper: the start of its day). */
  gameMinute: number;
}

export interface Recap {
  sinceMinute: number;
  untilMinute: number;
  bullets: RecapBullet[];
}

/** The card is a glance, not a log: the Journal has everything else. */
export const RECAP_MAX_BULLETS = 6;
/** A long absence spans several editions; two headlines are plenty. */
export const RECAP_MAX_HEADLINES = 2;
/** The player's own outcomes are the most personal lines, but not the whole card. */
const MAX_PLAYER = 2;
/** Beats of one family (row type + story beat: gossip, fights, storms…) on one card. */
const MAX_PER_FAMILY = 2;
/** A first kiss outranks a generic beat but not the player's own outcomes (70). */
const FIRST_KISS_PRIORITY = 60;
/** Rows below this never reach the recap, whatever their kind (the router pre-filters on it). */
export const RECAP_MIN_IMPORTANCE = 0.6;
/** A generic beat needs this much to compete with the named kinds above. */
const BEAT_MIN_IMPORTANCE = 0.75;

const MINUTES_PER_DAY = 1440;

/** Status flips worth a line: the ones that rewrite a pair (alertTiers.ts MAJOR_STATUSES). */
const STATUS_LINES: Record<string, (a: string, b: string) => string> = {
  partners: (a, b) => `${a} and ${b} got together.`,
  enemies: (a, b) => `${a} and ${b} became enemies.`,
  estranged: (a, b) => `${a} and ${b} fell out for good.`,
};

/**
 * Rows that are never a beat: bookkeeping, routine, or handled by a named
 * kind above (a proposal is only interesting through its answer).
 */
const NEVER_BEATS = new Set([
  'relationship_status_change', 'proposal', 'plan_generated', 'plan_changed', 'system', 'error',
  'state_gained', 'state_lost', 'conversation_ended', 'salary_paid', 'purchase', 'goal_created',
  'goal_abandoned', 'player_nudge', 'player_event', 'player_gift', 'player_whisper', 'player_rumor',
  'player_stir', 'player_letter', 'player_introduce', 'player_remove',
]);

const BEAT_ICONS: Record<string, string> = {
  fight: '⚔', insult: '⚔', snap: '🔥', date: '♥', flirt: '♥', reconciliation: '☘',
  confession: '🤫', gossip: '🤫', breakup: '💔', estrangement: '💔', arrest: '⛓', birthday: '🎂', theft: '💰',
  // Being seen leaving a house at dawn, and the town's whispers about a baby (lib/intimacy/): a secret out.
  caught: '🤫', scandal: '🤫',
  // The small rows that used to go untagged (lib/tavernEngine.ts, lonelinessEngine.ts, states.ts).
  release: '🔓', drunk: '🍺', outburst: '❗', blackmail: '✉', lonely: '☁',
  // Social calls (lib/socialCalls): someone going out of their way for someone.
  sick_visit: '🍲', vigil: '🕯', condolence: '🕯', congratulation: '🎉', birthday_wish: '🎂',
  forgotten_birthday: '☁', welcome: '🍞', consolation: '🫂', plea_to_stay: '🫂',
  welcome_home: '🏠', cold_shoulder: '❄', loan: '💰', loan_repaid: '💰', loan_unpaid: '💸',
  // Gatherings (lib/gatherings): the town doing something together.
  funeral: '🕯', wake: '🍺', send_off: '👋', market_day: '🧺', fire_saved: '🔥', fire_lost: '🔥', toast: '🥂', round: '🍺',
};
const CATEGORY_ICONS: Record<string, string> = {
  world_event: '~', aspiration: '★', goal: '▶', relationship: '♦', social: '💬', drama: '!',
};

interface Candidate extends RecapBullet {
  /** Selection rank: higher wins a slot. */
  priority: number;
  /** Rows about the same pair (or person, for a death) collapse into the strongest one. */
  subject: string;
  /** `type:beat`, for the per-family cap on generic beats. */
  family: string;
  rowId: number;
}

function agentsOf(row: RecapRow): number[] {
  const ids = [...(row.agent_ids ?? [])];
  for (const id of [row.initiator_id, row.target_id]) if (id != null && !ids.includes(id)) ids.push(id);
  return ids;
}

function pairKey(ids: number[]): string {
  return [...ids].sort((x, y) => x - y).join('-');
}

function sentence(row: RecapRow): string {
  return endSentence(renderMessage({ type: row.type, template_data: row.template_data ?? {}, timestamp: 0 }));
}

function classify(row: RecapRow): Candidate | null {
  if (row.game_minute == null || row.importance < RECAP_MIN_IMPORTANCE) return null;
  const agentIds = agentsOf(row);
  const beat = row.metadata?.beat;
  const base = {
    key: `row-${row.id}`, agentIds, gameMinute: row.game_minute, rowId: row.id,
    // A row about nobody in particular (a storm, a market) is its own subject.
    subject: agentIds.length ? pairKey(agentIds) : `row-${row.id}`, family: `${row.type}:${beat ?? ''}`,
  };

  if (beat === 'death') {
    // Keyed by the person alone: a death is never merged into a pair's line.
    return { ...base, kind: 'death', icon: '🕯', text: sentence(row), priority: 100, subject: `death-${agentIds[0] ?? row.id}` };
  }
  if (row.type === 'wedding') return { ...base, kind: 'wedding', icon: '💍', text: sentence(row), priority: 95 };
  if (row.type === 'engagement') return { ...base, kind: 'engagement', icon: '💍', text: sentence(row), priority: 90 };
  if (row.type === 'relationship_status_change') {
    const line = STATUS_LINES[String(row.template_data?.status ?? '')];
    if (!line) return null;
    const a = String(row.template_data?.agent1 ?? 'Someone');
    const b = String(row.template_data?.agent2 ?? 'someone');
    return { ...base, kind: 'status', icon: row.template_data?.status === 'partners' ? '♥' : '⚔', text: line(a, b), priority: 80 };
  }
  if (row.type === 'player_outcome' || row.type === 'player_nudge_expired') {
    // An outcome is about the player's own scene: never folded into a pair's line.
    return {
      ...base, kind: 'player', icon: '✦', text: sentence(row),
      priority: row.type === 'player_outcome' ? 70 : 55, subject: `player-${row.id}`,
    };
  }
  if (row.type === 'first_kiss') return { ...base, kind: 'romance', icon: '♥', text: sentence(row), priority: FIRST_KISS_PRIORITY };
  if (NEVER_BEATS.has(row.type) || row.importance < BEAT_MIN_IMPORTANCE) return null;
  const icon = (beat && BEAT_ICONS[beat]) ?? CATEGORY_ICONS[row.category] ?? '·';
  // Below every named kind, ordered among themselves by how much they mattered.
  return { ...base, kind: 'beat', icon, text: sentence(row), priority: row.importance * 50 };
}

export interface BuildRecapInput {
  sinceMinute: number;
  untilMinute: number;
  rows: readonly RecapRow[];
  headlines?: readonly RecapHeadline[];
}

export function buildRecap({ sinceMinute, untilMinute, rows, headlines = [] }: BuildRecapInput): Recap {
  const inSpan = (m: number | null): m is number => m != null && m > sinceMinute && m <= untilMinute;

  // Strongest line per subject; ties go to the later row (the pair's latest news).
  const bySubject = new Map<string, Candidate>();
  for (const row of rows) {
    if (!inSpan(row.game_minute)) continue;
    const c = classify(row);
    if (!c) continue;
    const prev = bySubject.get(c.subject);
    if (!prev || c.priority > prev.priority || (c.priority === prev.priority && c.rowId > prev.rowId)) {
      bySubject.set(c.subject, c);
    }
  }

  // One line per story: a rumor logs a row per retelling and a storm one per
  // day, so lines are keyed on what they are about (`storyKey`, shared with
  // the paper). Ranked first, so the widest telling ("The whole town now
  // knows…", importance 1) beats one person's, and ties go to the first.
  const seenStory = new Set<string>();
  const ranked = [...bySubject.values()]
    .sort((x, y) => (y.priority - x.priority) || (x.gameMinute - y.gameMinute) || (x.rowId - y.rowId))
    .filter((c) => {
      const key = storyKey(c.text);
      if (seenStory.has(key)) return false;
      seenStory.add(key);
      return true;
    });

  // The span's editions, newest first; one per day (the latest printing wins).
  const firstDay = Math.floor(sinceMinute / MINUTES_PER_DAY);
  const lastDay = Math.floor(untilMinute / MINUTES_PER_DAY);
  const perDay = new Map<number, RecapHeadline>();
  for (const h of headlines) {
    if (h.day < firstDay || h.day > lastDay || !h.headline.trim()) continue;
    const prev = perDay.get(h.day);
    if (!prev || h.id > prev.id) perDay.set(h.day, h);
  }
  const papers: RecapBullet[] = [...perDay.values()]
    .sort((x, y) => y.day - x.day)
    .slice(0, RECAP_MAX_HEADLINES)
    .reverse()
    .map((h) => ({
      key: `paper-${h.day}`,
      kind: 'paper',
      icon: '📰',
      text: `The Town Crier, day ${h.day}: “${h.headline.trim()}”`,
      agentIds: [],
      gameMinute: h.day * MINUTES_PER_DAY,
    }));

  const room = Math.max(0, RECAP_MAX_BULLETS - papers.length);
  const picked: Candidate[] = [];
  let players = 0;
  const perFamily = new Map<string, number>();
  for (const c of ranked) {
    if (picked.length >= room) break;
    if (c.kind === 'player' && players >= MAX_PLAYER) continue;
    if (c.kind === 'beat' || c.kind === 'romance') {
      // A gossip-heavy day would otherwise be six "The whole town now knows…"; a busy spring, six first kisses.
      const n = perFamily.get(c.family) ?? 0;
      if (n >= MAX_PER_FAMILY) continue;
      perFamily.set(c.family, n + 1);
    }
    if (c.kind === 'player') players++;
    picked.push(c);
  }
  picked.sort((x, y) => (x.gameMinute - y.gameMinute) || (x.rowId - y.rowId));

  const bullets: RecapBullet[] = [
    ...papers,
    ...picked.map(({ key, kind, icon, text, agentIds, gameMinute }) => ({ key, kind, icon, text, agentIds, gameMinute })),
  ];
  return { sinceMinute, untilMinute, bullets };
}
