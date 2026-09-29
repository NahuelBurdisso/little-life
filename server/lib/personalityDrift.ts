import { db } from '../db';
import { agents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { simEvents } from './simEvents';
import type { PersonalityProfile } from './personality';
import { asId, asNumber, asRecord, type SnapshotStore } from '../engine/snapshotCodec';
import { saveSnapshots } from '../engine/simSnapshots';

// ─── Personality Drift ────────────────────────────────────────────────────────
// Major life events cause small, permanent personality shifts.
// Being robbed → +neuroticism. Falling in love → +warmth. Achieving goals → -neuroticism.
// Shifts are small (1-3 points) and capped at ±15 from original values.
// Creates agents that evolve over time based on their experiences.

const MAX_DRIFT = 15;
const originalPersonalities = new Map<number, PersonalityProfile>();

const AXES: ReadonlyArray<keyof PersonalityProfile> = [
  'honesty', 'aggression', 'warmth', 'impulsiveness', 'vanity',
  'curiosity', 'loyalty', 'morality', 'sensuality', 'neuroticism',
];

/**
 * Drop cached personality baselines for a world replace. A reused agent id
 * would otherwise have its ±15 drift cap measured against a stranger's
 * baseline. Does not reset `initialized` — the simEvents listeners below must
 * stay registered exactly once.
 */
export function clearPersonalityBaselines(): void {
  originalPersonalities.clear();
}

/**
 * Checkpoint of the drift baselines (server/engine/simSnapshots.ts).
 *
 * This one is not just "nice to keep". The baseline is captured lazily from the
 * agents row the first time an agent drifts, and the row is where the drift is
 * written. When the baselines only lived in memory, the first drift after a
 * restart captured the *already drifted* personality as the new original, so
 * the ±15 cap re-anchored on every restart and drift was unbounded across them.
 * Shape: { [agentId]: PersonalityProfile }.
 */
export const personalityBaselineSnapshotStore: SnapshotStore = {
  key: 'personalityBaselines',
  version: 1,
  serialize() {
    const out: Record<string, PersonalityProfile> = {};
    for (const [agentId, p] of originalPersonalities) out[agentId] = { ...p };
    return out;
  },
  restore(data) {
    originalPersonalities.clear();
    for (const [key, raw] of Object.entries(asRecord(data) ?? {})) {
      const agentId = asId(key);
      const p = asRecord(raw);
      if (agentId === null || !p) continue;
      // All ten axes or nothing: a partial baseline would compare an axis
      // against `undefined` and silently disable its cap.
      const profile = {} as PersonalityProfile;
      let complete = true;
      for (const axis of AXES) {
        const v = asNumber(p[axis]);
        if (v === null) { complete = false; break; }
        profile[axis] = v;
      }
      if (complete) originalPersonalities.set(agentId, profile);
    }
  },
};

function getOriginal(agentId: number): PersonalityProfile | null {
  if (originalPersonalities.has(agentId)) return originalPersonalities.get(agentId)!;
  const agent = db.select({ personality: agents.personality }).from(agents).where(eq(agents.id, agentId)).get();
  if (!agent?.personality) return null;
  const p = agent.personality as PersonalityProfile;
  originalPersonalities.set(agentId, { ...p });
  // Write the new baseline through at once rather than waiting for the hourly
  // checkpoint: the drift about to be applied lands in the agents row right
  // away, and a crash in between would leave a drifted row with no baseline —
  // the same re-anchoring as before, just rarer. First captures happen once per
  // agent per world, so this is a handful of tiny writes. It runs inside the
  // emitting phase's transaction, so the baseline commits or rolls back
  // together with the drift that caused it.
  saveSnapshots([personalityBaselineSnapshotStore]);
  return p;
}

function applyDrift(agentId: number, axis: keyof PersonalityProfile, delta: number): void {
  const agent = db.select({ personality: agents.personality }).from(agents).where(eq(agents.id, agentId)).get();
  if (!agent?.personality) return;

  const original = getOriginal(agentId);
  if (!original) return;

  const current = agent.personality as PersonalityProfile;
  const originalValue = original[axis];
  const currentValue = current[axis];

  // Check drift cap
  const currentDrift = currentValue - originalValue;
  if (Math.abs(currentDrift + delta) > MAX_DRIFT) return;

  const newValue = Math.max(0, Math.min(100, currentValue + delta));
  const updated = { ...current, [axis]: newValue };
  db.update(agents).set({ personality: updated }).where(eq(agents.id, agentId)).run();
}

let initialized = false;

export function initPersonalityDrift(): void {
  if (initialized) return;
  initialized = true;

  // Being robbed → more neurotic, less trusting
  simEvents.on('economy:theft_caught', (p: { perpetratorId: number; victimId?: number }) => {
    if (p.victimId) {
      applyDrift(p.victimId, 'neuroticism', 2);
      applyDrift(p.victimId, 'warmth', -1);
    }
  });

  // Completing a goal → confidence boost
  simEvents.on('goal:completed', (p: { agentId: number; goalType: string }) => {
    applyDrift(p.agentId, 'neuroticism', -1);
    if (['protect', 'comfort_grieving', 'befriend'].includes(p.goalType)) {
      applyDrift(p.agentId, 'warmth', 1);
    }
    if (['revenge', 'undermine'].includes(p.goalType)) {
      applyDrift(p.agentId, 'aggression', 1);
      applyDrift(p.agentId, 'morality', -1);
    }
  });

  // Heartbreak → more neurotic or aggressive
  simEvents.on('state:triggered', (p: { agentId: number; state: string }) => {
    if (p.state === 'heartbroken') {
      applyDrift(p.agentId, 'neuroticism', 2);
      applyDrift(p.agentId, 'sensuality', -1);
    }
    if (p.state === 'depressed') {
      applyDrift(p.agentId, 'neuroticism', 1);
      applyDrift(p.agentId, 'impulsiveness', -1);
    }
    if (p.state === 'confident') {
      applyDrift(p.agentId, 'vanity', 1);
      applyDrift(p.agentId, 'neuroticism', -1);
    }
  });

  // Falling in love → warmer, more sensual
  simEvents.on('relationship:changed', (p: { agentId: number; status: string }) => {
    if (p.status === 'partners') {
      applyDrift(p.agentId, 'warmth', 2);
      applyDrift(p.agentId, 'sensuality', 1);
    }
    if (p.status === 'enemies') {
      applyDrift(p.agentId, 'aggression', 1);
    }
  });

  // Secret shared → more honest over time
  simEvents.on('secret:shared', (p: { sharerId: number }) => {
    applyDrift(p.sharerId, 'honesty', 1);
  });
}
