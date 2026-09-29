import { db } from '../../db';
import { agents, needs, locations, economy, goals } from '../../db/schema';
import { eq, ne, and } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { LLMEmptyReplyError } from '../../ai/llmErrors';
import { CONFIG } from '../constants';
import type { PersonalityProfile } from '../personality';
import { buildDailyPlanPrompt, buildReplanPrompt } from './planPrompts';
import { parsePlanBlocks } from './planParser';
import type { DailyPlan, PlanBlock, PlanExecutionState, ReplanEvent } from './types';
import { logActivity } from '../activityLogger';
import { getAgentHobbies } from '../hobbyEngine';
import { getReputation, getReputationLabel } from '../reputationEngine';
import { getMoodMomentum } from '../moodMomentum';
import { describeEvent } from '../memory/descriptionTemplates';
import {
  reportPlanningBug,
  type BackoffStep,
  type PlanLLMGate,
} from './PlanLLMGate';
import { joinForFeed, shortenForFeed } from '../factText';
import { gameMinutes, type ClockTime } from '../gameClock';

/** Run an optional context lookup; on failure log it and plan without it. */
async function bestEffort<T>(what: string, fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[PlanGenerator] ${what} unavailable, planning without it: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

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
  enqueue(agentId: number, job: () => Promise<void>, key?: string): boolean;
}

/** Dedupe key for daily-plan jobs in the per-agent LLM queue. */
const GENERATE_KEY = 'generate';
/** Dedupe key for replan jobs: one pending rewrite per agent is plenty. */
const REPLAN_KEY = 'replan';

interface PlanningContext {
  agentRow: {
    name: string;
    age: number;
    traits: unknown;
    personality: unknown;
    home: number;
    workplace: number | null;
    schedule: unknown;
    self_description: string | null;
  };
  currentNeeds: { hunger: number; energy: number; social: number; mood: number; stress: number };
  schedule: AgentSchedule;
  validLocations: string[];
  workplaceName: string | null;
  homeName: string;
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
    /** Shared LLM admission control: per-agent backoff, breaker, world epoch. */
    private readonly gate: PlanLLMGate,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Ask for today's plan. Cheap to call on every decision pass: it is a no-op
   * while a plan job for this agent is already queued or running, while the
   * agent is inside an LLM-failure backoff, and while the global breaker is
   * open. Returns whether a job was actually queued.
   */
  queueGeneration(agentId: number, time: ClockTime): boolean {
    const ticket = this.gate.tryAcquire(agentId, gameMinutes(time));
    if (!ticket) return false;
    const accepted = this.queue.enqueue(
      agentId,
      async () => {
        try {
          await this.generate(agentId, time.day);
        } finally {
          this.gate.release(ticket);
        }
      },
      GENERATE_KEY,
    );
    if (!accepted) this.gate.release(ticket);
    return accepted;
  }

  /**
   * Rewrite the rest of today's plan after a significant event. Optional
   * polish, so it is simply skipped while the gate refuses LLM traffic for
   * this agent rather than queued for later.
   */
  queueReplan(
    agentId: number,
    event: ReplanEvent,
    currentHour: number,
    gameMinute: number,
    sleepTime: number,
  ): void {
    const ticket = this.gate.tryAcquire(agentId, gameMinute);
    if (!ticket) return;
    const accepted = this.queue.enqueue(
      agentId,
      async () => {
        try {
          await this.replan(agentId, event, currentHour, sleepTime);
        } finally {
          this.gate.release(ticket);
        }
      },
      REPLAN_KEY,
    );
    if (!accepted) this.gate.release(ticket);
  }

  // ── Private: generate ──────────────────────────────────────────────────────

  private async generate(agentId: number, currentDay: number): Promise<void> {
    // 0. Skip if a real plan already exists for today (dedup against a wake-up
    //    request racing the stale-plan one). A fallback plan does not count:
    //    replacing it is the whole point of retrying after the backoff.
    const existing = this.cache.get(agentId);
    if (existing && existing.day >= currentDay && existing.source !== 'fallback') return;

    const ctx = this.loadContext(agentId);
    if (!ctx) {
      console.warn(`[PlanGenerator] agent ${agentId} not found`);
      return;
    }

    const epoch = this.gate.epoch;

    // Three stages, three kinds of failure, each told to the gate differently
    // (see PlanLLMGate): only the LLM call itself can signal an outage.
    let prompt: { system: string; user: string };
    try {
      prompt = await this.buildPlanPrompt(agentId, currentDay, ctx);
    } catch (err) {
      if (epoch !== this.gate.epoch) return;
      // Our bug, not the LLM's. Back off so it can't spin every pass, report
      // it loudly (first time per streak), and leave the breaker alone.
      const step = this.gate.backOff(agentId);
      reportPlanningBug(`plan prompt for ${ctx.agentRow.name}`, err, step.failures);
      this.fallBack(agentId, currentDay, ctx, 'prompt build failed', step);
      return;
    }

    let text: string;
    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL,
        purpose: 'plan.daily',
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        priority: 'normal',
        options: { temperature: 0.7, num_predict: 512 },
      });
      text = response.text;
    } catch (err) {
      if (epoch !== this.gate.epoch) return;
      const reason = err instanceof Error ? err.message : String(err);
      // An empty / reasoning-only answer means the LLM is up: treat it like an
      // unparseable plan (back off, reset the outage streak), not an outage.
      if (err instanceof LLMEmptyReplyError) {
        const step = this.gate.backOff(agentId);
        this.gate.noteAnswered();
        this.fallBack(agentId, currentDay, ctx, reason, step);
        return;
      }
      this.fallBack(agentId, currentDay, ctx, reason, this.gate.recordFailure(agentId, reason));
      return;
    }
    if (epoch !== this.gate.epoch) return;

    const blocks = parsePlanBlocks(text, ctx.validLocations);

    // An empty parse means the model answered with something we could not
    // read. Asking again right away mostly gets the same kind of answer, so the
    // agent backs off — but the LLM is plainly up, which resets the outage
    // streak rather than feeding it.
    if (blocks.length === 0) {
      const step = this.gate.backOff(agentId);
      this.gate.noteAnswered();
      this.fallBack(agentId, currentDay, ctx, 'unparseable plan output', step);
      return;
    }

    this.gate.recordSuccess(agentId);
    const { agentRow, currentNeeds } = ctx;

    // 13. Create DailyPlan and cache it
    const plan: DailyPlan = {
      day: currentDay,
      generated_at: Date.now(),
      blocks,
      needs_snapshot: {
        hunger: currentNeeds.hunger,
        energy: currentNeeds.energy,
        social: currentNeeds.social,
      },
      source: 'llm',
    };

    this.cache.set(agentId, plan);

    // 14. Record plan memory
    const summary = `Day ${currentDay} plan: ${blocks.map((b) => b.broad_action).join(', ')}`;
    this.memoryService.record(
      agentId,
      'plan',
      summary,
      { subtype: 'daily_plan', day: currentDay },
      0,
      4,
    );

    // 15. Generate anticipation memories for blocks involving other agents
    const allAgentRows = db
      .select({ name: agents.name })
      .from(agents)
      .where(ne(agents.id, agentId))
      .all();
    const allAgentNames = allAgentRows.map((r) => r.name);

    for (const block of plan.blocks) {
      const mentionedAgent = allAgentNames.find((name) =>
        block.broad_action.toLowerCase().includes(name.toLowerCase()),
      );
      if (mentionedAgent) {
        const hour = block.start_hour;
        const timeDesc = hour < 12 ? 'this morning' : hour < 17 ? 'this afternoon' : 'this evening';
        this.memoryService.record(
          agentId,
          'observation',
          describeEvent('anticipation', { agent: mentionedAgent, time: timeDesc, action: block.broad_action }),
          { subtype: 'anticipation' },
          0.2,
          3,
        );
      }
    }

    console.log(
      `[PlanGenerator] Agent ${agentRow.name} planned day ${currentDay}: ${blocks.length} blocks`,
    );

    // The memory keeps the whole plan; the feed gets a glance. Dumping the full
    // "Day N plan: a, b, c, …" (often 250+ chars) into the player feed buried
    // everything else, one wall of text per agent per morning.
    logActivity({
      type: 'plan_generated',
      templateData: { agentName: agentRow.name, summary: joinForFeed(blocks.map((b) => b.broad_action)) },
      agents: [agentId],
    });
  }

  /**
   * Synchronous DB reads the prompt and the fallback plan both need. Kept out
   * of the LLM try-block on purpose: a failure here is a bug, not an outage,
   * and should surface through the queue's error log rather than be papered
   * over with a fallback plan.
   */
  private loadContext(agentId: number): PlanningContext | null {
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
        self_description: agents.self_description,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();

    if (!agentRow) return null;

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

    return {
      agentRow,
      currentNeeds,
      schedule: agentRow.schedule as AgentSchedule,
      validLocations,
      workplaceName,
      homeName,
    };
  }

  /**
   * Build the daily-plan prompt. No LLM call here, so a throw from this is a
   * bug in our code, not an outage (see `generate`).
   *
   * Memory retrieval is best-effort: it embeds the query through Ollama, and
   * when that times out `MemoryService.retrieve` throws. Reflections and
   * yesterday's plan make the plan better but aren't worth losing it over,
   * and letting an embedding timeout fail the plan would also have counted a
   * memory problem as an LLM outage.
   */
  private async buildPlanPrompt(
    agentId: number,
    currentDay: number,
    ctx: PlanningContext,
  ): Promise<{ system: string; user: string }> {
    const { agentRow, currentNeeds, schedule, validLocations, workplaceName, homeName } = ctx;

    const agentEcon = db.select().from(economy).where(eq(economy.agent_id, agentId)).get();

    const personality = agentRow.personality as PersonalityProfile | null;
    const traits = agentRow.traits as string[];

    // 6. Retrieve 3 recent reflections
    const reflections = (
      await bestEffort('reflections', () => this.memoryService.retrieve(agentId, 'my recent reflections', 3))
    ).map((r) => r.memory.description);

    // 7. Retrieve yesterday's plan
    const planMemories = await bestEffort('yesterday plan', () =>
      this.memoryService.retrieveByType(agentId, 'plan', 1),
    );
    const yesterdayPlan = planMemories.length > 0 ? planMemories[0].description : null;

    // 8. Load active goals
    const activeGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active')))
      .all();

    // 9. Build prompt
    return buildDailyPlanPrompt({
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
      goals: activeGoals.map(g => {
        const desc = (g as any).description ?? g.type;
        return (g as any).strategy ? `${desc} (strategy: ${(g as any).strategy})` : desc;
      }),
      reflections,
      yesterdayPlan,
      dayNumber: currentDay,
      validLocations,
      economy: agentEcon ? { money: agentEcon.money, job: agentEcon.job, jobTitle: agentEcon.job_title, salary: agentEcon.salary } : undefined,
      selfDescription: agentRow.self_description ?? undefined,
      hobbies: getAgentHobbies(agentId),
      reputationLabel: getReputationLabel(getReputation(agentId)),
      moodMomentum: getMoodMomentum(agentId),
    });
  }

  /**
   * No LLM plan this time: cache a schedule-derived one for today. The caller
   * has already told the gate what went wrong (which decides the backoff and
   * whether it counts as an outage) and passes the resulting step for the log.
   *
   * Before this, a failure cached nothing, so the decisions phase saw the day
   * as still unplanned and asked again on the very next pass — every planless
   * agent re-requesting every pass, all of it queueing on the LLM semaphore in
   * front of conversations (B6).
   */
  private fallBack(
    agentId: number,
    currentDay: number,
    ctx: PlanningContext,
    reason: string,
    { failures, wait }: BackoffStep,
  ): void {
    // Don't clobber a real plan for today with a fallback. Only reachable if a
    // caller forces a regeneration over an LLM plan; today nothing does.
    const existing = this.cache.get(agentId);
    if (!existing || existing.day < currentDay || existing.source === 'fallback') {
      this.cache.set(agentId, {
        day: currentDay,
        generated_at: Date.now(),
        blocks: this.generateFallbackBlocks(ctx.schedule, ctx.workplaceName),
        needs_snapshot: {
          hunger: ctx.currentNeeds.hunger,
          energy: ctx.currentNeeds.energy,
          social: ctx.currentNeeds.social,
        },
        source: 'fallback',
      });
    }

    console.warn(
      `[PlanGenerator] Plan LLM failed for ${ctx.agentRow.name} (attempt ${failures}): ${reason}; ` +
        `using schedule plan, retry in ${wait} game min`,
    );
  }

  // ── Private: replan ────────────────────────────────────────────────────────

  private async replan(
    agentId: number,
    event: ReplanEvent,
    currentHour: number,
    sleepTime: number,
  ): Promise<void> {
    // 1. Read current plan from cache (at execution time)
    const existingPlan = this.cache.get(agentId);
    if (!existingPlan) {
      console.warn(`[PlanGenerator] replan: no plan found for agent ${agentId}`);
      return;
    }
    // A fallback plan is never executed (see DailyPlan.source), so rewriting its
    // tail buys nothing — and it only exists because the LLM just failed for
    // this agent, which makes another call here the most likely to fail too.
    if (existingPlan.source === 'fallback') return;

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

    // 4. (The active block used to be marked 'interrupted' here, before the LLM
    //    call. On success it is dropped from the merged plan anyway; on failure
    //    the mutation leaked into the cached plan object and silently killed a
    //    block that was still running. Nothing is touched until the rewrite
    //    has actually arrived.)

    // 5. Get location names
    const locationRows = db.select({ name: locations.name }).from(locations).all();
    const validLocations = locationRows.map((l) => l.name);

    const personality = agentRow.personality as PersonalityProfile | null;
    const traits = agentRow.traits as string[];

    // 6. Build replan prompt. A throw here is our bug, not an outage: log it
    //    and keep the plan. No backoff — replans are already rate-limited by
    //    ReplanEvaluator's cooldown, and backing off would also hold up this
    //    agent's plan and decomposition requests for a replan-only problem.
    let prompt: { system: string; user: string };
    try {
      prompt = buildReplanPrompt({
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
    } catch (err) {
      console.error(`[PlanGenerator] replan prompt for ${agentRow.name} failed, keeping existing plan:`, err);
      return;
    }

    // 7. Call LLM. Only this call's errors count towards the outage breaker.
    const epoch = this.gate.epoch;
    let text: string;
    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL,
        purpose: 'plan.revise',
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        priority: 'normal',
        options: { temperature: 0.7, num_predict: 512 },
      });
      text = response.text;
    } catch (err) {
      if (epoch !== this.gate.epoch) return;
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof LLMEmptyReplyError) {
        // The LLM answered, just with nothing usable: not an outage.
        this.gate.backOff(agentId);
        this.gate.noteAnswered();
      } else {
        this.gate.recordFailure(agentId, reason);
      }
      console.warn(`[PlanGenerator] replan failed for agent ${agentRow.name} (${reason}), keeping existing plan`);
      return;
    }
    // World replaced while we waited: the agent id may now belong to someone else.
    if (epoch !== this.gate.epoch) return;
    // The plan changed under us (new day, another replan): merging into the
    // stale copy would overwrite the newer plan.
    if (this.cache.get(agentId) !== existingPlan) return;

    // 8. Parse new blocks. The prompt asks for 2–8 blocks and an evening
    //    replan legitimately has only one or two hours left, so a single
    //    block is enough here (the daily plan keeps its 3-block minimum).
    const newBlocks = parsePlanBlocks(text, validLocations, 1);

    // 9. If parse fails, keep existing plan as-is. The LLM answered, so the
    //    outage streak resets; the agent backs off like for any unusable answer.
    if (newBlocks.length === 0) {
      this.gate.backOff(agentId);
      this.gate.noteAnswered();
      console.warn(
        `[PlanGenerator] replan parse failed for agent ${agentRow.name}, keeping existing plan`,
      );
      return;
    }
    this.gate.recordSuccess(agentId);

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

    // Feed-sized: the reason can be a whole conversation topic and the block
    // list is as long as the rest of the day. Both stay whole in the memory above.
    logActivity({
      type: 'plan_changed',
      templateData: {
        agentName: agentRow.name,
        // No closing period: the registry template and the client both add
        // their own punctuation after it.
        reason: shortenForFeed(event.description, 80).replace(/\.$/, ''),
        summary: joinForFeed(newBlocks.map((b) => b.broad_action)),
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
