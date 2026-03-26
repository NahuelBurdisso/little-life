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
} from '../../db/schema';
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface CascadeEntry {
  agentId: number;
  stateType: StateType;
  source: string;
  targetAgentId?: number;
  severity?: number;
}

// ─── Module-level state ───────────────────────────────────────────────────────

let previouslyActiveAgents = new Set<number>();

// Track ticks where an agent had stressed state removed (to avoid re-triggering immediately)
const stressRemovedAtTick = new Map<number, number>();

// Track tick when mood first dropped below 15 (for depressed trigger duration check)
const lowMoodSince = new Map<number, number>(); // agentId → tick when mood first dropped below 15

// Track tick when social first dropped below 20 (for lonely trigger duration check)
const lowSocialSince = new Map<number, number>(); // agentId → tick when social dropped below 20

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

  spreadPublicKnowledge();
  deactivateStaleFacts();

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
      if (loc?.type === 'tavern' && Math.random() < personality.impulsiveness / 100) {
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
        activeTypes.add('drunk');
      }
    }
  }

  // ── Sick ──────────────────────────────────────────────────────────────────
  if (!activeTypes.has('sick')) {
    const weatherMult = weather === 'rainy' || weather === 'stormy' ? 3 : 1;
    const seasonMult = season === 'winter' ? 2 : 1;
    const energyMult = agentNeeds && agentNeeds.energy < 25 ? 2 : 1;
    const sickChance = 0.001 * weatherMult * seasonMult * energyMult;
    if (Math.random() < sickChance) {
      const severity = 0.3 + Math.random() * 0.5;
      const duration = Math.floor(1440 + Math.random() * 2880); // 1-3 days
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
      activeTypes.add('sick');
      createFact('sickness', agent.id, null, 1, [agent.id], 'observed');
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
    if (lowNeedsCount >= 3 && currentTick - lastRemoved > 30) {
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
      activeTypes.add('stressed');
    }
  }

  // ── Euphoric ──────────────────────────────────────────────────────────────
  if (!activeTypes.has('euphoric') && agentNeeds && agentNeeds.mood > 80) {
    const msPerTick = CONFIG.TICK_INTERVAL_MS;
    const sinceWindow = Date.now() - 60 * msPerTick;
    const positiveConvoRows = db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.status, 'ended'),
          gt(conversations.sentiment, 0.8),
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

  // ── Lonely ────────────────────────────────────────────────────────────────
  if (!activeTypes.has('lonely') && agentNeeds) {
    if (agentNeeds.social < 20) {
      if (!lowSocialSince.has(agent.id)) {
        lowSocialSince.set(agent.id, currentTick);
      }
      const socialDuration = currentTick - lowSocialSince.get(agent.id)!;
      if (socialDuration >= 60) {
        const sinceWindow = Date.now() - 1440000; // last 24 minutes real-time (1440 ticks × 1000ms)
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
          activeTypes.add('lonely');
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
      activeTypes.add('depressed');
    }
  }

  // ── Confident ─────────────────────────────────────────────────────────────
  if (!activeTypes.has('confident') && personality.vanity > 50) {
    const msPerTick = CONFIG.TICK_INTERVAL_MS;
    const sinceWindow = Date.now() - 1440 * msPerTick;
    const positiveConvos = db
      .select()
      .from(conversations)
      .where(and(gt(conversations.sentiment, 0.3), gt(conversations.started_at, sinceWindow)))
      .all()
      .filter((c) => (c.participants as number[]).includes(agent.id));

    if (positiveConvos.length >= 3) {
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
        // Exits ONLY when a warm friend initiates a positive conversation
        const msPerTick = CONFIG.TICK_INTERVAL_MS;
        const sinceWindow = Date.now() - 60 * msPerTick;
        const recentPositiveConvos = db
          .select()
          .from(conversations)
          .where(and(gt(conversations.sentiment, 0.3), gt(conversations.started_at, sinceWindow)))
          .all()
          .filter((c) => {
            const parts = c.participants as number[];
            if (!parts.includes(agent.id)) return false;
            // Check if another participant is a warm friend
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
              const otherAgent = db
                .select({ personality: agents.personality })
                .from(agents)
                .where(eq(agents.id, otherId))
                .get();
              const otherPersonality = otherAgent?.personality as PersonalityProfile | null;
              return friendship > 50 && (otherPersonality?.warmth ?? 0) > 50;
            });
          });
        shouldExit = recentPositiveConvos.length > 0;
        break;
      }

      case 'infatuated': {
        if (!state.target_agent_id) break;
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

      default:
        break;
    }

    if (shouldExit) {
      if (state.type === 'stressed') {
        stressRemovedAtTick.set(agent.id, currentTick);
      }
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
        duration = Math.floor(1440 + Math.random() * 2880);
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
            timestamp: currentTick,
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
          const coLocKey = `coloc_${other.id}`;
          meta[coLocKey] = ((meta[coLocKey] as number | undefined) ?? 0) + 1;
          const coLocTicks = meta[coLocKey] as number;

          if (coLocTicks > 10 && Math.random() < 0.30) {
            // Spread sick only if other doesn't already have it
            const alreadySick = db
              .select()
              .from(agentStates)
              .where(
                and(eq(agentStates.agent_id, other.id), eq(agentStates.type, 'sick')),
              )
              .get();
            if (!alreadySick) {
              const severity = 0.3 + Math.random() * 0.5;
              const duration = Math.floor(1440 + Math.random() * 2880);
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
            }
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
              createFact('grudge', agent.id, state.target_agent_id!, 1, [agent.id], 'witnessed');
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
            timestamp: currentTick,
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
              gt(memories.timestamp, state.started_at - 300),
            ),
          )
          .all();

        for (const mem of recentConvoMemories) {
          const relatedAgents = (mem.related_agents as number[]) ?? [];
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
                  content: regretContent,
                  type: 'emotional',
                  importance: 4,
                  emotional_valence: -0.6,
                  embedding: null,
                  related_agents: [otherId],
                  related_location: null,
                  tags: ['regret', 'drunk'],
                  timestamp: currentTick,
                  access_count: 0,
                  last_accessed: currentTick,
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

      default:
        break;
    }
  }
}
