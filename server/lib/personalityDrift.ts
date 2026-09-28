import { db } from '../db';
import { agents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { simEvents } from './simEvents';
import type { PersonalityProfile } from './personality';

// ─── Personality Drift ────────────────────────────────────────────────────────
// Major life events cause small, permanent personality shifts.
// Being robbed → +neuroticism. Falling in love → +warmth. Achieving goals → -neuroticism.
// Shifts are small (1-3 points) and capped at ±15 from original values.
// Creates agents that evolve over time based on their experiences.

const MAX_DRIFT = 15;
const originalPersonalities = new Map<number, PersonalityProfile>();

/**
 * Drop cached personality baselines for a world replace. A reused agent id
 * would otherwise have its ±15 drift cap measured against a stranger's
 * baseline. Does not reset `initialized` — the simEvents listeners below must
 * stay registered exactly once.
 */
export function clearPersonalityBaselines(): void {
  originalPersonalities.clear();
}

function getOriginal(agentId: number): PersonalityProfile | null {
  if (originalPersonalities.has(agentId)) return originalPersonalities.get(agentId)!;
  const agent = db.select({ personality: agents.personality }).from(agents).where(eq(agents.id, agentId)).get();
  if (!agent?.personality) return null;
  const p = agent.personality as PersonalityProfile;
  originalPersonalities.set(agentId, { ...p });
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
