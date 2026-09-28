import { db } from '../../db';
import { agents, needs, locations, economy, goals } from '../../db/schema';
import { eq, ne, and } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
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

// ---------------------------------------------------------------------------
// Game clock + retry backoff
// ---------------------------------------------------------------------------

export interface GameClock {
  day: number;
  hour: number;
  minute: number;
}

/**
 * Absolute game minutes since day 1, 00:00.
 *
 * Backoffs are measured in game time rather than `totalTicks` (one tick is
 * `tick_speed` game minutes, so tick counts drift when the sim runs fast) or
 * wall-clock (a paused or slowed world would burn through the wait without the
 * town living through it).
 */
export function gameMinuteOf(t: GameClock): number {
  return ((t.day - 1) * 24 + t.hour) * 60 + t.minute;
}

/**
 * Game minutes to wait before asking the LLM for this agent's plan again after
 * the n-th consecutive failure (the last entry repeats). Short at first so a
 * blip — one timeout under load — costs little, growing so that a dead Ollama
 * costs each agent roughly one doomed request per four game hours instead of
 * one per decision pass.
 */
export const PLAN_RETRY_BACKOFF_MINUTES = [30, 60, 120, 240] as const;

/**
 * Real-time floor under the game-time backoff, in seconds, same indexing.
 *
 * Game time alone is not enough: at tick_speed 4, 30 game minutes pass in 7.5
 * real seconds, well inside the 60 s LLM timeout. Against a *hung* Ollama (one
 * that accepts the connection and never answers) every agent would then keep
 * one doomed plan call parked on a semaphore slot at all times. A retry needs
 * both clocks to have run out: the game one keeps the cadence sensible from the
 * town's point of view, the wall one bounds the load on the real LLM.
 */
export const PLAN_RETRY_FLOOR_SECONDS = [30, 60, 120, 300] as const;

/**
 * ±fraction applied to each backoff. An outage fails every agent within a
 * few seconds of each other; without jitter they would all retry in the same
 * game minute and hit the recovering LLM as one burst.
 */
export const PLAN_RETRY_JITTER = 0.2;

/**
 * Global circuit breaker. After this many plan failures in a row across ALL
 * agents (no success in between) the LLM is treated as down: plan requests are
 * refused town-wide, and every `PLAN_OUTAGE_PROBE_SECONDS` a single request is
 * let through as a probe. Its success closes the breaker; its failure keeps it
 * open for another window. The per-agent backoff alone would still let each of
 * ~13 agents send its own doomed request per window; the breaker turns an
 * outage into at most one in-flight plan call.
 */
export const PLAN_OUTAGE_THRESHOLD = 3;
export const PLAN_OUTAGE_PROBE_SECONDS = 60;

/** Dedupe key for daily-plan jobs in the per-agent LLM queue. */
const GENERATE_KEY = 'generate';

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
  /**
   * Per-agent LLM failure streak and the game minute before which no new plan
   * request is queued. Cleared on the first successful plan and on world
   * replace (worldCaches.ts): after a replace the clock restarts at day 1, so a
   * surviving `retryAt` would gag that agent id for days.
   */
  private backoff = new Map<number, { failures: number; retryAt: number; retryAtMs: number }>();

  /**
   * LLM-wide failure streak for the circuit breaker (see
   * PLAN_OUTAGE_THRESHOLD). Deliberately NOT reset by `clear()`: an outage is a
   * property of the LLM, not of the world, and a fresh world asking 13 agents'
   * worth of plans from a dead Ollama is exactly the storm this prevents.
   * `reported` makes the activity feed say so once per outage.
   */
  private outage = { failures: 0, openUntilMs: 0, reported: false };

  /**
   * Identity of the one probe request allowed through while the breaker is
   * open, or null. Released in the job's `finally` so a probe that ends without
   * reaching the LLM (plan already present, world replaced) can't wedge the
   * breaker shut; `clear()` releases it too, since the queue drops queued jobs
   * on a world replace and their `finally` never runs.
   */
  private probe: object | null = null;

  private readonly wallNow: () => number;
  private readonly random: () => number;

  /**
   * Bumped by `clear()`. A generate job that was awaiting the LLM across a
   * world replace compares it after the await and drops its result, instead of
   * writing the old world's plan onto a new agent that reuses the rowid.
   */
  private epoch = 0;

  constructor(
    private readonly cache: IPlanCache,
    private readonly queue: IPlanLLMQueue,
    private readonly memoryService: IMemoryService,
    /**
     * Current absolute game minute (see `gameMinuteOf`). Read when a request
     * fails, not when it is queued: an LLM timeout can take a long time of
     * game time at high tick speeds, and a backoff measured from the queue
     * time could already have expired by the time the failure lands.
     */
    private readonly now: () => number,
    /** Injectable wall clock (ms) and RNG, for tests. */
    opts: { wallNow?: () => number; random?: () => number } = {},
  ) {
    this.wallNow = opts.wallNow ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Ask for today's plan. Cheap to call on every decision pass: it is a no-op
   * while a plan job for this agent is already queued or running, while the
   * agent is inside an LLM-failure backoff, and while the global breaker is
   * open. Returns whether a job was actually queued.
   */
  queueGeneration(agentId: number, time: GameClock): boolean {
    const wall = this.wallNow();
    const gate = this.backoff.get(agentId);
    if (gate && (gameMinuteOf(time) < gate.retryAt || wall < gate.retryAtMs)) return false;

    let probe: object | null = null;
    if (this.outage.failures >= PLAN_OUTAGE_THRESHOLD) {
      if (wall < this.outage.openUntilMs || this.probe) return false;
      probe = {};
    }

    const accepted = this.queue.enqueue(
      agentId,
      async () => {
        try {
          await this.generate(agentId, time.day);
        } finally {
          if (probe && this.probe === probe) this.probe = null;
        }
      },
      GENERATE_KEY,
    );
    if (accepted && probe) this.probe = probe;
    return accepted;
  }

  /** Game minute before which no plan request is queued, or null. */
  getRetryAt(agentId: number): number | null {
    return this.backoff.get(agentId)?.retryAt ?? null;
  }

  /** Whether the global breaker currently counts the LLM as down. */
  isOutage(): boolean {
    return this.outage.failures >= PLAN_OUTAGE_THRESHOLD;
  }

  /** Drop all per-world state. Called from `clearPerWorldCaches`. */
  clear(): void {
    this.backoff.clear();
    this.probe = null;
    this.epoch++;
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

    const epoch = this.epoch;
    let blocks: PlanBlock[];
    try {
      blocks = await this.requestPlanBlocks(agentId, currentDay, ctx);
    } catch (err) {
      if (epoch !== this.epoch) return;
      this.fallBack(agentId, currentDay, ctx, err instanceof Error ? err.message : String(err));
      return;
    }
    if (epoch !== this.epoch) return;

    // An empty parse means the model answered with something we could not read.
    // Asking again right away mostly gets the same kind of answer, so this is a
    // failure like any other: fallback plan now, LLM again after the backoff.
    if (blocks.length === 0) {
      this.fallBack(agentId, currentDay, ctx, 'unparseable plan output');
      return;
    }

    this.backoff.delete(agentId);
    if (this.outage.failures >= PLAN_OUTAGE_THRESHOLD) {
      console.log('[PlanGenerator] LLM answered again; plan requests resume');
    }
    this.outage = { failures: 0, openUntilMs: 0, reported: false };
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

    logActivity({
      type: 'plan_generated',
      templateData: { agentName: agentRow.name, summary },
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
   * Everything that can fail because the LLM stack is down or slow: memory
   * retrieval (embeddings go through Ollama too), the chat call itself (throws
   * on HTTP errors and on `AI.TIMEOUT_MS`), and parsing. Returns the parsed
   * blocks, empty when the output was unreadable.
   */
  private async requestPlanBlocks(
    agentId: number,
    currentDay: number,
    ctx: PlanningContext,
  ): Promise<PlanBlock[]> {
    const { agentRow, currentNeeds, schedule, validLocations, workplaceName, homeName } = ctx;

    const agentEcon = db.select().from(economy).where(eq(economy.agent_id, agentId)).get();

    const personality = agentRow.personality as PersonalityProfile | null;
    const traits = agentRow.traits as string[];

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

    // 8. Load active goals
    const activeGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active')))
      .all();

    // 9. Build prompt
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

    // 10. Call LLM
    const response = await callOllamaChat({
      model: CONFIG.AI.LIGHT_MODEL,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      priority: 'normal',
      options: { temperature: 0.7, num_predict: 512 },
    });

    // 11. Parse blocks
    return parsePlanBlocks(response.text, validLocations);
  }

  /**
   * The LLM could not produce a plan: cache a schedule-derived one for today
   * and hold further requests for this agent off for a backoff window.
   *
   * Before this, a failure cached nothing, so the decisions phase saw the day
   * as still unplanned and asked again on the very next pass — every planless
   * agent re-requesting every pass, all of it queueing on the LLM semaphore in
   * front of conversations (B6).
   */
  private fallBack(agentId: number, currentDay: number, ctx: PlanningContext, reason: string): void {
    const prev = this.backoff.get(agentId);
    const failures = (prev?.failures ?? 0) + 1;
    const step = Math.min(failures, PLAN_RETRY_BACKOFF_MINUTES.length) - 1;
    const jitter = 1 + (this.random() * 2 - 1) * PLAN_RETRY_JITTER;
    const wait = Math.round(PLAN_RETRY_BACKOFF_MINUTES[step] * jitter);
    const wall = this.wallNow();
    this.backoff.set(agentId, {
      failures,
      retryAt: this.now() + wait,
      retryAtMs: wall + Math.round(PLAN_RETRY_FLOOR_SECONDS[step] * 1000 * jitter),
    });

    this.outage.failures++;
    const tripped = this.outage.failures >= PLAN_OUTAGE_THRESHOLD;
    if (tripped) this.outage.openUntilMs = wall + PLAN_OUTAGE_PROBE_SECONDS * 1000;

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
    // One activity-feed entry per outage, raised when the breaker trips and
    // re-armed by the next successful plan. Per-agent entries flooded the feed
    // with a dozen identical errors every time Ollama went away; a lone blip
    // that one agent's retry absorbs isn't worth the player's attention at all.
    if (tripped && !this.outage.reported) {
      this.outage.reported = true;
      try {
        logActivity({
          type: 'error',
          templateData: {
            system: 'planning',
            message: `Daily plans are failing (${reason}); townsfolk follow their routines until the LLM answers again`,
          },
        });
      } catch {
        // Reporting must never turn a handled failure into an unhandled one.
      }
    }
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
      model: CONFIG.AI.LIGHT_MODEL,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      priority: 'normal',
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
