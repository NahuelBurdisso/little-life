import { db } from '../../db';
import { agents, needs, locations } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import type { PersonalityProfile } from '../personality';
import { buildDailyPlanPrompt, buildReplanPrompt } from './planPrompts';
import { parsePlanBlocks } from './planParser';
import type { DailyPlan, PlanBlock, PlanExecutionState, ReplanEvent } from './types';
import { logActivity } from '../activityLogger';

// ---------------------------------------------------------------------------
// Structural interfaces for injected singletons
// (PlanCache and PlanLLMQueue classes are not exported, only their instances)
// ---------------------------------------------------------------------------

interface IPlanCache {
  get(agentId: number): DailyPlan | null;
  set(agentId: number, plan: DailyPlan): void;
  setExecState(agentId: number, state: PlanExecutionState): void;
}

interface IPlanLLMQueue {
  enqueue(agentId: number, job: () => Promise<void>): void;
}

// ---------------------------------------------------------------------------
// MemoryService interface — only the methods PlanGenerator needs
// ---------------------------------------------------------------------------

interface RetrievalResult {
  memory: { description: string };
  score: number;
  recencyScore: number;
  importanceScore: number;
  relevanceScore: number;
}

interface Memory {
  description: string;
}

interface IMemoryService {
  retrieve(agentId: number, query: string, topK: number): Promise<RetrievalResult[]>;
  retrieveByType(agentId: number, type: string, limit: number): Promise<Memory[]>;
  record(
    agentId: number,
    type: string,
    description: string,
    metadata: Record<string, unknown>,
    emotionalValence: number,
    importanceOverride?: number,
  ): void;
}

// ---------------------------------------------------------------------------
// Schedule shape (from agents.schedule)
// ---------------------------------------------------------------------------

interface AgentSchedule {
  wakeTime: number;
  sleepTime: number;
  workStart: number;
  workEnd: number;
  lunchTime: number;
  freeTimePreferences: string[];
}

// ---------------------------------------------------------------------------
// PlanGenerator
// ---------------------------------------------------------------------------

export class PlanGenerator {
  constructor(
    private readonly cache: IPlanCache,
    private readonly queue: IPlanLLMQueue,
    private readonly memoryService: IMemoryService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  queueGeneration(agentId: number, currentDay: number, currentTick: number): void {
    this.queue.enqueue(agentId, () => this.generate(agentId, currentDay, currentTick));
  }

  queueReplan(
    agentId: number,
    event: ReplanEvent,
    currentHour: number,
    currentTick: number,
    sleepTime: number,
  ): void {
    this.queue.enqueue(agentId, () =>
      this.replan(agentId, event, currentHour, currentTick, sleepTime),
    );
  }

  // ── Private: generate ──────────────────────────────────────────────────────

  private async generate(
    agentId: number,
    currentDay: number,
    _currentTick: number,
  ): Promise<void> {
    // 1. Load agent row
    const agentRow = db
      .select({
        name: agents.name,
        age: agents.age,
        traits: agents.traits,
        personality: agents.personality,
        home: agents.home,
        workplace: agents.workplace,
        schedule: agents.schedule,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();

    if (!agentRow) {
      console.warn(`[PlanGenerator] agent ${agentId} not found`);
      return;
    }

    // 2. Load needs row
    const needsRow = db
      .select({
        hunger: needs.hunger,
        energy: needs.energy,
        social: needs.social,
        mood: needs.mood,
        stress: needs.stress,
      })
      .from(needs)
      .where(eq(needs.agent_id, agentId))
      .get();

    const currentNeeds = needsRow ?? { hunger: 50, energy: 50, social: 50, mood: 50, stress: 50 };

    const personality = agentRow.personality as PersonalityProfile | null;
    const traits = agentRow.traits as string[];
    const schedule = agentRow.schedule as AgentSchedule;

    // 3. Get all location names
    const locationRows = db.select({ name: locations.name }).from(locations).all();
    const validLocations = locationRows.map((l) => l.name);

    // 4. Get workplace name (nullable FK)
    let workplaceName: string | null = null;
    if (agentRow.workplace != null) {
      const wpRow = db
        .select({ name: locations.name })
        .from(locations)
        .where(eq(locations.id, agentRow.workplace))
        .get();
      workplaceName = wpRow?.name ?? null;
    }

    // 5. Get home name
    const homeRow = db
      .select({ name: locations.name })
      .from(locations)
      .where(eq(locations.id, agentRow.home))
      .get();
    const homeName = homeRow?.name ?? 'Home';

    // 6. Retrieve 3 recent reflections
    const reflectionResults = await this.memoryService.retrieve(
      agentId,
      'my recent reflections',
      3,
    );
    const reflections = reflectionResults.map((r) => r.memory.description);

    // 7. Retrieve yesterday's plan
    const planMemories = await this.memoryService.retrieveByType(agentId, 'plan', 1);
    const yesterdayPlan = planMemories.length > 0 ? planMemories[0].description : null;

    // 8. Build prompt
    const prompt = buildDailyPlanPrompt({
      name: agentRow.name,
      age: agentRow.age,
      traits,
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
      needs: currentNeeds,
      home: homeName,
      workplace: workplaceName,
      workStart: schedule.workStart,
      workEnd: schedule.workEnd,
      wakeTime: schedule.wakeTime,
      sleepTime: schedule.sleepTime,
      goals: [],
      reflections,
      yesterdayPlan,
      dayNumber: currentDay,
      validLocations,
    });

    // 9. Call LLM
    const response = await callOllamaChat({
      model: CONFIG.AI.CHAT_MODEL,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      options: { temperature: 0.7, num_predict: 512 },
    });

    // 10. Parse blocks
    let blocks = parsePlanBlocks(response.text, validLocations);

    // 11. Fallback if parse fails
    if (blocks.length === 0) {
      blocks = this.generateFallbackBlocks(schedule, workplaceName);
    }

    // 12. Create DailyPlan and cache it
    const plan: DailyPlan = {
      day: currentDay,
      generated_at: Date.now(),
      blocks,
      needs_snapshot: {
        hunger: currentNeeds.hunger,
        energy: currentNeeds.energy,
        social: currentNeeds.social,
      },
    };

    this.cache.set(agentId, plan);

    // 13. Record plan memory
    const summary = `Day ${currentDay} plan: ${blocks.map((b) => b.broad_action).join(', ')}`;
    this.memoryService.record(
      agentId,
      'plan',
      summary,
      { subtype: 'daily_plan', day: currentDay },
      0,
      4,
    );

    console.log(
      `[PlanGenerator] Agent ${agentRow.name} planned day ${currentDay}: ${blocks.length} blocks`,
    );

    logActivity({
      type: 'plan_generated',
      templateData: { agentName: agentRow.name, summary },
      agents: [agentId],
    });
  }

  // ── Private: replan ────────────────────────────────────────────────────────

  private async replan(
    agentId: number,
    event: ReplanEvent,
    currentHour: number,
    _currentTick: number,
    sleepTime: number,
  ): Promise<void> {
    // 1. Read current plan from cache (at execution time)
    const existingPlan = this.cache.get(agentId);
    if (!existingPlan) {
      console.warn(`[PlanGenerator] replan: no plan found for agent ${agentId}`);
      return;
    }

    // 2. Load agent + needs
    const agentRow = db
      .select({
        name: agents.name,
        traits: agents.traits,
        personality: agents.personality,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();

    if (!agentRow) return;

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

    // 3. Filter remaining blocks
    const completedBlocks = existingPlan.blocks.filter(
      (b) => b.status === 'completed' || b.end_hour <= currentHour,
    );
    const remainingBlocks = existingPlan.blocks.filter(
      (b) => b.end_hour > currentHour && b.status !== 'completed',
    );

    // 4. Mark active block as interrupted
    for (const block of remainingBlocks) {
      if (block.status === 'active') {
        block.status = 'interrupted';
      }
    }

    // 5. Get location names
    const locationRows = db.select({ name: locations.name }).from(locations).all();
    const validLocations = locationRows.map((l) => l.name);

    const personality = agentRow.personality as PersonalityProfile | null;
    const traits = agentRow.traits as string[];

    // 6. Build replan prompt
    const prompt = buildReplanPrompt({
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
      eventDescription: event.description,
      remainingBlocks: remainingBlocks.map((b) => ({
        start_hour: b.start_hour,
        end_hour: b.end_hour,
        broad_action: b.broad_action,
        location_hint: b.location_hint,
      })),
      needs: currentNeeds,
      currentHour,
      sleepTime,
      validLocations,
    });

    // 7. Call LLM
    const response = await callOllamaChat({
      model: CONFIG.AI.CHAT_MODEL,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      options: { temperature: 0.7, num_predict: 512 },
    });

    // 8. Parse new blocks
    const newBlocks = parsePlanBlocks(response.text, validLocations);

    // 9. If parse fails, keep existing plan as-is
    if (newBlocks.length === 0) {
      console.warn(
        `[PlanGenerator] replan parse failed for agent ${agentRow.name}, keeping existing plan`,
      );
      return;
    }

    // 10. Merge completed + new blocks; mark new blocks as replanned
    const mergedBlocks: PlanBlock[] = [
      ...completedBlocks,
      ...newBlocks.map((b, i) => ({
        ...b,
        id: `replan_${currentHour}_${i}`,
        status: 'pending' as const,
      })),
    ];

    const updatedPlan: DailyPlan = {
      ...existingPlan,
      blocks: mergedBlocks,
    };

    // 11. Update cache and reset exec state
    this.cache.set(agentId, updatedPlan);
    this.cache.setExecState(agentId, {
      currentBlockId: null,
      currentActionIndex: 0,
      blockStartedAt: 0,
      actionStartedAt: 0,
    });

    // 12. Record replan memory
    const newBlocksSummary = newBlocks.map((b) => b.broad_action).join(', ');
    this.memoryService.record(
      agentId,
      'plan',
      `Replanned after: ${event.description}. New blocks: ${newBlocksSummary}`,
      { subtype: 'replan', event_type: event.type },
      event.sentiment,
      3,
    );

    console.log(`[PlanGenerator] Agent ${agentRow.name} replanned: ${event.description}`);

    logActivity({
      type: 'plan_changed',
      templateData: {
        agentName: agentRow.name,
        reason: event.description,
        summary: newBlocksSummary,
      },
      agents: [agentId],
    });
  }

  // ── Private: fallback ──────────────────────────────────────────────────────

  private generateFallbackBlocks(
    schedule: AgentSchedule,
    workplaceName: string | null,
  ): PlanBlock[] {
    const { wakeTime, sleepTime, workStart, workEnd, lunchTime } = schedule;
    const blocks: PlanBlock[] = [];
    let idx = 0;

    const make = (
      start: number,
      end: number,
      action: string,
      location: string,
    ): PlanBlock => ({
      id: `fallback_${idx++}`,
      start_hour: start,
      end_hour: end,
      broad_action: action,
      location_hint: location,
      status: 'pending',
    });

    // 1. Wake up + morning routine
    blocks.push(make(wakeTime, wakeTime + 1, 'morning routine', 'Home'));

    // 2. Morning free time or work
    if (workplaceName && workStart > wakeTime + 1) {
      blocks.push(make(wakeTime + 1, workStart, 'relax at home', 'Home'));
    }

    // 3. Work block (if employed)
    if (workplaceName) {
      const lunchHour = Math.min(lunchTime, workEnd - 1);
      blocks.push(make(workStart, lunchHour, 'work', workplaceName));

      // 4. Lunch
      blocks.push(make(lunchHour, lunchHour + 1, 'eat lunch', workplaceName));

      // 5. Afternoon work
      if (lunchHour + 1 < workEnd) {
        blocks.push(make(lunchHour + 1, workEnd, 'work', workplaceName));
      }

      // 6. Evening free time
      if (workEnd < sleepTime - 1) {
        blocks.push(make(workEnd, sleepTime - 1, 'relax at home', 'Home'));
      }
    } else {
      // No job — spread across the day
      const midday = Math.floor((wakeTime + sleepTime) / 2);
      blocks.push(make(wakeTime + 1, midday, 'spend free time', 'Home'));
      blocks.push(make(midday, midday + 1, 'eat lunch', 'Home'));
      blocks.push(make(midday + 1, sleepTime - 1, 'relax', 'Home'));
    }

    // Last block: sleep
    blocks.push(make(sleepTime - 1, sleepTime, 'prepare for bed', 'Home'));

    return blocks;
  }
}
