import type { DailyPlan, PlanBlock, PlanExecutionState } from './types';
import { gameMinutes } from '../gameClock';

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

  /**
   * `_currentTick` is no longer used: action timing runs on the world clock
   * (see step 6). It stays in the signature so decisions.ts, which is being
   * reworked in parallel, doesn't have to change with this module.
   */
  getPlannedAction(
    agentId: number,
    currentHour: number,
    _currentTick: number,
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

    const gameMinute = gameMinutes({
      day: currentDay ?? plan.day,
      hour: currentHour,
      minute: currentMinute,
    });

    // 3. Newly-found pending block → activate it
    if (block.status === 'pending') {
      this._setStatus(agentId, plan, block, 'active');

      // Drop the previous block's execution state, but do NOT start this
      // block's clock yet. It used to be stamped here, at activation; the
      // actions only arrive once decomposition answers, which can be a retry
      // after a 30+ game-minute backoff, and by then action 0's duration had
      // already "elapsed" on that stale stamp — the first action was skipped
      // and a single-action block completed on the spot. Step 5 stamps the
      // clock on the first pass that actually has actions to run.
      this.cache.setExecState(agentId, {
        currentBlockId: null,
        currentActionIndex: 0,
        blockStartedAt: gameMinute,
        actionStartedAt: gameMinute,
      });
    }

    // 4. Block is active but decomposition not done yet
    if (!block.decomposed_actions || block.decomposed_actions.length === 0) {
      const held = this._awaitDecomposition(agentId, block, gameMinute);
      // Sleep, own-workplace shifts and home meals are decomposed on the spot,
      // inside the request above (PlanDecomposer.decomposeWithoutLLM): run the
      // block this pass instead of losing a pass to the utility layer.
      if (!block.decomposed_actions || block.decomposed_actions.length === 0) return held;
    }

    // 5. Get or repair exec state. A state for another block (or none, right
    //    after activation) means this is the first pass with this block's
    //    actions: the block and its first action start now.
    let execState = this.cache.getExecState(agentId);
    if (!execState || execState.currentBlockId !== block.id) {
      execState = {
        currentBlockId: block.id,
        currentActionIndex: 0,
        blockStartedAt: gameMinute,
        actionStartedAt: gameMinute,
      };
      this.cache.setExecState(agentId, execState);
    }

    // 5b. In the block's last hour, ask for the next block's actions ahead of
    //     time. Otherwise the agent reaches the next block, finds nothing to do,
    //     and stands in the plan layer's idle until the LLM answers — at 4x a
    //     20 s reply is 80 game minutes of standing still at every block edge.
    if (currentHour >= block.end_hour - 1) this._prefetchNext(plan, block, agentId, gameMinute);

    // 6. Check if current action's duration has elapsed
    const actions = block.decomposed_actions;
    const idx = execState.currentActionIndex;

    if (idx >= actions.length) {
      // All actions consumed — mark block completed
      this._setStatus(agentId, plan, block, 'completed');
      this._prefetchNext(plan, block, agentId, gameMinute);
      return null;
    }

    const currentAction = actions[idx];
    // Game minutes on the world clock. This compared elapsed *ticks* with
    // `duration_minutes`, on the assumption that a tick is a game minute — but
    // a tick advances the clock by `tick_speed` minutes, so at speed 4 a
    // planned 60-minute action ran for 240 minutes of town time and a day's
    // plan fell hours behind its own blocks.
    const elapsedMinutes = gameMinute - execState.actionStartedAt;

    if (elapsedMinutes >= currentAction.duration_minutes) {
      // Advance to next action
      const newIdx = idx + 1;
      if (newIdx >= actions.length) {
        // Actions shorter than the block end it early; the next block's
        // actions are then needed now, not in its last hour.
        this._setStatus(agentId, plan, block, 'completed');
        this._prefetchNext(plan, block, agentId, gameMinute);
        return null;
      }

      const updatedState: PlanExecutionState = {
        ...execState,
        currentActionIndex: newIdx,
        actionStartedAt: gameMinute,
      };
      this.cache.setExecState(agentId, updatedState);

      return this._actionToScored(actions[newIdx]);
    }

    // 7. Return the current action
    return this._actionToScored(currentAction);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Queue decomposition of the block that follows `block`, if it still needs
   * it. A no-op while that job is out or the agent is backing off (same gate
   * as a regular request), and the result is dropped if a replan replaces the
   * plan meanwhile (PlanDecomposer checks the cached plan).
   */
  private _prefetchNext(plan: DailyPlan, block: PlanBlock, agentId: number, gameMinute: number): void {
    const next = plan.blocks
      .filter((b) => b.status === 'pending' && b.start_hour >= block.end_hour)
      .sort((a, b) => a.start_hour - b.start_hour)[0];
    if (!next || (next.decomposed_actions && next.decomposed_actions.length > 0)) return;
    if (this.decomposer.isPending(agentId, next.id)) return;
    this.decomposer.queueDecomposition(agentId, next.id, gameMinute);
  }

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
    // Settle the blocks whose hours are over. Both transitions are decided in
    // memory first and saved with ONE write, and only when something changed:
    // this runs on every decision pass, so an unconditional save would rewrite
    // the whole plan JSON for every agent all day.
    //  - a block still 'active' after its window ends is done ('completed');
    //  - a block still 'pending' after its window ends was never run — the agent
    //    was asleep, in a conversation, or the plan arrived late. It used to stay
    //    'pending' in the saved plan forever, so a finished day read as a day
    //    where nothing had happened (G8). 'skipped' says what actually happened.
    // The block the clock is in is never settled here: it is picked below.
    const activeBlock = plan.blocks.find((b) => b.status === 'active');
    let settled = false;
    if (activeBlock && (currentHour < activeBlock.start_hour || currentHour >= activeBlock.end_hour)) {
      activeBlock.status = 'completed';
      settled = true;
    }
    for (const b of plan.blocks) {
      if (b.status === 'pending' && b.end_hour <= currentHour) {
        b.status = 'skipped';
        settled = true;
      }
    }
    if (settled) this.cache.set(agentId, plan);

    // An active block whose window is still open keeps running.
    if (activeBlock && activeBlock.status === 'active') return activeBlock;

    // Find next pending block whose window covers current hour
    const pending = plan.blocks.find(
      (b) =>
        b.status === 'pending' &&
        currentHour >= b.start_hour &&
        currentHour < b.end_hour,
    );

    return pending ?? null;
  }

  /**
   * The one place a block's status changes and is saved. A no-op when the
   * status is already `status`, so a caller that reaches this on every pass
   * still writes only on a real transition (the save is the whole plan as JSON
   * in `agents.daily_plan`, see PlanCache.set).
   */
  private _setStatus(agentId: number, plan: DailyPlan, block: PlanBlock, status: PlanBlock['status']): void {
    if (block.status === status) return;
    block.status = status;
    this.cache.set(agentId, plan);
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
