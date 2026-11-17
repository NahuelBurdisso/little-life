/**
 * Shapes of the social-calls system (see ./engine.ts for the why).
 *
 * Pure: no DB, no Node. A kind's functions do their own DB work; the types only
 * say what the engine and the decision phase need from them.
 */

/** Free-form facts a producer pins on a call (the occasion, a mode, an amount). JSON-safe. */
export type CallPayload = Record<string, string | number | boolean | null>;

/** A promise one resident made to go and see another because of what happened to them. */
export interface SocialCall {
  id: number;
  /** A `SocialCallKind.id` ('sick_visit', 'vigil'...). */
  kind: string;
  callerId: number;
  targetId: number;
  /** GAME MINUTES, like every stamp here. */
  createdAtMin: number;
  /** The caller does not set off before this (visitors are staggered over hours or days). */
  notBeforeMin: number;
  /** Past this the call is missed (recorded `expired`, the kind's `onMissed` runs). */
  expiresAtMin: number;
  /** Copied from the kind when scheduled: an urgent call may pull the caller off a shift. */
  urgent: boolean;
  payload: CallPayload;
  /** When the conversation was seated (both together and queued), or null while on the way. */
  seatedAtMin: number | null;
}

export type CallOutcome = 'made' | 'expired' | 'dropped';

/** What became of a call, kept for cooldowns and for "who came and who didn't". */
export interface CallRecord {
  id: number;
  kind: string;
  callerId: number;
  targetId: number;
  atMin: number;
  outcome: CallOutcome;
  /** For a `made` call: whether the visit went well (a cold shoulder is `false`). */
  good: boolean | null;
  payload: CallPayload;
}

/** A follow-up a kind asked for at a later game minute (a birthday nobody marked, judged at night). */
export interface CallWatch {
  kind: string;
  targetId: number;
  sinceMin: number;
  dueMin: number;
}

/** How the visit's conversation went, as the kind's consequence reads it. */
export interface VisitResult {
  /** The visit came off: a welcome, not a slammed door. */
  good: boolean;
  /** A template-tier chat (the outcome was decided by character and a roll). */
  template: boolean;
  sentiment: number;
  nowMin: number;
}

/**
 * One kind of call. The table of these (kinds.ts `SOCIAL_CALL_KINDS`) is the
 * whole policy: the engine and the decision phase know nothing about sickness
 * or birthdays. Later passes (gatherings, factions) register their own.
 */
export interface SocialCallKind {
  id: string;
  /** May pull the caller off a work shift (never out of bed): a spouse going to a dying wife. */
  urgent?: boolean;
  /** At most this many callers on their way to one target for this kind at once. */
  maxPendingPerTarget: number;
  /** The same caller makes this kind of call to the same target at most once in this many game minutes. */
  pairCooldownMin: number;
  /** Game minutes the call stays open once `notBeforeMin` has come. */
  windowMin: number;
  /** After a good visit the caller stays with the target this long (a vigil at the bedside). */
  lingerMin?: number;
  /** Still worth going? (The patient recovered, the newcomer left.) Checked before every walk. */
  stillRelevant?(call: SocialCall): boolean;
  /** Conversation topic: what the LLM is told and the template scripts read (topics.ts). */
  topic(call: SocialCall): string;
  /**
   * What the cast bar and the agent panel say: on the walk ("On the way to see
   * Elena, who is ill") and once there ("Visiting Elena, who is ill").
   */
  label(call: SocialCall, targetName: string): { walking: string; there: string };
  /** Did it go well? Defaults to the conversation's tone (`defaultJudge`). */
  judge?(call: SocialCall, chat: { template: boolean; sentiment: number }): boolean;
  /** The visit happened: items, money, mood, memories, the feed row. */
  consequence(call: SocialCall, result: VisitResult): void;
  /** The call expired before it was made (the caller never came). */
  onMissed?(call: SocialCall, nowMin: number): void;
  /** A watch this kind set has come due. */
  onWatchDue?(watch: CallWatch, nowMin: number): void;
}
