import type { DailyPlan, PlanBlock, PlanExecutionState } from './types';
import { gameMinuteOf } from './PlanLLMGate';

/** The PlanDecomposer surface the executor uses. */
interface IPlanDecomposer {
  queueDecomposition(agentId: number, blockId: string, gameMinute: number): boolean;
  isPending(agentId: number, blockId: string): boolean;
}

// ---------------------------------------------------------------------------
// Structural interface for the injected cache singleton
// ---------------------------------------------------------------------------

interface IPlanCache {
  get(agentId: number): DailyPlan | null;
  set(agentId: number, plan: DailyPlan): void;
  getExecState(agentId: number): PlanExecutionState | null;
  setExecState(agentId: number, state: PlanExecutionState): void;
}

// ---------------------------------------------------------------------------
// ScoredAction — must match decisions.ts interface
// ---------------------------------------------------------------------------

export interface ScoredAction {
  action: string;
  score: number;
  targetLocationId?: number;
  targetAgentId?: number;
  topic?: string;
  source?: string;
}

// Score above free-time (typically ~5000) but below emergency (9999)
const PLAN_SCORE = 6000;

// ---------------------------------------------------------------------------
// PlanExecutor
// ---------------------------------------------------------------------------

export class PlanExecutor {
  constructor(
    private readonly cache: IPlanCache,
    private readonly decomposer: IPlanDecomposer,
  ) {}

  getPlannedAction(
    agentId: number,
    currentHour: number,
    currentTick: number,
    currentDay?: number,
    currentMinute = 0,
  ): ScoredAction | null {
    // 1. Get plan — null means no plan generated yet
    const plan = this.cache.get(agentId);
    if (!plan) return null;

    // 1b. Stale plan check — skip plans from previous days
    if (currentDay !== undefined && plan.day < currentDay) return null;

    // 1c. Fallback plans (cached when the LLM failed) are not executed. Running a
    // block means LLM decomposition, which is what just failed; the block would
    // sit 'active' with no actions and hold the agent in the plan layer's idle
    // at score 6000 for hours. Returning null hands the agent to the utility
    // layer, which already follows the same work/sleep schedule the fallback
    // blocks were derived from.
    if (plan.source === 'fallback') return null;

    // 2. Find the appropriate block for the current hour
    const block = this._resolveBlock(plan, agentId, currentHour);
    if (!block) return null;

    const gameMinute = gameMinuteOf({
      day: currentDay ?? plan.day,
      hour: currentHour,
      minute: currentMinute,
    });

    // 3. Newly-found pending block → activate it
    if (block.status === 'pending') {
      block.status = 'active';
      this.cache.set(agentId, plan);

      // Init execution state for this block
      const execState: PlanExecutionState = {
        currentBlockId: block.id,
        currentActionIndex: 0,
        blockStartedAt: currentTick,
        actionStartedAt: currentTick,
      };
      this.cache.setExecState(agentId, execState);

      return this._awaitDecomposition(agentId, block, gameMinute);
    }

    // 4. Block is active but decomposition not done yet
    if (!block.decomposed_actions || block.decomposed_actions.length === 0) {
      return this._awaitDecomposition(agentId, block, gameMinute);
    }

    // 5. Get or repair exec state
    let execState = this.cache.getExecState(agentId);
    if (!execState || execState.currentBlockId !== block.id) {
      execState = {
        currentBlockId: block.id,
        currentActionIndex: 0,
        blockStartedAt: currentTick,
        actionStartedAt: currentTick,
      };
      this.cache.setExecState(agentId, execState);
    }

    // 6. Check if current action's duration has elapsed
    const actions = block.decomposed_actions;
    const idx = execState.currentActionIndex;

    if (idx >= actions.length) {
      // All actions consumed — mark block completed
      block.status = 'completed';
      this.cache.set(agentId, plan);
      return null;
    }

    const currentAction = actions[idx];
    const elapsedTicks = currentTick - execState.actionStartedAt;
    // duration_minutes maps 1:1 to ticks (the sim uses ticks-per-minute = 1 by default)
    const durationTicks = currentAction.duration_minutes;

    if (elapsedTicks >= durationTicks) {
      // Advance to next action
      const newIdx = idx + 1;
      if (newIdx >= actions.length) {
        block.status = 'completed';
        this.cache.set(agentId, plan);
        return null;
      }

      const updatedState: PlanExecutionState = {
        ...execState,
        currentActionIndex: newIdx,
        actionStartedAt: currentTick,
      };
      this.cache.setExecState(agentId, updatedState);

      return this._actionToScored(actions[newIdx]);
    }

    // 7. Return the current action
    return this._actionToScored(currentAction);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * The block has no concrete actions yet. (Re-)ask for them — a no-op while a
   * job is out, while the agent backs off after an LLM failure, and while the
   * outage breaker is open — then hold the agent in an idle only if the
   * answer is actually on its way.
   *
   * This used to return the idle unconditionally. When the decomposition call
   * failed, nothing ever asked again and the block sat 'active' with no
   * actions, so the plan layer's idle (score 6000, above everything but
   * emergencies) pinned the agent in place until the block's hours ran out —
   * with Ollama down, that was most of the day. Returning null instead hands
   * the agent to needs/schedule scoring until decomposition succeeds.
   */
  private _awaitDecomposition(agentId: number, block: PlanBlock, gameMinute: number): ScoredAction | null {
    this.decomposer.queueDecomposition(agentId, block.id, gameMinute);
    return this.decomposer.isPending(agentId, block.id) ? this._idleAction(block) : null;
  }

  /**
   * Resolves the best block for the current hour, handling stale active blocks.
   */
  private _resolveBlock(
    plan: DailyPlan,
    agentId: number,
    currentHour: number,
  ): PlanBlock | null {
    // Check for an already-active block
    const activeBlock = plan.blocks.find((b) => b.status === 'active');
    if (activeBlock) {
      if (currentHour >= activeBlock.start_hour && currentHour < activeBlock.end_hour) {
        return activeBlock;
      }
      // Outside the block's time window — mark completed
      activeBlock.status = 'completed';
      this.cache.set(agentId, plan);
    }

    // Find next pending block whose window covers current hour
    const pending = plan.blocks.find(
      (b) =>
        b.status === 'pending' &&
        currentHour >= b.start_hour &&
        currentHour < b.end_hour,
    );

    return pending ?? null;
  }

  private _idleAction(block: PlanBlock): ScoredAction {
    return {
      action: 'idle',
      score: PLAN_SCORE,
      targetLocationId: undefined,
      source: `plan:${block.id}`,
    };
  }

  private _actionToScored(action: import('./types').DecomposedAction): ScoredAction {
    return {
      action: action.action_type,
      score: PLAN_SCORE,
      targetLocationId: action.resolved_location_id,
      targetAgentId: action.resolved_agent_id,
      topic: action.topic,
      source: `plan:decomposed`,
    };
  }
}
