/**
 * Life Events Engine
 *
 * Data-driven registry for major life events (death, future: marriage, birth).
 * Triggers are functions checked each tick. Effects are a pipeline.
 * To add a new death cause: add one entry to DEATH_TRIGGERS.
 * To add a new death effect: add one entry to DEATH_EFFECTS.
 */

import { db } from '../db';
import { agents, economy, locations, relationships, worldState, worldEvents, activityLog, agentStates, memories, conversations, conversationQueue } from '../db/schema';
import { eq, and, or } from 'drizzle-orm';
import { createFact } from './gossip';
import { createObservationMemory } from '../ai/memories';
import { taskRunner } from '../ai/taskRunner';
import { emitter } from '../engine/emitter';

// --- Types ---

export interface AgentDeathContext {
  agent: { id: number; name: string; age: number };
  currentTick: number;
  season: string;
  hungerZeroTicks: number;
  activeStates: Array<{ type: string; started_at: number; severity: number; metadata: any }>;
  currentAction: string;
  job: string;
  mood: number;
  hunger: number;
  energy: number;
  isOutdoors: boolean;
}

interface DeathTrigger {
  type: string;
  description: string;
  priority: number;
  check: (ctx: AgentDeathContext) => boolean;
}

interface DeathEffectContext {
  agentId: number;
  agentName: string;
  cause: string;
  causeDescription: string;
  currentTick: number;
}

interface DeathEffect {
  name: string;
  execute: (ctx: DeathEffectContext) => void;
}

// --- Hunger tracking (exported for needs.ts to update) ---

export const hungerZeroTicks = new Map<number, number>();

export function updateHungerTracking(agentId: number, hunger: number): void {
  if (hunger <= 0) {
    hungerZeroTicks.set(agentId, (hungerZeroTicks.get(agentId) ?? 0) + 1);
  } else {
    hungerZeroTicks.delete(agentId);
  }
}

// --- Death Triggers Registry ---

const DEATH_TRIGGERS: DeathTrigger[] = [
  {
    type: 'starvation',
    description: 'Starved — hunger at 0 for 3+ days',
    priority: 1,
    check: (ctx) => ctx.hungerZeroTicks >= 4320,
  },
  {
    type: 'untreated_sickness',
    description: 'Died of untreated illness',
    priority: 2,
    check: (ctx) => {
      const sickState = ctx.activeStates.find(s => s.type === 'sick');
      return sickState != null && (ctx.currentTick - sickState.started_at) > 7200;
    },
  },
  {
    type: 'alcoholism',
    description: 'Died from chronic alcohol abuse',
    priority: 3,
    check: (ctx) => {
      const alcState = ctx.activeStates.find(s => s.type === 'alcoholic');
      if (!alcState) return false;
      const meta = alcState.metadata as any;
      return meta?.stage === 3 && (ctx.currentTick - alcState.started_at) > 10080;
    },
  },
  {
    type: 'old_age',
    description: 'Died of natural causes',
    priority: 4,
    check: (ctx) => {
      const simAge = ctx.agent.age + Math.floor(ctx.currentTick / 1440);
      if (simAge < 80) return false;
      return Math.random() < 0.0001 * (simAge - 80);
    },
  },
  {
    type: 'accident',
    description: 'Died in a workplace accident',
    priority: 5,
    check: (ctx) => {
      if (ctx.currentAction !== 'working') return false;
      const riskyJobs = ['farmer', 'farmhand', 'handyperson'];
      if (!riskyJobs.includes(ctx.job)) return false;
      return Math.random() < 0.00005;
    },
  },
];

// --- Death Effects Pipeline ---

function deactivateAgent(ctx: DeathEffectContext): void {
  db.update(agents).set({
    is_active: false,
    current_action: { type: 'dead' },
    current_destination: null,
    current_path: null,
    action_queue: [],
  }).where(eq(agents.id, ctx.agentId)).run();

  // Remove from any location occupants
  const allLocs = db.select().from(locations).all();
  for (const loc of allLocs) {
    const occupants = loc.current_occupants as number[];
    if (occupants.includes(ctx.agentId)) {
      db.update(locations).set({
        current_occupants: occupants.filter(id => id !== ctx.agentId),
      }).where(eq(locations.id, loc.id)).run();
    }
  }

  // Clear all active states
  db.delete(agentStates).where(eq(agentStates.agent_id, ctx.agentId)).run();

  // End any active conversations the deceased was participating in
  const activeConvos = db.select().from(conversations)
    .where(eq(conversations.status, 'active')).all();
  for (const convo of activeConvos) {
    const participants = convo.participants as number[];
    if (!participants.includes(ctx.agentId)) continue;
    db.update(conversations).set({ status: 'ended', ended_at: Date.now() })
      .where(eq(conversations.id, convo.id)).run();
    // Reset any surviving participants who were set to 'talking'
    for (const pid of participants) {
      if (pid === ctx.agentId) continue;
      const other = db.select({ current_action: agents.current_action, is_active: agents.is_active })
        .from(agents).where(eq(agents.id, pid)).get();
      if (other?.is_active && (other.current_action as any)?.type === 'talking') {
        db.update(agents).set({ current_action: { type: 'idle' }, action_duration: null })
          .where(eq(agents.id, pid)).run();
      }
    }
  }

  // Remove the deceased from any pending conversation queue entries
  const queueEntries = db.select().from(conversationQueue).all();
  for (const entry of queueEntries) {
    if ((entry.participants as number[]).includes(ctx.agentId)) {
      db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
    }
  }
}

function createDeathFact(ctx: DeathEffectContext): void {
  // Note: query runs after deactivateAgent, so is_active = false for the deceased.
  // We seed knownBy with all currently living agents only.
  const livingAgentIds = db.select({ id: agents.id }).from(agents)
    .where(eq(agents.is_active, true)).all().map(a => a.id);
  createFact('death', ctx.agentId, null, 3, livingAgentIds, 'event', {
    detail: ctx.causeDescription,
  });
}

function triggerGrieving(ctx: DeathEffectContext): void {
  const rels = db.select().from(relationships).where(
    or(eq(relationships.agent_a, ctx.agentId), eq(relationships.agent_b, ctx.agentId))
  ).all();

  for (const rel of rels) {
    const otherId = rel.agent_a === ctx.agentId ? rel.agent_b : rel.agent_a;
    const isA = rel.agent_a === otherId;
    const friendship = isA ? rel.friendship_ab : rel.friendship_ba;

    if (friendship <= 50) continue;

    // Check if agent is still active
    const other = db.select({ is_active: agents.is_active }).from(agents).where(eq(agents.id, otherId)).get();
    if (!other?.is_active) continue;

    const severity = Math.min(1.0, (friendship - 50) / 50);
    const duration = Math.floor(2880 + (friendship - 50) * 100);

    db.insert(agentStates).values({
      agent_id: otherId,
      type: 'grieving',
      severity,
      started_at: ctx.currentTick,
      duration,
      target_agent_id: ctx.agentId,
      source: `event:death_of_${ctx.agentId}`,
      metadata: null,
    }).run();
  }
}

function processInheritance(ctx: DeathEffectContext): void {
  const deceasedEcon = db.select().from(economy).where(eq(economy.agent_id, ctx.agentId)).get();
  if (!deceasedEcon) return;
  if (deceasedEcon.money <= 0 && (deceasedEcon.inventory as any[]).length === 0) return;

  // Find closest living friend
  const rels = db.select().from(relationships).where(
    or(eq(relationships.agent_a, ctx.agentId), eq(relationships.agent_b, ctx.agentId))
  ).all();

  let bestFriend: { id: number; friendship: number } | null = null;
  for (const rel of rels) {
    const otherId = rel.agent_a === ctx.agentId ? rel.agent_b : rel.agent_a;
    const isA = rel.agent_a === otherId;
    const friendship = isA ? rel.friendship_ab : rel.friendship_ba;
    const other = db.select({ is_active: agents.is_active }).from(agents).where(eq(agents.id, otherId)).get();
    if (!other?.is_active) continue;
    if (friendship > 30 && (!bestFriend || friendship > bestFriend.friendship)) {
      bestFriend = { id: otherId, friendship };
    }
  }

  if (bestFriend) {
    const inheritorEcon = db.select().from(economy).where(eq(economy.agent_id, bestFriend.id)).get();
    if (inheritorEcon) {
      // Transfer money
      db.update(economy).set({ money: inheritorEcon.money + deceasedEcon.money })
        .where(eq(economy.agent_id, bestFriend.id)).run();
      // Transfer inventory
      let inv = inheritorEcon.inventory as any[];
      for (const item of deceasedEcon.inventory as any[]) {
        const existing = inv.find((i: any) => i.itemId === item.itemId);
        if (existing) {
          inv = inv.map((i: any) => i.itemId === item.itemId ? { ...i, quantity: i.quantity + item.quantity } : i);
        } else {
          inv = [...inv, item];
        }
      }
      db.update(economy).set({ inventory: inv }).where(eq(economy.agent_id, bestFriend.id)).run();

      db.insert(activityLog).values({
        type: 'economy',
        message: `${ctx.agentName}'s possessions were inherited by ${db.select({ name: agents.name }).from(agents).where(eq(agents.id, bestFriend.id)).get()?.name ?? 'someone'}.`,
        agent_ids: [ctx.agentId, bestFriend.id],
        timestamp: ctx.currentTick,
        real_timestamp: Date.now(),
      }).run();
    }
  } else {
    // No inheritor — money goes to tax pool
    const world = db.select().from(worldState).get();
    if (world) {
      db.update(worldState).set({ tax_pool: world.tax_pool + deceasedEcon.money })
        .where(eq(worldState.id, world.id)).run();
    }
  }

  // Zero out deceased economy
  db.update(economy).set({ money: 0, inventory: [] }).where(eq(economy.agent_id, ctx.agentId)).run();
}

function handleJobVacancy(ctx: DeathEffectContext): void {
  const ownedLocations = db.select().from(locations).all()
    .filter(l => l.owner === ctx.agentId);

  for (const loc of ownedLocations) {
    // Find inheritor (same as inheritance logic — closest friend)
    const rels = db.select().from(relationships).where(
      or(eq(relationships.agent_a, ctx.agentId), eq(relationships.agent_b, ctx.agentId))
    ).all();

    let bestFriend: number | null = null;
    let bestFriendship = 0;
    for (const rel of rels) {
      const otherId = rel.agent_a === ctx.agentId ? rel.agent_b : rel.agent_a;
      const isA = rel.agent_a === otherId;
      const friendship = isA ? rel.friendship_ab : rel.friendship_ba;
      const other = db.select({ is_active: agents.is_active }).from(agents).where(eq(agents.id, otherId)).get();
      if (other?.is_active && friendship > bestFriendship) {
        bestFriend = otherId;
        bestFriendship = friendship;
      }
    }

    db.update(locations).set({ owner: bestFriend }).where(eq(locations.id, loc.id)).run();
  }
}

function createFuneralEvent(ctx: DeathEffectContext): void {
  db.insert(worldEvents).values({
    type: 'funeral',
    name: `Funeral of ${ctx.agentName}`,
    description: `The town gathers to mourn ${ctx.agentName}. ${ctx.causeDescription}.`,
    started_at: ctx.currentTick,
    duration: 240, // 4 hours
    effects: { social_boost: 15, mood_outdoor: -5 },
    location_id: null,
    triggered_by: `death:${ctx.agentId}`,
    is_active: true,
  }).run();
}

function createMemorialMemories(ctx: DeathEffectContext): void {
  const activeAgents = db.select({ id: agents.id, name: agents.name }).from(agents)
    .where(eq(agents.is_active, true)).all();

  for (const other of activeAgents) {
    // Get friendship for personalized memory
    const rel = db.select().from(relationships).where(
      or(
        and(eq(relationships.agent_a, Math.min(other.id, ctx.agentId)), eq(relationships.agent_b, Math.max(other.id, ctx.agentId))),
      )
    ).get();

    const friendship = rel
      ? (other.id < ctx.agentId ? rel.friendship_ab : rel.friendship_ba)
      : 0;

    let reflection: string;
    if (friendship > 70) {
      reflection = `${ctx.agentName} is gone. I've lost one of my closest friends. Nothing feels the same.`;
    } else if (friendship > 40) {
      reflection = `${ctx.agentName} passed away. We weren't the closest, but I'll miss seeing them around town.`;
    } else if (friendship > 0) {
      reflection = `${ctx.agentName} died. ${ctx.causeDescription}. Life in Little Life feels a bit emptier.`;
    } else {
      reflection = `I heard ${ctx.agentName} died. ${ctx.causeDescription}. Strange how quickly things change.`;
    }

    const importance = friendship > 70 ? 8 : friendship > 40 ? 6 : 4;
    const valence = friendship > 40 ? -0.7 : -0.3;

    const memData = createObservationMemory(
      other.id, reflection, [ctx.agentId], null, importance, valence, ctx.currentTick,
    );
    const memResult = db.insert(memories).values(memData).returning({ id: memories.id }).get();
    taskRunner.generateEmbedding(memResult.id, memData.content);
  }
}

function logDeath(ctx: DeathEffectContext): void {
  db.insert(activityLog).values({
    type: 'drama',
    message: `${ctx.agentName} has died. ${ctx.causeDescription}. The town mourns.`,
    agent_ids: [ctx.agentId],
    timestamp: ctx.currentTick,
    real_timestamp: Date.now(),
  }).run();
  emitter.markDirty('agents.all');
  emitter.markDirty('activity.all');
}

// --- Pipeline ---

const DEATH_EFFECTS: DeathEffect[] = [
  { name: 'deactivate',        execute: deactivateAgent },
  { name: 'create_death_fact', execute: createDeathFact },
  { name: 'trigger_grieving',  execute: triggerGrieving },
  { name: 'inheritance',       execute: processInheritance },
  { name: 'job_vacancy',       execute: handleJobVacancy },
  { name: 'funeral_event',     execute: createFuneralEvent },
  { name: 'memorial_memories', execute: createMemorialMemories },
  { name: 'activity_log',      execute: logDeath },
];

// --- Public API ---

export function checkDeathTriggers(
  agent: { id: number; name: string; age: number },
  currentTick: number,
  statesArr: Array<{ type: string; started_at: number; severity: number; metadata: any }>,
  needsData: { mood: number; hunger: number; energy: number },
  job: string,
  currentAction: string,
  isOutdoors: boolean,
  season: string,
): string | null {
  const ctx: AgentDeathContext = {
    agent,
    currentTick,
    season,
    hungerZeroTicks: hungerZeroTicks.get(agent.id) ?? 0,
    activeStates: statesArr,
    currentAction,
    job,
    mood: needsData.mood,
    hunger: needsData.hunger,
    energy: needsData.energy,
    isOutdoors,
  };

  // Check triggers in priority order
  const sorted = [...DEATH_TRIGGERS].sort((a, b) => a.priority - b.priority);
  for (const trigger of sorted) {
    if (trigger.check(ctx)) {
      return trigger.type;
    }
  }
  return null;
}

export function processAgentDeath(agentId: number, agentName: string, cause: string, currentTick: number): void {
  const trigger = DEATH_TRIGGERS.find(t => t.type === cause);
  const causeDescription = trigger?.description ?? cause;

  const ctx: DeathEffectContext = {
    agentId,
    agentName,
    cause,
    causeDescription,
    currentTick,
  };

  for (const effect of DEATH_EFFECTS) {
    try {
      effect.execute(ctx);
    } catch (err) {
      console.error(`Death effect '${effect.name}' failed for agent ${agentName}:`, err);
    }
  }
}
