import { db } from '../../db';
import { agents, needs, locations, economy } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import type { PersonalityProfile } from '../personality';
import { buildDecompositionPrompt } from './planPrompts';
import { parseDecomposedActions, isUnparsedDecomposition } from './planParser';
import type { DailyPlan } from './types';
import { reportPlanningBug, type PlanLLMGate } from './PlanLLMGate';

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

/** Queue dedupe key for one block's decomposition. */
function decomposeKey(blockId: string): string {
  return `decompose:${blockId}`;
}

// ---------------------------------------------------------------------------
// PlanDecomposer
// ---------------------------------------------------------------------------

export class PlanDecomposer {
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
      return;
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

    let prompt: { system: string; user: string };
    try {
      prompt = buildDecompositionPrompt({
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
    } catch (err) {
      // Our bug, not an outage: back off so the executor's re-asks don't spin
      // on it every pass, report it, and leave the breaker alone.
      const { failures } = this.gate.backOff(agentId);
      reportPlanningBug(`decomposition prompt for ${agentRow.name}`, err, failures);
      return;
    }

    // 8. Call LLM. Only this call's errors count towards the outage breaker
    //    (see PlanLLMGate); the executor yields to the utility layer meanwhile
    //    and asks again once the gate reopens.
    const epoch = this.gate.epoch;
    let text: string;
    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        priority: 'normal',
        options: { temperature: 0.7, num_predict: 256 },
      });
      text = response.text;
    } catch (err) {
      if (epoch !== this.gate.epoch) return;
      const reason = err instanceof Error ? err.message : String(err);
      this.gate.recordFailure(agentId, reason);
      console.warn(`[PlanDecomposer] ${agentRow.name} block ${blockId} failed: ${reason}`);
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
      console.warn(`[PlanDecomposer] ${agentRow.name} block ${blockId}: no usable actions`);
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
}
