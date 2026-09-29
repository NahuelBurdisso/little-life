import { PersonalityProfile } from './personality';
import { db, getAgentStatesWriteVersion, verifyAgentStatesWriteHook } from '../db';
import { agentStates, agents, worldState } from '../db/schema';
import { gameMinutes } from './gameClock';
import { eq } from 'drizzle-orm';

// ─── State clock ──────────────────────────────────────────────────────────────

/**
 * Now, on the clock `agentStates.started_at` is stamped in: GAME MINUTES
 * (`gameMinutes(world.time)`), and every `duration` is game minutes too. They
 * were ticks, so at tick_speed 4 every state lasted four times its game-time
 * length (a "~12 game hours" drunk spell ran two game days). For writers that
 * don't already hold the world row; states.ts computes it once per tick.
 */
export function stateClockNow(): number {
  const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  return world?.time ? gameMinutes(world.time) : 0;
}

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
  | 'confident'
  | 'jealous'
  | 'alcoholic'
  | 'in_debt'
  | 'arrested';

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
  jealous: {
    type: 'jealous',
    modifiers: { aggression: 20, neuroticism: 10 },
    prompt: (targetName) =>
      `You're consumed by jealousy over ${targetName ?? 'someone'}. You can't stop thinking about them with your rival. It makes you irritable and obsessive.`,
    conditionalExit: true,
  },
  alcoholic: {
    type: 'alcoholic',
    modifiers: { impulsiveness: 10, warmth: -20, morality: -10 },
    prompt: "You have a drinking problem. You crave alcohol constantly. Work feels pointless compared to the tavern. You know it's destroying you but you can't stop.",
    conditionalExit: true,
  },
  in_debt: {
    type: 'in_debt',
    modifiers: { neuroticism: 15 },
    prompt: "You're broke and desperate. You can barely afford to eat. Every interaction is colored by your financial anxiety. You might need to ask for help — or take matters into your own hands.",
    conditionalExit: true,
  },
  arrested: {
    type: 'arrested',
    modifiers: { aggression: 15, warmth: -15, neuroticism: 20 },
    prompt:
      "You're locked in a cell. You cannot go anywhere or do anything until your sentence is served. You are humiliated, bored, and stewing on how you ended up here.",
  },
};

// ─── Tick-level agentStates cache ─────────────────────────────────────────────

let agentStatesCache: Map<number, string[]> | null = null;
/**
 * `getAgentStatesWriteVersion()` as of the last (re)build. The cache is built
 * once after the states phase, but later phases in the same tick still start and
 * end states — conversations (affair discovery), decisions, gossip, cascade,
 * tavern, gifts, loneliness — and without this every getAgentStates() after such
 * a write kept answering from the pre-write snapshot: a freshly-heartbroken agent
 * read as fine, a just-arrested one could still be queued for a chat.
 */
let agentStatesCacheVersion = -1;

/**
 * Build the tick-level snapshot. Called once per tick after the states phase, so
 * it is also where the write triggers are re-verified (cheap, and bounds any
 * period with a disconnected hook to one tick). Mid-tick refreshes go through
 * `rebuildAgentStatesCache()` and skip that check.
 */
export function cacheAllAgentStates(): void {
  verifyAgentStatesWriteHook();
  rebuildAgentStatesCache();
}

function rebuildAgentStatesCache(): void {
  // Read the version BEFORE the select: a write racing in between (there is none
  // today, better-sqlite3 is synchronous) would then force a rebuild rather than
  // be absorbed silently.
  agentStatesCacheVersion = getAgentStatesWriteVersion();
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

/**
 * Force the next getAgentStates() to rebuild from the DB, keeping the cache on.
 *
 * Call this after catching a rolled-back transaction that may have written
 * agent_states. The write triggers count the writes but nothing fires on
 * ROLLBACK, so a rebuild taken between the write and the rollback would keep
 * serving the vanished rows ("phantom states") for the rest of the tick.
 */
export function invalidateAgentStatesCache(): void {
  agentStatesCacheVersion = -1;
}

// ─── Helper Accessors ─────────────────────────────────────────────────────────

export function getAgentStates(agentId: number): StateType[] {
  if (agentStatesCache) {
    // Rebuild the whole snapshot (one query) rather than drop it: dropping it
    // would send every remaining read this tick down the per-agent fallback
    // below — the query storm the cache exists to prevent. Writes after the
    // states phase come a handful per tick, so this rebuilds at most that often.
    if (getAgentStatesWriteVersion() !== agentStatesCacheVersion) rebuildAgentStatesCache();
    return (agentStatesCache!.get(agentId) ?? []) as StateType[];
  }
  // Fallback to DB query if cache not initialized
  const states = db
    .select({ type: agentStates.type })
    .from(agentStates)
    .where(eq(agentStates.agent_id, agentId))
    .all();
  return states.map((s) => s.type as StateType);
}

/** `nowMinutes` is the state clock (see stateClockNow), not a tick. */
export function getActiveStatePrompts(agentId: number, nowMinutes?: number): string[] {
  const states = db
    .select()
    .from(agentStates)
    .where(eq(agentStates.agent_id, agentId))
    .all();

  // Pre-load all agent names to avoid per-state N+1 queries
  const allAgentNames = db.select({ id: agents.id, name: agents.name }).from(agents).all();
  const nameMap = new Map(allAgentNames.map(a => [a.id, a.name]));

  return states
    .map((s) => {
      const def = STATE_DEFINITIONS[s.type as StateType];
      if (!def) return '';

      if (typeof def.prompt === 'function') {
        let targetName: string | undefined;
        if (s.target_agent_id) {
          targetName = nameMap.get(s.target_agent_id);
        }
        const elapsed = nowMinutes ? nowMinutes - s.started_at : 0;
        const phase = elapsed < 2880 ? 'early' : elapsed < 10080 ? 'mid' : 'late';
        return def.prompt(targetName, phase);
      }

      return def.prompt;
    })
    .filter(Boolean);
}
