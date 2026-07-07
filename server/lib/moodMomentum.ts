import { db } from '../db';
import { agents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from './activityLogger';

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

/** Process all agents at day change. */
export function processAllMoodMomentum(): void {
  const allAgents = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all();
  for (const { id } of allAgents) {
    processDayEnd(id);
  }
}
