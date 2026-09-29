/**
 * Conversation pacing: how long an LLM conversation may run in GAME time, how
 * many turns fit in that at the current speed, and when a participant's body
 * overrules the chat.
 *
 * Why this exists: the conversation budget used to be wall-clock (15 s per
 * deep turn). An LLM turn takes the same 20–60 real seconds at every speed, so
 * at 4x a single turn cost up to four game hours and a ten-turn conversation
 * up to ten — Rosa and Yuki talked from 21:00 to 05:00 and never slept. Budgets
 * are now game minutes, and the turn count is sized to what the model can
 * actually deliver inside them at the current `tick_speed`.
 *
 * The latency window and probe stamp are game-minute stamped, so they are reset
 * with the other per-world caches (engine/worldCaches.ts).
 */

import { CONFIG } from './constants';
import { effectiveSleepWindow, inSleepWindow, type Chronotype, type SleepScheduleInput } from './sleepSchedule';

export { effectiveSleepWindow } from './sleepSchedule';

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Game-minute budget for a conversation whose tier allows `tierMaxTurns`. */
export function conversationBudgetGameMinutes(tierMaxTurns: number): number {
  return tierMaxTurns * CONFIG.CONVERSATIONS.GAME_MINUTES_PER_TURN;
}

/**
 * Game minutes one LLM turn costs: the loop runs one tick per TICK_INTERVAL_MS
 * and each tick advances the clock `tickSpeed` minutes, so a turn's real
 * latency is multiplied by the speed. Speed 0 (paused) counts as 1x.
 */
export function turnGameMinutes(latencyMs: number, tickSpeed: number): number {
  const speed = tickSpeed > 0 ? tickSpeed : 1;
  return (latencyMs / CONFIG.TICK_INTERVAL_MS) * speed;
}

export interface ConversationPlan {
  /** 'template': not even one exchange fits — have it as a template chat. */
  tier: 'llm' | 'template';
  maxTurns: number;
  budgetGameMin: number;
  /** How long an in-flight turn may still land once the conversation wraps up. */
  graceGameMin: number;
  /** An ordinary conversation run anyway, to re-measure a model the town gave up on. */
  probe: boolean;
}

/**
 * Size one LLM conversation before it is dispatched.
 *
 * - The budget is the tier's (turns × GAME_MINUTES_PER_TURN).
 * - The turn count is capped by how many expected turns fit in it. At 1x and
 *   below only MEASURED latency may cap it — that is the speed the old
 *   wall-clock budget was tuned for, and a guess must not shorten conversations
 *   there. Above 1x an unmeasured model is assumed to take TURN_LATENCY_PRIOR_MS.
 * - When not even MIN_LLM_TURNS fit, an ordinary conversation becomes a template
 *   chat — unless a probe is due. Protected ones (player-requested, comfort
 *   visits) and probes keep the LLM with MIN_LLM_TURNS and a budget stretched to
 *   fit them, up to EXTENDED_BUDGET_CAP_GAME_MINUTES, so both sides get a line.
 * - Grace is one expected turn, at least WRAP_UP_GRACE_GAME_MINUTES and at most
 *   MAX_WRAP_UP_GRACE_GAME_MINUTES.
 */
export function planConversation(p: {
  tierMaxTurns: number;
  tickSpeed: number;
  isProtected: boolean;
  /** Median of recent measured turns, or null. */
  observedLatencyMs: number | null;
  probeDue: boolean;
}): ConversationPlan {
  const C = CONFIG.CONVERSATIONS;
  const speed = p.tickSpeed > 0 ? p.tickSpeed : 1;
  const tierBudget = conversationBudgetGameMinutes(p.tierMaxTurns);
  const latencyMs = p.observedLatencyMs ?? (speed > 1 ? C.TURN_LATENCY_PRIOR_MS : null);
  const turnMin = latencyMs != null && latencyMs > 0 ? turnGameMinutes(latencyMs, speed) : null;
  const affordable = turnMin != null ? Math.floor(tierBudget / turnMin) : Infinity;
  const graceGameMin = Math.min(
    C.MAX_WRAP_UP_GRACE_GAME_MINUTES,
    Math.max(C.WRAP_UP_GRACE_GAME_MINUTES, Math.ceil(turnMin ?? 0)),
  );

  if (affordable >= C.MIN_LLM_TURNS) {
    return {
      tier: 'llm',
      maxTurns: Math.min(p.tierMaxTurns, affordable),
      budgetGameMin: tierBudget,
      graceGameMin,
      probe: false,
    };
  }
  if (!p.isProtected && !p.probeDue) {
    return { tier: 'template', maxTurns: 0, budgetGameMin: 0, graceGameMin, probe: false };
  }
  const budgetGameMin = Math.min(
    C.EXTENDED_BUDGET_CAP_GAME_MINUTES,
    Math.max(tierBudget, Math.ceil(C.MIN_LLM_TURNS * (turnMin ?? 0))),
  );
  return {
    tier: 'llm',
    maxTurns: Math.min(p.tierMaxTurns, C.MIN_LLM_TURNS),
    budgetGameMin,
    graceGameMin,
    probe: !p.isProtected,
  };
}

// ---------------------------------------------------------------------------
// Turn latency window
// ---------------------------------------------------------------------------

const latencySamples: Array<{ ms: number; gameMin: number }> = [];
let lastProbeGameMin: number | null = null;

/**
 * Record how long one conversation turn's LLM work took (wall ms), stamped with
 * the game minute. Also called with a CENSORED sample — how long an abandoned
 * turn had been running when its conversation was closed — so a model too slow
 * to ever finish a turn still registers as slow instead of leaving no trace.
 */
export function recordTurnLatency(ms: number, gameMin: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  latencySamples.push({ ms, gameMin });
  while (latencySamples.length > CONFIG.CONVERSATIONS.TURN_LATENCY_WINDOW) latencySamples.shift();
}

function isFresh(stampGameMin: number, nowGameMin: number): boolean {
  const age = nowGameMin - stampGameMin;
  // Negative age: stamped under a clock that was ahead of this one.
  return age >= 0 && age <= CONFIG.CONVERSATIONS.TURN_LATENCY_MAX_AGE_GAME_MINUTES;
}

/**
 * Median of the fresh samples in ms, or null when there are none. A median, not
 * a mean: one stalled call (a model reload, a retry storm) must not flip every
 * conversation onto templates.
 */
export function turnLatencyEstimateMs(nowGameMin: number): number | null {
  const fresh = latencySamples
    .filter((s) => isFresh(s.gameMin, nowGameMin))
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  if (fresh.length === 0) return null;
  const mid = Math.floor(fresh.length / 2);
  return fresh.length % 2 ? fresh[mid] : (fresh[mid - 1] + fresh[mid]) / 2;
}

/**
 * May an ordinary conversation run as a latency probe now? Only when nothing
 * has been measured recently (otherwise the estimate is trusted) and no probe
 * ran in the last TURN_LATENCY_MAX_AGE_GAME_MINUTES. Without probes, a town the
 * estimate pushed onto templates would never time an LLM turn again.
 */
export function latencyProbeDue(nowGameMin: number): boolean {
  if (turnLatencyEstimateMs(nowGameMin) != null) return false;
  return lastProbeGameMin == null || !isFresh(lastProbeGameMin, nowGameMin);
}

export function markLatencyProbe(nowGameMin: number): void {
  lastProbeGameMin = nowGameMin;
}

/** Forget every sample and the probe stamp (world replace, tests). */
export function resetConversationPacing(): void {
  latencySamples.length = 0;
  lastProbeGameMin = null;
}

// ---------------------------------------------------------------------------
// Needs interrupt
// ---------------------------------------------------------------------------

export type NeedsWrapUpReason = 'energy' | 'sleep' | 'hunger';

/**
 * Is `hour` inside the agent's sleep window? The window itself lives in
 * sleepSchedule.ts, shared with decisions.ts, so a conversation ends exactly
 * when decisions would otherwise send the agent to bed — including the
 * worker's wake-before-the-shift clamp, which needs `hasWorkplace`.
 */
export function isPastBedtime(
  schedule: SleepScheduleInput,
  personality: Chronotype | null,
  hour: number,
  hasWorkplace = false,
): boolean {
  return inSleepWindow(effectiveSleepWindow(schedule, personality, hasWorkplace), hour);
}

/**
 * Why this participant has to leave the conversation now, if at all. Critical
 * energy first (they are about to collapse), then bedtime, then critical
 * hunger — the same needs `checkEmergency`/`checkSchedule` in decisions.ts act
 * on, which never got a say while the agent was `talking`.
 */
export function needsWrapUpReason(
  n: { hunger: number; energy: number; critical: number },
  pastBedtime: boolean,
): NeedsWrapUpReason | null {
  if (n.energy < n.critical) return 'energy';
  if (pastBedtime) return 'sleep';
  if (n.hunger < n.critical) return 'hunger';
  return null;
}

// ---------------------------------------------------------------------------
// Queue waits
// ---------------------------------------------------------------------------

/**
 * `conversation_queue.max_wait` for a wait of `gameMinutes`: the column is in
 * ms of 1x play (one game minute per TICK_INTERVAL_MS), which is what every
 * producer already wrote — decisions.ts' literal 10000 reads as 10 game minutes.
 */
export function queueMaxWait(gameMinutes: number): number {
  return gameMinutes * CONFIG.TICK_INTERVAL_MS;
}

/**
 * The game minute a queue entry times out, for an entry no producer stamped:
 * from now, by its 1x-equivalent `max_wait`. Deliberately NOT backdated by its
 * wall-clock age — an entry queued before (or during) a pause would otherwise
 * expire the moment play resumes, having waited no game time at all. The
 * scheduler first sees an entry the tick after it is queued, so at most one
 * tick of extra wait.
 */
export function queueDeadlineGameMin(entry: { max_wait: number }, nowGameMin: number): number {
  return Math.round(nowGameMin + entry.max_wait / CONFIG.TICK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Are ordinary conversations being demoted to template lines right now because
 * a measured LLM turn is too slow for the current speed? The health banner's
 * "degraded" case: nothing failed, but the town cannot afford live chats.
 * Unmeasured latency is no verdict (a fresh start has none).
 */
export function conversationsOnTemplates(nowGameMin: number, tickSpeed: number): boolean {
  const observedLatencyMs = turnLatencyEstimateMs(nowGameMin);
  if (observedLatencyMs == null) return false;
  return planConversation({
    tierMaxTurns: CONFIG.CONVERSATIONS.MAX_TURNS_STANDARD,
    tickSpeed,
    isProtected: false,
    observedLatencyMs,
    probeDue: false,
  }).tier === 'template';
}
