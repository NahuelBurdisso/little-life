import { db } from '../db';
import { agents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { asId, asNumber, asRecord, type SnapshotStore } from '../engine/snapshotCodec';
import { MOOD_BASELINE_NEUTRAL, moodBaseline } from './moodBaseline';
import type { PersonalityProfile } from './personality';

// ─── Mood Momentum System ─────────────────────────────────────────────────────
// Tracks running mood average per agent. At day change, converts average mood
// into a momentum modifier that affects next day's mood calculation.
//
// A day above the resident's baseline (moodBaseline.ts) lifts the next a little,
// a day below weighs on it: emotional inertia, a run of good or bad days deepening
// it — but always a fraction of the deviation (`nextMomentum`), so it fades back to
// temperament instead of spiralling.

interface MoodTracker {
  moodSamples: number[];      // mood readings throughout the day
  momentum: number;            // -15 to +15 modifier applied to mood
  streak: number;              // consecutive good/bad days (amplifies momentum)
}

const moodTrackers = new Map<number, MoodTracker>();

/** Drop per-agent mood momentum for a world replace (agent ids are reused). */
export function clearMoodTrackers(): void {
  moodTrackers.clear();
}

/**
 * Checkpoint of every tracker (server/engine/simSnapshots.ts). The streak is
 * built one game day at a time, so a restart used to snap every agent out of a
 * week-long spiral (or glow) at once. Today's samples go along too, or the day
 * in progress would be judged on its post-restart hours only. Shape:
 * { [agentId]: { moodSamples, momentum, streak } }.
 */
export const moodMomentumSnapshotStore: SnapshotStore = {
  key: 'moodMomentum',
  version: 1,
  serialize() {
    const out: Record<string, MoodTracker> = {};
    for (const [agentId, t] of moodTrackers) {
      out[agentId] = { moodSamples: [...t.moodSamples], momentum: t.momentum, streak: t.streak };
    }
    return out;
  },
  restore(data) {
    moodTrackers.clear();
    for (const [key, raw] of Object.entries(asRecord(data) ?? {})) {
      const agentId = asId(key);
      const t = asRecord(raw);
      const momentum = asNumber(t?.momentum);
      const streak = asNumber(t?.streak);
      if (agentId === null || momentum === null || streak === null) continue;
      const rawSamples = t?.moodSamples;
      const moodSamples = Array.isArray(rawSamples)
        ? rawSamples.map(asNumber).filter((n): n is number => n !== null)
        : [];
      moodTrackers.set(agentId, { moodSamples, momentum, streak });
    }
  },
};

function getTracker(agentId: number): MoodTracker {
  let tracker = moodTrackers.get(agentId);
  if (!tracker) {
    tracker = { moodSamples: [], momentum: 0, streak: 0 };
    moodTrackers.set(agentId, tracker);
  }
  return tracker;
}

/** Called every tick to sample agent mood. */
export function sampleMood(agentId: number, mood: number): void {
  const tracker = getTracker(agentId);
  // Only keep ~24 samples per day (one per game hour)
  if (tracker.moodSamples.length < 24) {
    tracker.moodSamples.push(mood);
  }
}

/** A day this far above the resident's baseline counts as a good one (streaks, the feed). */
const GOOD_DAY_MARGIN = 12;
/** ... and this far below as a bad one. Under 35 is a bad day for anyone (populationFlow). */
const BAD_DAY_MARGIN = 20;
const BAD_DAY_ABSOLUTE = 35;
/** Momentum never exceeds this either way. */
const MAX_MOMENTUM = 8;

/**
 * Tomorrow's momentum from today's average, measured against the resident's baseline.
 *
 * It used to be absolute: any day averaging over 65 — almost every day in a fed, rested town
 * — earned +3..+15 on the next, which kept the next one over 65: the loop that parked the
 * whole town near 91 (see moodBaseline.ts). Now momentum carries a share of how far the day
 * strayed from the resident's usual self, 25% rising to 35% on a streak. The share is under 1,
 * so a good day still colours the next one but the town drifts back to temperament instead
 * of running away. Pure (exported for tests).
 */
export function nextMomentum(avgMood: number, baseline: number, streak: number): { momentum: number; streak: number } {
  let next = 0;
  // The bad-day bar is measured from the baseline, but never from above a
  // neutral temperament's. Below baseline, mood is ~90% needs and ~10%
  // temperament (moodBaseline.ts adaptNeedsMood), so a sunny baseline mostly
  // raised the bar: Omar (baseline 72) had 24 "terrible" days in a row on an
  // ordinary ~48 average, and thought of leaving every fourth day.
  const badBar = Math.min(baseline, MOOD_BASELINE_NEUTRAL) - BAD_DAY_MARGIN;
  if (avgMood >= baseline + GOOD_DAY_MARGIN) next = streak > 0 ? streak + 1 : 1;
  else if (avgMood < BAD_DAY_ABSOLUTE || avgMood <= badBar) next = streak < 0 ? streak - 1 : -1;
  const gain = 0.25 + Math.min(Math.abs(next), 4) * 0.025;
  const momentum = Math.max(-MAX_MOMENTUM, Math.min(MAX_MOMENTUM, (avgMood - baseline) * gain));
  return { momentum, streak: next };
}

/** Called on day change. Computes momentum for next day. */
export function processDayEnd(agentId: number): void {
  const tracker = getTracker(agentId);
  if (tracker.moodSamples.length === 0) return;

  const avgMood = tracker.moodSamples.reduce((a, b) => a + b, 0) / tracker.moodSamples.length;
  const row = db.select({ personality: agents.personality }).from(agents).where(eq(agents.id, agentId)).get();
  const baseline = moodBaseline((row?.personality as PersonalityProfile | null | undefined) ?? null);
  const next = nextMomentum(avgMood, baseline, tracker.streak);
  tracker.momentum = next.momentum;
  tracker.streak = next.streak;

  // Log notable mood streaks
  if (Math.abs(tracker.streak) >= 3) {
    const agent = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).get();
    if (agent) {
      const direction = tracker.streak > 0 ? 'great' : 'terrible';
      logActivity({
        type: 'system',
        initiator: agentId,
        templateData: { message: `${agent.name} has been having ${direction} days (${Math.abs(tracker.streak)} day streak)` },
      });
    }
  }

  // Reset samples for next day
  tracker.moodSamples = [];
}

/**
 * Deciding to stay is a turning point: the bad streak that made someone think
 * of leaving ends there, and half its drag goes with it. Without this the
 * streak was still counting when the three days' grace ran out, and the
 * resident was thinking of leaving again the next morning (Omar: days 7, 11,
 * 15, 19, 23).
 */
export function freshStart(agentId: number): void {
  const tracker = getTracker(agentId);
  if (tracker.streak < 0) tracker.streak = 0;
  if (tracker.momentum < 0) tracker.momentum /= 2;
}

/** Get current mood momentum modifier. Applied in needs system. */
export function getMoodMomentum(agentId: number): number {
  return getTracker(agentId).momentum;
}

/**
 * Consecutive good (positive) or bad (negative) days, as judged at the last day
 * change; 0 after a neutral day. lib/populationFlow.ts reads a long bad streak
 * as "miserable here for days" — the one record of how someone has felt over
 * more than today.
 */
export function getMoodStreak(agentId: number): number {
  return moodTrackers.get(agentId)?.streak ?? 0;
}

/** Process all agents at day change. */
export function processAllMoodMomentum(): void {
  const allAgents = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all();
  for (const { id } of allAgents) {
    processDayEnd(id);
  }
}
