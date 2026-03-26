import { PersonalityProfile } from './personality';
import { db } from '../db';
import { agentStates, agents } from '../db/schema';
import { eq } from 'drizzle-orm';

// ─── Effective Personality Map ────────────────────────────────────────────────

const effectivePersonalities = new Map<number, PersonalityProfile>();

export function getEffectivePersonality(agentId: number): PersonalityProfile | null {
  return effectivePersonalities.get(agentId) ?? null;
}

export function setEffectivePersonality(agentId: number, p: PersonalityProfile) {
  effectivePersonalities.set(agentId, p);
}

export function clearEffectivePersonalities() {
  effectivePersonalities.clear();
}

// ─── State Types ──────────────────────────────────────────────────────────────

export type StateType =
  | 'drunk'
  | 'hungover'
  | 'sick'
  | 'heartbroken'
  | 'angry'
  | 'stressed'
  | 'euphoric'
  | 'grieving'
  | 'infatuated'
  | 'lonely'
  | 'depressed'
  | 'confident';

export interface StateDefinition {
  type: StateType;
  modifiers: Partial<Record<keyof PersonalityProfile, number>>; // deltas scaled by severity
  prompt: string | ((targetName?: string, phase?: string) => string);
  conditionalExit?: boolean; // true = no fixed duration, exits by condition
  speedMultiplier?: number; // movement speed modifier
}

// ─── State Definitions ────────────────────────────────────────────────────────

export const STATE_DEFINITIONS: Record<StateType, StateDefinition> = {
  drunk: {
    type: 'drunk',
    modifiers: { impulsiveness: 30, warmth: 20, honesty: -25 },
    prompt: "You've been drinking. You're loose-lipped and say things you'd normally keep to yourself.",
    speedMultiplier: 0.7,
  },
  hungover: {
    type: 'hungover',
    modifiers: {}, // energy/mood handled by needs system
    prompt: "You're hungover and regretting last night. You're sluggish and irritable.",
  },
  sick: {
    type: 'sick',
    modifiers: {},
    prompt: "You're feeling ill. You don't have energy for much and just want to rest.",
    speedMultiplier: 0.6,
  },
  heartbroken: {
    type: 'heartbroken',
    modifiers: { neuroticism: 30, warmth: -20 },
    prompt: (targetName) =>
      `Your heart is broken. You're devastated and can't stop thinking about ${targetName ?? 'them'}.`,
  },
  angry: {
    type: 'angry',
    modifiers: { aggression: 40, warmth: -20 },
    prompt: (targetName) =>
      `You're furious at ${targetName ?? 'someone'}. You can barely contain your anger when they come up.`,
  },
  stressed: {
    type: 'stressed',
    modifiers: { neuroticism: 20 },
    prompt: "You're stressed and overwhelmed. Everything feels like too much right now.",
    conditionalExit: true,
  },
  euphoric: {
    type: 'euphoric',
    modifiers: { warmth: 20, sensuality: 15, impulsiveness: 10 },
    prompt:
      "You're on top of the world right now. Everything feels wonderful and you want to share that feeling.",
  },
  grieving: {
    type: 'grieving',
    modifiers: {},
    prompt: (targetName, phase) => {
      if (phase === 'early') return `You're in shock. You can't believe ${targetName ?? 'they'} is gone.`;
      if (phase === 'mid') return `You miss ${targetName ?? 'them'} terribly. Talking about them helps.`;
      return `You're starting to accept the loss of ${targetName ?? 'them'}, but it still hurts.`;
    },
  },
  infatuated: {
    type: 'infatuated',
    modifiers: { sensuality: 20, warmth: 15 },
    prompt: (targetName) =>
      `You can't stop thinking about ${targetName ?? 'them'}. Everything reminds you of them.`,
    conditionalExit: true,
  },
  lonely: {
    type: 'lonely',
    modifiers: { neuroticism: 15 },
    prompt: "You feel invisible. Nobody seems to notice or care about you lately.",
    conditionalExit: true,
  },
  depressed: {
    type: 'depressed',
    modifiers: {},
    prompt: "Everything feels hollow. You go through the motions but nothing feels worth the effort.",
    conditionalExit: true,
  },
  confident: {
    type: 'confident',
    modifiers: { vanity: 15, neuroticism: -10, warmth: 10 },
    prompt:
      "You're feeling good about yourself. You're assertive, charming, and ready to take on anything.",
  },
};

// ─── Tick-level agentStates cache ─────────────────────────────────────────────

let agentStatesCache: Map<number, string[]> | null = null;

export function cacheAllAgentStates(): void {
  const allStates = db
    .select({ agent_id: agentStates.agent_id, type: agentStates.type })
    .from(agentStates)
    .all();
  agentStatesCache = new Map();
  for (const s of allStates) {
    const list = agentStatesCache.get(s.agent_id) ?? [];
    list.push(s.type);
    agentStatesCache.set(s.agent_id, list);
  }
}

export function clearAgentStatesCache(): void {
  agentStatesCache = null;
}

// ─── Helper Accessors ─────────────────────────────────────────────────────────

export function getAgentStates(agentId: number): StateType[] {
  if (agentStatesCache) {
    return (agentStatesCache.get(agentId) ?? []) as StateType[];
  }
  // Fallback to DB query if cache not initialized
  const states = db
    .select({ type: agentStates.type })
    .from(agentStates)
    .where(eq(agentStates.agent_id, agentId))
    .all();
  return states.map((s) => s.type as StateType);
}

export function getActiveStatePrompts(agentId: number, currentTick?: number): string[] {
  const states = db
    .select()
    .from(agentStates)
    .where(eq(agentStates.agent_id, agentId))
    .all();

  return states
    .map((s) => {
      const def = STATE_DEFINITIONS[s.type as StateType];
      if (!def) return '';

      if (typeof def.prompt === 'function') {
        let targetName: string | undefined;
        if (s.target_agent_id) {
          targetName = db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, s.target_agent_id))
            .get()?.name;
        }
        const elapsed = currentTick ? currentTick - s.started_at : 0;
        const phase = elapsed < 2880 ? 'early' : elapsed < 10080 ? 'mid' : 'late';
        return def.prompt(targetName, phase);
      }

      return def.prompt;
    })
    .filter(Boolean);
}
