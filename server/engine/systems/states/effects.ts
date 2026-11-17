/**
 * Pass 3 of the states phase: what each active state makes the agent do this tick.
 */

import { db } from '../../../db';
import {
  agents,
  agentStates,
  relationships,
  conversations,
  locations,
  economy as economyTable,
  economyTransactions,
  relationshipEvents,
  memories,
  shared_knowledge,
} from '../../../db/schema';
import { logActivity } from '../../../lib/activityLogger';
import { eq, and, gt, lt, or } from 'drizzle-orm';
import { PersonalityProfile } from '../../../lib/personality';
import { clamp } from '../../../lib/utils';
import { StateType, type AgentStateRow } from '../../../lib/states';
import { isIntimacyEligible } from '../../../lib/intimacy/eligibility';
import { createFact, getAgentName, jealousRumorContext } from '../../../lib/gossip';
import { taskRunner } from '../../../ai/taskRunner';
import { simEvents } from '../../../lib/simEvents';
import { contagionMultiplier, getRules, sicknessMultiplier, type LiveRules } from '../../../lib/worldRules';
import { zoneOccupancy } from '../../../lib/interiorGrid';
import { giveImpulsiveGift } from '../../../lib/giftEngine';
import { chancePerTick } from '../../../lib/gameClock';
import { itemPhrase } from '../../../data/economyData';
import { gameMinutesToMs } from '../../../lib/worldClock';
import { HEALER_JOBS } from '../../../lib/careers';
import { isGravelyIll, worsen, worsenChancePerMinute } from '../../../lib/sickness';
import { addMoodModifier } from '../../../lib/dailyLife';
import { type AgentRow, type StatesTickContext } from './context';
import { gamblingCooldowns, gamblingHistory, sickRecoveredAt } from './trackers';

const isHealerJob = (job: string | undefined) => job != null && HEALER_JOBS.includes(job);

/**
 * Recovery of a sick resident resting at home while nobody in town can treat
 * them, per game minute: severity down, and this share of the time left
 * taken off. Below a healer's no-medicine rate (0.01 and 2%) — a doctor is
 * still worth having — but the illness is kept moving: when the doctor died
 * the sick used to walk to the empty clinic and wait there for someone who
 * would never come.
 */
export const HOME_REST_RECOVERY = { SEVERITY_PER_MINUTE: 0.004, REMAINING_SHARE_PER_MINUTE: 0.008 } as const;

/**
 * Who a manipulative flirt may set their sights on: someone in the same room
 * with a sensual streak, AND intimacy-eligible with the seducer. The eligibility
 * gate is the adults-only line (a minor is never a target, and never a target's
 * seducer) plus orientation, so a seducer does not pick someone neither of them
 * could be drawn to. The relationship tick zeroes the romance of any such event
 * that slips through some other way; this keeps the story from even starting.
 */
export function seductionTargets(agent: AgentRow, allAgents: AgentRow[]): AgentRow[] {
  return allAgents.filter(a => {
    if (a.id === agent.id || a.current_location !== agent.current_location) return false;
    const tp = a.personality as PersonalityProfile | null;
    if (!tp || tp.sensuality <= 50) return false;
    return isIntimacyEligible(agent, a);
  });
}

/**
 * Per-game-minute chance a sick agent passes it to someone who has shared the
 * room with them for over 30 minutes. 1% at the default 'low' — low enough to
 * prevent epidemics — scaled by the world's "Contagion Rate" ('off' = 0).
 */
export function contagionChancePerMinute(rules: LiveRules = getRules()): number {
  return 0.01 * contagionMultiplier(rules);
}

// ─── processStateEffects ─────────────────────────────────────────────────────

/** What every side-effect handler reads: one agent plus the tick's clock. */
interface EffectContext {
  agent: AgentRow;
  personality: PersonalityProfile | null;
  allAgents: AgentRow[];
  nowMinutes: number;
  /** TICK clock, for the tick-stamped memory stream only. */
  currentTick: number;
  /** Game minutes per tick, for durations accumulated per call. */
  tickSpeed: number;
  ctx: StatesTickContext;
}

export function processStateEffects(
  agent: typeof agents.$inferSelect,
  states: readonly AgentStateRow[],
  allAgents: Array<typeof agents.$inferSelect>,
  nowMinutes: number,
  /** TICK clock, for the tick-stamped memory stream only. */
  currentTick: number,
  /** Game minutes per tick, for durations accumulated per call. */
  tickSpeed: number,
  ctx: StatesTickContext,
) {
  const personality = agent.personality as PersonalityProfile | null;
  const e: EffectContext = { agent, personality, allAgents, nowMinutes, currentTick, tickSpeed, ctx };

  for (const state of states) {
    switch (state.type as StateType) {
      // ── Drunk: random gift purchase near others ──────────────────────────
      case 'drunk': effectDrunk(e, state); break;
      // ── Sick: contagion spread ───────────────────────────────────────────
      case 'sick': effectSick(e, state); break;
      // ── Angry: grudge tag after 480 game minutes ────────────────────────────────
      case 'angry': effectAngry(e, state); break;
      // ── Euphoric: random generosity ───────────────────────────────────────
      case 'euphoric': effectEuphoric(e, state); break;
      // ── Infatuated: jealousy check ────────────────────────────────────────
      case 'infatuated': effectInfatuated(e, state); break;
      // ── Confident: fragile vanity → cascade angry on negative convo ──────
      case 'confident': effectConfident(e, state); break;
      // ── Hungover: review drunk memories for regret ────────────────────────
      case 'hungover': effectHungover(e, state); break;
      // ── Alcoholic: shame mood penalty ────────────────────────────────────
      case 'alcoholic': effectAlcoholic(e); break;
      // ── In Debt: mood penalty + theft attempts ───────────────────────────
      case 'in_debt': effectInDebt(e, state); break;
      // ── Jealous: mood penalty, grudge escalation, confrontation ──────────
      case 'jealous': effectJealous(e, state); break;
      default:
        break;
    }
  }

  // Once per agent, after the per-state effects, in this order.
  doctorTreatsPatients(e);
  gambleAtTavern(e);
  attemptSeduction(e);
  fabricateRumor(e);
}

/**
 * Drunk: now and then buys someone in the room a gift.
 */
function effectDrunk(e: EffectContext, state: AgentStateRow) {
  const { agent, allAgents, tickSpeed } = e;
  if (agent.current_location == null) return;
  if (Math.random() > chancePerTick(0.30, tickSpeed)) return; // 30% per game minute

  const nearbyAgents = allAgents.filter(
    (a) => a.id !== agent.id && a.current_location === agent.current_location,
  );
  if (nearbyAgents.length === 0) return;

  const target = nearbyAgents[Math.floor(Math.random() * nearbyAgents.length)];
  // Cooldown, per-episode limit, balance cap, ledger and feed entry all
  // live in giftEngine — see giveImpulsiveGift for why.
  giveImpulsiveGift({
    giver: agent,
    receiver: target,
    reason: 'drunk_gift',
    stateId: state.id,
    desiredAmount: 5 + Math.random() * 10, // $5-15
  });
}

/**
 * Sick: spreads to roommates, heals faster near a healer (or slowly at home
 * when no healer is left), and may take a turn for the worse untreated.
 */
function effectSick(e: EffectContext, state: AgentStateRow) {
  const { agent } = e;
  if (agent.current_location == null) return;

  // Read meta once, accumulate all updates, then write once. The steps below
  // mutate this one object in place; only a turn for the worse replaces it.
  let meta: Record<string, unknown> = { ...(state.metadata ?? {}) };

  spreadSickness(e, meta);
  const healerNearby = treatSickness(e, state, meta);
  meta = worsenUntreatedSickness(e, state, meta, healerNearby);

  // Write accumulated co-location counters once after loop
  db.update(agentStates)
    .set({ metadata: meta })
    .where(eq(agentStates.id, state.id))
    .run();
}

/**
 * Contagion: counts the minutes each roommate (outside their immunity window)
 * has shared the room, in `meta`, and past half an hour may pass it on.
 */
function spreadSickness(e: EffectContext, meta: Record<string, unknown>) {
  const { agent, allAgents, nowMinutes, tickSpeed, ctx } = e;
  const nearbyAgents = allAgents.filter(
    (a) => a.id !== agent.id && a.current_location === agent.current_location,
  );

  for (const other of nearbyAgents) {
    // Skip agents with immunity (recently recovered)
    const otherRecovery = sickRecoveredAt.get(other.id) ?? -9999;
    if (nowMinutes - otherRecovery <= 2880) continue;

    const coLocKey = `coloc_${other.id}`;
    // Game minutes spent together (a tick's worth per call); counting calls
    // made the incubation 2 game hours at 4x.
    meta[coLocKey] = ((meta[coLocKey] as number | undefined) ?? 0) + tickSpeed;
    const coLocMinutes = meta[coLocKey] as number;

    // Contagion after 30 minutes together, rolled per tick via chancePerTick.
    if (coLocMinutes > 30 && Math.random() < chancePerTick(contagionChancePerMinute(), tickSpeed)) {
      // Spread sick only if other doesn't already have it
      if (!ctx.states.find(other.id, 'sick')) {
        const severity = 0.2 + Math.random() * 0.4;
        const duration = Math.floor(360 + Math.random() * 720); // 6-18 hours
        db.insert(agentStates)
          .values({
            agent_id: other.id,
            type: 'sick',
            severity,
            started_at: nowMinutes,
            duration,
            source: `cascade:sick_from_${agent.id}`,
            metadata: null,
          })
          .run();
        createFact('sickness', other.id, null, 1, [other.id, agent.id], 'observed');
      }
    }
  }
}

/**
 * Treatment: a healer in the room speeds recovery (much faster with medicine)
 * and records the visit in `meta`; with no healer left in town, slow bed rest
 * at home. Returns the healer in the room, if any.
 */
function treatSickness(e: EffectContext, state: AgentStateRow, meta: Record<string, unknown>): AgentRow | undefined {
  const { agent, allAgents, nowMinutes, tickSpeed, ctx } = e;
  // Doctor/medical_assistant at same location heals — consumes medicine for faster cure
  const healerNearby = allAgents.find((a) =>
    a.id !== agent.id && a.current_location === agent.current_location && isHealerJob(ctx.jobOf(a.id)));
  if (healerNearby) {
    // Being seen to: stops the illness worsening and lifts the death hazard (lib/sickness.ts).
    meta.treatedAt = nowMinutes;
    const healerEcon = db.select().from(economyTable).where(eq(economyTable.agent_id, healerNearby.id)).get();
    const hasMedicine = healerEcon && healerEcon.inventory.some(
      (i) => i.itemId === 'medicine' && i.quantity > 0
    );

    if (hasMedicine) {
      // Use medicine: much faster healing (severity -0.05 and duration halved
      // per GAME MINUTE — scaled by the tick's minutes, as the rates were
      // per tick and healed four times slower per game hour at 4x).
      const newSeverity = Math.max(0, state.severity - 0.05 * tickSpeed);
      const reducedDuration = Math.max(1, Math.floor(state.duration * Math.pow(0.5, tickSpeed)));
      db.update(agentStates)
        .set({ severity: newSeverity, duration: reducedDuration })
        .where(eq(agentStates.id, state.id))
        .run();

      // Consume 1 medicine every 120 game minutes
      const lastMedUsed = (meta.lastMedicineUsed as number | undefined) ?? 0;
      if (nowMinutes - lastMedUsed > 120) {
        const newInv = healerEcon!.inventory.map((i) =>
          i.itemId === 'medicine' ? { ...i, quantity: i.quantity - 1 } : i
        ).filter((i) => i.quantity > 0);
        db.update(economyTable).set({ inventory: newInv }).where(eq(economyTable.agent_id, healerNearby.id)).run();
        meta.lastMedicineUsed = nowMinutes;

        logActivity({
          type: 'system',
          agents: [healerNearby.id, agent.id],
          templateData: { message: `${healerNearby.name} used medicine to treat ${agent.name}.` },
        });
      }
    } else {
      // No medicine: slower healing (original rate): severity -0.01 and 2% of
      // the remaining time per GAME MINUTE. The 2% compounds over the tick's
      // minutes — the same 1 - (1 - f)^n as a per-minute chance, and exactly
      // 0.02 at 1x.
      const newSeverity = Math.max(0.1, state.severity - 0.01 * tickSpeed);
      const remainingDuration = (state.started_at + state.duration) - nowMinutes;
      const reducedDuration = Math.max(
        1,
        state.duration - Math.floor(remainingDuration * chancePerTick(0.02, tickSpeed)),
      );
      db.update(agentStates)
        .set({ severity: newSeverity, duration: reducedDuration })
        .where(eq(agentStates.id, state.id))
        .run();
    }

    // Periodically create a "helped" relationship event (every ~60 game minutes)
    const lastHealEvent = (meta.lastHealEvent as number | undefined) ?? 0;
    if (nowMinutes - lastHealEvent > 60) {
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
      meta.lastHealEvent = nowMinutes;
    }
  } else if (agent.current_location === agent.home && !allAgents.some((a) => isHealerJob(ctx.jobOf(a.id)))) {
    // No one left to treat them: bed rest at home (HOME_REST_RECOVERY).
    // Same shape as the no-medicine treatment above, at a lower rate.
    const newSeverity = Math.max(0.1, state.severity - HOME_REST_RECOVERY.SEVERITY_PER_MINUTE * tickSpeed);
    const remaining = Math.max(0, (state.started_at + state.duration) - nowMinutes);
    const reducedDuration = Math.max(
      1,
      state.duration - Math.floor(remaining * chancePerTick(HOME_REST_RECOVERY.REMAINING_SHARE_PER_MINUTE, tickSpeed)),
    );
    db.update(agentStates)
      .set({ severity: newSeverity, duration: reducedDuration })
      .where(eq(agentStates.id, state.id))
      .run();
  }
  return healerNearby;
}

/**
 * Worsening: an untreated illness may take a turn for the worse. Returns the
 * metadata to write, which a turn replaces with a new object.
 */
function worsenUntreatedSickness(
  e: EffectContext,
  state: AgentStateRow,
  meta: Record<string, unknown>,
  healerNearby: AgentRow | undefined,
): Record<string, unknown> {
  const { agent, tickSpeed } = e;
  // Untreated, an illness can take a turn for the worse (lib/sickness.ts): a
  // step of severity and half a day more. Above 0.4 the patient heads for the
  // clinic, so with a healer in town this is a scare; without one, two turns
  // make it grave and lifeEventsEngine's `untreated_sickness` can take them.
  const worsenChance = worsenChancePerMinute({
    treated: healerNearby != null,
    age: agent.age,
    rateMultiplier: sicknessMultiplier(getRules()),
  });
  if (worsenChance > 0 && Math.random() < chancePerTick(worsenChance, tickSpeed)) {
    // Re-read: the home-rest branch above may have just written severity/duration.
    const current = db.select({ severity: agentStates.severity, duration: agentStates.duration })
      .from(agentStates).where(eq(agentStates.id, state.id)).get();
    if (current) {
      const next = worsen({ ...current, metadata: meta });
      meta = next.metadata;
      db.update(agentStates)
        .set({ severity: next.severity, duration: next.duration })
        .where(eq(agentStates.id, state.id))
        .run();
      const grave = isGravelyIll(next);
      logActivity({
        type: 'drama',
        initiator: agent.id,
        severity: grave ? 0.8 : 0.5,
        templateData: {
          description: grave
            ? `${agent.name} is gravely ill, and no one is tending to them.`
            : `${agent.name}'s illness has taken a turn for the worse.`,
        },
        metadata: { beat: 'illness' },
      });
    }
  }
  return meta;
}

/**
 * Angry: after eight game hours the anger hardens into a grudge tag.
 */
function effectAngry(e: EffectContext, state: AgentStateRow) {
  const { agent, nowMinutes } = e;
  const elapsed = nowMinutes - state.started_at;
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
}

/**
 * Euphoric: random generosity, a gift and a little friendship.
 */
function effectEuphoric(e: EffectContext, state: AgentStateRow) {
  const { agent, allAgents, tickSpeed } = e;
  if (agent.current_location == null) return;
  if (Math.random() > chancePerTick(0.30, tickSpeed)) return; // 30% per game minute

  const nearbyAgents = allAgents.filter(
    (a) => a.id !== agent.id && a.current_location === agent.current_location,
  );
  if (nearbyAgents.length === 0) return;

  const target = nearbyAgents[Math.floor(Math.random() * nearbyAgents.length)];
  const given = giveImpulsiveGift({
    giver: agent,
    receiver: target,
    reason: 'euphoric_gift',
    stateId: state.id,
    desiredAmount: 5 + Math.random() * 5, // $5-10
  });
  if (given == null) return;

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
}

/**
 * Infatuated: seeing the love interest talking with a sensual third party
 * stings (a mood modifier).
 */
function effectInfatuated(e: EffectContext, state: AgentStateRow) {
  const { agent, nowMinutes } = e;
  if (!state.target_agent_id) return;

  // Find if target is in a conversation with a high-sensuality agent
  const targetConvo = db
    .select({ participants: conversations.participants })
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
    // Seeing them with someone else stings on top of the jealousy itself
    // (lib/stateMood.ts). A modifier: the needs phase rebuilds `needs.mood`
    // every tick, so the old direct -10 was gone a tick later. Refreshed
    // (not stacked) while the sighting lasts.
    addMoodModifier(agent.id, -10, 'jealous_sighting', 120, nowMinutes);
  }
}

/**
 * Confident: a vain agent's confidence shatters into anger after a bad
 * conversation.
 */
function effectConfident(e: EffectContext, state: AgentStateRow) {
  const { agent, personality, nowMinutes, tickSpeed, ctx } = e;
  if (!personality || personality.vanity <= 60) return;

  // Wall-clock-stamped table: 30 game minutes at the current speed.
  const sinceWindow = Date.now() - gameMinutesToMs(30, tickSpeed);
  const negativeConvo = db
    .select()
    .from(conversations)
    .where(and(lt(conversations.sentiment, -0.3), gt(conversations.started_at, sinceWindow)))
    .all()
    .find((c) => (c.participants as number[]).includes(agent.id));

  if (!negativeConvo) return;

  if (ctx.states.find(agent.id, 'angry')) return;

  const parts = negativeConvo.participants as number[];
  const targetId = parts.find((p) => p !== agent.id);
  const severity = clamp(personality.vanity / 100, 0.4, 1.0);
  const duration = Math.floor(180 + Math.random() * 300);

  db.insert(agentStates)
    .values({
      agent_id: agent.id,
      type: 'angry',
      severity,
      started_at: nowMinutes,
      duration,
      target_agent_id: targetId ?? null,
      source: 'cascade:confident_vanity',
      metadata: null,
    })
    .run();

  // Remove confident state since it shattered
  db.delete(agentStates).where(eq(agentStates.id, state.id)).run();
}

/**
 * Hungover: once per hangover, regret over what was said to friends while
 * drunk (a memory and a friendship penalty).
 */
function effectHungover(e: EffectContext, state: AgentStateRow) {
  const { agent, nowMinutes, currentTick, tickSpeed } = e;
  if (state.metadata?.regretProcessed) return;

  // Find memories created while agent was drunk (around when this state started).
  // Memories are tick-stamped and the state is not, so carry the 300-minute
  // lookback over to ticks at the current speed.
  const lookbackTicks = (nowMinutes - state.started_at + 300) / (tickSpeed > 0 ? tickSpeed : 1);
  const recentConvoMemories = db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.agent_id, agent.id),
        eq(memories.type, 'conversation'),
        gt(memories.created_at, currentTick - lookbackTicks),
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
    .set({ metadata: { ...(state.metadata ?? {}), regretProcessed: true } })
    .where(eq(agentStates.id, state.id))
    .run();
}

/**
 * Alcoholic: a moral agent carries a standing shame mood penalty.
 */
function effectAlcoholic(e: EffectContext) {
  const { agent, personality, nowMinutes } = e;
  if (personality && personality.morality > 70) {
    // A standing -5 while the drinking lasts, refreshed each tick. It was a
    // -0.5 written to `needs.mood`, which the needs phase rebuilt away on
    // the next tick, so the shame never showed.
    addMoodModifier(agent.id, -5, 'alcoholic_shame', 60, nowMinutes);
  }
}

/** An inventory entry as the theft reads it. */
type InventoryItem = { itemId: string; quantity: number; acquiredAt: number };

/**
 * In debt: a desperate, low-morality agent may steal from the owner of
 * the place they are in.
 */
function effectInDebt(e: EffectContext, state: AgentStateRow) {
  const { agent, personality, tickSpeed } = e;
  // The mood penalty is STATE_MOOD's in_debt entry (lib/stateMood.ts),
  // applied by the needs phase: the -0.3 written here each tick was
  // rebuilt away by that phase on the next one.

  if (agent.current_location == null) return;
  if (!personality) return;

  const meta = state.metadata ?? {};
  const desperationUnlocked = meta.desperationUnlocked as boolean ?? false;
  const moralityThreshold = desperationUnlocked ? 50 : 40;

  if (personality.morality >= moralityThreshold) return;
  if (Math.random() > chancePerTick(0.05, tickSpeed)) return; // 5% per game minute

  const loc = db.select().from(locations).where(eq(locations.id, agent.current_location)).get();
  if (!loc?.owner || loc.owner === agent.id) return;

  const ownerEcon = db.select().from(economyTable).where(eq(economyTable.agent_id, loc.owner)).get();
  if (!ownerEcon || ownerEcon.inventory.length === 0) return;

  const items = ownerEcon.inventory as InventoryItem[];
  const targetItem = items.find((i) => i.quantity > 0);
  if (!targetItem) return;

  stealItem(e, state, meta, loc, loc.owner, items, targetItem);
}

/**
 * The theft itself: whether the thief is seen, the item changing hands and,
 * if caught, the facts, the owner's ban after repeat offences and the
 * witnesses' memories. `ownerId` is `loc.owner`, already checked non-null.
 */
function stealItem(
  e: EffectContext,
  state: AgentStateRow,
  meta: Record<string, unknown>,
  loc: typeof locations.$inferSelect,
  ownerId: number,
  items: InventoryItem[],
  targetItem: InventoryItem,
) {
  const { agent, allAgents } = e;
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
  db.update(economyTable).set({ inventory: newOwnerInv }).where(eq(economyTable.agent_id, ownerId)).run();

  const thiefEcon = db.select().from(economyTable).where(eq(economyTable.agent_id, agent.id)).get();
  if (thiefEcon) {
    const existing = thiefEcon.inventory.find((i) => i.itemId === targetItem.itemId);
    let newThiefInv;
    if (existing) {
      newThiefInv = thiefEcon.inventory.map((i) =>
        i.itemId === targetItem.itemId ? { ...i, quantity: i.quantity + 1 } : i
      );
    } else {
      newThiefInv = [...thiefEcon.inventory, { itemId: targetItem.itemId, quantity: 1, acquiredAt: Date.now() }];
    }
    db.update(economyTable).set({ inventory: newThiefInv }).where(eq(economyTable.agent_id, agent.id)).run();
  }

  if (!caught) {
    simEvents.emit('economy:theft_success', { agentId: agent.id, item: targetItem.itemId, locationName: loc.name });
  }

  if (caught) {
    simEvents.emit('economy:theft_caught', { agentId: agent.id, item: targetItem.itemId, locationName: loc.name });
    const witnessIds = witnesses.map((w) => w.id);
    createFact('theft', agent.id, ownerId, 2, [agent.id, ownerId, ...witnessIds], 'witnessed', {
      item: itemPhrase(targetItem.itemId), location: loc.name,
    });

    // Check theft escalation: 3+ theft shared_knowledge = reputation + banned
    const totalThefts = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.type, 'theft'), eq(shared_knowledge.subject_id, agent.id), eq(shared_knowledge.is_active, true))).all();
    if (totalThefts.length >= 3) {
      createFact('reputation', agent.id, null, 1, allAgents.map(a => a.id), 'observed');
      const ownerRel = db.select().from(relationships).where(
        or(
          and(eq(relationships.agent_a, agent.id), eq(relationships.agent_b, ownerId)),
          and(eq(relationships.agent_a, ownerId), eq(relationships.agent_b, agent.id)),
        )
      ).get();
      if (ownerRel) {
        const tags = ownerRel.tags as string[];
        if (!tags.includes('banned')) {
          db.update(relationships).set({ tags: [...tags, 'banned'] }).where(eq(relationships.id, ownerRel.id)).run();
        }
      }
    }

    const [ordA, ordB] = [Math.min(agent.id, ownerId), Math.max(agent.id, ownerId)];
    db.insert(relationshipEvents).values({
      agent_a: ordA, agent_b: ordB,
      event_type: 'theft_caught',
      description: `${agent.name} was caught stealing ${itemPhrase(targetItem.itemId)} from ${loc.name}`,
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
      target: ownerId,
      templateData: { description: `${agent.name} was caught stealing from ${loc.name}!` },
      metadata: { beat: 'theft' },
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
      action: `stole ${itemPhrase(targetItem.itemId)} from ${loc.name}${caught ? ' and got caught' : ''}`,
    });
  } else {
    const updatedMeta = { ...meta, theftCount: ((meta.theftCount as number) ?? 0) + 1 };
    db.update(agentStates).set({ metadata: updatedMeta }).where(eq(agentStates.id, state.id)).run();
  }
}

/**
 * Jealous: an aggressive agent's jealousy becomes a grudge against the
 * rival; a dishonest one may make up a rumor about them.
 */
function effectJealous(e: EffectContext, state: AgentStateRow) {
  const { agent, personality, nowMinutes, tickSpeed } = e;
  // Mood penalty: STATE_MOOD's jealous entry (lib/stateMood.ts), applied
  // by the needs phase, which rebuilt away the -0.2 once written here.

  const meta = state.metadata ?? {};
  const rivalId = meta.rivalId as number | undefined;

  if (rivalId && personality && personality.aggression > 60) {
    const elapsed = nowMinutes - state.started_at;
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
    const elapsed = nowMinutes - state.started_at;
    if (elapsed > 720 && Math.random() < chancePerTick(0.005, tickSpeed)) { // 0.5%/game minute
      // Name the love interest the jealousy is about, so the rumor says
      // something; without one it stays the generic "rumors about X".
      const loveInterestId = meta.loveInterestId as number | undefined;
      createFact('rumor', rivalId, loveInterestId ?? null, 2, [agent.id], 'fabricated',
        jealousRumorContext(loveInterestId != null ? getAgentName(loveInterestId) : undefined));
    }
  }
}

/**
 * A healer with medicine in the clinic exam room treats one patient's
 * alcoholism or depression per tick.
 */
function doctorTreatsPatients(e: EffectContext) {
  const { agent, allAgents, nowMinutes, tickSpeed, ctx } = e;
  if (agent.current_location != null) {
    if (isHealerJob(ctx.jobOf(agent.id))) {
      // Zone gate: healer must be at clinic:exam_room
      const healerZone = zoneOccupancy.findAgentZone(agent.id);
      const inClinicExamRoom = healerZone?.building === 'clinic' && healerZone.zone === 'exam_room';
      const healerEcon = ctx.economyOf(agent.id);
      const hasMedicine = healerEcon && healerEcon.inventory.some(
        (i) => i.itemId === 'medicine' && i.quantity > 0
      );

      if (inClinicExamRoom && hasMedicine) {
        const nearbyPatients = allAgents.filter(
          (a) => a.id !== agent.id && a.current_location === agent.current_location,
        );

        for (const patient of nearbyPatients) {
          const patientStates = ctx.states.forAgent(patient.id);

          // Treat alcoholism: consume medicine, trigger recovery
          const alcoholicState = patientStates.find(s => s.type === 'alcoholic');
          if (alcoholicState && Math.random() < chancePerTick(0.02, tickSpeed)) { // 2% per game minute
            const alcMeta = { ...(alcoholicState.metadata ?? {}), recoveryTriggered: true };
            db.update(agentStates).set({ metadata: alcMeta }).where(eq(agentStates.id, alcoholicState.id)).run();

            // Consume medicine
            const newInv = healerEcon!.inventory.map((i) =>
              i.itemId === 'medicine' ? { ...i, quantity: i.quantity - 1 } : i
            ).filter((i) => i.quantity > 0);
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
          if (depressedState && Math.random() < chancePerTick(0.03, tickSpeed)) { // 3% per game minute
            db.delete(agentStates).where(eq(agentStates.id, depressedState.id)).run();

            // Consume medicine
            const newInv = healerEcon!.inventory.map((i) =>
              i.itemId === 'medicine' ? { ...i, quantity: i.quantity - 1 } : i
            ).filter((i) => i.quantity > 0);
            db.update(economyTable).set({ inventory: newInv }).where(eq(economyTable.agent_id, agent.id)).run();

            // Mood boost
            // A modifier: a +20 written to `needs.mood` was rebuilt away by the
            // needs phase on the next tick.
            addMoodModifier(patient.id, 12, 'treated', 480, nowMinutes);

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
}

/**
 * An impulsive agent at the tavern tables may bet against another player;
 * five bets in three game days make them a gambling addict.
 */
function gambleAtTavern(e: EffectContext) {
  const { agent, personality, allAgents, nowMinutes, tickSpeed, ctx } = e;
  if (personality && personality.impulsiveness > 40 && agent.current_location != null) {
    // Zone gate: gambling requires tavern:tables zone
    const gamblerZone = zoneOccupancy.findAgentZone(agent.id);
    const atTables = gamblerZone?.building === 'tavern' && gamblerZone.zone === 'tables';
    if (ctx.locationType(agent.current_location) === 'tavern' && atTables && Math.random() < chancePerTick(0.08, tickSpeed)) { // 8%/game minute
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
          if (nowMinutes - lastGamble >= 120) {
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
                metadata: { beat: 'drunk' },
              });
              simEvents.emit('economy:gambling', { agentId: agent.id, amount: betAmount, won: agentWins, opponentName: opponent.name });
              gamblingCooldowns.set(pairKey, nowMinutes);

              // Track gambling frequency for addiction detection
              const gambHistory = gamblingHistory.get(agent.id) ?? [];
              gambHistory.push(nowMinutes);
              // Keep only last 3 game days (4320 minutes)
              const recentGambles = gambHistory.filter(t => nowMinutes - t < 4320);
              gamblingHistory.set(agent.id, recentGambles);

              // Trigger gambling_addict state if 5+ gambles in 3 days
              const agentActiveTypes = new Set(ctx.states.forAgent(agent.id).map(s => s.type));
              if (recentGambles.length >= 5 && !agentActiveTypes.has('gambling_addict')) {
                db.insert(agentStates).values({
                  agent_id: agent.id,
                  type: 'gambling_addict',
                  severity: 0.5,
                  started_at: nowMinutes,
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
}

/**
 * A sensual, low-morality agent flirts with someone in the room for personal
 * gain; witnesses make it a fact.
 */
function attemptSeduction(e: EffectContext) {
  const { agent, personality, allAgents, tickSpeed } = e;
  if (personality && personality.sensuality > 70 && personality.morality < 40 && agent.current_location != null) {
    if (Math.random() < chancePerTick(0.02, tickSpeed)) { // 2% per game minute
      const nearbyTargets = seductionTargets(agent, allAgents);

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
}

/**
 * A dishonest, curious agent now and then makes up a rumor about someone who
 * is not their friend.
 */
function fabricateRumor(e: EffectContext) {
  const { agent, personality, allAgents, tickSpeed } = e;
  if (personality && personality.honesty < 30 && personality.curiosity > 60) {
    if (Math.random() < chancePerTick(0.005, tickSpeed)) { // 0.5% per game minute — very rare
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
          metadata: { beat: 'gossip' },
        });
      }
    }
  }
}
