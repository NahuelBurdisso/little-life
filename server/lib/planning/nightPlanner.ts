/**
 * Night planning: tomorrow's daily plans (and the self-descriptions) are asked
 * for in the small hours, staggered, instead of at wake-up.
 *
 * Why (playtest #3, G8 at 4x): every daily plan was requested the moment its
 * owner woke, so the whole town asked the LLM within one game hour — the same
 * hour the midnight burst of goal reviews, pivots and self-descriptions was
 * still draining. Plans arrived 05:18–09:23; on day 4, 9 of 13 landed after
 * 07:00 and the first blocks of those days were settled as `skipped` before
 * anyone had run them. plan.daily waited ~3.4 s in the queue for a ~9 s reply,
 * and at 4x one real second is four game minutes.
 *
 * Asking at night costs nothing that matters: everyone is asleep, no dialogue
 * holds slots, and the plan prompt reads nothing that changes between 01:00
 * and waking (needs are projected to a rested morning, see PlanGenerator).
 * The wake-up request stays as the safety net — it is a no-op when the plan
 * is already there (PlanGenerator.generate), and it still covers a server
 * started at 08:00 or an LLM that failed overnight.
 *
 * Staggered by wake hour, earliest riser first, a few game minutes apart: at
 * 1x one plan answers before the next is asked, so the pool never holds a
 * dozen plans at once; at 4x they queue, but at `normal` they go ahead of the
 * midnight low-priority burst, and there are hours of night to drain it.
 *
 * Under "skip to morning" (30 game minutes a tick) the plans still queue at
 * `normal`, which counts toward the skip's LLM backlog, so the skip slows to 4x
 * until they drain (NIGHT_SKIP.LLM_BACKLOG_LIMIT) — the morning waits for them.
 *
 * Self-descriptions move off the midnight burst to after the plans (03:00 on):
 * they are `low`, nobody waits for them, and at midnight they only held slots
 * the plans and goal reviews needed (p50 38 s, mostly queueing).
 */

import { db } from '../../db';
import { agents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import type { ClockTime } from '../gameClock';

export const NIGHT_PLANNING = {
  /** Minute of the day the first plan is asked for (00:15). After the midnight
   *  day-change work has queued, so the plan prompt sees the new day's goals. */
  PLAN_START_MINUTE: 15,
  /** Game minutes between two agents' requests. */
  STAGGER_MINUTES: 6,
  /** Minute of the day the first self-description is asked for (03:00). */
  SELF_DESCRIPTION_START_MINUTE: 3 * 60,
  /** Nothing is started from here on: the morning belongs to the wake-up path.
   *  Also stops a server started mid-afternoon from firing a night's worth of
   *  requests into the busiest hours. */
  NIGHT_END_MINUTE: 5 * 60,
} as const;

export interface NightPlannerAgent {
  id: number;
  wakeTime: number;
}

export interface NightPlannerDeps {
  /** Living, free (not jailed) residents with their wake hour. */
  listAgents(): NightPlannerAgent[];
  /** Whether a real (non-fallback) plan for `day` is already cached. */
  hasPlanFor(agentId: number, day: number): boolean;
  /** Queue the plan request (PlanGenerator.queueGeneration). */
  queuePlan(agentId: number, time: ClockTime): boolean;
  /** Queue the self-description refresh (it keeps its own 3-day interval). */
  refreshSelfDescription(agentId: number, day: number): void;
}

/**
 * Minute of the day at which the `rank`-th agent's request is due. Pure, for
 * tests and for the reasoning above.
 */
export function nightSlotMinute(start: number, rank: number): number {
  return start + rank * NIGHT_PLANNING.STAGGER_MINUTES;
}

export class NightPlanner {
  /** agentId → the day a plan was last asked for at night (once per night). */
  private planAsked = new Map<number, number>();
  /** agentId → the day a self-description was last queued at night. */
  private selfAsked = new Map<number, number>();

  constructor(private readonly deps: NightPlannerDeps) {}

  /**
   * Called once per tick with the new clock. Each agent's slot is "due" once
   * the clock is past it, not "crossed this tick": night skip steps 30 minutes
   * a tick, and a server restarted at 02:00 must still plan the rest.
   */
  tick(time: ClockTime): void {
    const minuteOfDay = time.hour * 60 + time.minute;
    if (minuteOfDay >= NIGHT_PLANNING.NIGHT_END_MINUTE) return;
    if (minuteOfDay < NIGHT_PLANNING.PLAN_START_MINUTE) return;

    // Earliest riser first; id breaks ties so the order is stable night to night.
    const ranked = this.deps.listAgents().sort((a, b) => a.wakeTime - b.wakeTime || a.id - b.id);

    ranked.forEach((agent, rank) => {
      // Plans: only before this agent's own wake hour (the wake-up request
      // takes over from there) and only once per night — a failed request
      // falls back to a schedule plan and the daytime path retries it under
      // the gate's backoff, which is the right place for retries.
      if (
        this.planAsked.get(agent.id) !== time.day &&
        minuteOfDay >= nightSlotMinute(NIGHT_PLANNING.PLAN_START_MINUTE, rank) &&
        minuteOfDay < agent.wakeTime * 60
      ) {
        this.planAsked.set(agent.id, time.day);
        if (!this.deps.hasPlanFor(agent.id, time.day)) this.deps.queuePlan(agent.id, time);
      }

      if (
        this.selfAsked.get(agent.id) !== time.day &&
        minuteOfDay >= nightSlotMinute(NIGHT_PLANNING.SELF_DESCRIPTION_START_MINUTE, rank)
      ) {
        this.selfAsked.set(agent.id, time.day);
        this.deps.refreshSelfDescription(agent.id, time.day);
      }
    });
  }

  clear(): void {
    this.planAsked.clear();
    this.selfAsked.clear();
  }
}

/** Residents the night planner considers: active and alive. The jailed are
 *  left to the wake-up path, which skips them too (decisions.ts). */
export function listNightPlannerAgents(isJailed: (agentId: number) => boolean): NightPlannerAgent[] {
  const rows = db
    .select({ id: agents.id, schedule: agents.schedule, action: agents.current_action })
    .from(agents)
    .where(eq(agents.is_active, true))
    .all();
  const out: NightPlannerAgent[] = [];
  for (const r of rows) {
    if ((r.action as { type?: string } | null)?.type === 'dead') continue;
    if (isJailed(r.id)) continue;
    const wake = (r.schedule as { wakeTime?: number } | null)?.wakeTime;
    out.push({ id: r.id, wakeTime: typeof wake === 'number' ? wake : 7 });
  }
  return out;
}
