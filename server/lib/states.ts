import { PersonalityProfile } from './personality';
import { db, getAgentStatesRowVersion, getAgentStatesWriteVersion, verifyWriteHooks } from '../db';
import { agentStates, agents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { RowsByAgentSnapshot } from './rowsByAgentSnapshot';

// CLOCK: `agentStates.started_at` and every `duration` are GAME MINUTES
// (`gameMinutes(world.time)`, or `gameMinutesNow()` in lib/worldClock.ts for
// writers without the world row). They were ticks, so at tick_speed 4 every
// state lasted four times its game-time length (a "~12 game hours" drunk spell
// ran two game days).

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
  | 'envious'
  | 'alcoholic'
  | 'in_debt'
  | 'arrested'
  // The adult layer's aftermath (lib/intimacy): the warmth of a night together,
  // the weight of having betrayed someone, and the itch of suspecting it.
  | 'afterglow'
  | 'guilty'
  | 'suspicious';

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
  // Someone else won what you wanted: a festival contest, the mayor's chair
  // (lib/townCalendar.ts). Not `jealous`, whose prompt is about a rival in
  // love; envy is about standing, fixed-length, and the seed of a grudge.
  envious: {
    type: 'envious',
    modifiers: { aggression: 10, warmth: -15, neuroticism: 10 },
    prompt: (targetName) =>
      `You can't shake your envy of ${targetName ?? 'someone'}. They won what should have been yours, and everyone keeps congratulating them.`,
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
  // ~8 game hours after a night with a lover (lib/intimacy/tryst.ts). Fixed length:
  // it is a mood, not a condition, and it ends quietly (no "is no longer" feed row).
  afterglow: {
    type: 'afterglow',
    modifiers: { warmth: 10, sensuality: 10, neuroticism: -10 },
    prompt: (targetName) =>
      `You are still glowing from last night with ${targetName ?? 'them'}; you catch yourself smiling.`,
  },
  // 24 game hours for someone with a conscience who betrayed a spouse or partner.
  // Targets the one betrayed, so kindness from THEM is what stings.
  guilty: {
    type: 'guilty',
    modifiers: { neuroticism: 15, warmth: -5, honesty: 10 },
    prompt: (targetName) =>
      `You betrayed ${targetName ?? 'them'}. Every kind word from them cuts.`,
  },
  // A partner's nights away from home, noticed (lib/intimacy/suspicion.ts). Targets
  // the partner. Ends after a while, or when the truth is learnt one way or the other.
  suspicious: {
    type: 'suspicious',
    modifiers: { curiosity: 10, neuroticism: 10, warmth: -10 },
    prompt: (targetName) =>
      `You suspect ${targetName ?? 'them'} is hiding something about where they spend their nights.`,
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
  verifyWriteHooks();
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

// ─── Whole-row agent_states snapshot ──────────────────────────────────────────

export type AgentStateRow = typeof agentStates.$inferSelect;

/**
 * Every agent_states row, grouped by agent, re-read in ONE query only when the
 * table has been written since the last read (`getAgentStatesRowVersion`; see
 * RowsByAgentSnapshot for the mechanism and its rules).
 *
 * The states phase used to re-select an agent's rows after each step that might
 * have changed them — expiry, conditional exits, triggers, effective personality,
 * side effects, the death check — about six queries per agent per tick, plus a
 * point lookup for every "does X already have state Y" check. Most ticks write
 * nothing, so nearly all of those were the same answer read again. A snapshot
 * keyed on the write counter answers them from memory and still sees every write
 * the moment it lands, including ones made by simEvents listeners (the cascade
 * engine inserts states from inside other phases' events).
 *
 * Order matches the per-agent query it replaces: `WHERE agent_id = ?` walks
 * idx_agent_states_agent_id, i.e. rowid order, and a full scan grouped by agent
 * keeps rowid order within each agent. `find` returns the lowest rowid of that
 * type, as `WHERE agent_id = ? AND type = ?` ... `.get()` does. Order matters:
 * effective personality clamps per state, so it is order-sensitive at the bounds.
 *
 * Scope one instance to one phase call. Like the type cache it cannot see a
 * ROLLBACK, and a phase that throws discards its snapshot along with its
 * transaction. The returned rows and arrays are shared — read them, never
 * mutate them (every caller builds a new metadata object before writing).
 */
export class AgentStateRowsSnapshot extends RowsByAgentSnapshot<AgentStateRow> {
  constructor() {
    super(
      getAgentStatesRowVersion,
      // `id` is the rowid alias, so the ORDER BY costs nothing on a table scan
      // and pins the order the per-agent index walk used to give.
      () => db.select().from(agentStates).orderBy(agentStates.id).all(),
      (row) => row.agent_id,
    );
  }

  /** The agent's oldest row of `type`, if any. */
  find(agentId: number, type: string): AgentStateRow | undefined {
    return this.forAgent(agentId).find((s) => s.type === type);
  }
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

/** `nowMinutes` is game minutes (the state clock), not a tick. */
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
