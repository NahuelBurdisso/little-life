/**
 * Goal progress from what actually happens between two people, and goal completion.
 *
 * WHY THIS EXISTS: a 30-day soak finished zero goals. The registry's `progress_events` name
 * interactions ("fight", "blackmail", "comfort") that nothing ever reports against a goal, so
 * the only progress writer was a `conversation:ended` listener in systems/goals.ts that
 *   - advanced EVERY goal aimed at the chat partner on ANY chat that wasn't openly hostile —
 *     a warm "lovely weather" nudged a revenge plot forward — and
 *   - capped progress at 1.0 without ever marking the goal completed.
 * Goals then died of old age (`minutes_elapsed` abandonment), and the story beat a player
 * waits for — the grudge settled, the friend won over — never landed.
 *
 * Progress is now read off OUTCOMES, and each goal type only listens to the ones that serve
 * it: a revenge advances on a hostile outcome (a sharp exchange, an insult, a fight, a rumor
 * about the target spread around), a courtship on warm ones (a good talk, a flirt, a gift),
 * a protect/comfort goal on care (comfort, a gift, the target getting better). A goal that
 * reaches its registry `completion_at` completes: status + feed row + memory (MemoryObserver's
 * `goal:completed`) + a mood lift, the same path passive and rule-based completion use.
 *
 * `GOAL_OUTCOME_GAINS` is pure data; the writers below touch the database and are called
 * synchronously from inside the emitting phase's transaction, like every simEvents listener.
 */
import { db } from '../../db';
import { agents, goals, needs } from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import { GOAL_REGISTRY } from '../../data/goalRegistry';
import { logActivity } from '../activityLogger';
import { simEvents } from '../simEvents';
import { gameMinutesNow } from '../worldClock';
import { goalClause } from '../goalText';
import { firstName as givenName } from '../../ai/names';

/** Something that happened between a goal's owner and its target. */
export type GoalOutcome =
  /** A friendly conversation (sentiment > WARM_CHAT). */
  | 'warm_chat'
  /** A sour one (sentiment < HOSTILE_CHAT): a sniping exchange is a small win for a grudge. */
  | 'hostile_chat'
  | 'flirt'
  /** The owner insulted / humiliated the target. */
  | 'insulted_target'
  /** The owner got into a fight or shouting match with the target. */
  | 'fought_target'
  /** A public confrontation the owner came out of on top. */
  | 'confrontation_won'
  /** A confrontation that cleared the air instead. */
  | 'confrontation_resolved'
  /** The owner told someone a secret or rumor ABOUT the target. */
  | 'rumor_spread'
  /** The owner learned a secret about the target (what an investigation is after). */
  | 'rumor_heard'
  | 'stole_from_target'
  /** A warm talk with the target while they were down (lonely, grieving, heartbroken...). */
  | 'comforted'
  | 'gift_given'
  | 'reconciled'
  /** They kissed (lib/intimacy/kiss.ts): what a courtship was after, though not yet all of it. */
  | 'kissed'
  /** They spent the night together (lib/intimacy/aftermath.ts): a seduction achieved. */
  | 'night_together';

/** Sentiment thresholds that make a conversation "warm" or "hostile" for goal purposes. */
export const WARM_CHAT = 0.2;
export const HOSTILE_CHAT = -0.2;

/**
 * Progress per outcome, by goal type (GOAL_REGISTRY keys; `custom` is what the LLM goal
 * mapper files economic / uncategorised goals under). An outcome a goal doesn't list does
 * nothing for it — that is the point: revenge ignores warm chats, a courtship ignores fights.
 *
 * Sized so a goal takes a few real beats, not one lucky roll: revenge needs roughly an insult
 * and a fight, or a couple of rumors and a sharp word; befriending needs half a dozen good
 * talks or a gift and a few. `steal_from` is the one-shot exception — the theft IS the goal.
 */
export const GOAL_OUTCOME_GAINS: Record<string, Partial<Record<GoalOutcome, number>>> = {
  revenge: {
    hostile_chat: 0.1, insulted_target: 0.35, fought_target: 0.45, confrontation_won: 0.5,
    rumor_spread: 0.25, stole_from_target: 0.4,
  },
  undermine: {
    hostile_chat: 0.05, insulted_target: 0.2, fought_target: 0.2, confrontation_won: 0.3, rumor_spread: 0.3,
  },
  // A kiss is most of the way (a flirt or a date closes it); a night together is the goal met.
  seduce: { warm_chat: 0.12, comforted: 0.15, flirt: 0.3, gift_given: 0.15, reconciled: 0.2, kissed: 0.6, night_together: 1.0 },
  befriend: {
    warm_chat: 0.15, gift_given: 0.2, comforted: 0.25, reconciled: 0.4, confrontation_resolved: 0.3,
  },
  // The target getting better finishes these too, once the owner has put something in
  // (systems/goals.ts, the `target_recovered` rule).
  protect: { warm_chat: 0.1, comforted: 0.35, gift_given: 0.3 },
  comfort_grieving: { warm_chat: 0.15, comforted: 0.4, gift_given: 0.25 },
  investigate: { hostile_chat: 0.1, warm_chat: 0.05, rumor_heard: 0.35 },
  steal_from: { stole_from_target: 1.0 },
  custom: { warm_chat: 0.08, gift_given: 0.15, comforted: 0.2, reconciled: 0.3 },
};

/**
 * Progress `outcome` earns a goal of `goalType` (0 when it doesn't serve it). `intensity`
 * scales it (a glowing chat counts more than a polite one), clamped to [0.5, 1.5] so one
 * outcome can neither vanish nor finish a goal on its own.
 */
export function goalProgressGain(goalType: string, outcome: GoalOutcome, intensity = 1): number {
  const base = GOAL_OUTCOME_GAINS[goalType]?.[outcome] ?? 0;
  if (base <= 0) return 0;
  return base * Math.min(1.5, Math.max(0.5, intensity));
}

/** Where a goal of this type completes (registry `completion_at`, 1.0 for LLM `custom` goals). */
export function completionAt(goalType: string): number {
  return GOAL_REGISTRY[goalType]?.completion_at ?? 1.0;
}

/**
 * Mood lift for finishing a goal. A settled grudge is satisfaction, not joy; helping or
 * winning someone over is the warm kind. Game minutes it lasts: half a day.
 */
const COMPLETION_MOOD: Record<string, number> = { revenge: 5, undermine: 4, steal_from: 3 };
const COMPLETION_MOOD_DEFAULT = 8;
const COMPLETION_MOOD_MINUTES = 720;

type GoalRow = typeof goals.$inferSelect;

/** "getting revenge on Marco", for the feed and the memory; the LLM's own text when it wrote one. */
export function describeGoal(goal: Pick<GoalRow, 'type' | 'description'>, targetFirstName?: string | null): string {
  if (goal.description?.trim()) return goal.description;
  const phrase = goalClause(goal.type);
  if (!targetFirstName) return phrase;
  const TARGETED: Record<string, (t: string) => string> = {
    revenge: (t) => `getting even with ${t}`,
    seduce: (t) => `winning ${t} over`,
    steal_from: (t) => `stealing from ${t}`,
    protect: (t) => `looking after ${t}`,
    investigate: (t) => `digging up the truth about ${t}`,
    undermine: (t) => `undermining ${t}`,
    befriend: (t) => `making friends with ${t}`,
    comfort_grieving: (t) => `comforting ${t}`,
  };
  return TARGETED[goal.type]?.(targetFirstName) ?? phrase;
}

function firstNameOf(agentId: number | null): string | null {
  if (agentId == null) return null;
  const row = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).get();
  return row ? givenName(row.name) : null;
}

function addMoodModifier(agentId: number, value: number, source: string, minutes: number, now: number): void {
  const row = db.select().from(needs).where(eq(needs.agent_id, agentId)).get();
  if (!row) return;
  const mods = row.mood_modifiers.filter((m) => m.source !== source);
  mods.push({ source, value, expiresAt: now + minutes });
  db.update(needs).set({ mood_modifiers: mods }).where(eq(needs.id, row.id)).run();
}

/**
 * Finish a goal: the one completion path (outcome progress, passive progress, a registry rule
 * that `becomes: 'completed'`). Writes the status, emits `goal:completed` (memory, cascade
 * rules, favors, reputation, drift all listen), logs the feed row and lifts the owner's mood.
 * A goal that is no longer active is left alone, so a race between two writers completes once.
 */
export function completeGoal(goal: Pick<GoalRow, 'id' | 'agent_id' | 'type' | 'target_id' | 'description'> & { priority?: number }, nowMinutes = gameMinutesNow(), progress?: number): boolean {
  const res = db.update(goals)
    .set({ status: 'completed', completed_at: nowMinutes, ...(progress != null ? { progress } : {}) })
    .where(and(eq(goals.id, goal.id), eq(goals.status, 'active')))
    .run();
  if (res.changes === 0) return false;

  const owner = db.select({ name: agents.name }).from(agents).where(eq(agents.id, goal.agent_id)).get();
  const description = describeGoal(goal, firstNameOf(goal.target_id));
  simEvents.emit('goal:completed', {
    agentId: goal.agent_id,
    goalType: goal.type,
    description,
    // Same cast as goals.ts `goalEventCast`: the target is the other party.
    ...(goal.target_id != null ? { victimId: goal.target_id } : {}),
    // How much it mattered to them (0..1): friends come to congratulate a big one (lib/socialCalls).
    ...(goal.priority != null ? { priority: goal.priority } : {}),
  });
  logActivity({
    type: 'goal_completed',
    initiator: goal.agent_id,
    ...(goal.target_id != null ? { target: goal.target_id } : {}),
    templateData: { agent: owner?.name ?? '', goal_description: description },
  });
  addMoodModifier(goal.agent_id, COMPLETION_MOOD[goal.type] ?? COMPLETION_MOOD_DEFAULT, 'goal_completed', COMPLETION_MOOD_MINUTES, nowMinutes);
  return true;
}

/**
 * Report an outcome between `agentId` and `targetId`: every active goal of `agentId` aimed at
 * `targetId` that this outcome serves moves forward, and completes at its `completion_at`.
 * Returns how many goals it advanced (tests; callers ignore it).
 */
export function recordGoalOutcome(agentId: number, targetId: number | null | undefined, outcome: GoalOutcome, intensity = 1): number {
  if (targetId == null || targetId === agentId) return 0;
  const active = db.select().from(goals)
    .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active'), eq(goals.target_id, targetId)))
    .all();
  if (active.length === 0) return 0;

  let advanced = 0;
  let now: number | null = null;
  for (const goal of active) {
    const gain = goalProgressGain(goal.type, outcome, intensity);
    if (gain <= 0) continue;
    advanced++;
    const target = completionAt(goal.type);
    const progress = Math.min(target, (goal.progress ?? 0) + gain);
    if (progress >= target) {
      now ??= gameMinutesNow();
      completeGoal(goal, now, progress);
    } else {
      db.update(goals).set({ progress }).where(eq(goals.id, goal.id)).run();
    }
  }
  return advanced;
}
