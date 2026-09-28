import { db } from '../../db';
import {
  agents,
  agentStates,
  needs as needsTable,
  relationships,
  conversations,
  locations,
  worldState,
  economy as economyTable,
  economyTransactions,
  relationshipEvents,
  memories,
  shared_knowledge,
} from '../../db/schema';
import { logActivity } from '../../lib/activityLogger';
import { eq, and, gt, lt, or } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { PersonalityProfile } from '../../lib/personality';
import { clamp } from '../../lib/utils';
import {
  STATE_DEFINITIONS,
  StateType,
  clearEffectivePersonalities,
  setEffectivePersonality,
} from '../../lib/states';
import { emitter } from '../emitter';
import { createFact, spreadPublicKnowledge, deactivateStaleFacts } from '../../lib/gossip';
import { taskRunner } from '../../ai/taskRunner';
import { simEvents } from '../../lib/simEvents';
import { checkDeathTriggers, processAgentDeath } from '../../lib/lifeEventsEngine';
import { zoneOccupancy } from '../../lib/interiorGrid';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CascadeEntry {
  agentId: number;
  stateType: StateType;
  source: string;
  targetAgentId?: number;
  severity?: number;
}

// ─── Module-level state ───────────────────────────────────────────────────────

/** Minimum lifetime (1 game hour) before a conditional-exit state may be removed. */
const CONDITIONAL_EXIT_GRACE_TICKS = 60;

let previouslyActiveAgents = new Set<number>();

// Track ticks where an agent had stressed state removed (to avoid re-triggering immediately)
const stressRemovedAtTick = new Map<number, number>();

const gamblingCooldowns = new Map<string, number>();

// Track tick when mood first dropped below 15 (for depressed trigger duration check)
const lowMoodSince = new Map<number, number>(); // agentId → tick when mood first dropped below 15

// Track tick when social first dropped below 20 (for lonely trigger duration check)
const lowSocialSince = new Map<number, number>(); // agentId → tick when social dropped below 20

// Track when an agent recovered from sickness (for immunity cooldown)
const sickRecoveredAtTick = new Map<number, number>(); // agentId → tick when sickness expired

// Track drunk episode timestamps per agent for alcoholism detection
const drunkHistory = new Map<number, number[]>();

// Track alcoholism recovery for relapse mechanic
const alcoholRecoveredAtTick = new Map<number, number>();

// Track how long an agent has been broke (for in_debt trigger)
const brokeSince = new Map<number, number>();

// Track ticks when each agent gambled (for addiction detection)
const gamblingHistory = new Map<number, number[]>(); // agentId → array of ticks when gambled

/**
 * Drop all per-agent tracking for a world replace.
 *
 * Every map above is keyed by agent id and holds tick values. SQLite reuses
 * rowids after a DELETE while `totalTicks` restarts at 0, so surviving entries
 * both belong to a stranger and sit in the future — `currentTick - since` goes
 * negative and the cooldowns/duration gates they guard never fire again.
 */
export function clearStatesTrackers(): void {
  previouslyActiveAgents = new Set();
  stressRemovedAtTick.clear();
  gamblingCooldowns.clear();
  lowMoodSince.clear();
  lowSocialSince.clear();
  sickRecoveredAtTick.clear();
  drunkHistory.clear();
  alcoholRecoveredAtTick.clear();
  brokeSince.clear();
  gamblingHistory.clear();
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export function statesTick() {
  const world = db.select().from(worldState).limit(1).all()[0];
  if (!world) return;

  const currentTick = (world.time as any).totalTicks as number;
  const weather = world.weather as string;
  const season = (world.time as any).season as string;

  clearEffectivePersonalities();

  const allAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const currentActiveIds = new Set(allAgents.map((a) => a.id));
  const removedAgentIds = [...previouslyActiveAgents].filter((id) => !currentActiveIds.has(id));
  previouslyActiveAgents = currentActiveIds;

  const pendingCascades: CascadeEntry[] = [];

  // ── Pass 1: Per-agent processing ──────────────────────────────────────────
  for (const agent of allAgents) {
    let agentStateRows = db
      .select()
      .from(agentStates)
      .where(eq(agentStates.agent_id, agent.id))
      .all();

    // 1a. Expire time-bounded states
    for (const state of agentStateRows) {
      const def = STATE_DEFINITIONS[state.type as StateType];
      if (def?.conditionalExit) continue; // handled in 1b
      if (state.started_at + state.duration <= currentTick) {
        // Track sickness recovery for immunity cooldown
        if (state.type === 'sick') {
          sickRecoveredAtTick.set(agent.id, currentTick);
          logActivity({
            type: 'state_lost',
            initiator: agent.id,
            templateData: { agent: agent.name, state: 'sick' },
          });
        } else if (state.type === 'arrested') {
          // Release: the town remembers, so the sentence becomes a gossip fact.
          logActivity({
            type: 'drama',
            initiator: agent.id,
            severity: 0.5,
            templateData: {
              description: `${agent.name} was released from prison after ${Math.round(state.duration / 60)} hours.`,
            },
          });
        } else {
          logActivity({
            type: 'state_lost',
            initiator: agent.id,
            templateData: { agent: agent.name, state: state.type },
          });
        }
        simEvents.emit('state:cleared', { agentId: agent.id, state: state.type });
        collectExpiryCascades(state, agent, pendingCascades);
        db.delete(agentStates).where(eq(agentStates.id, state.id)).run();
      }
    }

    // 1b. Check conditional exits (stressed, lonely, depressed, infatuated)
    agentStateRows = db
      .select()
      .from(agentStates)
      .where(eq(agentStates.agent_id, agent.id))
      .all();
    const agentNeeds = db
      .select()
      .from(needsTable)
      .where(eq(needsTable.agent_id, agent.id))
      .get();
    checkConditionalExits(agentStateRows, agentNeeds, agent, currentTick);

    // 1c. Evaluate triggers for new states
    agentStateRows = db
      .select()
      .from(agentStates)
      .where(eq(agentStates.agent_id, agent.id))
      .all();
    const activeTypes = new Set(agentStateRows.map((s) => s.type));
    evaluateTriggers(
      agent,
      agentNeeds,
      activeTypes,
      currentTick,
      weather,
      season,
      removedAgentIds,
      allAgents,
    );

    // 1d. Compute effective personality from all current states
    agentStateRows = db
      .select()
      .from(agentStates)
      .where(eq(agentStates.agent_id, agent.id))
      .all();
    if (agent.personality) {
      const effective = computeEffectivePersonality(
        agent.personality as PersonalityProfile,
        agentStateRows,
      );
      setEffectivePersonality(agent.id, effective);
    }
  }

  // ── Pass 2: Cascades (max depth 2) ────────────────────────────────────────
  applyCascades(pendingCascades, currentTick, 0, 2);

  // ── Pass 3: Side effects ──────────────────────────────────────────────────
  for (const agent of allAgents) {
    const states = db
      .select()
      .from(agentStates)
      .where(eq(agentStates.agent_id, agent.id))
      .all();
    processStateEffects(agent, states, allAgents, currentTick);
  }

  // ── Blackmail self-expose: honest victims have a small daily chance to expose ──
  if (currentTick % 1440 < 2) {
    const blackmailFacts = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.type, 'blackmail'), eq(shared_knowledge.is_active, true)))
      .all();
    for (const fact of blackmailFacts) {
      const victimId = fact.target_id;
      if (!victimId) continue;
      const victim = db.select({ personality: agents.personality, name: agents.name }).from(agents).where(eq(agents.id, victimId)).get();
      if (!victim?.personality) continue;
      const honesty = (victim.personality as any).honesty ?? 50;
      if (honesty > 60 && Math.random() < 0.05) {
        // Self-expose: make the secret public, deactivate blackmail
        db.update(shared_knowledge).set({ is_active: false }).where(eq(shared_knowledge.id, fact.id)).run();
        simEvents.emit('state:triggered', { agentId: victimId, state: 'relieved', cause: 'exposed blackmail secret publicly' });
        logActivity({ type: 'drama', initiator: victimId, templateData: { description: `${victim.name} publicly exposed their blackmailer's leverage, ending the blackmail.` } });
      }
    }
  }

  spreadPublicKnowledge();
  deactivateStaleFacts();

  // ── Death check — runs after all state processing ────────────────────
  // Track agents who die this tick so Pass 3 (already run) didn't harm anything,
  // and we avoid processing the same agent twice.
  const diedThisTick = new Set<number>();
  for (const agent of allAgents) {
    const agentNeeds = db.select().from(needsTable).where(eq(needsTable.agent_id, agent.id)).get();
    if (!agentNeeds) continue;

    const states = db.select().from(agentStates).where(eq(agentStates.agent_id, agent.id)).all();
    const econ = db.select({ job: economyTable.job }).from(economyTable).where(eq(economyTable.agent_id, agent.id)).get();
    const action = (agent.current_action as any)?.type ?? 'idle';
    const isOutdoors = agent.current_location == null;

    const deathCause = checkDeathTriggers(
      { id: agent.id, name: agent.name, age: agent.age },
      currentTick, states as any, agentNeeds, econ?.job ?? '', action, isOutdoors, season,
    );

    if (deathCause && !diedThisTick.has(agent.id)) {
      diedThisTick.add(agent.id);
      processAgentDeath(agent.id, agent.name, deathCause, currentTick);
    }
  }

  emitter.markDirty('agents.all');
}

// ─── computeEffectivePersonality ──────────────────────────────────────────────

function computeEffectivePersonality(
  base: PersonalityProfile,
  states: Array<{ type: string; severity: number }>,
): PersonalityProfile {
  const effective = { ...base };

  for (const state of states) {
    const def = STATE_DEFINITIONS[state.type as StateType];
    if (!def?.modifiers) continue;

    for (const [axis, modifier] of Object.entries(def.modifiers) as [
      keyof PersonalityProfile,
      number,
    ][]) {
      const delta = modifier * state.severity;
      effective[axis] = clamp(effective[axis] + delta, 0, 100);
    }
  }

  return effective;
}

// ─── evaluateTriggers ─────────────────────────────────────────────────────────

function evaluateTriggers(
  agent: typeof agents.$inferSelect,
  agentNeeds: typeof needsTable.$inferSelect | undefined,
  activeTypes: Set<string>,
  currentTick: number,
  weather: string,
  season: string,
  removedAgentIds: number[],
  allAgents: Array<typeof agents.$inferSelect>,
) {
  const personality = agent.personality as PersonalityProfile | null;
  if (!personality) return;

  // ── Drunk ─────────────────────────────────────────────────────────────────
  if (!activeTypes.has('drunk') && !activeTypes.has('hungover')) {
    if (agent.current_location != null && personality.impulsiveness > 40) {
      const loc = db
        .select({ type: locations.type })
        .from(locations)
        .where(eq(locations.id, agent.current_location))
        .get();
      // Chance per visit session (~1% base scaled by impulsiveness), not per tick.
      // Using /10000 so a 70-impulsiveness agent has ~0.7% chance per tick to start drinking.
      if (loc?.type === 'tavern' && Math.random() < personality.impulsiveness / 10000) {
        const severity = clamp(0.3 + (personality.impulsiveness / 100) * 0.7, 0, 1);
        const duration = Math.floor(120 + Math.random() * 120); // 120-240 ticks
        db.insert(agentStates)
          .values({
            agent_id: agent.id,
            type: 'drunk',
            severity,
            started_at: currentTick,
            duration,
            source: 'action:drinking',
            metadata: null,
          })
          .run();
        logActivity({
          type: 'state_gained',
          initiator: agent.id,
          templateData: { agent: agent.name, state: 'drunk' },
        });
        simEvents.emit('state:triggered', { agentId: agent.id, state: 'drunk', cause: 'action:drinking' });
        activeTypes.add('drunk');
        // Track for alcoholism escalation
        const history = drunkHistory.get(agent.id) ?? [];
        history.push(currentTick);
        const cutoff = currentTick - 10080; // 7 days
        drunkHistory.set(agent.id, history.filter((t) => t > cutoff));
      }
    }
  }

  // ── Sick ──────────────────────────────────────────────────────────────────
  if (!activeTypes.has('sick')) {
    // Check immunity cooldown — recently recovered agents can't get sick again immediately
    const lastRecovery = sickRecoveredAtTick.get(agent.id) ?? -9999;
    const immunityPeriod = 2880; // ~2 days of immunity after recovery
    if (currentTick - lastRecovery > immunityPeriod) {
      const weatherMult = weather === 'rainy' || weather === 'stormy' ? 2 : 1;
      const seasonMult = season === 'winter' ? 1.5 : 1;
      const energyMult = agentNeeds && agentNeeds.energy < 25 ? 1.5 : 1;
      const sickChance = 0.0001 * weatherMult * seasonMult * energyMult;
      if (Math.random() < sickChance) {
        const severity = 0.3 + Math.random() * 0.4;
        const duration = Math.floor(480 + Math.random() * 960); // 8-24 hours (shorter)
        db.insert(agentStates)
          .values({
            agent_id: agent.id,
            type: 'sick',
            severity,
            started_at: currentTick,
            duration,
            source: 'random:environment',
            metadata: null,
          })
          .run();
        logActivity({
          type: 'state_gained',
          initiator: agent.id,
          templateData: { agent: agent.name, state: 'sick' },
        });
        simEvents.emit('state:triggered', { agentId: agent.id, state: 'sick', cause: 'random:environment' });
        activeTypes.add('sick');
        createFact('sickness', agent.id, null, 1, [agent.id], 'observed');
      }
    }
  }

  // ── Alcoholic ────────────────────────────────────────────────────────────
  if (!activeTypes.has('alcoholic') && personality.impulsiveness > 50) {
    const history = drunkHistory.get(agent.id) ?? [];
    const recentWindow = currentTick - 10080; // 7 days
    const recentDrunkCount = history.filter((t) => t > recentWindow).length;

    if (recentDrunkCount >= 3) {
      const recoveredAt = alcoholRecoveredAtTick.get(agent.id) ?? -9999;
      const inRelapseWindow = currentTick - recoveredAt < 720;

      if (inRelapseWindow) {
        // Within relapse window: tavern visit has chance of re-triggering
        const relapseChance = personality.neuroticism > 60 ? 0.5 : 0.3;
        if (Math.random() < relapseChance) {
          const severity = clamp(0.3 + (recentDrunkCount - 3) * 0.15, 0.3, 1.0);
          db.insert(agentStates).values({
            agent_id: agent.id,
            type: 'alcoholic',
            severity,
            started_at: currentTick,
            duration: 999999,
            source: `relapse:drunk_count_${recentDrunkCount}`,
            metadata: { drunkCount: recentDrunkCount, stage: recentDrunkCount >= 5 ? 3 : 2 },
          }).run();
          logActivity({
            type: 'state_gained',
            initiator: agent.id,
            templateData: { agent: agent.name, state: 'alcoholic' },
          });
          simEvents.emit('state:triggered', { agentId: agent.id, state: 'alcoholic', cause: 'relapse' });
          activeTypes.add('alcoholic');
          createFact('alcoholic', agent.id, null, 2, [agent.id], 'observed');
        }
      } else {
        // Normal trigger: 3+ drunk in 7 days
        const severity = clamp(0.3 + (recentDrunkCount - 3) * 0.15, 0.3, 1.0);
        db.insert(agentStates).values({
          agent_id: agent.id,
          type: 'alcoholic',
          severity,
          started_at: currentTick,
          duration: 999999,
          source: `trigger:drunk_count_${recentDrunkCount}`,
          metadata: { drunkCount: recentDrunkCount, stage: recentDrunkCount >= 5 ? 3 : 2 },
        }).run();
        logActivity({
          type: 'state_gained',
          initiator: agent.id,
          templateData: { agent: agent.name, state: 'alcoholic' },
        });
        simEvents.emit('state:triggered', { agentId: agent.id, state: 'alcoholic', cause: `drunk_count_${recentDrunkCount}` });
        activeTypes.add('alcoholic');
        createFact('alcoholic', agent.id, null, 2, [agent.id], 'observed');
      }
    }
  }

  // ── In Debt ──────────────────────────────────────────────────────────────
  if (!activeTypes.has('in_debt')) {
    const eco = db.select({ money: economyTable.money, inventory: economyTable.inventory })
      .from(economyTable).where(eq(economyTable.agent_id, agent.id)).get();
    // `<= 0`, not `=== 0`: sale tax splits leave fractional balances and
    // disasters can push money negative, and both are more broke than zero.
    if (eco && eco.money <= 0) {
      const hasFood = (eco.inventory as any[]).some(
        (i: any) => ['food_raw', 'food_prepared'].includes(i.itemId) && i.quantity > 0
      );
      if (!hasFood) {
        if (!brokeSince.has(agent.id)) {
          brokeSince.set(agent.id, currentTick);
        }
        const duration = currentTick - brokeSince.get(agent.id)!;
        if (duration > 4320) { // 3 days
          db.insert(agentStates).values({
            agent_id: agent.id,
            type: 'in_debt',
            severity: 0.5,
            started_at: currentTick,
            duration: 999999,
            source: 'trigger:broke_3_days',
            metadata: { beggingFailCount: 0, desperationUnlocked: false },
          }).run();
          logActivity({
            type: 'state_gained',
            initiator: agent.id,
            templateData: { agent: agent.name, state: 'in_debt' },
          });
          simEvents.emit('state:triggered', { agentId: agent.id, state: 'in_debt', cause: 'broke_3_days' });
          activeTypes.add('in_debt');
        }
      }
    } else {
      brokeSince.delete(agent.id);
    }
  }

  // ── Heartbroken ───────────────────────────────────────────────────────────
  if (!activeTypes.has('heartbroken')) {
    const msPerTick = CONFIG.TICK_INTERVAL_MS;
    const sinceWindow = Date.now() - 60 * msPerTick;
    const recentRomanceDrops = db
      .select()
      .from(relationshipEvents)
      .where(
        and(
          or(
            eq(relationshipEvents.agent_a, agent.id),
            eq(relationshipEvents.agent_b, agent.id),
          ),
          gt(relationshipEvents.timestamp, sinceWindow),
        ),
      )
      .all();

    for (const event of recentRomanceDrops) {
      const isA = event.agent_a === agent.id;
      const romanceDelta = isA ? event.romance_delta_ab : event.romance_delta_ba;
      if (romanceDelta < -20) {
        const severity = clamp(Math.abs(romanceDelta) / 50, 0.3, 1.0);
        const baseDuration = Math.floor(2880 + Math.random() * 7200); // 2-7 days
        const neuroDuration =
          personality.neuroticism > 60 ? Math.floor(baseDuration * 1.5) : baseDuration;
        const targetId = isA ? event.agent_b : event.agent_a;
        db.insert(agentStates)
          .values({
            agent_id: agent.id,
            type: 'heartbroken',
            severity,
            started_at: currentTick,
            duration: neuroDuration,
            target_agent_id: targetId,
            source: 'event:romance_drop',
            metadata: null,
          })
          .run();
        logActivity({
          type: 'state_gained',
          initiator: agent.id,
          templateData: { agent: agent.name, state: 'heartbroken' },
        });
        simEvents.emit('state:triggered', { agentId: agent.id, state: 'heartbroken', cause: 'romance_drop' });
        activeTypes.add('heartbroken');
        createFact('heartbreak', agent.id, targetId, 2, [agent.id], 'witnessed');
        break; // one heartbreak at a time
      }
    }
  }

  // ── Angry ─────────────────────────────────────────────────────────────────
  if (!activeTypes.has('angry') && personality.aggression > 40) {
    const msPerTick = CONFIG.TICK_INTERVAL_MS;
    const sinceWindow = Date.now() - 60 * msPerTick;
    const badConvos = db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.status, 'ended'),
          lt(conversations.sentiment, -0.5),
          gt(conversations.started_at, sinceWindow),
        ),
      )
      .all();

    for (const conv of badConvos) {
      const participants = conv.participants as number[];
      if (!participants.includes(agent.id)) continue;

      // Find who caused it (the other participant)
      const targetId = participants.find((p) => p !== agent.id);
      const severity = clamp(
        (personality.aggression / 100) * Math.abs(conv.sentiment),
        0.4,
        1.0,
      );
      const baseDuration = Math.floor(180 + Math.random() * 540); // 3-12 hours
      const duration =
        personality.aggression > 60 ? Math.floor(baseDuration * 1.3) : baseDuration;
      db.insert(agentStates)
        .values({
          agent_id: agent.id,
          type: 'angry',
          severity,
          started_at: currentTick,
          duration,
          target_agent_id: targetId ?? null,
          source: 'event:bad_conversation',
          metadata: null,
        })
        .run();
      logActivity({
        type: 'state_gained',
        initiator: agent.id,
        templateData: { agent: agent.name, state: 'angry' },
      });
      simEvents.emit('state:triggered', { agentId: agent.id, state: 'angry', cause: 'bad_conversation' });
      activeTypes.add('angry');
      break;
    }
  }

  // ── Stressed ──────────────────────────────────────────────────────────────
  if (!activeTypes.has('stressed') && agentNeeds) {
    const needValues = [
      agentNeeds.hunger,
      agentNeeds.energy,
      agentNeeds.social,
      agentNeeds.comfort,
      agentNeeds.fun,
    ];
    const lowNeedsCount = needValues.filter((v) => v < 35).length;
    const lastRemoved = stressRemovedAtTick.get(agent.id) ?? -9999;
    if (lowNeedsCount >= 3 && currentTick - lastRemoved > 120) { // 2 game hours hysteresis to prevent oscillation
      const severity = clamp(0.3 + (lowNeedsCount / 5) * 0.5, 0.3, 0.8);
      db.insert(agentStates)
        .values({
          agent_id: agent.id,
          type: 'stressed',
          severity,
          started_at: currentTick,
          duration: 999999, // conditional exit
          source: 'needs:multiple_low',
          metadata: { lowNeedsCount },
        })
        .run();
      logActivity({
        type: 'state_gained',
        initiator: agent.id,
        templateData: { agent: agent.name, state: 'stressed' },
      });
      activeTypes.add('stressed');
    }
  }

  // ── Euphoric ──────────────────────────────────────────────────────────────
  if (!activeTypes.has('euphoric') && agentNeeds && agentNeeds.mood > 70) {
    const msPerTick = CONFIG.TICK_INTERVAL_MS;
    const sinceWindow = Date.now() - 90 * msPerTick;
    const positiveConvoRows = db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.status, 'ended'),
          gt(conversations.sentiment, 0.6),
          gt(conversations.started_at, sinceWindow),
        ),
      )
      .all();
    const positiveConvo = positiveConvoRows.find((c) =>
      (c.participants as number[]).includes(agent.id),
    );

    if (positiveConvo) {
      const severity = 0.5 + Math.random() * 0.5;
      const duration = Math.floor(120 + Math.random() * 240); // 2-6 hours
      db.insert(agentStates)
        .values({
          agent_id: agent.id,
          type: 'euphoric',
          severity,
          started_at: currentTick,
          duration,
          source: 'event:positive_conversation',
          metadata: null,
        })
        .run();
      logActivity({
        type: 'state_gained',
        initiator: agent.id,
        templateData: { agent: agent.name, state: 'euphoric' },
      });
      simEvents.emit('state:triggered', { agentId: agent.id, state: 'euphoric', cause: 'positive_conversation' });
      activeTypes.add('euphoric');
    }
  }

  // ── Grieving ──────────────────────────────────────────────────────────────
  if (!activeTypes.has('grieving') && removedAgentIds.length > 0) {
    for (const removedId of removedAgentIds) {
      // Check if they had a close friendship
      const rel = db
        .select()
        .from(relationships)
        .where(
          or(
            and(eq(relationships.agent_a, agent.id), eq(relationships.agent_b, removedId)),
            and(eq(relationships.agent_a, removedId), eq(relationships.agent_b, agent.id)),
          ),
        )
        .get();

      if (!rel) continue;
      const isA = rel.agent_a === agent.id;
      const friendship = isA ? rel.friendship_ab : rel.friendship_ba;

      if (friendship > 70) {
        const severity = clamp(0.6 + (friendship - 70) / 100, 0.6, 1.0);
        const baseDuration = Math.floor(7200 + Math.random() * 12960); // 5-14 days
        const duration =
          personality.loyalty > 60 ? Math.floor(baseDuration * 1.2) : baseDuration;
        db.insert(agentStates)
          .values({
            agent_id: agent.id,
            type: 'grieving',
            severity,
            started_at: currentTick,
            duration,
            target_agent_id: removedId,
            source: 'event:agent_removed',
            metadata: null,
          })
          .run();
        logActivity({
          type: 'state_gained',
          initiator: agent.id,
          templateData: { agent: agent.name, state: 'grieving' },
        });
        simEvents.emit('state:triggered', { agentId: agent.id, state: 'grieving', cause: 'agent_removed' });
        activeTypes.add('grieving');
        break;
      }
    }
  }

  // ── Infatuated ────────────────────────────────────────────────────────────
  if (!activeTypes.has('infatuated') && personality.sensuality > 40) {
    const rels = db
      .select()
      .from(relationships)
      .where(or(eq(relationships.agent_a, agent.id), eq(relationships.agent_b, agent.id)))
      .all();

    for (const rel of rels) {
      const isA = rel.agent_a === agent.id;
      const romance = isA ? rel.romance_ab : rel.romance_ba;
      if (romance > 60) {
        const targetId = isA ? rel.agent_b : rel.agent_a;
        const severity = clamp((romance - 50) / 50, 0.3, 1.0);
        db.insert(agentStates)
          .values({
            agent_id: agent.id,
            type: 'infatuated',
            severity,
            started_at: currentTick,
            duration: 999999, // conditional exit
            target_agent_id: targetId,
            source: 'relationship:high_romance',
            metadata: null,
          })
          .run();
        logActivity({
          type: 'state_gained',
          initiator: agent.id,
          templateData: { agent: agent.name, state: 'infatuated' },
        });
        simEvents.emit('state:triggered', { agentId: agent.id, state: 'infatuated', cause: 'high_romance' });
        activeTypes.add('infatuated');
        createFact('crush', agent.id, targetId, 2, [agent.id], 'witnessed');

        // Check for affair: does the target have romance > 40 with any third agent?
        const targetRomanceRels = db
          .select()
          .from(relationships)
          .where(or(eq(relationships.agent_a, targetId), eq(relationships.agent_b, targetId)))
          .all();

        for (const tRel of targetRomanceRels) {
          const tIsA = tRel.agent_a === targetId;
          const thirdAgentId = tIsA ? tRel.agent_b : tRel.agent_a;
          if (thirdAgentId === agent.id) continue;
          const targetRomanceWithThird = tIsA ? tRel.romance_ab : tRel.romance_ba;
          if (targetRomanceWithThird > 40) {
            const coLocated = allAgents
              .filter(
                (a) =>
                  a.current_location === agent.current_location &&
                  a.id !== agent.id &&
                  a.id !== targetId,
              )
              .map((a) => a.id);
            createFact('affair', agent.id, targetId, 3, coLocated, 'observed');
            break;
          }
        }

        break;
      }
    }
  }

  // ── Jealous ──────────────────────────────────────────────────────────────
  if (!activeTypes.has('jealous') && activeTypes.has('infatuated')) {
    const infatuatedState = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, 'infatuated'))).get();
    if (infatuatedState?.target_agent_id) {
      const loveInterestId = infatuatedState.target_agent_id;
      const loveInterestRels = db.select().from(relationships)
        .where(or(eq(relationships.agent_a, loveInterestId), eq(relationships.agent_b, loveInterestId))).all();
      for (const rel of loveInterestRels) {
        const isA = rel.agent_a === loveInterestId;
        const rivalId = isA ? rel.agent_b : rel.agent_a;
        if (rivalId === agent.id) continue;
        const rivalRomance = isA ? rel.romance_ab : rel.romance_ba;
        if (rivalRomance > 40) {
          const severity = clamp((rivalRomance - 40) / 60, 0.3, 1.0);
          db.insert(agentStates).values({
            agent_id: agent.id,
            type: 'jealous',
            severity,
            started_at: currentTick,
            duration: 999999,
            target_agent_id: rivalId,
            source: 'trigger:rival_romance',
            metadata: { loveInterestId, rivalId },
          }).run();
          logActivity({
            type: 'state_gained',
            initiator: agent.id,
            templateData: { agent: agent.name, state: 'jealous' },
          });
          simEvents.emit('state:triggered', { agentId: agent.id, state: 'jealous', cause: 'rival_romance' });
          activeTypes.add('jealous');
          break;
        }
      }
    }
  }

  // ── Lonely ────────────────────────────────────────────────────────────────
  if (!activeTypes.has('lonely') && agentNeeds) {
    if (agentNeeds.social < 20) {
      if (!lowSocialSince.has(agent.id)) {
        lowSocialSince.set(agent.id, currentTick);
      }
      const socialDuration = currentTick - lowSocialSince.get(agent.id)!;
      if (socialDuration >= 60) {
        const sinceWindow = Date.now() - 3600000; // last 60 minutes real-time
        const positiveConvoRows = db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.status, 'ended'),
              gt(conversations.sentiment, 0),
              gt(conversations.started_at, sinceWindow),
            ),
          )
          .all();
        const positiveConvo = positiveConvoRows.find((c) =>
          (c.participants as number[]).includes(agent.id),
        );

        if (!positiveConvo) {
          const severity = clamp((20 - agentNeeds.social) / 20, 0.3, 1.0);
          db.insert(agentStates)
            .values({
              agent_id: agent.id,
              type: 'lonely',
              severity,
              started_at: currentTick,
              duration: 999999, // conditional exit
              source: 'needs:low_social',
              metadata: null,
            })
            .run();
          logActivity({
            type: 'state_gained',
            initiator: agent.id,
            templateData: { agent: agent.name, state: 'lonely' },
          });
          simEvents.emit('state:triggered', { agentId: agent.id, state: 'lonely', cause: 'low_social' });
          activeTypes.add('lonely');
          // Reset the timer, otherwise an agent who leaves `lonely` with social
          // still under 20 relapses on the very next tick instead of getting
          // the 60-tick grace period again.
          lowSocialSince.delete(agent.id);
        }
      }
    } else {
      lowSocialSince.delete(agent.id); // social recovered, reset tracker
    }
  }

  // ── Depressed ─────────────────────────────────────────────────────────────
  if (!activeTypes.has('depressed')) {
    let shouldDepress = false;
    let depressSource = '';

    // Lonely for > 3 days (4320 ticks)
    const lonelyState = db
      .select()
      .from(agentStates)
      .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, 'lonely')))
      .get();
    if (lonelyState && currentTick - lonelyState.started_at > 4320) {
      shouldDepress = true;
      depressSource = 'cascade:lonely';
    }

    // Mood < 15 for > 2 days (2880 ticks) — requires sustained low mood
    if (!shouldDepress && agentNeeds) {
      if (agentNeeds.mood < 15) {
        if (!lowMoodSince.has(agent.id)) {
          lowMoodSince.set(agent.id, currentTick);
        }
        const duration = currentTick - lowMoodSince.get(agent.id)!;
        if (duration >= 2880) {
          shouldDepress = true;
          depressSource = 'trigger:low_mood';
        }
      } else {
        lowMoodSince.delete(agent.id); // mood recovered, reset tracker
      }
    }

    // Both heartbroken and stressed simultaneously
    if (!shouldDepress && activeTypes.has('heartbroken') && activeTypes.has('stressed')) {
      shouldDepress = true;
      depressSource = 'cascade:heartbroken+stressed';
    }

    // Neuroticism > 60 doubles trigger probability
    if (!shouldDepress && personality.neuroticism > 60) {
      // Re-evaluate with doubled probability for lonely/low_mood sub-conditions
      if (lonelyState && currentTick - lonelyState.started_at > 2160) {
        shouldDepress = Math.random() < 0.5;
        depressSource = 'cascade:lonely_neurotic';
      }
    }

    if (shouldDepress) {
      const severity = 0.5 + Math.random() * 0.5;
      db.insert(agentStates)
        .values({
          agent_id: agent.id,
          type: 'depressed',
          severity,
          started_at: currentTick,
          duration: 999999, // conditional exit
          source: depressSource,
          metadata: null,
        })
        .run();
      logActivity({
        type: 'state_gained',
        initiator: agent.id,
        templateData: { agent: agent.name, state: 'depressed' },
      });
      simEvents.emit('state:triggered', { agentId: agent.id, state: 'depressed', cause: depressSource });
      activeTypes.add('depressed');
    }
  }

  // ── Confident ─────────────────────────────────────────────────────────────
  if (!activeTypes.has('confident') && personality.vanity > 40) {
    const msPerTick = CONFIG.TICK_INTERVAL_MS;
    const sinceWindow = Date.now() - 1440 * msPerTick;
    // Projected: only membership is read, but `select()` dragged the whole
    // `messages` transcript of every recent conversation across for each agent,
    // every tick.
    const positiveConvos = db
      .select({ participants: conversations.participants })
      .from(conversations)
      .where(and(gt(conversations.sentiment, 0.25), gt(conversations.started_at, sinceWindow)))
      .all()
      .filter((c) => (c.participants as number[]).includes(agent.id));

    if (positiveConvos.length >= 2) {
      const severity = 0.4 + Math.random() * 0.4;
      const duration = Math.floor(480 + Math.random() * 480); // 8-16 hours
      db.insert(agentStates)
        .values({
          agent_id: agent.id,
          type: 'confident',
          severity,
          started_at: currentTick,
          duration,
          source: 'event:positive_conversations',
          metadata: null,
        })
        .run();
      logActivity({
        type: 'state_gained',
        initiator: agent.id,
        templateData: { agent: agent.name, state: 'confident' },
      });
      simEvents.emit('state:triggered', { agentId: agent.id, state: 'confident', cause: 'positive_conversations' });
      activeTypes.add('confident');
    }
  }
}

// ─── checkConditionalExits ────────────────────────────────────────────────────

function checkConditionalExits(
  stateRows: Array<typeof agentStates.$inferSelect>,
  agentNeeds: typeof needsTable.$inferSelect | undefined,
  agent: typeof agents.$inferSelect,
  currentTick: number,
) {
  for (const state of stateRows) {
    if (!STATE_DEFINITIONS[state.type as StateType]?.conditionalExit) continue;

    // A state created while its exit condition already holds would be deleted on
    // the very next tick. That silently no-op'd every cascade rule that grants
    // `stressed` (arrest, blackmail, humiliation, ...) to an agent whose needs
    // happened to be fine. Give every conditional state a minimum lifetime.
    if (currentTick - state.started_at < CONDITIONAL_EXIT_GRACE_TICKS) continue;

    let shouldExit = false;

    switch (state.type as StateType) {
      case 'stressed': {
        if (!agentNeeds) break;
        const { hunger, energy, social, comfort, fun } = agentNeeds;
        const highCount = [hunger, energy, social, comfort, fun].filter((v) => v > 50).length;
        shouldExit = highCount >= 2;
        break;
      }

      case 'lonely': {
        shouldExit = agentNeeds != null && agentNeeds.social > 50;
        break;
      }

      case 'depressed': {
        // Exit path 1: positive conversation with any friend (friendship > 30)
        // Look back 10 minutes real-time (enough to catch recent conversations)
        const sinceWindow = Date.now() - 600_000;
        const recentPositiveConvos = db
          .select({ participants: conversations.participants })
          .from(conversations)
          .where(and(gt(conversations.sentiment, 0.2), gt(conversations.started_at, sinceWindow)))
          .all()
          .filter((c) => {
            const parts = c.participants as number[];
            if (!parts.includes(agent.id)) return false;
            return parts.some((otherId) => {
              if (otherId === agent.id) return false;
              const rel = db
                .select()
                .from(relationships)
                .where(
                  or(
                    and(eq(relationships.agent_a, agent.id), eq(relationships.agent_b, otherId)),
                    and(eq(relationships.agent_a, otherId), eq(relationships.agent_b, agent.id)),
                  ),
                )
                .get();
              if (!rel) return false;
              const isA = rel.agent_a === agent.id;
              const friendship = isA ? rel.friendship_ab : rel.friendship_ba;
              return friendship > 30;
            });
          });
        if (recentPositiveConvos.length > 0) {
          shouldExit = true;
          break;
        }
        // Exit path 2: sustained high mood (mood > 55 for 120+ ticks = natural recovery)
        if (agentNeeds && agentNeeds.mood > 55) {
          const elapsed = currentTick - state.started_at;
          if (elapsed > 120) {
            shouldExit = true;
          }
        }
        // Exit path 3: long duration (depression lifts after ~2 game days even without help)
        const maxDepressedTicks = 2880; // ~2 game days
        if (currentTick - state.started_at > maxDepressedTicks) {
          // OR, not assignment: a plain `=` let this arm overwrite the exit that
          // path 2 had already granted, so past the two-day mark a recovered
          // agent was pushed back into depression 95% of the time and the state
          // became effectively permanent.
          shouldExit = shouldExit || Math.random() < 0.05; // 5% per tick after 2 days
        }
        break;
      }

      case 'infatuated': {
        if (!state.target_agent_id) {
          // No love-interest link to evaluate. Pass 1a skips conditional-exit
          // states entirely, so without this fallback the state is permanent.
          shouldExit = state.started_at + state.duration <= currentTick;
          break;
        }
        const rel = db
          .select()
          .from(relationships)
          .where(
            or(
              and(
                eq(relationships.agent_a, agent.id),
                eq(relationships.agent_b, state.target_agent_id),
              ),
              and(
                eq(relationships.agent_a, state.target_agent_id),
                eq(relationships.agent_b, agent.id),
              ),
            ),
          )
          .get();
        if (rel) {
          const isA = rel.agent_a === agent.id;
          const romance = isA ? rel.romance_ab : rel.romance_ba;
          shouldExit = romance < 40;
        } else {
          shouldExit = true; // relationship gone
        }
        break;
      }

      case 'alcoholic': {
        // Recovery path 1: metadata flag set by conversations system
        const meta = (state.metadata as Record<string, any> | null) ?? {};
        if (meta.recoveryTriggered) {
          shouldExit = true;
          break;
        }
        // Recovery path 2: rock bottom (money = 0, no food)
        const eco = db.select({ money: economyTable.money, inventory: economyTable.inventory })
          .from(economyTable).where(eq(economyTable.agent_id, agent.id)).get();
        if (eco && eco.money <= 0) {
          const hasFood = (eco.inventory as any[]).some(
            (i: any) => ['food_raw', 'food_prepared'].includes(i.itemId) && i.quantity > 0
          );
          if (!hasFood && Math.random() < 0.01) {
            shouldExit = true;
          }
        }
        break;
      }

      case 'jealous': {
        const meta = (state.metadata as Record<string, any> | null) ?? {};
        const loveInterestId = meta.loveInterestId as number | undefined;
        const rivalId = meta.rivalId as number | undefined;
        if (!loveInterestId || !rivalId) {
          // Jealousy from a source that didn't record the triangle (e.g. a
          // cascade rule). Exiting immediately would delete it the very next
          // tick, so let it run out its duration instead.
          shouldExit = state.started_at + state.duration <= currentTick;
          break;
        }

        const rel = db.select().from(relationships).where(
          or(
            and(eq(relationships.agent_a, loveInterestId), eq(relationships.agent_b, rivalId)),
            and(eq(relationships.agent_a, rivalId), eq(relationships.agent_b, loveInterestId)),
          )
        ).get();
        if (rel) {
          const isA = rel.agent_a === loveInterestId;
          const rivalRomance = isA ? rel.romance_ab : rel.romance_ba;
          if (rivalRomance < 30) shouldExit = true;
        } else {
          shouldExit = true;
        }

        if (!shouldExit) {
          const ownRel = db.select().from(relationships).where(
            or(
              and(eq(relationships.agent_a, agent.id), eq(relationships.agent_b, loveInterestId)),
              and(eq(relationships.agent_a, loveInterestId), eq(relationships.agent_b, agent.id)),
            )
          ).get();
          if (ownRel) {
            const isA = ownRel.agent_a === agent.id;
            const ownRomance = isA ? ownRel.romance_ab : ownRel.romance_ba;
            if (ownRomance < 30) shouldExit = true;
          }
        }
        // Safety valve: jealousy fades after ~1.5 game days even if romance is still high
        if (!shouldExit) {
          const elapsed = currentTick - state.started_at;
          if (elapsed > 2160 && Math.random() < 0.03) shouldExit = true;
        }
        break;
      }

      case 'in_debt': {
        const eco = db.select({ money: economyTable.money })
          .from(economyTable).where(eq(economyTable.agent_id, agent.id)).get();
        shouldExit = eco != null && eco.money > 20;
        if (shouldExit) brokeSince.delete(agent.id);
        break;
      }

      default:
        break;
    }

    if (shouldExit) {
      if (state.type === 'stressed') {
        stressRemovedAtTick.set(agent.id, currentTick);
      }
      if (state.type === 'alcoholic') {
        alcoholRecoveredAtTick.set(agent.id, currentTick);
        logActivity({
          type: 'state_lost',
          initiator: agent.id,
          templateData: { agent: agent.name, state: 'alcoholic' },
        });
      } else {
        logActivity({
          type: 'state_lost',
          initiator: agent.id,
          templateData: { agent: agent.name, state: state.type },
        });
      }
      simEvents.emit('state:cleared', { agentId: agent.id, state: state.type });
      db.delete(agentStates).where(eq(agentStates.id, state.id)).run();
    }
  }
}

// ─── collectExpiryCascades ────────────────────────────────────────────────────

function collectExpiryCascades(
  state: typeof agentStates.$inferSelect,
  agent: typeof agents.$inferSelect,
  pendingCascades: CascadeEntry[],
) {
  const personality = agent.personality as PersonalityProfile | null;

  if (state.type === 'drunk') {
    // Drunk → Hungover
    pendingCascades.push({
      agentId: agent.id,
      stateType: 'hungover',
      source: 'cascade:drunk',
      severity: state.severity,
    });

    // Drunk + aggression > 50 + disliked agent nearby → Angry
    if (personality && personality.aggression > 50 && agent.current_location != null) {
      const locationOccupants = db
        .select({ current_occupants: locations.current_occupants })
        .from(locations)
        .where(eq(locations.id, agent.current_location))
        .get();

      if (locationOccupants) {
        const occupants = locationOccupants.current_occupants as number[];
        for (const otherId of occupants) {
          if (otherId === agent.id) continue;
          const rel = db
            .select()
            .from(relationships)
            .where(
              or(
                and(eq(relationships.agent_a, agent.id), eq(relationships.agent_b, otherId)),
                and(eq(relationships.agent_a, otherId), eq(relationships.agent_b, agent.id)),
              ),
            )
            .get();
          if (!rel) continue;
          const isA = rel.agent_a === agent.id;
          const friendship = isA ? rel.friendship_ab : rel.friendship_ba;
          if (friendship < -20) {
            pendingCascades.push({
              agentId: agent.id,
              stateType: 'angry',
              source: 'cascade:drunk_expiry',
              targetAgentId: otherId,
              severity: clamp(state.severity * 0.8, 0.4, 1.0),
            });
            break; // one angry cascade per drunk expiry
          }
        }
      }
    }
  }
}

// ─── applyCascades ────────────────────────────────────────────────────────────

function applyCascades(
  cascades: CascadeEntry[],
  currentTick: number,
  depth: number,
  maxDepth: number,
) {
  if (depth >= maxDepth || cascades.length === 0) return;

  const nextCascades: CascadeEntry[] = [];

  for (const cascade of cascades) {
    // Check if this state already exists for the agent
    const existing = db
      .select()
      .from(agentStates)
      .where(
        and(
          eq(agentStates.agent_id, cascade.agentId),
          eq(agentStates.type, cascade.stateType),
        ),
      )
      .get();
    if (existing) continue;

    let duration: number;
    let severity = cascade.severity ?? 0.5;

    switch (cascade.stateType) {
      case 'hungover':
        duration = Math.floor(180 + Math.random() * 180); // 3-6 hours
        break;
      case 'angry':
        duration = Math.floor(180 + Math.random() * 540); // 3-12 hours
        break;
      case 'depressed':
        duration = 999999;
        break;
      case 'sick':
        duration = Math.floor(360 + Math.random() * 720); // 6-18 hours
        break;
      default:
        duration = 240;
        break;
    }

    db.insert(agentStates)
      .values({
        agent_id: cascade.agentId,
        type: cascade.stateType,
        severity,
        started_at: currentTick,
        duration,
        target_agent_id: cascade.targetAgentId ?? null,
        source: cascade.source,
        metadata: null,
      })
      .run();

    {
      const agentName = db.select({ name: agents.name }).from(agents).where(eq(agents.id, cascade.agentId)).get()?.name ?? `Agent#${cascade.agentId}`;
      logActivity({
        type: 'state_gained',
        initiator: cascade.agentId,
        templateData: { agent: agentName, state: cascade.stateType },
      });
      simEvents.emit('state:triggered', { agentId: cascade.agentId, state: cascade.stateType, cause: cascade.source });
    }

    // Collect any expiry cascades from the newly inserted state (only for fixed-duration states)
    // At depth 1 we don't generate further cascades — we only go 2 deep
    if (depth + 1 < maxDepth) {
      // hungover has no cascade-on-expiry, angry could cascade further but we stop here
    }
  }

  if (nextCascades.length > 0) {
    applyCascades(nextCascades, currentTick, depth + 1, maxDepth);
  }
}

// ─── processStateEffects ─────────────────────────────────────────────────────

function processStateEffects(
  agent: typeof agents.$inferSelect,
  states: Array<typeof agentStates.$inferSelect>,
  allAgents: Array<typeof agents.$inferSelect>,
  currentTick: number,
) {
  const personality = agent.personality as PersonalityProfile | null;

  for (const state of states) {
    switch (state.type as StateType) {
      // ── Drunk: random gift purchase near others ──────────────────────────
      case 'drunk': {
        if (agent.current_location == null) break;
        if (Math.random() > 0.30) break;

        const nearbyAgents = allAgents.filter(
          (a) => a.id !== agent.id && a.current_location === agent.current_location,
        );
        if (nearbyAgents.length === 0) break;

        const target = nearbyAgents[Math.floor(Math.random() * nearbyAgents.length)];
        const amount = 5 + Math.random() * 10; // $5-15

        const agentEconomy = db
          .select()
          .from(economyTable)
          .where(eq(economyTable.agent_id, agent.id))
          .get();
        if (!agentEconomy || agentEconomy.money < amount) break;

        db.update(economyTable)
          .set({ money: agentEconomy.money - amount })
          .where(eq(economyTable.agent_id, agent.id))
          .run();

        db.insert(economyTransactions)
          .values({
            from_agent: agent.id,
            to_agent: target.id,
            amount,
            reason: 'drunk_gift',
            items_exchanged: null,
            location_id: agent.current_location,
            timestamp: Date.now(),
          })
          .run();

        // Credit receiver
        const receiverEcon = db
          .select()
          .from(economyTable)
          .where(eq(economyTable.agent_id, target.id))
          .get();
        if (receiverEcon) {
          db.update(economyTable)
            .set({ money: receiverEcon.money + amount })
            .where(eq(economyTable.agent_id, target.id))
            .run();
        }
        break;
      }

      // ── Sick: contagion spread ───────────────────────────────────────────
      case 'sick': {
        if (agent.current_location == null) break;

        const nearbyAgents = allAgents.filter(
          (a) => a.id !== agent.id && a.current_location === agent.current_location,
        );

        // Read meta once, accumulate all updates, then write once
        let meta = { ...((state.metadata as Record<string, any> | null) ?? {}) };

        for (const other of nearbyAgents) {
          // Skip agents with immunity (recently recovered)
          const otherRecovery = sickRecoveredAtTick.get(other.id) ?? -9999;
          if (currentTick - otherRecovery <= 2880) continue;

          const coLocKey = `coloc_${other.id}`;
          meta[coLocKey] = ((meta[coLocKey] as number | undefined) ?? 0) + 1;
          const coLocTicks = meta[coLocKey] as number;

          // Contagion: 1% chance after 30 co-location ticks — low enough to prevent epidemics
          if (coLocTicks > 30 && Math.random() < 0.01) {
            // Spread sick only if other doesn't already have it
            const alreadySick = db
              .select()
              .from(agentStates)
              .where(
                and(eq(agentStates.agent_id, other.id), eq(agentStates.type, 'sick')),
              )
              .get();
            if (!alreadySick) {
              const severity = 0.2 + Math.random() * 0.4;
              const duration = Math.floor(360 + Math.random() * 720); // 6-18 hours
              db.insert(agentStates)
                .values({
                  agent_id: other.id,
                  type: 'sick',
                  severity,
                  started_at: currentTick,
                  duration,
                  source: `cascade:sick_from_${agent.id}`,
                  metadata: null,
                })
                .run();
              createFact('sickness', other.id, null, 1, [other.id, agent.id], 'observed');
            }
          }
        }

        // Doctor/medical_assistant at same location heals — consumes medicine for faster cure
        const healerNearby = allAgents.find((a) => {
          if (a.id === agent.id || a.current_location !== agent.current_location) return false;
          const econ = db.select({ job: economyTable.job }).from(economyTable).where(eq(economyTable.agent_id, a.id)).get();
          return econ && (econ.job === 'doctor' || econ.job === 'medical_assistant');
        });
        if (healerNearby) {
          const healerEcon = db.select().from(economyTable).where(eq(economyTable.agent_id, healerNearby.id)).get();
          const hasMedicine = healerEcon && (healerEcon.inventory as any[]).some(
            (i: any) => i.itemId === 'medicine' && i.quantity > 0
          );

          if (hasMedicine) {
            // Use medicine: much faster healing (severity -0.05/tick, duration halved)
            const newSeverity = Math.max(0, state.severity - 0.05);
            const reducedDuration = Math.max(1, Math.floor(state.duration * 0.5));
            db.update(agentStates)
              .set({ severity: newSeverity, duration: reducedDuration })
              .where(eq(agentStates.id, state.id))
              .run();

            // Consume 1 medicine every 120 ticks (~2 minutes)
            const lastMedUsed = (meta.lastMedicineUsed as number | undefined) ?? 0;
            if (currentTick - lastMedUsed > 120) {
              const newInv = (healerEcon!.inventory as any[]).map((i: any) =>
                i.itemId === 'medicine' ? { ...i, quantity: i.quantity - 1 } : i
              ).filter((i: any) => i.quantity > 0);
              db.update(economyTable).set({ inventory: newInv }).where(eq(economyTable.agent_id, healerNearby.id)).run();
              meta.lastMedicineUsed = currentTick;

              logActivity({
                type: 'system',
                agents: [healerNearby.id, agent.id],
                templateData: { message: `${healerNearby.name} used medicine to treat ${agent.name}.` },
              });
            }
          } else {
            // No medicine: slower healing (original rate)
            const newSeverity = Math.max(0.1, state.severity - 0.01);
            const remainingDuration = (state.started_at + state.duration) - currentTick;
            const reducedDuration = Math.max(1, state.duration - Math.floor(remainingDuration * 0.02));
            db.update(agentStates)
              .set({ severity: newSeverity, duration: reducedDuration })
              .where(eq(agentStates.id, state.id))
              .run();
          }

          // Periodically create a "helped" relationship event (every ~60 ticks)
          const lastHealEvent = (meta.lastHealEvent as number | undefined) ?? 0;
          if (currentTick - lastHealEvent > 60) {
            const [orderedA, orderedB] = agent.id < healerNearby.id
              ? [agent.id, healerNearby.id] : [healerNearby.id, agent.id];
            const isPatientA = orderedA === agent.id;
            db.insert(relationshipEvents).values({
              agent_a: orderedA,
              agent_b: orderedB,
              event_type: 'helped',
              description: `${healerNearby.name} treated ${agent.name}'s ${hasMedicine ? 'illness with medicine' : 'illness'}`,
              friendship_delta_ab: isPatientA ? 3 : 1,
              friendship_delta_ba: isPatientA ? 1 : 3,
              romance_delta_ab: 0,
              romance_delta_ba: 0,
              trust_delta_ab: isPatientA ? 4 : 1,
              trust_delta_ba: isPatientA ? 1 : 4,
              sentiment: 0.5,
              processed: false,
              timestamp: Date.now(),
            }).run();
            meta.lastHealEvent = currentTick;
          }
        }

        // Write accumulated co-location counters once after loop
        db.update(agentStates)
          .set({ metadata: meta })
          .where(eq(agentStates.id, state.id))
          .run();
        break;
      }

      // ── Angry: grudge tag after 480 ticks ────────────────────────────────
      case 'angry': {
        const elapsed = currentTick - state.started_at;
        if (elapsed > 480 && state.target_agent_id != null) {
          const rel = db
            .select()
            .from(relationships)
            .where(
              or(
                and(
                  eq(relationships.agent_a, agent.id),
                  eq(relationships.agent_b, state.target_agent_id),
                ),
                and(
                  eq(relationships.agent_a, state.target_agent_id),
                  eq(relationships.agent_b, agent.id),
                ),
              ),
            )
            .get();

          if (rel) {
            const currentTags = rel.tags as string[];
            if (!currentTags.includes('grudge')) {
              db.update(relationships)
                .set({ tags: [...currentTags, 'grudge'] })
                .where(eq(relationships.id, rel.id))
                .run();
              createFact('grudge', agent.id, state.target_agent_id!, 1, [agent.id], 'witnessed', {
                detail: 'from sustained anger',
              });
            }
          }
        }
        break;
      }

      // ── Euphoric: random generosity ───────────────────────────────────────
      case 'euphoric': {
        if (agent.current_location == null) break;
        if (Math.random() > 0.30) break;

        const nearbyAgents = allAgents.filter(
          (a) => a.id !== agent.id && a.current_location === agent.current_location,
        );
        if (nearbyAgents.length === 0) break;

        const target = nearbyAgents[Math.floor(Math.random() * nearbyAgents.length)];
        const amount = 5 + Math.random() * 5; // $5-10

        const agentEconomy = db
          .select()
          .from(economyTable)
          .where(eq(economyTable.agent_id, agent.id))
          .get();
        if (!agentEconomy || agentEconomy.money < amount) break;

        db.update(economyTable)
          .set({ money: agentEconomy.money - amount })
          .where(eq(economyTable.agent_id, agent.id))
          .run();

        db.insert(economyTransactions)
          .values({
            from_agent: agent.id,
            to_agent: target.id,
            amount,
            reason: 'euphoric_gift',
            items_exchanged: null,
            location_id: agent.current_location,
            timestamp: Date.now(),
          })
          .run();

        // Credit receiver
        const receiverEcon = db
          .select()
          .from(economyTable)
          .where(eq(economyTable.agent_id, target.id))
          .get();
        if (receiverEcon) {
          db.update(economyTable)
            .set({ money: receiverEcon.money + amount })
            .where(eq(economyTable.agent_id, target.id))
            .run();
        }

        // +3 friendship from generous gift
        const rel = db
          .select()
          .from(relationships)
          .where(
            or(
              and(eq(relationships.agent_a, agent.id), eq(relationships.agent_b, target.id)),
              and(eq(relationships.agent_a, target.id), eq(relationships.agent_b, agent.id)),
            ),
          )
          .get();
        if (rel) {
          const isA = rel.agent_a === agent.id;
          if (isA) {
            db.update(relationships)
              .set({ friendship_ab: clamp(rel.friendship_ab + 3, -100, 100) })
              .where(eq(relationships.id, rel.id))
              .run();
          } else {
            db.update(relationships)
              .set({ friendship_ba: clamp(rel.friendship_ba + 3, -100, 100) })
              .where(eq(relationships.id, rel.id))
              .run();
          }
        }
        break;
      }

      // ── Infatuated: jealousy check ────────────────────────────────────────
      case 'infatuated': {
        if (!state.target_agent_id) break;

        // Find if target is in a conversation with a high-sensuality agent
        const targetConvo = db
          .select()
          .from(conversations)
          .where(eq(conversations.status, 'active'))
          .all()
          .find((c) => {
            const parts = c.participants as number[];
            if (!parts.includes(state.target_agent_id!)) return false;
            return parts.some((pid) => {
              if (pid === state.target_agent_id || pid === agent.id) return false;
              const otherAgent = db
                .select({ personality: agents.personality })
                .from(agents)
                .where(eq(agents.id, pid))
                .get();
              const op = otherAgent?.personality as PersonalityProfile | null;
              return (op?.sensuality ?? 0) > 50;
            });
          });

        if (targetConvo) {
          // Mood penalty for jealousy — apply via needs
          const agentNeedsRow = db
            .select()
            .from(needsTable)
            .where(eq(needsTable.agent_id, agent.id))
            .get();
          if (agentNeedsRow) {
            db.update(needsTable)
              .set({ mood: clamp(agentNeedsRow.mood - 10, 0, 100) })
              .where(eq(needsTable.agent_id, agent.id))
              .run();
          }
        }
        break;
      }

      // ── Confident: fragile vanity → cascade angry on negative convo ──────
      case 'confident': {
        if (!personality || personality.vanity <= 60) break;

        const msPerTick = CONFIG.TICK_INTERVAL_MS;
        const sinceWindow = Date.now() - 30 * msPerTick;
        const negativeConvo = db
          .select()
          .from(conversations)
          .where(and(lt(conversations.sentiment, -0.3), gt(conversations.started_at, sinceWindow)))
          .all()
          .find((c) => (c.participants as number[]).includes(agent.id));

        if (!negativeConvo) break;

        const alreadyAngry = db
          .select()
          .from(agentStates)
          .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, 'angry')))
          .get();
        if (alreadyAngry) break;

        const parts = negativeConvo.participants as number[];
        const targetId = parts.find((p) => p !== agent.id);
        const severity = clamp(personality.vanity / 100, 0.4, 1.0);
        const duration = Math.floor(180 + Math.random() * 300);

        db.insert(agentStates)
          .values({
            agent_id: agent.id,
            type: 'angry',
            severity,
            started_at: currentTick,
            duration,
            target_agent_id: targetId ?? null,
            source: 'cascade:confident_vanity',
            metadata: null,
          })
          .run();

        // Remove confident state since it shattered
        db.delete(agentStates).where(eq(agentStates.id, state.id)).run();
        break;
      }

      // ── Hungover: review drunk memories for regret ────────────────────────
      case 'hungover': {
        if (state.metadata?.regretProcessed) break;

        // Find memories created while agent was drunk (around when this state started)
        const recentConvoMemories = db
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.agent_id, agent.id),
              eq(memories.type, 'conversation'),
              gt(memories.created_at, state.started_at - 300),
            ),
          )
          .all();

        for (const mem of recentConvoMemories) {
          const relatedAgents = ((mem.metadata as Record<string, unknown>)?.related_agents as number[] | undefined) ?? [];
          for (const otherId of relatedAgents) {
            const rel = db
              .select()
              .from(relationships)
              .where(
                or(
                  and(
                    eq(relationships.agent_a, Math.min(agent.id, otherId)),
                    eq(relationships.agent_b, Math.max(agent.id, otherId)),
                  ),
                ),
              )
              .get();
            if (!rel) continue;

            const friendship = agent.id < otherId ? rel.friendship_ab : rel.friendship_ba;
            if (friendship > 40) {
              const otherName =
                db
                  .select({ name: agents.name })
                  .from(agents)
                  .where(eq(agents.id, otherId))
                  .get()?.name ?? 'them';

              const regretContent = `I feel terrible about what I said to ${otherName} while drunk.`;
              const regretResult = db.insert(memories)
                .values({
                  agent_id: agent.id,
                  description: regretContent,
                  type: 'emotional',
                  importance: 4,
                  emotional_valence: -0.6,
                  embedding: null,
                  depth: 0,
                  created_at: currentTick,
                  last_accessed: currentTick,
                  metadata: { related_agents: [otherId], tags: ['regret', 'drunk'] },
                  is_active: 1,
                  parent_ids: [],
                })
                .returning({ id: memories.id })
                .get();
              taskRunner.generateEmbedding(regretResult.id, regretContent);

              // Friendship penalty
              if (agent.id < otherId) {
                db.update(relationships)
                  .set({ friendship_ab: clamp(friendship - 5, -100, 100) })
                  .where(eq(relationships.id, rel.id))
                  .run();
              } else {
                db.update(relationships)
                  .set({ friendship_ba: clamp(friendship - 5, -100, 100) })
                  .where(eq(relationships.id, rel.id))
                  .run();
              }
            }
          }
        }

        // Mark regret as processed so it only runs once per hangover
        db.update(agentStates)
          .set({ metadata: { ...(state.metadata as Record<string, any> | null ?? {}), regretProcessed: true } })
          .where(eq(agentStates.id, state.id))
          .run();
        break;
      }

      // ── Alcoholic: shame mood penalty ────────────────────────────────────
      case 'alcoholic': {
        if (personality && personality.morality > 70) {
          const alcNeeds = db.select().from(needsTable).where(eq(needsTable.agent_id, agent.id)).get();
          if (alcNeeds) {
            db.update(needsTable).set({ mood: Math.max(20, alcNeeds.mood - 0.5) }).where(eq(needsTable.agent_id, agent.id)).run();
          }
        }
        break;
      }

      // ── In Debt: mood penalty + theft attempts ───────────────────────────
      case 'in_debt': {
        const debtNeeds = db.select().from(needsTable).where(eq(needsTable.agent_id, agent.id)).get();
        if (debtNeeds) {
          db.update(needsTable).set({ mood: Math.max(5, debtNeeds.mood - 0.3) }).where(eq(needsTable.agent_id, agent.id)).run();
        }

        if (agent.current_location == null) break;
        if (!personality) break;

        const meta = (state.metadata as Record<string, any> | null) ?? {};
        const desperationUnlocked = meta.desperationUnlocked as boolean ?? false;
        const moralityThreshold = desperationUnlocked ? 50 : 40;

        if (personality.morality >= moralityThreshold) break;
        if (Math.random() > 0.05) break;

        const loc = db.select().from(locations).where(eq(locations.id, agent.current_location)).get();
        if (!loc?.owner || loc.owner === agent.id) break;

        const ownerEcon = db.select().from(economyTable).where(eq(economyTable.agent_id, loc.owner)).get();
        if (!ownerEcon || (ownerEcon.inventory as any[]).length === 0) break;

        const items = ownerEcon.inventory as Array<{ itemId: string; quantity: number; acquiredAt: number }>;
        const targetItem = items.find((i) => i.quantity > 0);
        if (!targetItem) break;

        // Detection chance
        const witnesses = allAgents.filter(
          (a) => a.id !== agent.id && a.current_location === agent.current_location
        );
        let detectionChance = 0.3 + witnesses.length * 0.1;
        for (const w of witnesses) {
          const wp = w.personality as PersonalityProfile | null;
          if (wp && wp.curiosity > 60) detectionChance += 0.1;
        }
        detectionChance = Math.min(detectionChance, 0.95);

        const caught = Math.random() < detectionChance;

        // Transfer item
        const newOwnerInv = items.map((i) =>
          i.itemId === targetItem.itemId ? { ...i, quantity: i.quantity - 1 } : i
        ).filter((i) => i.quantity > 0);
        db.update(economyTable).set({ inventory: newOwnerInv }).where(eq(economyTable.agent_id, loc.owner)).run();

        const thiefEcon = db.select().from(economyTable).where(eq(economyTable.agent_id, agent.id)).get();
        if (thiefEcon) {
          const existing = (thiefEcon.inventory as any[]).find((i: any) => i.itemId === targetItem.itemId);
          let newThiefInv;
          if (existing) {
            newThiefInv = (thiefEcon.inventory as any[]).map((i: any) =>
              i.itemId === targetItem.itemId ? { ...i, quantity: i.quantity + 1 } : i
            );
          } else {
            newThiefInv = [...(thiefEcon.inventory as any[]), { itemId: targetItem.itemId, quantity: 1, acquiredAt: Date.now() }];
          }
          db.update(economyTable).set({ inventory: newThiefInv }).where(eq(economyTable.agent_id, agent.id)).run();
        }

        if (!caught) {
          simEvents.emit('economy:theft_success', { agentId: agent.id, item: targetItem.itemId, locationName: loc.name });
        }

        if (caught) {
          simEvents.emit('economy:theft_caught', { agentId: agent.id, item: targetItem.itemId, locationName: loc.name });
          const witnessIds = witnesses.map((w) => w.id);
          createFact('theft', agent.id, loc.owner, 2, [agent.id, loc.owner, ...witnessIds], 'witnessed', {
            item: targetItem.itemId, location: loc.name,
          });

          // Check theft escalation: 3+ theft shared_knowledge = reputation + banned
          const totalThefts = db.select().from(shared_knowledge)
            .where(and(eq(shared_knowledge.type, 'theft'), eq(shared_knowledge.subject_id, agent.id), eq(shared_knowledge.is_active, true))).all();
          if (totalThefts.length >= 3) {
            createFact('reputation', agent.id, null, 1, allAgents.map(a => a.id), 'observed');
            const ownerRel = db.select().from(relationships).where(
              or(
                and(eq(relationships.agent_a, agent.id), eq(relationships.agent_b, loc.owner)),
                and(eq(relationships.agent_a, loc.owner), eq(relationships.agent_b, agent.id)),
              )
            ).get();
            if (ownerRel) {
              const tags = ownerRel.tags as string[];
              if (!tags.includes('banned')) {
                db.update(relationships).set({ tags: [...tags, 'banned'] }).where(eq(relationships.id, ownerRel.id)).run();
              }
            }
          }

          const [ordA, ordB] = [Math.min(agent.id, loc.owner), Math.max(agent.id, loc.owner)];
          db.insert(relationshipEvents).values({
            agent_a: ordA, agent_b: ordB,
            event_type: 'theft_caught',
            description: `${agent.name} was caught stealing ${targetItem.itemId} from ${loc.name}`,
            friendship_delta_ab: agent.id === ordA ? -15 : 0,
            friendship_delta_ba: agent.id === ordA ? 0 : -15,
            romance_delta_ab: 0, romance_delta_ba: 0,
            trust_delta_ab: agent.id === ordA ? -30 : 0,
            trust_delta_ba: agent.id === ordA ? 0 : -30,
            sentiment: -0.8,
            processed: false,
            timestamp: Date.now(),
          }).run();

          logActivity({
            type: 'drama',
            initiator: agent.id,
            target: loc.owner ?? undefined,
            templateData: { description: `${agent.name} was caught stealing from ${loc.name}!` },
          });

          // Observation memories for witnesses
          for (const w of witnesses) {
            simEvents.emit('interaction:completed', {
              agentId: w.id,
              otherName: agent.name,
              action: `saw ${agent.name} steal from ${loc.name}`,
            });
          }
          // Thief's own memory
          simEvents.emit('interaction:completed', {
            agentId: agent.id,
            otherName: loc.name,
            action: `stole ${targetItem.itemId} from ${loc.name}${caught ? ' and got caught' : ''}`,
          });
        } else {
          const updatedMeta = { ...meta, theftCount: ((meta.theftCount as number) ?? 0) + 1 };
          db.update(agentStates).set({ metadata: updatedMeta }).where(eq(agentStates.id, state.id)).run();
        }
        break;
      }

      // ── Jealous: mood penalty, grudge escalation, confrontation ──────────
      case 'jealous': {
        const jealousNeeds = db.select().from(needsTable).where(eq(needsTable.agent_id, agent.id)).get();
        if (jealousNeeds) {
          db.update(needsTable).set({ mood: Math.max(5, jealousNeeds.mood - 0.2) }).where(eq(needsTable.agent_id, agent.id)).run();
        }

        const meta = (state.metadata as Record<string, any> | null) ?? {};
        const rivalId = meta.rivalId as number | undefined;

        if (rivalId && personality && personality.aggression > 60) {
          const elapsed = currentTick - state.started_at;
          if (elapsed > 480) {
            const rel = db.select().from(relationships).where(
              or(
                and(eq(relationships.agent_a, agent.id), eq(relationships.agent_b, rivalId)),
                and(eq(relationships.agent_a, rivalId), eq(relationships.agent_b, agent.id)),
              )
            ).get();
            if (rel) {
              const tags = rel.tags as string[];
              if (!tags.includes('grudge')) {
                db.update(relationships).set({ tags: [...tags, 'grudge'] }).where(eq(relationships.id, rel.id)).run();
                const loveInterestId2 = meta.loveInterestId as number | undefined;
                createFact('grudge', agent.id, rivalId, 1, [agent.id], 'witnessed', {
                  detail: loveInterestId2 ? `jealousy over ${db.select({ name: agents.name }).from(agents).where(eq(agents.id, loveInterestId2)).get()?.name ?? 'someone'}` : 'jealousy',
                });
              }
            }
          }
        }

        // Rumor about rival if low morality + dishonest
        if (rivalId && personality && personality.morality < 40 && personality.honesty < 30) {
          const elapsed = currentTick - state.started_at;
          if (elapsed > 720 && Math.random() < 0.005) {
            createFact('rumor', rivalId, null, 2, [agent.id], 'fabricated');
          }
        }
        break;
      }

      default:
        break;
    }
  }

  // ── Doctor: treat alcoholism and depression at clinic ──────────────────
  if (agent.current_location != null) {
    const agentEconJob = db.select({ job: economyTable.job }).from(economyTable).where(eq(economyTable.agent_id, agent.id)).get();
    if (agentEconJob && (agentEconJob.job === 'doctor' || agentEconJob.job === 'medical_assistant')) {
      // Zone gate: healer must be at clinic:exam_room
      const healerZone = zoneOccupancy.findAgentZone(agent.id);
      const inClinicExamRoom = healerZone?.building === 'clinic' && healerZone.zone === 'exam_room';
      const healerEcon = db.select().from(economyTable).where(eq(economyTable.agent_id, agent.id)).get();
      const hasMedicine = healerEcon && (healerEcon.inventory as any[]).some(
        (i: any) => i.itemId === 'medicine' && i.quantity > 0
      );

      if (inClinicExamRoom && hasMedicine) {
        const nearbyPatients = allAgents.filter(
          (a) => a.id !== agent.id && a.current_location === agent.current_location,
        );

        for (const patient of nearbyPatients) {
          const patientStates = db.select().from(agentStates)
            .where(eq(agentStates.agent_id, patient.id)).all();

          // Treat alcoholism: consume medicine, trigger recovery
          const alcoholicState = patientStates.find(s => s.type === 'alcoholic');
          if (alcoholicState && Math.random() < 0.02) { // 2% per tick
            const alcMeta = { ...((alcoholicState.metadata as any) ?? {}), recoveryTriggered: true };
            db.update(agentStates).set({ metadata: alcMeta }).where(eq(agentStates.id, alcoholicState.id)).run();

            // Consume medicine
            const newInv = (healerEcon!.inventory as any[]).map((i: any) =>
              i.itemId === 'medicine' ? { ...i, quantity: i.quantity - 1 } : i
            ).filter((i: any) => i.quantity > 0);
            db.update(economyTable).set({ inventory: newInv }).where(eq(economyTable.agent_id, agent.id)).run();

            logActivity({
              type: 'system',
              agents: [agent.id, patient.id],
              templateData: { message: `${agent.name} is treating ${patient.name}'s alcoholism.` },
            });

            const [ordA, ordB] = [Math.min(agent.id, patient.id), Math.max(agent.id, patient.id)];
            db.insert(relationshipEvents).values({
              agent_a: ordA, agent_b: ordB,
              event_type: 'helped',
              description: `${agent.name} treated ${patient.name}'s alcoholism with medicine`,
              friendship_delta_ab: 5, friendship_delta_ba: 5,
              romance_delta_ab: 0, romance_delta_ba: 0,
              trust_delta_ab: 6, trust_delta_ba: 6,
              sentiment: 0.6, processed: false, timestamp: Date.now(),
            }).run();
            break; // One treatment per tick
          }

          // Treat depression: consume medicine, remove depressed state
          const depressedState = patientStates.find(s => s.type === 'depressed');
          if (depressedState && Math.random() < 0.03) { // 3% per tick
            db.delete(agentStates).where(eq(agentStates.id, depressedState.id)).run();

            // Consume medicine
            const newInv = (healerEcon!.inventory as any[]).map((i: any) =>
              i.itemId === 'medicine' ? { ...i, quantity: i.quantity - 1 } : i
            ).filter((i: any) => i.quantity > 0);
            db.update(economyTable).set({ inventory: newInv }).where(eq(economyTable.agent_id, agent.id)).run();

            // Mood boost
            const patientNeeds = db.select().from(needsTable).where(eq(needsTable.agent_id, patient.id)).get();
            if (patientNeeds) {
              db.update(needsTable).set({ mood: Math.min(100, patientNeeds.mood + 20) }).where(eq(needsTable.agent_id, patient.id)).run();
            }

            logActivity({
              type: 'system',
              agents: [agent.id, patient.id],
              templateData: { message: `${agent.name} treated ${patient.name}'s depression with medicine.` },
            });

            const [ordA, ordB] = [Math.min(agent.id, patient.id), Math.max(agent.id, patient.id)];
            db.insert(relationshipEvents).values({
              agent_a: ordA, agent_b: ordB,
              event_type: 'helped',
              description: `${agent.name} treated ${patient.name}'s depression`,
              friendship_delta_ab: 4, friendship_delta_ba: 4,
              romance_delta_ab: 0, romance_delta_ba: 0,
              trust_delta_ab: 5, trust_delta_ba: 5,
              sentiment: 0.7, processed: false, timestamp: Date.now(),
            }).run();
            break; // One treatment per tick
          }
        }
      }
    }
  }

  // ── Gambling: impulsive agents at tavern gamble (not state-dependent) ──
  if (personality && personality.impulsiveness > 40 && agent.current_location != null) {
    const loc = db.select({ type: locations.type }).from(locations).where(eq(locations.id, agent.current_location)).get();
    // Zone gate: gambling requires tavern:tables zone
    const gamblerZone = zoneOccupancy.findAgentZone(agent.id);
    const atTables = gamblerZone?.building === 'tavern' && gamblerZone.zone === 'tables';
    if (loc?.type === 'tavern' && atTables && Math.random() < 0.08) {
      const agentEcon = db.select().from(economyTable).where(eq(economyTable.agent_id, agent.id)).get();
      if (agentEcon && agentEcon.money > 10) {
        const nearbyAgents = allAgents.filter(
          (a) => {
            if (a.id === agent.id || a.current_location !== agent.current_location) return false;
            // Opponent must also be at the tavern:tables zone
            const oppZone = zoneOccupancy.findAgentZone(a.id);
            return oppZone?.building === 'tavern' && oppZone.zone === 'tables';
          },
        );
        if (nearbyAgents.length > 0) {
          const opponent = nearbyAgents[Math.floor(Math.random() * nearbyAgents.length)];
          const pairKey = [agent.id, opponent.id].sort().join('-');
          const lastGamble = gamblingCooldowns.get(pairKey) ?? 0;
          if (currentTick - lastGamble >= 120) {
            const opponentPersonality = opponent.personality as PersonalityProfile | null;
            const betAmount = Math.floor(agentEcon.money * (0.1 + Math.random() * 0.2));

            const agentCuriosity = personality.curiosity ?? 50;
            const opponentCuriosity = opponentPersonality?.curiosity ?? 50;
            const winChance = clamp(0.5 + (agentCuriosity - opponentCuriosity) * 0.002, 0.4, 0.6);
            const agentWins = Math.random() < winChance;

            const opponentEcon = db.select().from(economyTable).where(eq(economyTable.agent_id, opponent.id)).get();
            if (opponentEcon && opponentEcon.money >= betAmount) {
              if (agentWins) {
                db.update(economyTable).set({ money: agentEcon.money + betAmount }).where(eq(economyTable.agent_id, agent.id)).run();
                db.update(economyTable).set({ money: opponentEcon.money - betAmount }).where(eq(economyTable.agent_id, opponent.id)).run();
              } else {
                db.update(economyTable).set({ money: agentEcon.money - betAmount }).where(eq(economyTable.agent_id, agent.id)).run();
                db.update(economyTable).set({ money: opponentEcon.money + betAmount }).where(eq(economyTable.agent_id, opponent.id)).run();

                if (agentEcon.money - betAmount < 5) {
                  createFact('gambling_loss', agent.id, null, 1, [agent.id, opponent.id], 'witnessed', {
                    detail: `$${betAmount} to ${opponent.name}`,
                  });
                }
              }

              db.insert(economyTransactions).values({
                from_agent: agentWins ? opponent.id : agent.id,
                to_agent: agentWins ? agent.id : opponent.id,
                amount: betAmount,
                reason: 'gambling',
                items_exchanged: null,
                location_id: agent.current_location,
                timestamp: Date.now(),
              }).run();

              const [ordA, ordB] = [Math.min(agent.id, opponent.id), Math.max(agent.id, opponent.id)];
              db.insert(relationshipEvents).values({
                agent_a: ordA,
                agent_b: ordB,
                event_type: 'gambling',
                description: `Gambling at the tavern — ${agentWins ? agent.name : opponent.name} won $${betAmount}`,
                friendship_delta_ab: agentWins === (agent.id === ordA) ? 2 : -3,
                friendship_delta_ba: agentWins === (agent.id === ordA) ? -3 : 2,
                romance_delta_ab: 0, romance_delta_ba: 0,
                trust_delta_ab: -1, trust_delta_ba: -1,
                sentiment: 0,
                processed: false,
                timestamp: Date.now(),
              }).run();

              logActivity({
                type: 'drama',
                initiator: agent.id,
                target: opponent.id,
                templateData: { description: `${agent.name} and ${opponent.name} gambled at the tavern — ${agentWins ? agent.name : opponent.name} won $${betAmount}` },
              });
              simEvents.emit('economy:gambling', { agentId: agent.id, amount: betAmount, won: agentWins, opponentName: opponent.name });
              gamblingCooldowns.set(pairKey, currentTick);

              // Track gambling frequency for addiction detection
              const gambHistory = gamblingHistory.get(agent.id) ?? [];
              gambHistory.push(currentTick);
              // Keep only last 3 game days (4320 ticks)
              const recentGambles = gambHistory.filter(t => currentTick - t < 4320);
              gamblingHistory.set(agent.id, recentGambles);

              // Trigger gambling_addict state if 5+ gambles in 3 days
              const agentActiveTypes = new Set(
                db.select({ type: agentStates.type }).from(agentStates).where(eq(agentStates.agent_id, agent.id)).all().map(s => s.type)
              );
              if (recentGambles.length >= 5 && !agentActiveTypes.has('gambling_addict')) {
                db.insert(agentStates).values({
                  agent_id: agent.id,
                  type: 'gambling_addict',
                  severity: 0.5,
                  started_at: currentTick,
                  duration: 999999,
                  source: 'gambling:frequency',
                  metadata: null,
                }).run();
                simEvents.emit('state:triggered', { agentId: agent.id, state: 'gambling_addict', cause: 'frequent gambling' });
                logActivity({ type: 'state_gained', initiator: agent.id, templateData: { agent: agent.name, state: 'gambling_addict' } });
              }
            }
          }
        }
      }
    }
  }

  // ── Seduction: manipulative flirting for personal gain ──────────────────
  if (personality && personality.sensuality > 70 && personality.morality < 40 && agent.current_location != null) {
    if (Math.random() < 0.02) {
      const nearbyTargets = allAgents.filter(a => {
        if (a.id === agent.id || a.current_location !== agent.current_location) return false;
        const tp = a.personality as PersonalityProfile | null;
        if (!tp || tp.sensuality <= 50) return false;
        return true;
      });

      if (nearbyTargets.length > 0) {
        const target = nearbyTargets[Math.floor(Math.random() * nearbyTargets.length)];
        const [ordA, ordB] = [Math.min(agent.id, target.id), Math.max(agent.id, target.id)];

        db.insert(relationshipEvents).values({
          agent_a: ordA, agent_b: ordB,
          event_type: 'seduction',
          description: `${agent.name} is flirting with ${target.name} for personal gain`,
          friendship_delta_ab: 2, friendship_delta_ba: 2,
          romance_delta_ab: agent.id === ordA ? 5 : 3,
          romance_delta_ba: agent.id === ordA ? 3 : 5,
          trust_delta_ab: 0, trust_delta_ba: 0,
          sentiment: 0.3, processed: false, timestamp: Date.now(),
        }).run();

        simEvents.emit('social:seduction', { agentId: agent.id, targetName: target.name });

        // Create seduction fact if witnesses present
        const witnesses = allAgents.filter(a =>
          a.id !== agent.id && a.id !== target.id && a.current_location === agent.current_location
        );
        if (witnesses.length > 0) {
          createFact('seduction', agent.id, target.id, 2,
            [agent.id, ...witnesses.map(w => w.id)], 'witnessed');
        }
      }
    }
  }

  // ── Manipulation: dishonest + curious agents fabricate rumors ──────────
  if (personality && personality.honesty < 30 && personality.curiosity > 60) {
    if (Math.random() < 0.005) { // 0.5% per tick — very rare
      // Pick a target to spread rumors about (not a close friend)
      const agentRels = db.select().from(relationships)
        .where(or(eq(relationships.agent_a, agent.id), eq(relationships.agent_b, agent.id))).all();
      const potentialTargets = allAgents.filter(a => {
        if (a.id === agent.id) return false;
        const rel = agentRels.find(r =>
          (r.agent_a === agent.id && r.agent_b === a.id) ||
          (r.agent_b === agent.id && r.agent_a === a.id)
        );
        if (!rel) return true; // stranger is fair game
        const isA = rel.agent_a === agent.id;
        const friendship = isA ? rel.friendship_ab : rel.friendship_ba;
        return friendship < 40; // not a friend
      });
      if (potentialTargets.length > 0) {
        const target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
        createFact('rumor', target.id, null, 2, [agent.id], 'fabricated');

        logActivity({
          type: 'drama',
          initiator: agent.id,
          target: target.id,
          templateData: { description: `${agent.name} started spreading rumors about ${target.name}.` },
        });
      }
    }
  }
}
