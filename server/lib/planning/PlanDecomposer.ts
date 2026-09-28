import { db } from '../../db';
import { agents, needs, locations, economy } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import type { PersonalityProfile } from '../personality';
import { buildDecompositionPrompt } from './planPrompts';
import { parseDecomposedActions } from './planParser';
import type { DailyPlan } from './types';

// ---------------------------------------------------------------------------
// Structural interfaces for the injected singletons
// (PlanCache and PlanLLMQueue classes are not exported, only their instances)
// ---------------------------------------------------------------------------

interface IPlanCache {
  get(agentId: number): DailyPlan | null;
  set(agentId: number, plan: DailyPlan): void;
}

interface IPlanLLMQueue {
  enqueue(agentId: number, job: () => Promise<void>): void;
}

// ---------------------------------------------------------------------------
// PlanDecomposer
// ---------------------------------------------------------------------------

export class PlanDecomposer {
  constructor(
    private readonly cache: IPlanCache,
    private readonly queue: IPlanLLMQueue,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  queueDecomposition(agentId: number, blockId: string): void {
    this.queue.enqueue(agentId, () => this.decompose(agentId, blockId));
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

    // 8. Call LLM
    const response = await callOllamaChat({
      model: CONFIG.AI.LIGHT_MODEL,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      priority: 'normal',
      options: { temperature: 0.7, num_predict: 256 },
    });

    // 9. Parse decomposed actions
    const actions = parseDecomposedActions(response.text, validLocations, validAgentNames);

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
