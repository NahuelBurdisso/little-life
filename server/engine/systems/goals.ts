import { db } from '../../db';
import {
  agents,
  goals,
  aspirations,
  agentStates,
  shared_knowledge,
  economy,
  relationships,
  worldState,
} from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { GOAL_REGISTRY, GOAL_TRIGGER_REGISTRY } from '../../data/goalRegistry';
import { MAX_GOALS_PER_AGENT } from '../../lib/interactionConstants';
import { getEffectivePersonality } from '../../lib/states';
import { logActivity } from '../../lib/activityLogger';
import type { GoalTriggerDef } from '../../lib/interactionConstants';
import { simEvents } from '../../lib/simEvents';
import { goalReviewer, pivotEvaluator } from '../../lib/goals/instance';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentTick(): number {
  const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  return (world?.time as any)?.totalTicks ?? 0;
}

function compareOp(actual: number, op: string, value: number): boolean {
  switch (op) {
    case '>':  return actual > value;
    case '<':  return actual < value;
    case '>=': return actual >= value;
    case '<=': return actual <= value;
    case '==': return actual === value;
    default:   return false;
  }
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

function getRelationship(agentA: number, agentB: number) {
  const a = Math.min(agentA, agentB);
  const b = Math.max(agentA, agentB);
  return db.select().from(relationships)
    .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
    .get();
}

function getRelField(rel: any, field: string, isA: boolean): number {
  switch (field) {
    case 'friendship': return isA ? rel.friendship_ab : rel.friendship_ba;
    case 'romance':    return isA ? rel.romance_ab    : rel.romance_ba;
    case 'trust':      return isA ? rel.trust_ab      : rel.trust_ba;
    case 'familiarity': return rel.familiarity;
    default:           return 0;
  }
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
): number | null | false {
  const cond = trigger.condition;

  switch (cond.type) {
    case 'state_gained': {
      const states = db.select().from(agentStates)
        .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, cond.state!)))
        .all();
      if (states.length === 0) return false;
      if (cond.has_target) {
        const targetState = states.find(s => s.target_agent_id != null);
        return targetState ? targetState.target_agent_id! : false;
      }
      return null;
    }

    case 'fact_learned': {
      const relevantFacts = cachedKnowledge
        .filter(f => {
          if (f.type !== cond.fact_type!) return false;
          const knownBy = f.known_by as number[];
          if (!knownBy.includes(agent.id)) return false;
          if (cond.is_victim && f.target_id !== agent.id) return false;
          if (cond.involves_partner) {
            const a = Math.min(agent.id, f.subject_id);
            const b = Math.max(agent.id, f.subject_id);
            const rel = cachedRelationships.find(r => r.agent_a === a && r.agent_b === b);
            if (!rel || !(rel.tags as string[])?.includes('partner')) return false;
          }
          return true;
        });
      if (relevantFacts.length === 0) return false;
      return relevantFacts[0].subject_id;
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
  currentTick: number,
  cachedKnowledge: (typeof shared_knowledge.$inferSelect)[],
  cachedRelationships: (typeof relationships.$inferSelect)[],
): void {
  const personality = getEffectivePersonality(agent.id);
  const activeGoals = db.select().from(goals)
    .where(and(eq(goals.agent_id, agent.id), eq(goals.status, 'active')))
    .all();

  // Also load recently abandoned/completed goals to prevent create→abandon spam.
  // Without this, a persistent trigger (e.g., infatuated state) creates a goal every tick
  // that gets immediately abandoned, flooding the activity log.
  const COOLDOWN_TICKS = 720; // ~12 game hours — prevents goal→abandon spam for persistent triggers
  const recentGoals = db.select().from(goals)
    .where(eq(goals.agent_id, agent.id))
    .all()
    .filter(g => g.status !== 'active' && (currentTick - g.created_at) < COOLDOWN_TICKS);

  for (const trigger of GOAL_TRIGGER_REGISTRY) {
    if (activeGoals.length >= MAX_GOALS_PER_AGENT) break;

    if (trigger.personality_gate && !checkPersonalityGate(personality, trigger.personality_gate)) continue;

    const targetId = checkTriggerCondition(trigger, agent, currentTick, cachedKnowledge, cachedRelationships);
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
      created_at: currentTick,
    }).run();

    activeGoals.push({ type: trigger.generates, target_id: targetId } as any);

    simEvents.emit('goal:created', { agentId: agent.id, goalType: trigger.generates, targetId: targetId });

    logActivity({
      type: 'system',
      initiator: agent.id,
      templateData: { message: `${agent.name} set a new goal: ${trigger.generates}` },
    });
  }
}

// ─── evaluateAbandonment ──────────────────────────────────────────────────────

function evaluateAbandonment(
  agent: any,
  goal: any,
  currentTick: number,
  allAgentStates: (typeof agentStates.$inferSelect)[],
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
        shouldAbandon = rule.auto === true || (rule.chance != null && Math.random() < rule.chance);
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
            shouldAbandon = rule.auto === true || (rule.chance != null && Math.random() < rule.chance);
          }
        }
      }
    } else if (rule.condition.startsWith('ticks_elapsed')) {
      const maxTicks = parseInt(rule.condition.split('> ')[1]);
      if (currentTick - goal.created_at > maxTicks) {
        shouldAbandon = rule.auto === true || (rule.chance != null && Math.random() < rule.chance);
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
      const newStatus = rule.becomes ?? 'abandoned';
      db.update(goals).set({ status: newStatus }).where(eq(goals.id, goal.id)).run();
      goal.status = newStatus;

      if (newStatus === 'completed') {
        simEvents.emit('goal:completed', { agentId: agent.id, goalType: goal.type, perpetratorId: goal.target_id ?? undefined, victimId: agent.id });
      } else {
        simEvents.emit('goal:abandoned', { agentId: agent.id, goalType: goal.type, perpetratorId: goal.target_id ?? undefined });
      }

      logActivity({
        type: newStatus === 'completed' ? 'goal_completed' : 'goal_abandoned',
        initiator: agent.id,
        templateData: { agent: agent.name, goal_description: goal.type },
      });
      break;
    }
  }
}

// ─── evaluatePassiveProgress ──────────────────────────────────────────────────

function evaluatePassiveProgress(agent: any, goal: any, _currentTick: number): void {
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
      const hasState = db.select().from(agentStates)
        .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, stateType)))
        .all();
      conditionMet = hasState.length === 0;
    }

    if (conditionMet) {
      const newProgress = Math.min(def.completion_at, goal.progress + pe.progress);
      if (newProgress >= def.completion_at) {
        db.update(goals)
          .set({ progress: newProgress, status: 'completed' })
          .where(eq(goals.id, goal.id))
          .run();
        simEvents.emit('goal:completed', { agentId: agent.id, goalType: goal.type, perpetratorId: goal.target_id ?? undefined, victimId: agent.id });
        logActivity({
          type: 'goal_completed',
          initiator: agent.id,
          templateData: { agent: agent.name, goal_description: goal.type },
        });
      } else {
        db.update(goals).set({ progress: newProgress }).where(eq(goals.id, goal.id)).run();
      }
    }
  }
}

// ─── Conversation-driven goal progress ────────────────────────────────────────

let goalConvoListenerInitialized = false;

function initGoalConversationListener(): void {
  if (goalConvoListenerInitialized) return;
  goalConvoListenerInitialized = true;

  simEvents.on('conversation:ended', (payload: {
    agentId: number;
    perpetratorId?: number | null;
    sentiment?: number;
    turns?: number;
  }) => {
    const otherId = payload.perpetratorId;
    if (!otherId || otherId === payload.agentId) return;
    const sentiment = payload.sentiment ?? 0;
    if (sentiment < -0.5) return; // negative conversations don't help goals

    // Find active goals targeting this conversation partner
    const agentGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, payload.agentId), eq(goals.status, 'active')))
      .all();

    for (const goal of agentGoals) {
      if (goal.target_id !== otherId) continue;
      // Social goals advance through positive conversations
      const progressGain = Math.max(0.02, sentiment * 0.05);
      const newProgress = Math.min(1.0, (goal.progress ?? 0) + progressGain);
      db.update(goals).set({ progress: newProgress }).where(eq(goals.id, goal.id)).run();
    }
  });
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export function goalsTick(): void {
  // Initialize conversation listener on first tick
  initGoalConversationListener();
  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const currentTick = getCurrentTick();
  const world = db.select().from(worldState).limit(1).all()[0];
  const isDayChange = world?.pending_transitions?.some(
    (t: any) => t.type === 'day_changed'
  ) ?? false;

  // Pre-load shared tables once per tick to avoid per-agent/per-trigger queries
  const allActiveKnowledge = db.select().from(shared_knowledge)
    .where(eq(shared_knowledge.is_active, true))
    .all();
  const allRelationships = db.select().from(relationships).all();
  const allAgentStates = db.select().from(agentStates).all();

  for (const agent of activeAgents) {
    const agentGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, agent.id), eq(goals.status, 'active')))
      .all();

    // 1. Morning LLM review (on day change only, async fire-and-forget)
    if (isDayChange) {
      void goalReviewer.review(agent.id, currentTick, world?.time?.day ?? 1);
    }

    // 2. Evaluate abandonment on existing goals (rule-based)
    for (const goal of agentGoals) {
      evaluateAbandonment(agent, goal, currentTick, allAgentStates);
    }

    // 3. Evaluate passive goal progress
    for (const goal of agentGoals) {
      if (goal.status === 'active') {
        evaluatePassiveProgress(agent, goal, currentTick);
      }
    }

    // 4. Check reactive triggers for new goals
    evaluateTriggers(agent, currentTick, allActiveKnowledge, allRelationships);

    // 5. Pivot evaluation (async fire-and-forget)
    void pivotEvaluator.evaluate(agent.id, currentTick);
  }
}
