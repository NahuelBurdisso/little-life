import { db, getTableWriteVersion } from '../../db';
import {
  agents,
  goals,
  aspirations,
  shared_knowledge,
  economy,
  relationships,
  worldState,
} from '../../db/schema';
import { eq, and, gte, or } from 'drizzle-orm';
import { RowsByAgentSnapshot } from '../../lib/rowsByAgentSnapshot';
import { GOAL_REGISTRY, GOAL_TRIGGER_REGISTRY } from '../../data/goalRegistry';
import { MAX_GOALS_PER_AGENT } from '../../lib/interactionConstants';
import { AgentStateRowsSnapshot, getEffectivePersonality, type AgentStateRow } from '../../lib/states';
import { logActivity } from '../../lib/activityLogger';
import type { GoalTriggerDef } from '../../lib/interactionConstants';
import { simEvents } from '../../lib/simEvents';
import { goalReviewer, pivotEvaluator } from '../../lib/goals/instance';
import { compareOp, getRelationship, getRelField } from '../../lib/goals/relationshipConditions';
import { gameMinutes } from '../../lib/gameClock';
import {
  completeGoal, describeGoal, recordGoalOutcome, HOSTILE_CHAT, WARM_CHAT, type GoalOutcome,
} from '../../lib/goals/goalProgress';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// CLOCK: the goal system runs on GAME MINUTES — `goals.created_at` /
// `completed_at`, `aspirations.adopted_at` / `shifted_at`, the trigger cooldown,
// the registry's `minutes_elapsed` rules and the pivot/stale thresholds. They were
// ticks, so at 4x every "12 hours" or "3 days" in here took four times as long.
const MINUTES_PER_DAY = 1440;

/**
 * How long a finished goal still blocks its trigger from creating the same goal
 * again. 12 game hours — prevents goal→abandon spam for persistent triggers.
 */
const RECREATE_COOLDOWN_MINUTES = 720;

type GoalRow = typeof goals.$inferSelect;

/**
 * Roll an abandonment rule's `chance`, which the registry authors as a
 * probability *per game day* — it sits next to thresholds written in whole days
 * (`minutes_elapsed > 4320`), and rules meant to fire immediately use `auto: true`
 * instead.
 *
 * Abandonment is re-evaluated on every tick, so rolling `chance` straight turned
 * "30% chance" into a near-certainty: 1 - 0.7^1440. Convert to the equivalent
 * per-tick hazard rate so a game day's worth of ticks compounds back to
 * `chance`. A tick covers `tickSpeed` game minutes, so a day is 1440 / tickSpeed
 * ticks, not 1440 — at 4x the old rate compounded to a quarter of the chance.
 */
export function dailyChancePerTick(chance: number, tickSpeed: number): number {
  if (chance >= 1) return 1;
  if (chance <= 0) return 0;
  return 1 - Math.pow(1 - chance, tickSpeed / MINUTES_PER_DAY);
}

function rollDailyChance(chance: number, tickSpeed: number): boolean {
  return Math.random() < dailyChancePerTick(chance, tickSpeed);
}

function checkPersonalityGate(personality: any, gate: Record<string, string>): boolean {
  for (const [trait, condition] of Object.entries(gate)) {
    const parts = condition.split(' ');
    const op = parts[0];
    const value = parseFloat(parts[1]);
    const actual = personality?.[trait] ?? 50;
    if (!compareOp(actual, op, value)) return false;
  }
  return true;
}

// ─── checkTriggerCondition ────────────────────────────────────────────────────
// Returns false if the trigger does not fire, or the target agent ID (or null)
// if it does.

function checkTriggerCondition(
  trigger: GoalTriggerDef,
  agent: any,
  _currentTick: number,
  cachedKnowledge: (typeof shared_knowledge.$inferSelect)[],
  cachedRelationships: (typeof relationships.$inferSelect)[],
  stateRows: AgentStateRowsSnapshot,
): number | null | false {
  const cond = trigger.condition;

  switch (cond.type) {
    case 'state_gained': {
      // From the phase's row snapshot, not a query per trigger: ~3.5 state
      // triggers per agent made this the goals phase's most frequent read.
      const states = stateRows.forAgent(agent.id).filter((s) => s.type === cond.state);
      if (states.length === 0) return false;
      if (cond.has_target) {
        const targetState = states.find(s => s.target_agent_id != null);
        return targetState ? targetState.target_agent_id! : false;
      }
      return null;
    }

    case 'fact_learned': {
      // Read off `known_by`, not off an event: a fact learned by gossip, by a merge into the row
      // (a witness, the spouse who walked in: intimacy/tryst.ts) or by being born knowing counts alike.
      const partnered = (other: number): boolean => {
        const rel = cachedRelationships.find(r => r.agent_a === Math.min(agent.id, other) && r.agent_b === Math.max(agent.id, other));
        return !!rel && !!(rel.tags as string[])?.includes('partner');
      };
      for (const f of cachedKnowledge) {
        if (f.type !== cond.fact_type!) continue;
        if (!(f.known_by as number[]).includes(agent.id)) continue;
        if (cond.is_victim && f.target_id !== agent.id) continue;
        if (cond.involves_partner) {
          // The betrayed one, not a party to it: the lover a fact names is not wronged by their own affair
          // (their row with the straying partner can read "partner" too), and a fact that names the lover
          // first (the subject is whoever is spoken for, the lower id when both are) is still about
          // the cheater the agent is with. The revenge is aimed at THAT person.
          if (f.subject_id === agent.id || f.target_id === agent.id) continue;
          const betrayer = [f.subject_id, f.target_id].find((id): id is number => id != null && partnered(id));
          if (betrayer == null) continue;
          return betrayer;
        }
        return f.subject_id;
      }
      return false;
    }

    case 'aspiration_pressure': {
      const asp = db.select().from(aspirations)
        .where(and(eq(aspirations.agent_id, agent.id), eq(aspirations.status, 'active')))
        .get();
      if (!asp || asp.type !== cond.aspiration) return false;
      const econ = db.select().from(economy)
        .where(eq(economy.agent_id, agent.id))
        .get();
      if (!econ || econ.money >= (cond.money_below ?? 0)) return false;
      const allEcon = db.select().from(economy).all();
      const wealthiest = allEcon
        .filter(e => e.agent_id !== agent.id)
        .sort((a, b) => b.money - a.money)[0];
      return wealthiest?.agent_id ?? null;
    }

    case 'relationship_threshold': {
      for (const rel of cachedRelationships) {
        const isA = rel.agent_a === agent.id;
        const isB = rel.agent_b === agent.id;
        if (!isA && !isB) continue;
        const otherId = isA ? rel.agent_b : rel.agent_a;
        const fieldValue = getRelField(rel, cond.field!, isA);
        if (compareOp(fieldValue, cond.op!, cond.value!)) {
          return otherId;
        }
      }
      return false;
    }

    default:
      return false;
  }
}

// ─── evaluateTriggers ─────────────────────────────────────────────────────────

function evaluateTriggers(
  agent: any,
  nowMinutes: number,
  cachedKnowledge: (typeof shared_knowledge.$inferSelect)[],
  cachedRelationships: (typeof relationships.$inferSelect)[],
  stateRows: AgentStateRowsSnapshot,
  goalRows: RowsByAgentSnapshot<GoalRow>,
): void {
  const personality = getEffectivePersonality(agent.id);
  // One read of the agent's goals serves both lists below (it was two queries
  // per agent, the second a superset of the first). The snapshot re-reads after
  // any goals write, so this sees what abandonment and passive progress just did.
  const agentGoalRows = goalRows.forAgent(agent.id);
  const activeGoals = agentGoalRows.filter(g => g.status === 'active');

  // Also load recently abandoned/completed goals to prevent create→abandon spam.
  // Without this, a persistent trigger (e.g., infatuated state) creates a goal every tick
  // that gets immediately abandoned, flooding the activity log.
  const recentGoals = agentGoalRows
    .filter(g => g.status !== 'active' && (nowMinutes - g.created_at) < RECREATE_COOLDOWN_MINUTES);

  for (const trigger of GOAL_TRIGGER_REGISTRY) {
    if (activeGoals.length >= MAX_GOALS_PER_AGENT) break;

    if (trigger.personality_gate && !checkPersonalityGate(personality, trigger.personality_gate)) continue;

    // `trigger_on: 'observers'` (protect a sick neighbour, comfort a grieving one) means the
    // goal belongs to someone WATCHING the state, aimed at the one who has it. Nothing here
    // implements that: `checkTriggerCondition` tests the agent's OWN states, so the sick or
    // grieving resident got a target-less "protect" / "comfort_grieving" goal about themselves.
    // Such a goal can never advance (progress needs a target: conversation listener below) nor
    // end on `target_recovered` (needs one too), so it sat until the 3-day timeout: 47 of the 57
    // goals of a 30-day, 13-resident soak, and 456 goals given up at 32 residents, all of them
    // this. Skipped until observers exist rather than creating dead goals.
    if (trigger.trigger_on === 'observers') continue;

    const targetId = checkTriggerCondition(trigger, agent, nowMinutes, cachedKnowledge, cachedRelationships, stateRows);
    if (targetId === false) continue;

    // Don't duplicate: skip if agent already has this goal type targeting the same agent
    // (active OR recently abandoned/completed — prevents create→abandon loops)
    const allRelevant = [...activeGoals, ...recentGoals];
    const duplicate = allRelevant.find(g =>
      g.type === trigger.generates &&
      (targetId === null ? true : g.target_id === targetId),
    );
    if (duplicate) continue;

    const condState = trigger.condition.state ?? trigger.condition.fact_type ?? trigger.condition.aspiration ?? '';
    db.insert(goals).values({
      agent_id: agent.id,
      type: trigger.generates,
      target_id: targetId ?? undefined,
      motivation: `${trigger.condition.type}:${condState}`,
      priority: trigger.priority_base,
      progress: 0,
      status: 'active',
      created_at: nowMinutes,
    }).run();

    activeGoals.push({ type: trigger.generates, target_id: targetId } as any);

    simEvents.emit('goal:created', { agentId: agent.id, goalType: trigger.generates, targetId: targetId });

    // `goal_created`, not `system`: this is the same event GoalReviewer logs, and
    // filing it under System hid every trigger-generated goal behind the ⚙ filter
    // and dropped its importance to 0.1, below the drama/highlight thresholds.
    logActivity({
      type: 'goal_created',
      initiator: agent.id,
      templateData: { name: agent.name, goal: trigger.generates },
    });
  }
}

// ─── evaluateAbandonment ──────────────────────────────────────────────────────

function evaluateAbandonment(
  agent: any,
  goal: any,
  nowMinutes: number,
  allAgentStates: readonly AgentStateRow[],
  tickSpeed: number,
): void {
  const def = GOAL_REGISTRY[goal.type];
  if (!def) return;

  for (const rule of def.abandonment) {
    let shouldAbandon = false;

    if (rule.condition.startsWith('state_expired:')) {
      const stateType = rule.condition.split(':')[1];
      const hasState = allAgentStates.filter(
        s => s.agent_id === agent.id && s.type === stateType,
      );
      if (hasState.length === 0) {
        shouldAbandon = rule.auto === true || (rule.chance != null && rollDailyChance(rule.chance, tickSpeed));
      }
    } else if (rule.condition.startsWith('relationship.')) {
      if (goal.target_id) {
        const rel = getRelationship(agent.id, goal.target_id);
        if (rel) {
          const parts = rule.condition.split(' ');
          const field = parts[0].split('.')[1];
          const op = parts[1];
          const value = parseFloat(parts[2]);
          const isA = rel.agent_a === agent.id;
          const actual = getRelField(rel, field, isA);
          if (compareOp(actual, op, value)) {
            shouldAbandon = rule.auto === true || (rule.chance != null && rollDailyChance(rule.chance, tickSpeed));
          }
        }
      }
    } else if (rule.condition.startsWith('minutes_elapsed')) {
      const maxMinutes = parseInt(rule.condition.split('> ')[1]);
      if (nowMinutes - goal.created_at > maxMinutes) {
        shouldAbandon = rule.auto === true || (rule.chance != null && rollDailyChance(rule.chance, tickSpeed));
      }
    } else if (rule.condition.startsWith('economy.')) {
      const econ = db.select().from(economy).where(eq(economy.agent_id, agent.id)).get();
      if (econ) {
        const parts = rule.condition.split(' ');
        const field = parts[0].split('.')[1];
        const op = parts[1];
        const value = parseFloat(parts[2]);
        if (compareOp((econ as any)[field], op, value)) {
          shouldAbandon = true;
        }
      }
    } else if (rule.condition === 'target_recovered') {
      if (goal.target_id) {
        const needsCare = allAgentStates.some(s =>
          s.agent_id === goal.target_id &&
          ['sick', 'grieving', 'heartbroken', 'lonely', 'depressed'].includes(s.type),
        );
        if (!needsCare) shouldAbandon = true;
      }
    } else if (rule.condition === 'relapsed') {
      const hasAlcoholic = allAgentStates.some(
        s => s.agent_id === agent.id && s.type === 'alcoholic',
      );
      if (hasAlcoholic) shouldAbandon = true;
    }

    if (shouldAbandon) {
      let newStatus = rule.becomes ?? 'abandoned';
      // A protect / comfort goal whose target got better after the owner had already been
      // there for them (a comfort, a gift, a few kind talks) is a job done, not a goal given
      // up: "target_recovered" used to abandon it whatever the owner had put in.
      if (rule.condition === 'target_recovered' && (goal.progress ?? 0) >= RECOVERED_COUNTS_AS_DONE) {
        newStatus = 'completed';
      }

      if (newStatus === 'completed') {
        // The one completion path (lib/goals/goalProgress.ts): status, feed row, memory, mood lift.
        completeGoal(goal, nowMinutes);
        goal.status = 'completed';
        break;
      }

      db.update(goals)
        .set({ status: newStatus, completed_at: nowMinutes })
        .where(eq(goals.id, goal.id))
        .run();
      goal.status = newStatus;

      // MemoryObserver turns this into "I gave up on my goal: ...", so the owner remembers it.
      const description = describeGoal(goal, targetFirstName(goal.target_id));
      simEvents.emit('goal:abandoned', { agentId: agent.id, goalType: goal.type, description, ...goalEventCast(goal) });

      logActivity({
        type: 'goal_abandoned',
        initiator: agent.id,
        templateData: { agent: agent.name, goal_description: description },
      });
      break;
    }
  }
}

/** Progress a protect / comfort goal needs for its target's recovery to count as done. */
const RECOVERED_COUNTS_AS_DONE = 0.3;

function targetFirstName(targetId: number | null): string | null {
  if (targetId == null) return null;
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, targetId)).get()?.name.split(' ')[0] ?? null;
}

/**
 * The cast of a goal event, in the cascade engine's vocabulary.
 *
 * These events used to name the goal's *target* as `perpetratorId` and the
 * achiever as `victimId`, so every consumer read the roles backwards: witnesses
 * spread rumors about the person who was protected or befriended, and
 * favorEngine recorded a "protect" favor from the agent to themself. The agent
 * pursuing the goal is the actor (`agentId`, which the engine also treats as
 * the perpetrator); the goal's target is the other party, carried in `victimId`
 * — the engine's only "other party" slot, and the field favorEngine already
 * reads for the person who was helped.
 */
export function goalEventCast(goal: { target_id: number | null }): { victimId?: number } {
  return goal.target_id != null ? { victimId: goal.target_id } : {};
}

// ─── evaluatePassiveProgress ──────────────────────────────────────────────────

function evaluatePassiveProgress(agent: any, goal: any, nowMinutes: number, stateRows: AgentStateRowsSnapshot): void {
  const def = GOAL_REGISTRY[goal.type];
  if (!def || def.valid_interactions.length > 0) return; // only passive goals

  for (const pe of def.progress_events) {
    if (!pe.condition) continue;

    let conditionMet = false;
    if (pe.condition === 'economy.money > 0') {
      const econ = db.select().from(economy).where(eq(economy.agent_id, agent.id)).get();
      conditionMet = econ != null && econ.money > 0;
    } else if (pe.condition.startsWith('state_expired:')) {
      const stateType = pe.condition.split(':')[1];
      conditionMet = stateRows.find(agent.id, stateType) === undefined;
    }

    if (conditionMet) {
      const newProgress = Math.min(def.completion_at, goal.progress + pe.progress);
      if (newProgress >= def.completion_at) {
        completeGoal(goal, nowMinutes, newProgress);
        goal.status = 'completed';
        return;
      }
      db.update(goals).set({ progress: newProgress }).where(eq(goals.id, goal.id)).run();
      goal.progress = newProgress;
    }
  }
}

// ─── Outcome-driven goal progress ─────────────────────────────────────────────

let goalProgressListenersInitialized = false;

/**
 * Feed goal progress from what happens between people (lib/goals/goalProgress.ts decides
 * which outcome serves which goal type). The old single listener advanced every goal aimed at
 * a chat partner on any non-hostile chat — a revenge included — and never completed anything.
 *
 * Sources that are events already are wired here; the gossip engine, confrontations and the
 * drama beats of both conversation tiers call `recordGoalOutcome` directly where they know
 * who did what to whom.
 */
function initGoalProgressListeners(): void {
  if (goalProgressListenersInitialized) return;
  goalProgressListenersInitialized = true;

  simEvents.on('conversation:ended', (payload: {
    agentId: number;
    perpetratorId?: number | null;
    sentiment?: number;
    partnerState?: string | null;
  }) => {
    const otherId = payload.perpetratorId;
    if (otherId == null || otherId === payload.agentId) return;
    const sentiment = payload.sentiment ?? 0;
    // Intensity: a glowing chat (0.6) counts 1.5x a merely pleasant one (0.2), and the
    // same for a bitter one. goalProgressGain clamps it. A kind word to someone who is
    // down (both tiers pass the partner's distress state) is comfort — what a protect or
    // comfort goal is waiting for.
    if (sentiment > WARM_CHAT) {
      const outcome = payload.partnerState && DISTRESS.has(payload.partnerState) ? 'comforted' : 'warm_chat';
      recordGoalOutcome(payload.agentId, otherId, outcome, sentiment / 0.4);
    } else if (sentiment < HOSTILE_CHAT) recordGoalOutcome(payload.agentId, otherId, 'hostile_chat', -sentiment / 0.4);
  });

  // The drama beats: `insult` / `confrontation` / `flirt` carry the doer as perpetrator.
  simEvents.on('interaction:completed', (payload: { perpetratorId?: number; victimId?: number; action?: string }) => {
    if (payload.perpetratorId == null || payload.victimId == null) return;
    const outcome = INTERACTION_OUTCOMES[payload.action ?? ''];
    if (outcome) recordGoalOutcome(payload.perpetratorId, payload.victimId, outcome);
  });

  simEvents.on('gift:given', (payload: { giverId: number; receiverId: number }) => {
    recordGoalOutcome(payload.giverId, payload.receiverId, 'gift_given');
  });

  simEvents.on('economy:theft_success', (payload: { thief?: number; victim?: number }) => {
    if (payload.thief != null && payload.victim != null) recordGoalOutcome(payload.thief, payload.victim, 'stole_from_target');
  });
}

/** Exported for tests: register the listeners without running a whole goals tick. */
export const initGoalProgressListenersForTest = initGoalProgressListeners;

/** The partner states conversations.ts reports as `partnerState`. */
const DISTRESS = new Set(['lonely', 'heartbroken', 'depressed', 'stressed', 'grieving', 'in_debt']);

const INTERACTION_OUTCOMES: Record<string, GoalOutcome> = {
  insult: 'insulted_target',
  confrontation: 'fought_target',
  flirt: 'flirt',
};

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export function goalsTick(): void {
  // Register the outcome listeners on the first tick
  initGoalProgressListeners();
  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const world = db.select().from(worldState).limit(1).all()[0];
  const nowMinutes = world?.time ? gameMinutes(world.time) : 0;
  const tickSpeed = world?.tick_speed ?? 1;
  const isDayChange = world?.pending_transitions?.some(
    (t: any) => t.type === 'day_changed'
  ) ?? false;

  // Pre-load shared tables once per tick to avoid per-agent/per-trigger queries
  const allActiveKnowledge = db.select().from(shared_knowledge)
    .where(eq(shared_knowledge.is_active, true))
    .all();
  const allRelationships = db.select().from(relationships).all();
  // Live view of agent_states for the triggers and passive progress (it re-reads
  // only after a write, e.g. a cascade rule reacting to 'goal:created').
  const stateRows = new AgentStateRowsSnapshot();
  // Abandonment deliberately judges every agent against the states as the phase
  // began; `all()` returns the array of this read, which later refreshes of the
  // snapshot replace rather than mutate.
  const allAgentStates = stateRows.all();
  // Every goal this phase can look at — the active ones and those recent
  // enough to block a re-trigger — re-read only after a goals write (a cascade
  // rule creates goals from inside this phase's events). Two queries per agent
  // before. Filtered in SQL because finished goals are never deleted and the
  // table only grows; `>=` keeps it a superset of evaluateTriggers' `<` window.
  const goalRows = new RowsByAgentSnapshot<GoalRow>(
    () => getTableWriteVersion('goals'),
    () => db.select().from(goals)
      .where(or(eq(goals.status, 'active'), gte(goals.created_at, nowMinutes - RECREATE_COOLDOWN_MINUTES)))
      .orderBy(goals.id)
      .all(),
    (row) => row.agent_id,
  );

  for (const agent of activeAgents) {
    // Copies: abandonment writes the new status onto the goal object, and the
    // snapshot's rows are shared. Rowid order, as idx_goals_agent_status gave.
    const agentGoals = goalRows.forAgent(agent.id)
      .filter(g => g.status === 'active')
      .map(g => ({ ...g }));

    // 1. Morning LLM review (on day change only, async fire-and-forget)
    if (isDayChange) {
      void goalReviewer.review(agent.id, nowMinutes, world?.time?.day ?? 1);
    }

    // 2. Evaluate abandonment on existing goals (rule-based)
    for (const goal of agentGoals) {
      evaluateAbandonment(agent, goal, nowMinutes, allAgentStates, tickSpeed);
    }

    // 3. Evaluate passive goal progress
    for (const goal of agentGoals) {
      if (goal.status === 'active') {
        evaluatePassiveProgress(agent, goal, nowMinutes, stateRows);
      }
    }

    // 4. Check reactive triggers for new goals
    evaluateTriggers(agent, nowMinutes, allActiveKnowledge, allRelationships, stateRows, goalRows);

    // 5. Pivot evaluation (async fire-and-forget)
    void pivotEvaluator.evaluate(agent.id, nowMinutes);
  }
}
