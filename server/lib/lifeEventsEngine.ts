/**
 * Life Events Engine
 *
 * Data-driven registry for major life events (death, future: marriage, birth).
 * Triggers are functions checked each tick. Effects are a pipeline.
 * To add a new death cause: add one entry to DEATH_TRIGGERS.
 * To add a new death effect: add one entry to DEATH_EFFECTS.
 */

import { graveDeathChancePerMinute } from './sickness';
import { db } from '../db';
import { agents, economy, relationships, worldState, agentStates } from '../db/schema';
import { logActivity } from './activityLogger';
import { startWorldEvent } from '../engine/systems/events';
import { eq, and, or } from 'drizzle-orm';
import { createFact } from './gossip';
import { simEvents } from './simEvents';
import { emitter } from '../engine/emitter';
import { passOwnedPlaces, retireResident } from './residents';
import { heirsOf, type HeirKind } from './heirs';
import { memoryService } from './memory/instance';
import { chancePerTick } from './gameClock';
import { numberMapToRecord, restoreIdNumberMap, type SnapshotStore } from '../engine/snapshotCodec';

// --- Types ---

export interface AgentDeathContext {
  agent: { id: number; name: string; age: number };
  /** CLOCK: GAME MINUTES, like `agentStates.started_at` (states.ts). */
  nowMinutes: number;
  /** Game minutes this tick covers: the hazards below are per game minute. */
  tickSpeed: number;
  season: string;
  /** Game minutes hunger has sat at 0 without a break. */
  hungerZeroMinutes: number;
  activeStates: ReadonlyArray<{ type: string; started_at: number; severity: number; metadata: Record<string, unknown> | null }>;
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
  /** CLOCK: GAME MINUTES — stamps the survivors' `grieving` states. */
  nowMinutes: number;
}

interface DeathEffect {
  name: string;
  execute: (ctx: DeathEffectContext) => void;
}

// --- Hunger tracking (exported for needs.ts to update) ---

// Game minutes, accumulated `tick_speed` per needsTick. It counted ticks, so at
// 4x "3 days at zero" took twelve.
export const hungerZeroMinutes = new Map<number, number>();

export function updateHungerTracking(agentId: number, hunger: number, elapsedMinutes: number): void {
  if (hunger <= 0) {
    hungerZeroMinutes.set(agentId, (hungerZeroMinutes.get(agentId) ?? 0) + elapsedMinutes);
  } else {
    hungerZeroMinutes.delete(agentId);
  }
}

/**
 * Drop per-agent hunger counters for a world replace (SQLite reuses agent ids).
 * These hold a DURATION, not a clock stamp, so they cannot go negative, and the first
 * `needsTick` deletes them anyway (a new agent starts at hunger 80). Cleared for
 * consistency, and to close the window where a death check for a reused id runs
 * before that first `needsTick`.
 */
export function clearHungerTracking(): void {
  hungerZeroMinutes.clear();
}

/**
 * Checkpoint of the starvation counters (server/engine/simSnapshots.ts). The
 * death trigger needs three game days at zero hunger; without this a restart
 * handed every starving agent a fresh three days. Shape: { [agentId]: minutes }.
 */
export const hungerSnapshotStore: SnapshotStore = {
  key: 'hungerZero',
  version: 1,
  serialize: () => numberMapToRecord(hungerZeroMinutes),
  restore: (data) => restoreIdNumberMap(hungerZeroMinutes, data),
};

// --- Death Triggers Registry ---

const DEATH_TRIGGERS: DeathTrigger[] = [
  {
    type: 'starvation',
    description: 'Starved — hunger at 0 for 3+ days',
    priority: 1,
    check: (ctx) => ctx.hungerZeroMinutes >= 4320,
  },
  {
    type: 'untreated_sickness',
    description: 'Died of untreated illness',
    priority: 2,
    check: (ctx) => {
      const sickState = ctx.activeStates.find(s => s.type === 'sick');
      if (sickState == null) return false;
      // The old rule alone could never fire: a `sick` state lasts 6-24 game hours.
      // Kept for an illness that turns for the worse again and again.
      if (ctx.nowMinutes - sickState.started_at > 7200) return true;
      // Grave (two turns for the worse) and nobody treating it: lib/sickness.ts.
      const perMinute = graveDeathChancePerMinute(sickState, ctx.nowMinutes);
      return perMinute > 0 && Math.random() < chancePerTick(perMinute, ctx.tickSpeed);
    },
  },
  {
    type: 'alcoholism',
    description: 'Died from chronic alcohol abuse',
    priority: 3,
    check: (ctx) => {
      const alcState = ctx.activeStates.find(s => s.type === 'alcoholic');
      if (!alcState) return false;
      return alcState.metadata?.stage === 3 && (ctx.nowMinutes - alcState.started_at) > 10080;
    },
  },
  {
    type: 'old_age',
    description: 'Died of natural causes',
    priority: 4,
    check: (ctx) => {
      // `agents.age` is already the sim age: agingEngine adds a year on each
      // birthday (a game year = 4 seasons of SEASON_LENGTH_DAYS). This used to add
      // the absolute game DAY to it as if days were years, so everyone past day
      // ~50 counted as 80+ and became eligible for old age.
      const simAge = ctx.agent.age;
      if (simAge < 80) return false;
      // Per game minute, rolled per tick: a straight per-tick roll made the
      // elderly live four times as many game days at 4x.
      return Math.random() < chancePerTick(0.0001 * (simAge - 80), ctx.tickSpeed);
    },
  },
  {
    type: 'accident',
    description: 'Died in a workplace accident',
    priority: 5,
    check: (ctx) => {
      const perMinute = accidentChancePerMinute(ctx);
      return perMinute > 0 && Math.random() < chancePerTick(perMinute, ctx.tickSpeed);
    },
  },
];

/**
 * Workplace-accident hazard (E7).
 *
 * It was a flat 0.005% per game minute at work for three jobs. Per shift that
 * is small, but it is the *only* death the default town can hit in its first
 * weeks, it only ever hits the farm and the workshop, and it compounds: three
 * risky workers on 8-9 h shifts is ~7% a day, a coin flip within the first ten
 * days, one funeral every ~2 weeks thereafter. James O'Brien, the farmhand with
 * the most farm minutes, kept being the one. A death should be a dramatic turn
 * the story can point at, not background attrition of one trade.
 *
 * So the base rate is ~8x lower (~1 accident death per ~100 game days for the
 * default cast's three risky workers even at full 9 h shifts) and the
 * hazard now has causes the player can see coming: working exhausted or
 * impaired multiplies it. An overworked, hungover farmhand is at real risk; a
 * rested one almost never is.
 */
export const ACCIDENT_HAZARD = {
  RISKY_JOBS: ['farmer', 'farmhand', 'handyperson'] as readonly string[],
  /** Per game minute of 'working', rested and sober. */
  BASE_PER_MINUTE: 0.000006,
  /** Energy below this at work counts as exhausted. */
  EXHAUSTED_ENERGY: 25,
  EXHAUSTED_MULTIPLIER: 5,
  IMPAIRED_STATES: ['drunk', 'hungover'] as readonly string[],
  IMPAIRED_MULTIPLIER: 3,
} as const;

/** Accident chance per game minute for this agent right now (0 if not exposed). */
export function accidentChancePerMinute(
  ctx: Pick<AgentDeathContext, 'currentAction' | 'job' | 'energy' | 'activeStates'>,
): number {
  if (ctx.currentAction !== 'working') return 0;
  if (!ACCIDENT_HAZARD.RISKY_JOBS.includes(ctx.job)) return 0;
  let p = ACCIDENT_HAZARD.BASE_PER_MINUTE;
  if (ctx.energy < ACCIDENT_HAZARD.EXHAUSTED_ENERGY) p *= ACCIDENT_HAZARD.EXHAUSTED_MULTIPLIER;
  if (ctx.activeStates.some((s) => ACCIDENT_HAZARD.IMPAIRED_STATES.includes(s.type))) {
    p *= ACCIDENT_HAZARD.IMPAIRED_MULTIPLIER;
  }
  return p;
}

// --- Death Effects Pipeline ---

/**
 * The shared way out of town (lib/residents.ts): inactive, out of every
 * building and zone slot, conversations and queue entries dropped, plan
 * cancelled, owned places handed to the closest friend. A death, a player
 * removal and a resident moving away all go through it, so none of them can
 * leave a ghost holding a bed or a conversation slot.
 */
function deactivateAgent(ctx: DeathEffectContext): void {
  retireResident(ctx.agentId, 'death');
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
      started_at: ctx.nowMinutes,
      duration,
      target_agent_id: ctx.agentId,
      source: `event:death_of_${ctx.agentId}`,
      metadata: null,
    }).run();
  }
}

/**
 * The estate — money, belongings and the places they owned — goes to the
 * first heir (lib/heirs.ts: the spouse, then the children — held in trust by
 * their guardian — then the closest friend). It used to go to the closest friend whatever the
 * marriage, and the places to a friend by a second rule in residents.ts. With
 * no heir the money goes to the town, the belongings are lost and the places
 * stand unowned until someone takes up the trade (lib/careers.ts).
 */
function processInheritance(ctx: DeathEffectContext): void {
  const deceasedEcon = db.select().from(economy).where(eq(economy.agent_id, ctx.agentId)).get();
  const money = Math.max(0, deceasedEcon?.money ?? 0);
  const items = (deceasedEcon?.inventory as Array<{ itemId: string; quantity: number; acquiredAt: number }> | undefined) ?? [];

  const heir = heirsOf(ctx.agentId)[0] ?? null;
  const inheritorEcon = heir ? db.select().from(economy).where(eq(economy.agent_id, heir.agentId)).get() : undefined;
  // An heir without an economy row (a malformed test world) can't hold money: treat as none.
  const heirId = heir && inheritorEcon ? heir.agentId : null;
  const places = passOwnedPlaces(ctx.agentId, heirId);
  if (!deceasedEcon) return;
  if (money <= 0 && items.length === 0 && places.length === 0) return;

  if (heir && inheritorEcon) {
    let inv = inheritorEcon.inventory as Array<{ itemId: string; quantity: number; acquiredAt: number }>;
    for (const item of items) {
      const existing = inv.find((i) => i.itemId === item.itemId);
      inv = existing
        ? inv.map((i) => (i.itemId === item.itemId ? { ...i, quantity: i.quantity + item.quantity } : i))
        : [...inv, item];
    }
    db.update(economy).set({ money: inheritorEcon.money + money, inventory: inv })
      .where(eq(economy.agent_id, heir.agentId)).run();

    const heirRow = db.select({ name: agents.name, gender: agents.gender }).from(agents).where(eq(agents.id, heir.agentId)).get();
    logActivity({
      type: 'drama',
      initiator: ctx.agentId,
      target: heir.agentId,
      templateData: { description: estateLine(ctx.agentName, heirRow?.name ?? 'someone', heir.kind, heirRow?.gender ?? null, money, items.length > 0, places, heir.child?.name) },
      metadata: { beat: 'inheritance' },
    });
    const left = [money > 0 ? 'their savings' : '', items.length > 0 ? 'their belongings' : '', ...places].filter(Boolean).join(', ') || 'what little they had';
    memoryService.record(heir.agentId, 'observation',
      heir.child
        // Held in trust: the guardian keeps it for the child, and knows it.
        ? `${ctx.agentName} left ${left} to little ${heir.child.name}, and I am to keep it for the child. I'll do right by them.`
        : `${ctx.agentName} left me ${left}. I'd give it all back to have them here.`,
      { subtype: 'inheritance', related_agents: [ctx.agentId] }, -0.3, 6);
  } else if (money > 0) {
    const world = db.select().from(worldState).get();
    if (world) {
      db.update(worldState).set({ tax_pool: world.tax_pool + money })
        .where(eq(worldState.id, world.id)).run();
    }
  }

  db.update(economy).set({ money: 0, inventory: [] }).where(eq(economy.agent_id, ctx.agentId)).run();
}

/**
 * "Rosa's estate — savings ($120), belongings and the General Store — went to
 * Tom, the widower." The dash list reads for any mix (a place alone would
 * otherwise come out as "Rosa's the General Store").
 */
function estateLine(
  deceased: string,
  heirName: string,
  kind: HeirKind,
  heirGender: string | null,
  money: number,
  hasItems: boolean,
  places: readonly string[],
  childName?: string,
): string {
  const parts = [
    money > 0 ? `savings ($${Math.round(money)})` : '',
    hasItems ? 'belongings' : '',
    ...places,
  ].filter(Boolean);
  const what = parts.length <= 1 ? parts[0] ?? '' : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  // A child heir's share goes to the guardian named in the heir row (lib/heirs.ts).
  const who = kind === 'spouse'
    ? `the ${heirGender === 'female' ? 'widow' : heirGender === 'male' ? 'widower' : 'surviving spouse'}`
    : kind === 'child' ? `in trust for little ${childName ?? 'their child'}` : 'a close friend';
  return `${deceased}'s estate${what ? ` — ${what} —` : ''} went to ${heirName}, ${who}.`;
}

function createFuneralEvent(ctx: DeathEffectContext): void {
  // Catalog duration is in game hours; this used to insert `duration: 240`
  // commented "4 hours", which the expiry math read as 240 hours.
  startWorldEvent('funeral', {
    triggeredBy: `death:${ctx.agentId}`,
    name: `Funeral of ${ctx.agentName}`,
    description: `The town gathers to mourn ${ctx.agentName}. ${ctx.causeDescription}.`,
    enforceLimits: false,
    announce: false, // the death itself is the feed entry; memorials are written separately
  });
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

    simEvents.emit('state:triggered', {
      agentId: other.id,
      state: 'grieving',
      cause: reflection,
    });
  }
}

function logDeath(ctx: DeathEffectContext): void {
  logActivity({
    type: 'drama',
    initiator: ctx.agentId,
    templateData: { description: `${ctx.agentName} has died. ${ctx.causeDescription}. The town mourns.` },
    metadata: { beat: 'death' },
  });
  emitter.markDirty('agents.all');
}

// --- Pipeline ---

const DEATH_EFFECTS: DeathEffect[] = [
  { name: 'deactivate',        execute: deactivateAgent },
  { name: 'create_death_fact', execute: createDeathFact },
  { name: 'trigger_grieving',  execute: triggerGrieving },
  { name: 'inheritance',       execute: processInheritance },
  { name: 'funeral_event',     execute: createFuneralEvent },
  { name: 'memorial_memories', execute: createMemorialMemories },
  { name: 'activity_log',      execute: logDeath },
];

// --- Public API ---

export function checkDeathTriggers(
  agent: { id: number; name: string; age: number },
  nowMinutes: number,
  statesArr: ReadonlyArray<{ type: string; started_at: number; severity: number; metadata: Record<string, unknown> | null }>,
  needsData: { mood: number; hunger: number; energy: number },
  job: string,
  currentAction: string,
  isOutdoors: boolean,
  season: string,
  tickSpeed: number,
): string | null {
  const ctx: AgentDeathContext = {
    agent,
    nowMinutes,
    tickSpeed,
    season,
    hungerZeroMinutes: hungerZeroMinutes.get(agent.id) ?? 0,
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

export function processAgentDeath(agentId: number, agentName: string, cause: string, nowMinutes: number): void {
  const trigger = DEATH_TRIGGERS.find(t => t.type === cause);
  const causeDescription = trigger?.description ?? cause;

  const ctx: DeathEffectContext = {
    agentId,
    agentName,
    cause,
    causeDescription,
    nowMinutes,
  };

  for (const effect of DEATH_EFFECTS) {
    try {
      effect.execute(ctx);
    } catch (err) {
      console.error(`Death effect '${effect.name}' failed for agent ${agentName}:`, err);
    }
  }

  // After the whole pipeline, so a listener (director, sound, outcomes) sees
  // the funeral, the fact and the inheritance already in place. The per-person
  // `state:triggered` grieving events above are about the survivors; this one
  // is about the death itself.
  simEvents.emit('life:death', { agentId, name: agentName, cause, causeDescription });
}
