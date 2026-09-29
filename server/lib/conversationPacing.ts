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
 * Pure apart from the in-memory latency window, which is about the model, not
 * the world, so it is deliberately NOT a per-world cache: a world replace does
 * not make the LLM faster.
 */

import { CONFIG } from './constants';
import type { PersonalityProfile } from './personality';

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

/**
 * How many turns fit in `budgetGameMin` when a turn takes `latencyMs` of real
 * time at `tickSpeed`. No latency observed yet → no cap (Infinity): with no
 * evidence the model is slow, a conversation keeps its tier's full length and
 * the budget itself is the backstop.
 */
export function affordableTurns(
  budgetGameMin: number,
  latencyMs: number | null,
  tickSpeed: number,
): number {
  if (latencyMs == null || latencyMs <= 0) return Infinity;
  return Math.floor(budgetGameMin / turnGameMinutes(latencyMs, tickSpeed));
}

// ---------------------------------------------------------------------------
// Rolling turn latency
// ---------------------------------------------------------------------------

const latencySamples: Array<{ ms: number; at: number }> = [];

/** Record the wall-clock duration of one completed LLM conversation turn. */
export function recordTurnLatency(ms: number, at: number = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  latencySamples.push({ ms, at });
  while (latencySamples.length > CONFIG.CONVERSATIONS.TURN_LATENCY_WINDOW) latencySamples.shift();
}

/**
 * Mean of the recent turn latencies in ms, or null when there is no recent
 * evidence. Samples expire: once a slow model has pushed every conversation onto
 * the template tier, no LLM turn is ever timed again, and without expiry the
 * town would stay on templates for good even after the model (or the speed)
 * recovered. With no fresh samples the next conversation runs uncapped and
 * re-measures.
 */
export function averageTurnLatencyMs(now: number = Date.now()): number | null {
  const maxAge = CONFIG.CONVERSATIONS.TURN_LATENCY_MAX_AGE_MS;
  while (latencySamples.length > 0 && now - latencySamples[0].at > maxAge) latencySamples.shift();
  if (latencySamples.length === 0) return null;
  return latencySamples.reduce((s, v) => s + v.ms, 0) / latencySamples.length;
}

/** Test hook: forget every sample. */
export function resetTurnLatency(): void {
  latencySamples.length = 0;
}

// ---------------------------------------------------------------------------
// Needs interrupt
// ---------------------------------------------------------------------------

export type NeedsWrapUpReason = 'energy' | 'sleep' | 'hunger';

interface SleepSchedule {
  wakeTime: number;
  sleepTime: number;
}

/**
 * Is `hour` inside the agent's personality-shifted sleep window?
 *
 * MIRRORS `checkSchedule` in engine/systems/decisions.ts (the "Sleep time:
 * personality-adjusted chronotype" block) — the same shift, clamps and window,
 * so a conversation ends exactly when decisions would otherwise send the agent
 * to bed. Duplicated rather than extracted because decisions.ts is mid-rework
 * elsewhere; if you change one, change both.
 */
export function isPastBedtime(
  schedule: SleepSchedule,
  personality: Pick<PersonalityProfile, 'impulsiveness' | 'sensuality' | 'morality' | 'neuroticism'> | null,
  hour: number,
): boolean {
  let sleepShift = 0;
  if (personality) {
    sleepShift += (personality.impulsiveness - 50) * 0.02;
    sleepShift += (personality.sensuality - 50) * 0.01;
    sleepShift -= (personality.morality - 50) * 0.015;
    if (personality.neuroticism > 60) sleepShift *= 0.5;
    sleepShift = Math.max(-2, Math.min(3, Math.round(sleepShift)));
  }
  const baseSleepTime = schedule.sleepTime === 0 ? 24 : schedule.sleepTime;
  const effectiveSleepTime = Math.max(19, Math.min(26, baseSleepTime + sleepShift)) % 24 || 24;
  const effectiveWakeTime = Math.max(4, Math.min(12, schedule.wakeTime + sleepShift));
  if (effectiveSleepTime > effectiveWakeTime) {
    return hour >= effectiveSleepTime || hour < effectiveWakeTime;
  }
  return hour >= effectiveSleepTime && hour < effectiveWakeTime;
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
