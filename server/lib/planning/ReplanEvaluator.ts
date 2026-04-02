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

/** Cooldown in ticks between replans for the same agent. */
const REPLAN_COOLDOWN_TICKS = 30;

export class ReplanEvaluator {
  /** Tracks the last tick at which each agent triggered a replan. */
  private lastReplanAt = new Map<number, number>();

  constructor(
    private readonly cache: IPlanCache,
    private readonly generator: PlanGenerator,
    private readonly getCurrentHour: () => number,
    private readonly getCurrentTick: () => number,
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
    const currentTick = this.getCurrentTick();

    // Check cooldown
    const lastAt = this.lastReplanAt.get(agentId) ?? -Infinity;
    if (currentTick - lastAt < REPLAN_COOLDOWN_TICKS) {
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
    this.lastReplanAt.set(agentId, currentTick);

    this.generator.queueReplan(
      agentId,
      event,
      currentHour,
      currentTick,
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
