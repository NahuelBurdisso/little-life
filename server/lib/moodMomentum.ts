import { db } from '../db';
import { agents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { asId, asNumber, asRecord, type SnapshotStore } from '../engine/snapshotCodec';

// ─── Mood Momentum System ─────────────────────────────────────────────────────
// Tracks running mood average per agent. At day change, converts average mood
// into a momentum modifier that affects next day's mood calculation.
//
// Good days (avg mood > 65) → positive momentum → mood bonus next day
// Bad days (avg mood < 35) → negative momentum → mood penalty next day
// Creates realistic emotional inertia: happiness breeds happiness, misery spirals.

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

/** Called on day change. Computes momentum for next day. */
export function processDayEnd(agentId: number): void {
  const tracker = getTracker(agentId);
  if (tracker.moodSamples.length === 0) return;

  const avgMood = tracker.moodSamples.reduce((a, b) => a + b, 0) / tracker.moodSamples.length;

  // Determine streak direction
  if (avgMood > 65) {
    // Good day
    tracker.streak = tracker.streak > 0 ? tracker.streak + 1 : 1;
    const streakBonus = Math.min(tracker.streak, 5) * 1.5;
    tracker.momentum = Math.min(15, 3 + streakBonus);
  } else if (avgMood < 35) {
    // Bad day
    tracker.streak = tracker.streak < 0 ? tracker.streak - 1 : -1;
    const streakPenalty = Math.min(Math.abs(tracker.streak), 5) * 1.5;
    tracker.momentum = Math.max(-15, -3 - streakPenalty);
  } else {
    // Neutral day — momentum decays toward 0
    tracker.momentum *= 0.5;
    tracker.streak = 0;
  }

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
