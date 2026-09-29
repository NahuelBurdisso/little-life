import { db } from '../../db';
import { agents, needs, locations, economy } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { LLMEmptyReplyError } from '../../ai/llmErrors';
import { CONFIG } from '../constants';
import type { PersonalityProfile } from '../personality';
import { buildDecompositionPrompt, type PlanPrompt } from './planPrompts';
import { parseDecomposedActions, isUnparsedDecomposition } from './planParser';
import type { DailyPlan, PlanBlock } from './types';
import { reportPlanningBug, type PlanLLMGate } from './PlanLLMGate';
import { decomposeDeterministically, type DeterministicContext } from './deterministicDecompose';

// ---------------------------------------------------------------------------
// Structural interfaces for the injected singletons
// (PlanCache and PlanLLMQueue classes are not exported, only their instances)
// ---------------------------------------------------------------------------

interface IPlanCache {
  get(agentId: number): DailyPlan | null;
  set(agentId: number, plan: DailyPlan): void;
}

interface IPlanLLMQueue {
  enqueue(agentId: number, job: () => Promise<void>, key?: string): boolean;
  isPending(agentId: number, key: string): boolean;
}

/** Everything `decompose` needs from the DB, plus the built prompt. */
interface DecompositionContext {
  agentName: string;
  prompt: PlanPrompt;
  validLocations: string[];
  validAgentNames: string[];
  locationIdMap: Map<string, number>;
  agentIdMap: Map<string, number>;
}

/** Queue dedupe key for one block's decomposition. */
function decomposeKey(blockId: string): string {
  return `decompose:${blockId}`;
}

// ---------------------------------------------------------------------------
// PlanDecomposer
// ---------------------------------------------------------------------------

export class PlanDecomposer {
  /** Blocks `decomposeDeterministically` declined; see `decomposeWithoutLLM`. */
  private readonly needsLLM = new WeakSet<PlanBlock>();

  constructor(
    private readonly cache: IPlanCache,
    private readonly queue: IPlanLLMQueue,
    /** Shared with PlanGenerator: per-agent backoff, outage breaker, world epoch. */
    private readonly gate: PlanLLMGate,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Ask for `blockId` to be broken into concrete actions. Safe to call on every
   * decision pass: a no-op while that block's job is queued or running, while
   * the agent is backing off after an LLM failure, and while the outage
   * breaker is open. Returns whether a job was queued.
   */
  queueDecomposition(agentId: number, blockId: string, gameMinute: number): boolean {
    if (this.queue.isPending(agentId, decomposeKey(blockId))) return false;
    // Sleep, a shift at one's own workplace and a meal at home need no model
    // (see deterministicDecompose). Tried before the gate on purpose: no LLM
    // is involved, so neither this agent's backoff nor an outage breaker that
    // is open for everyone else has any reason to hold these blocks back —
    // during an outage the routine part of the day keeps running.
    if (this.decomposeWithoutLLM(agentId, blockId)) return false;
    const ticket = this.gate.tryAcquire(agentId, gameMinute);
    if (!ticket) return false;
    const accepted = this.queue.enqueue(
      agentId,
      async () => {
        try {
          await this.decompose(agentId, blockId);
        } finally {
          this.gate.release(ticket);
        }
      },
      decomposeKey(blockId),
    );
    if (!accepted) this.gate.release(ticket);
    return accepted;
  }

  /** Whether a decomposition of `blockId` is queued or running. */
  isPending(agentId: number, blockId: string): boolean {
    return this.queue.isPending(agentId, decomposeKey(blockId));
  }

  // ── Private: deterministic path ────────────────────────────────────────────

  /**
   * Fill `blockId` with actions computed from the block itself, synchronously.
   * True when the block now has actions (nothing left to ask the LLM); false
   * when it needs the model, which includes any failure here — this path is an
   * optimisation and must never be the reason a block goes undecomposed.
   */
  private decomposeWithoutLLM(agentId: number, blockId: string): boolean {
    const plan = this.cache.get(agentId);
    const block = plan?.blocks.find((b) => b.id === blockId);
    if (!plan || !block) return false;
    if (block.decomposed_actions && block.decomposed_actions.length > 0) return false;
    // The executor re-asks on every decision pass while a block has no actions;
    // remember the blocks that need the LLM so those passes cost a set lookup,
    // not four DB reads. Keyed on the block object: a replan or a new day
    // brings new objects, and so a fresh look.
    if (this.needsLLM.has(block)) return false;

    try {
      const actions = decomposeDeterministically(block, this.loadDeterministicContext(agentId));
      if (!actions) {
        this.needsLLM.add(block);
        return false;
      }
      block.decomposed_actions = actions;
      this.cache.set(agentId, plan);
      return true;
    } catch (err) {
      // Not remembered: a transient DB error should not pin the block to the LLM path.
      console.warn(`[PlanDecomposer] deterministic decomposition for agent ${agentId} failed, using the LLM:`, err);
      return false;
    }
  }

  private loadDeterministicContext(agentId: number): DeterministicContext {
    const row = db
      .select({ home: agents.home, workplace: agents.workplace, schedule: agents.schedule })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    if (!row) throw new Error(`agent ${agentId} not found`);
    const schedule = row.schedule as { workStart?: number; workEnd?: number } | null;
    return {
      homeId: row.home ?? null,
      workplaceId: row.workplace ?? null,
      locations: db.select({ id: locations.id, name: locations.name }).from(locations).all(),
      otherAgentNames: db.select({ id: agents.id, name: agents.name }).from(agents).all()
        .filter((a) => a.id !== agentId)
        .map((a) => a.name),
      workStart: schedule?.workStart,
      workEnd: schedule?.workEnd,
    };
  }

  // ── Private: decompose ─────────────────────────────────────────────────────

  private async decompose(agentId: number, blockId: string): Promise<void> {
    // 1. Read plan from cache, find block
    const plan = this.cache.get(agentId);
    if (!plan) {
      console.warn(`[PlanDecomposer] no plan for agent ${agentId}`);
      return;
    }

    const block = plan.blocks.find((b) => b.id === blockId);
    if (!block) {
      console.warn(`[PlanDecomposer] block ${blockId} not found for agent ${agentId}`);
      return;
    }

    // 2. Skip if already decomposed
    if (block.decomposed_actions && block.decomposed_actions.length > 0) {
      return;
    }

    // 3–7. Load what the prompt needs and build it. Everything here is our
    //      own code and the local DB — no LLM — so a throw is a bug, not an
    //      outage: back off so the executor's re-asks don't spin on it every
    //      pass, report it, and leave the breaker alone. (Only the prompt build
    //      used to be covered; a throwing DB lookup escaped to the queue's
    //      generic catch with no backoff, and was retried every pass.)
    let prep: DecompositionContext | null;
    try {
      prep = this.prepare(agentId, block);
    } catch (err) {
      const { failures } = this.gate.backOff(agentId);
      reportPlanningBug(`decomposition prep for agent ${agentId}`, err, failures);
      return;
    }
    if (!prep) return;
    const { agentName, prompt, validLocations, validAgentNames, locationIdMap, agentIdMap } = prep;

    // 8. Call LLM. Only this call's errors count towards the outage breaker
    //    (see PlanLLMGate); the executor yields to the utility layer meanwhile
    //    and asks again once the gate reopens.
    const epoch = this.gate.epoch;
    let text: string;
    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL,
        purpose: 'plan.decompose',
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        priority: 'normal',
        format: prompt.format,
        options: { temperature: 0.7, num_predict: 360 },
      });
      text = response.text;
    } catch (err) {
      if (epoch !== this.gate.epoch) return;
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof LLMEmptyReplyError) {
        // An empty / reasoning-only answer: the LLM is up, so back off like
        // for unusable output and reset the outage streak.
        this.gate.backOff(agentId);
        this.gate.noteAnswered();
      } else {
        this.gate.recordFailure(agentId, reason);
      }
      console.warn(`[PlanDecomposer] ${agentName} block ${blockId} failed: ${reason}`);
      return;
    }

    // World replaced while we waited: the agent id may now belong to a
    // different townsperson, whose plan must not receive these actions.
    if (epoch !== this.gate.epoch) return;
    // The plan was replaced (replan, new day) while we waited. Writing our
    // stale copy back would undo that; the new plan's blocks get their own
    // decomposition.
    if (this.cache.get(agentId) !== plan) return;

    // 9. Parse decomposed actions
    const actions = parseDecomposedActions(text, validLocations, validAgentNames);

    // Nothing usable. The parser's answer to unreadable output is one hour of
    // 'idle', which used to be stored as the block's actions and pinned the
    // agent in the plan layer's idle (score 6000) for that hour. Now nothing is
    // written, the executor yields to the utility layer, and this agent backs
    // off before asking again. The LLM did answer, though, so the outage
    // streak resets instead of growing.
    if (isUnparsedDecomposition(actions)) {
      this.gate.backOff(agentId);
      this.gate.noteAnswered();
      console.warn(`[PlanDecomposer] ${agentName} block ${blockId}: no usable actions`);
      return;
    }
    this.gate.recordSuccess(agentId);

    // 10. Resolve locations: fuzzy match target_location → resolved_location_id
    for (const action of actions) {
      if (action.target_location) {
        const key = action.target_location.toLowerCase();
        // Try exact match first
        let resolvedId = locationIdMap.get(key);
        if (resolvedId == null) {
          // Try substring match
          for (const [locName, locId] of locationIdMap) {
            if (locName.includes(key) || key.includes(locName)) {
              resolvedId = locId;
              break;
            }
          }
        }
        if (resolvedId != null) {
          action.resolved_location_id = resolvedId;
        }
      }
    }

    // 11. Resolve agents: match target_agent name → resolved_agent_id
    for (const action of actions) {
      if (action.target_agent) {
        const key = action.target_agent.toLowerCase();
        const resolvedId = agentIdMap.get(key);
        if (resolvedId != null) {
          action.resolved_agent_id = resolvedId;
        }
      }
    }

    // 12. Attach decomposed_actions to the block and persist via cache
    block.decomposed_actions = actions;
    this.cache.set(agentId, plan);
  }

  // ── Private: context + prompt ──────────────────────────────────────────────

  /** Synchronous DB reads and prompt build for one block; null if the agent is gone. */
  private prepare(agentId: number, block: PlanBlock): DecompositionContext | null {
    // 3. Load agent
    const agentRow = db
      .select({
        name: agents.name,
        traits: agents.traits,
        personality: agents.personality,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();

    if (!agentRow) {
      console.warn(`[PlanDecomposer] agent ${agentId} not found`);
      return null;
    }

    // 4. Load needs
    const needsRow = db
      .select({
        hunger: needs.hunger,
        energy: needs.energy,
        social: needs.social,
      })
      .from(needs)
      .where(eq(needs.agent_id, agentId))
      .get();

    const currentNeeds = needsRow ?? { hunger: 50, energy: 50, social: 50 };

    const agentEcon = db.select({ money: economy.money }).from(economy).where(eq(economy.agent_id, agentId)).get();

    // 5. Get all location names + id map for resolution later
    const locationRows = db
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .all();
    const validLocations = locationRows.map((l) => l.name);
    const locationIdMap = new Map<string, number>(
      locationRows.map((l) => [l.name.toLowerCase(), l.id]),
    );

    // 6. Get all agent names + id map for resolution later
    const agentRows = db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .all();
    const validAgentNames = agentRows.map((a) => a.name);
    const agentIdMap = new Map<string, number>(
      agentRows.map((a) => [a.name.toLowerCase(), a.id]),
    );

    // 7. Build decomposition prompt
    const personality = agentRow.personality as PersonalityProfile | null;
    const traits = agentRow.traits as string[];

    const prompt = buildDecompositionPrompt({
      name: agentRow.name,
      personality: personality ?? {
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
      },
      traits,
      blockAction: block.broad_action,
      locationHint: block.location_hint,
      needs: currentNeeds,
      money: agentEcon?.money,
      startHour: block.start_hour,
      endHour: block.end_hour,
      validLocations,
      validAgents: validAgentNames.filter((n) => n !== agentRow.name),
    });

    return {
      agentName: agentRow.name,
      prompt,
      validLocations,
      validAgentNames,
      locationIdMap,
      agentIdMap,
    };
  }
}
