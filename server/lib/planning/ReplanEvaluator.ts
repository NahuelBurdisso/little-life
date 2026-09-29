import { db } from '../../db';
import { agents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { simEvents } from '../simEvents';
import type { DailyPlan, PlanBlock, ReplanEvent } from './types';
import type { PlanGenerator } from './PlanGenerator';
import type { PersonalityProfile } from '../personality';

// ---------------------------------------------------------------------------
// Structural interfaces for injected singletons
// ---------------------------------------------------------------------------

interface IPlanCache {
  get(agentId: number): DailyPlan | null;
}

// ---------------------------------------------------------------------------
// AgentSchedule shape (same as in PlanGenerator)
// ---------------------------------------------------------------------------

interface AgentSchedule {
  sleepTime: number;
}

// ---------------------------------------------------------------------------
// ReplanEvaluator
// ---------------------------------------------------------------------------

/**
 * Game minutes between replans for the same agent. This was 30 *ticks*, and a
 * tick advances the clock by `tick_speed` game minutes, so the cooldown's
 * length in town time depended on the speed setting: 120 game minutes at
 * speed 4, 15 at speed 0.5. Measured on the world clock it is the same half
 * hour of town life at any speed.
 */
export const REPLAN_COOLDOWN_MINUTES = 30;

export class ReplanEvaluator {
  /** Absolute game minute (see `gameMinutes`) of each agent's last replan. */
  private lastReplanAt = new Map<number, number>();

  constructor(
    private readonly cache: IPlanCache,
    private readonly generator: Pick<PlanGenerator, 'queueReplan'>,
    private readonly getCurrentHour: () => number,
    /** Current absolute game minute. */
    private readonly getGameMinute: () => number,
  ) {
    simEvents.on('plan:evaluate-replan', (payload: ReplanEvent) => {
      this._handleEvent(payload);
    });
  }

  clear(): void {
    this.lastReplanAt.clear();
  }

  // ── Private: event handler ─────────────────────────────────────────────────

  private _handleEvent(event: ReplanEvent): void {
    const { agentId } = event;
    const now = this.getGameMinute();

    // Check cooldown
    const lastAt = this.lastReplanAt.get(agentId) ?? -Infinity;
    if (now - lastAt < REPLAN_COOLDOWN_MINUTES) {
      return;
    }

    // Load plan
    const plan = this.cache.get(agentId);

    // Find currently active block (if any)
    const currentHour = this.getCurrentHour();
    const currentBlock = plan
      ? plan.blocks.find(
          (b) =>
            b.status === 'active' ||
            (b.status === 'pending' &&
              currentHour >= b.start_hour &&
              currentHour < b.end_hour),
        ) ?? null
      : null;

    // Load agent personality + schedule
    const agentRow = db
      .select({ personality: agents.personality, schedule: agents.schedule })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();

    const personality = (agentRow?.personality as PersonalityProfile | null) ?? {
      honesty: 50,
      aggression: 50,
      warmth: 50,
      impulsiveness: 50,
      vanity: 50,
      curiosity: 50,
      loyalty: 50,
      morality: 50,
      sensuality: 50,
      neuroticism: 50,
    };

    const schedule = (agentRow?.schedule as AgentSchedule | null) ?? { sleepTime: 22 };

    if (!this.shouldReplan(event, currentBlock, personality)) {
      return;
    }

    // Update cooldown and queue replan
    this.lastReplanAt.set(agentId, now);

    this.generator.queueReplan(
      agentId,
      event,
      currentHour,
      now,
      schedule.sleepTime,
    );
  }

  // ── Public: heuristic (exported for testing) ───────────────────────────────

  shouldReplan(
    event: ReplanEvent,
    currentBlock: PlanBlock | null,
    personality: PersonalityProfile,
  ): boolean {
    // Dramatic events always warrant a replan
    if (event.isDramatic) return true;

    // No active block → nothing to disrupt
    if (!currentBlock) return false;

    // Personality-gated sentiment threshold:
    //   lower neuroticism/impulsiveness = higher threshold (harder to replan)
    //   higher neuroticism/impulsiveness = lower threshold (easier to replan)
    const threshold =
      0.5 -
      (personality.neuroticism / 100) * 0.15 -
      (personality.impulsiveness / 100) * 0.1;

    return Math.abs(event.sentiment) > threshold;
  }
}
