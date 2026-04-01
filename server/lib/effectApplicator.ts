import { db } from '../db';
import {
  relationshipEvents,
  agentStates,
  needs as needsTable,
  economyTransactions,
  economy,
  memories,
  goals,
} from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import type { EffectDef, AwarenessLevel } from './interactionConstants';
import { AWARENESS_TEMPLATES } from './interactionConstants';
import { createFact } from './gossip';

// ─── Context / Witness types ──────────────────────────────────────────────────

interface InteractionContext {
  initiatorId: number;
  initiatorName: string;
  targetId: number;
  targetName: string;
  locationId: number | null;
  locationType: string;
  interactionType: string;
  goalId: number | null;
  currentTick: number;
  severity: number;
  narration: string; // template text for memories
}

interface WitnessInfo {
  agent_id: number;
  agent_name: string;
  awareness: AwarenessLevel;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function applyEffects(
  effects: EffectDef[],
  ctx: InteractionContext,
  witnesses: WitnessInfo[],
): void {
  for (const effect of effects) {
    applyEffect(effect, ctx);
  }

  // Create memories for participants
  createParticipantMemory(ctx.initiatorId, ctx, 'initiator');
  createParticipantMemory(ctx.targetId, ctx, 'target');

  // Create memories for witnesses
  for (const w of witnesses) {
    createWitnessMemory(w, ctx);
  }
}

// ─── Effect router ────────────────────────────────────────────────────────────

function applyEffect(effect: EffectDef, ctx: InteractionContext): void {
  switch (effect.system) {
    case 'relationship':
      applyRelationshipEffect(effect, ctx);
      break;
    case 'state':
      applyStateEffect(effect, ctx);
      break;
    case 'needs':
      applyNeedsEffect(effect, ctx);
      break;
    case 'fact':
      applyFactEffect(effect, ctx);
      break;
    case 'economy':
      applyEconomyEffect(effect, ctx);
      break;
    case 'goal':
      applyGoalEffect(effect, ctx);
      break;
  }
}

// ─── Relationship effect ──────────────────────────────────────────────────────

function applyRelationshipEffect(effect: EffectDef, ctx: InteractionContext): void {
  const a = Math.min(ctx.initiatorId, ctx.targetId);
  const b = Math.max(ctx.initiatorId, ctx.targetId);
  const isInitiatorA = ctx.initiatorId === a;
  const delta = (effect.delta ?? 0) * ctx.severity;

  // Start with all deltas zeroed out
  let friendship_delta_ab = 0;
  let friendship_delta_ba = 0;
  let romance_delta_ab = 0;
  let romance_delta_ba = 0;
  let trust_delta_ab = 0;
  let trust_delta_ba = 0;

  const field = effect.field ?? 'friendship';
  const targets = effect.target ?? 'both';

  // Helper to set the right directional delta
  function setDelta(forInitiator: boolean): void {
    // From initiator's side: ab when initiatorId < targetId, else ba
    const isAB = forInitiator ? isInitiatorA : !isInitiatorA;
    if (field === 'romance') {
      if (isAB) romance_delta_ab = delta; else romance_delta_ba = delta;
    } else if (field === 'trust') {
      if (isAB) trust_delta_ab = delta; else trust_delta_ba = delta;
    } else {
      // default: friendship
      if (isAB) friendship_delta_ab = delta; else friendship_delta_ba = delta;
    }
  }

  if (targets === 'both' || targets === 'initiator') setDelta(true);
  if (targets === 'both' || targets === 'target') setDelta(false);

  db.insert(relationshipEvents).values({
    agent_a: a,
    agent_b: b,
    event_type: ctx.interactionType,
    description: `${ctx.interactionType} interaction`,
    sentiment: delta > 0 ? Math.min(1, delta / 30) : Math.max(-1, delta / 30),
    processed: false,
    timestamp: ctx.currentTick,
    friendship_delta_ab,
    friendship_delta_ba,
    romance_delta_ab,
    romance_delta_ba,
    trust_delta_ab,
    trust_delta_ba,
  }).run();
}

// ─── State effect ─────────────────────────────────────────────────────────────

function applyStateEffect(effect: EffectDef, ctx: InteractionContext): void {
  const stateType = effect.trigger ?? 'angry';
  const targets = effect.target ?? 'target';
  const agentIds =
    targets === 'both'
      ? [ctx.initiatorId, ctx.targetId]
      : targets === 'initiator'
        ? [ctx.initiatorId]
        : [ctx.targetId];

  for (const agentId of agentIds) {
    // Skip if the agent already has this state active
    const existing = db
      .select({ id: agentStates.id })
      .from(agentStates)
      .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, stateType)))
      .get();
    if (existing) continue;

    db.insert(agentStates).values({
      agent_id: agentId,
      type: stateType,
      severity: ctx.severity,
      started_at: ctx.currentTick,
      // arrested = 8 hours (480 ticks), others = 2 hours (120 ticks)
      duration: stateType === 'arrested' ? 480 : 120,
      target_agent_id: agentId === ctx.initiatorId ? ctx.targetId : ctx.initiatorId,
      source: 'interaction',
    }).run();
  }
}

// ─── Needs effect ─────────────────────────────────────────────────────────────

// Drizzle for SQLite does not expose sql.identifier for dynamic column names,
// so we use an explicit field mapping to stay type-safe and avoid raw string injection.
function applyNeedsEffect(effect: EffectDef, ctx: InteractionContext): void {
  const field = effect.field ?? 'mood';
  const delta = (effect.delta ?? 0) * ctx.severity;
  const targets = effect.target ?? 'target';
  const agentIds =
    targets === 'both'
      ? [ctx.initiatorId, ctx.targetId]
      : targets === 'initiator'
        ? [ctx.initiatorId]
        : [ctx.targetId];

  // sql<number>`...` tells Drizzle the expression evaluates to a number,
  // satisfying the typed column constraint without losing the clamping logic.
  const clampedSql = (col: string) =>
    sql<number>`MAX(0, MIN(100, ${sql.raw(col)} + ${delta}))`;

  for (const agentId of agentIds) {
    switch (field) {
      case 'hunger':
        db.update(needsTable).set({ hunger: clampedSql('hunger') }).where(eq(needsTable.agent_id, agentId)).run();
        break;
      case 'energy':
        db.update(needsTable).set({ energy: clampedSql('energy') }).where(eq(needsTable.agent_id, agentId)).run();
        break;
      case 'social':
        db.update(needsTable).set({ social: clampedSql('social') }).where(eq(needsTable.agent_id, agentId)).run();
        break;
      case 'comfort':
        db.update(needsTable).set({ comfort: clampedSql('comfort') }).where(eq(needsTable.agent_id, agentId)).run();
        break;
      case 'fun':
        db.update(needsTable).set({ fun: clampedSql('fun') }).where(eq(needsTable.agent_id, agentId)).run();
        break;
      case 'stress':
        db.update(needsTable).set({ stress: clampedSql('stress') }).where(eq(needsTable.agent_id, agentId)).run();
        break;
      case 'mood':
      default:
        db.update(needsTable).set({ mood: clampedSql('mood') }).where(eq(needsTable.agent_id, agentId)).run();
        break;
    }
  }
}

// ─── Fact effect ──────────────────────────────────────────────────────────────

function applyFactEffect(effect: EffectDef, ctx: InteractionContext): void {
  const subjectId = effect.subject === 'target' ? ctx.targetId : ctx.initiatorId;
  const targetId = effect.subject === 'target' ? ctx.initiatorId : ctx.targetId;

  createFact(
    effect.type ?? ctx.interactionType,
    subjectId,
    targetId,
    effect.sensitivity ?? 1,
    [ctx.initiatorId, ctx.targetId], // initially known by participants
    'interaction',
  );
}

// ─── Economy effect ───────────────────────────────────────────────────────────

function applyEconomyEffect(effect: EffectDef, ctx: InteractionContext): void {
  if (effect.transfer) {
    // Transfer money from one agent to another
    const amount = parseEconomyAmount(effect.amount ?? '10', ctx);
    const [fromId, toId] =
      effect.transfer === 'target_to_initiator'
        ? [ctx.targetId, ctx.initiatorId]
        : [ctx.initiatorId, ctx.targetId];

    db.update(economy)
      .set({ money: sql`money - ${amount}` })
      .where(eq(economy.agent_id, fromId))
      .run();
    db.update(economy)
      .set({ money: sql`money + ${amount}` })
      .where(eq(economy.agent_id, toId))
      .run();

    db.insert(economyTransactions).values({
      from_agent: fromId,
      to_agent: toId,
      amount,
      reason: ctx.interactionType,
      location_id: ctx.locationId,
      timestamp: ctx.currentTick,
    }).run();
  } else if (effect.delta !== undefined) {
    // Flat delta applied to specified agents
    const targets = effect.target ?? 'target';
    const agentIds =
      targets === 'both'
        ? [ctx.initiatorId, ctx.targetId]
        : targets === 'initiator'
          ? [ctx.initiatorId]
          : [ctx.targetId];

    for (const agentId of agentIds) {
      db.update(economy)
        .set({ money: sql`money + ${effect.delta}` })
        .where(eq(economy.agent_id, agentId))
        .run();
    }
  }
}

function parseEconomyAmount(amountExpr: string, ctx: InteractionContext): number {
  // Plain number
  if (!isNaN(Number(amountExpr))) return Number(amountExpr);

  // "X * target.money" or "X * initiator.money"
  const mulMatch = amountExpr.match(/^([\d.]+)\s*\*\s*(target|initiator)\.money$/);
  if (mulMatch) {
    const factor = parseFloat(mulMatch[1]);
    const agentId = mulMatch[2] === 'target' ? ctx.targetId : ctx.initiatorId;
    const econ = db
      .select({ money: economy.money })
      .from(economy)
      .where(eq(economy.agent_id, agentId))
      .get();
    return Math.floor((econ?.money ?? 0) * factor);
  }

  // "min(X, initiator.money * Y)" or "min(X, target.money * Y)"
  const minMatch = amountExpr.match(
    /^min\((\d+),\s*(initiator|target)\.money\s*\*\s*([\d.]+)\)$/,
  );
  if (minMatch) {
    const cap = parseInt(minMatch[1], 10);
    const agentId = minMatch[2] === 'target' ? ctx.targetId : ctx.initiatorId;
    const factor = parseFloat(minMatch[3]);
    const econ = db
      .select({ money: economy.money })
      .from(economy)
      .where(eq(economy.agent_id, agentId))
      .get();
    return Math.min(cap, Math.floor((econ?.money ?? 0) * factor));
  }

  return 10; // fallback
}

// ─── Goal effect ──────────────────────────────────────────────────────────────

function applyGoalEffect(effect: EffectDef, ctx: InteractionContext): void {
  if (!ctx.goalId || !effect.advance) return;

  const goal = db.select().from(goals).where(eq(goals.id, ctx.goalId)).get();
  if (!goal || goal.status !== 'active') return;

  const newProgress = Math.min(1, goal.progress + effect.advance);
  if (newProgress >= 1) {
    db.update(goals)
      .set({ progress: newProgress, status: 'completed' })
      .where(eq(goals.id, ctx.goalId))
      .run();
  } else {
    db.update(goals)
      .set({ progress: newProgress })
      .where(eq(goals.id, ctx.goalId))
      .run();
  }
}

// ─── Memory creation ──────────────────────────────────────────────────────────

function createParticipantMemory(
  agentId: number,
  ctx: InteractionContext,
  role: string,
): void {
  db.insert(memories).values({
    agent_id: agentId,
    description: ctx.narration,
    type: 'interaction',
    importance: Math.round(ctx.severity * 8),
    // Initiator: slight positive (acted); target: slight negative (acted upon)
    emotional_valence: role === 'initiator' ? 0.2 : -0.2,
    depth: 0,
    created_at: ctx.currentTick,
    last_accessed: ctx.currentTick,
    metadata: {
      related_agents: [agentId === ctx.initiatorId ? ctx.targetId : ctx.initiatorId],
      location_id: ctx.locationId,
      tags: [ctx.interactionType],
    },
    is_active: 1,
    parent_ids: [],
  }).run();
}

function createWitnessMemory(witness: WitnessInfo, ctx: InteractionContext): void {
  const template = AWARENESS_TEMPLATES[witness.awareness];
  const content = template.memory_template
    .replace('{narration}', ctx.narration)
    .replace('{agent}', witness.agent_name)
    .replace('{interaction_summary}', ctx.interactionType)
    .replace('{participants}', `${ctx.initiatorName} and ${ctx.targetName}`)
    .replace('{initiator}', ctx.initiatorName)
    .replace('{target}', ctx.targetName);

  db.insert(memories).values({
    agent_id: witness.agent_id,
    description: content,
    type: 'observation',
    importance: Math.round(ctx.severity * 8 * template.importance_modifier),
    emotional_valence: 0,
    depth: 0,
    created_at: ctx.currentTick,
    last_accessed: ctx.currentTick,
    metadata: {
      related_agents: [ctx.initiatorId, ctx.targetId],
      location_id: ctx.locationId,
      tags: [ctx.interactionType, 'witnessed'],
    },
    is_active: 1,
    parent_ids: [],
  }).run();
}
