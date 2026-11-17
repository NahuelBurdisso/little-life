/**
 * Pass 1c of the states phase: which new states each agent gains this tick.
 */

import { db } from '../../../db';
import {
  agents,
  agentStates,
  needs as needsTable,
  relationships,
  conversations,
  relationshipEvents,
} from '../../../db/schema';
import { logActivity } from '../../../lib/activityLogger';
import { eq, and, gt, lt, or } from 'drizzle-orm';
import { PersonalityProfile } from '../../../lib/personality';
import { clamp } from '../../../lib/utils';
import { committedTo } from '../../../lib/intimacy/committed';
import { createFact } from '../../../lib/gossip';
import { simEvents } from '../../../lib/simEvents';
import { getRules, sicknessMultiplier, type LiveRules } from '../../../lib/worldRules';
import { chancePerTick } from '../../../lib/gameClock';
import { foodCount } from '../../../lib/economyEngine';
import { gameMinutesToMs } from '../../../lib/worldClock';
import { type AgentRow, type NeedsRow, type StatesTickContext } from './context';
import { alcoholRecoveredAt, brokeSince, drunkHistory, lowMoodSince, lowSocialSince, sickRecoveredAt, stressRemovedAt } from './trackers';

/** The columns the romance checks read from a relationship row. */
const PAIR_ROMANCE = {
  agent_a: relationships.agent_a,
  agent_b: relationships.agent_b,
  romance_ab: relationships.romance_ab,
  romance_ba: relationships.romance_ba,
};

// ─── Sickness odds ────────────────────────────────────────────────────────────

/**
 * Per-game-minute chance of an agent falling ill on their own. Doubled in
 * rain and storms, x1.5 in winter and x1.5 when exhausted, then scaled by the
 * world's "Sickness Rate" (worldRules.ts): 'low', the default, is the tuned
 * base of 0.0001; 'off' makes it 0, and a roll `Math.random() < 0` never
 * passes.
 */
export function environmentSickChancePerMinute(
  weather: string,
  season: string,
  energy: number | null,
  rules: LiveRules = getRules(),
): number {
  const weatherMult = weather === 'rainy' || weather === 'stormy' ? 2 : 1;
  const seasonMult = season === 'winter' ? 1.5 : 1;
  const energyMult = energy != null && energy < 25 ? 1.5 : 1;
  return 0.0001 * weatherMult * seasonMult * energyMult * sicknessMultiplier(rules);
}

// ─── evaluateTriggers ─────────────────────────────────────────────────────────

/**
 * What every trigger reads: one agent's rows plus the tick's clock and world.
 * `activeTypes` is shared, not copied: each trigger adds the state it grants,
 * and the triggers after it must see that within the same tick.
 */
interface TriggerContext {
  agent: AgentRow;
  /** Non-null: evaluateTriggers returns before building the context without one. */
  personality: PersonalityProfile;
  agentNeeds: NeedsRow | undefined;
  activeTypes: Set<string>;
  nowMinutes: number;
  weather: string;
  season: string;
  removedAgentIds: number[];
  allAgents: AgentRow[];
  /** Game minutes per tick, for windows over wall-clock-stamped tables. */
  tickSpeed: number;
  ctx: StatesTickContext;
}

export function evaluateTriggers(
  agent: typeof agents.$inferSelect,
  agentNeeds: typeof needsTable.$inferSelect | undefined,
  activeTypes: Set<string>,
  nowMinutes: number,
  weather: string,
  season: string,
  removedAgentIds: number[],
  allAgents: Array<typeof agents.$inferSelect>,
  /** Game minutes per tick, for windows over wall-clock-stamped tables. */
  tickSpeed: number,
  ctx: StatesTickContext,
) {
  const personality = agent.personality as PersonalityProfile | null;
  if (!personality) return;

  // Order matters: each trigger adds what it grants to `activeTypes`, and
  // later ones read it (jealous needs this tick's infatuated; depressed reads
  // heartbroken and stressed). The Math.random() sequence follows it too.
  const t: TriggerContext = {
    agent, personality, agentNeeds, activeTypes, nowMinutes, weather, season,
    removedAgentIds, allAgents, tickSpeed, ctx,
  };
  triggerDrunk(t);
  triggerSick(t);
  triggerAlcoholic(t);
  triggerInDebt(t);
  triggerHeartbroken(t);
  triggerAngry(t);
  triggerStressed(t);
  triggerEuphoric(t);
  triggerGrieving(t);
  triggerInfatuated(t);
  triggerJealous(t);
  triggerLonely(t);
  triggerDepressed(t);
  triggerConfident(t);
}

/**
 * An impulsive agent at the tavern may start drinking; each spell is logged in
 * `drunkHistory`, which the alcoholic trigger reads.
 */
function triggerDrunk(t: TriggerContext) {
  const { agent, personality, activeTypes, nowMinutes, tickSpeed, ctx } = t;
  if (!activeTypes.has('drunk') && !activeTypes.has('hungover')) {
    if (agent.current_location != null && personality.impulsiveness > 40) {
      // impulsiveness / 10000 per GAME MINUTE at the tavern: a 70-impulsiveness
      // agent has ~0.7% a minute to start drinking. Rolled per tick through
      // chancePerTick so an hour at the tavern carries the same risk at any speed.
      if (ctx.locationType(agent.current_location) === 'tavern' && Math.random() < chancePerTick(personality.impulsiveness / 10000, tickSpeed)) {
        const severity = clamp(0.3 + (personality.impulsiveness / 100) * 0.7, 0, 1);
        const duration = Math.floor(120 + Math.random() * 120); // 2-4 hours
        db.insert(agentStates)
          .values({
            agent_id: agent.id,
            type: 'drunk',
            severity,
            started_at: nowMinutes,
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
        history.push(nowMinutes);
        const cutoff = nowMinutes - 10080; // 7 days
        drunkHistory.set(agent.id, history.filter((t) => t > cutoff));
      }
    }
  }
}

/**
 * Falling ill on one's own (weather, season, exhaustion), outside the
 * immunity window after the last recovery.
 */
function triggerSick(t: TriggerContext) {
  const { agent, agentNeeds, activeTypes, nowMinutes, weather, season, tickSpeed } = t;
  if (!activeTypes.has('sick')) {
    // Check immunity cooldown — recently recovered agents can't get sick again immediately
    const lastRecovery = sickRecoveredAt.get(agent.id) ?? -9999;
    const immunityPeriod = 2880; // ~2 days of immunity after recovery
    if (nowMinutes - lastRecovery > immunityPeriod) {
      const sickChance = environmentSickChancePerMinute(weather, season, agentNeeds?.energy ?? null);
      if (Math.random() < chancePerTick(sickChance, tickSpeed)) {
        const severity = 0.3 + Math.random() * 0.4;
        const duration = Math.floor(480 + Math.random() * 960); // 8-24 hours (shorter)
        db.insert(agentStates)
          .values({
            agent_id: agent.id,
            type: 'sick',
            severity,
            started_at: nowMinutes,
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
}

/**
 * Three or more drunk spells in a week make an impulsive agent alcoholic;
 * right after a recovery it is a per-minute relapse roll instead.
 */
function triggerAlcoholic(t: TriggerContext) {
  const { agent, personality, activeTypes, nowMinutes, tickSpeed } = t;
  if (!activeTypes.has('alcoholic') && personality.impulsiveness > 50) {
    const history = drunkHistory.get(agent.id) ?? [];
    const recentWindow = nowMinutes - 10080; // 7 days
    const recentDrunkCount = history.filter((t) => t > recentWindow).length;

    if (recentDrunkCount >= 3) {
      const recoveredAt = alcoholRecoveredAt.get(agent.id) ?? -9999;
      const inRelapseWindow = nowMinutes - recoveredAt < 720;

      if (inRelapseWindow) {
        // Within relapse window: tavern visit has chance of re-triggering
        const relapseChance = personality.neuroticism > 60 ? 0.5 : 0.3; // per game minute
        if (Math.random() < chancePerTick(relapseChance, tickSpeed)) {
          const severity = clamp(0.3 + (recentDrunkCount - 3) * 0.15, 0.3, 1.0);
          db.insert(agentStates).values({
            agent_id: agent.id,
            type: 'alcoholic',
            severity,
            started_at: nowMinutes,
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
          started_at: nowMinutes,
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
}

/**
 * Three game days broke with no food puts the agent in debt; `brokeSince`
 * tracks the run and resets once they have money again.
 */
function triggerInDebt(t: TriggerContext) {
  const { agent, activeTypes, nowMinutes, ctx } = t;
  if (!activeTypes.has('in_debt')) {
    const eco = ctx.economyOf(agent.id);
    // `<= 0`, not `=== 0`: sale tax splits leave fractional balances and
    // disasters can push money negative, and both are more broke than zero.
    if (eco && eco.money <= 0) {
      const hasFood = foodCount(eco.inventory) > 0;
      if (!hasFood) {
        if (!brokeSince.has(agent.id)) {
          brokeSince.set(agent.id, nowMinutes);
        }
        const duration = nowMinutes - brokeSince.get(agent.id)!;
        if (duration > 4320) { // 3 days
          db.insert(agentStates).values({
            agent_id: agent.id,
            type: 'in_debt',
            severity: 0.5,
            started_at: nowMinutes,
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
}

/**
 * A sharp romance drop in the last game hour breaks the agent's heart.
 */
function triggerHeartbroken(t: TriggerContext) {
  const { agent, personality, activeTypes, nowMinutes, tickSpeed } = t;
  if (!activeTypes.has('heartbroken')) {
    // Tables stamped with Date.now(), so the game-time window is converted to
    // wall clock at the current speed. A fixed ms window covered four times the
    // game time at 4x.
    const sinceWindow = Date.now() - gameMinutesToMs(60, tickSpeed);
    // Projected (here and in the checks below): these run per agent per tick,
    // and `select()` mapped every column of every row — descriptions, tags,
    // whole conversation transcripts — to read two or three of them.
    const recentRomanceDrops = db
      .select({
        agent_a: relationshipEvents.agent_a,
        agent_b: relationshipEvents.agent_b,
        romance_delta_ab: relationshipEvents.romance_delta_ab,
        romance_delta_ba: relationshipEvents.romance_delta_ba,
      })
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
            started_at: nowMinutes,
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
}

/**
 * An aggressive agent who just came out of a bad conversation turns angry
 * at the other participant.
 */
function triggerAngry(t: TriggerContext) {
  const { agent, personality, activeTypes, nowMinutes, tickSpeed } = t;
  if (!activeTypes.has('angry') && personality.aggression > 40) {
    // Tables stamped with Date.now(), so the game-time window is converted to
    // wall clock at the current speed. A fixed ms window covered four times the
    // game time at 4x.
    const sinceWindow = Date.now() - gameMinutesToMs(60, tickSpeed);
    const badConvos = db
      .select({ participants: conversations.participants, sentiment: conversations.sentiment })
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
          started_at: nowMinutes,
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
}

/**
 * Three or more low needs make the agent stressed, with a two-hour
 * hysteresis after the last time it lifted.
 */
function triggerStressed(t: TriggerContext) {
  const { agent, agentNeeds, activeTypes, nowMinutes } = t;
  if (!activeTypes.has('stressed') && agentNeeds) {
    const needValues = [
      agentNeeds.hunger,
      agentNeeds.energy,
      agentNeeds.social,
      agentNeeds.comfort,
      agentNeeds.fun,
    ];
    const lowNeedsCount = needValues.filter((v) => v < 35).length;
    const lastRemoved = stressRemovedAt.get(agent.id) ?? -9999;
    if (lowNeedsCount >= 3 && nowMinutes - lastRemoved > 120) { // 2 game hours hysteresis to prevent oscillation
      const severity = clamp(0.3 + (lowNeedsCount / 5) * 0.5, 0.3, 0.8);
      db.insert(agentStates)
        .values({
          agent_id: agent.id,
          type: 'stressed',
          severity,
          started_at: nowMinutes,
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
      // Every other trigger announces its state; this one only logged it, so
      // the `state:triggered` listeners never heard that anyone got stressed.
      simEvents.emit('state:triggered', { agentId: agent.id, state: 'stressed', cause: 'needs:multiple_low' });
      activeTypes.add('stressed');
    }
  }
}

/**
 * High mood plus a very good recent conversation makes the agent euphoric.
 */
function triggerEuphoric(t: TriggerContext) {
  const { agent, agentNeeds, activeTypes, nowMinutes, tickSpeed } = t;
  if (!activeTypes.has('euphoric') && agentNeeds && agentNeeds.mood > 70) {
    // Tables stamped with Date.now(), so the game-time window is converted to
    // wall clock at the current speed. A fixed ms window covered four times the
    // game time at 4x.
    const sinceWindow = Date.now() - gameMinutesToMs(90, tickSpeed);
    const positiveConvoRows = db
      .select({ participants: conversations.participants })
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
          started_at: nowMinutes,
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
}

/**
 * Losing a close friend (friendship > 70) who left the town this tick.
 */
function triggerGrieving(t: TriggerContext) {
  const { agent, personality, activeTypes, nowMinutes, removedAgentIds } = t;
  if (!activeTypes.has('grieving') && removedAgentIds.length > 0) {
    for (const removedId of removedAgentIds) {
      // Check if they had a close friendship
      const rel = db
        .select({ agent_a: relationships.agent_a, friendship_ab: relationships.friendship_ab, friendship_ba: relationships.friendship_ba })
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
            started_at: nowMinutes,
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
}

/**
 * A sensual agent with romance > 60 toward someone becomes infatuated, and
 * the room learns of an affair when either of them is spoken for.
 */
function triggerInfatuated(t: TriggerContext) {
  const { agent, personality, activeTypes, nowMinutes, allAgents } = t;
  if (!activeTypes.has('infatuated') && personality.sensuality > 40) {
    const rels = db
      .select(PAIR_ROMANCE)
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
            started_at: nowMinutes,
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

        // Check for affair: somebody in it is spoken for (partner, fiance(e) or spouse) to a third
        // person. It used to be "the target has romance > 40 with any third agent", spoken for or not,
        // so two single people drifting together were "an affair" (a 30-day soak: 32 such rumors,
        // 18 between pairs who never even kissed, each known by ~11 residents, each a candidate for a
        // partner's reckoning). Known to those in the room, as before.
        if (committedTo(targetId, agent.id) != null || committedTo(agent.id, targetId) != null) {
          const coLocated = allAgents
            .filter(
              (a) =>
                a.current_location === agent.current_location &&
                a.id !== agent.id &&
                a.id !== targetId,
            )
            .map((a) => a.id);
          createFact('affair', agent.id, targetId, 3, coLocated, 'observed');
        }

        break;
      }
    }
  }
}

/**
 * An infatuated agent grows jealous of a rival with romance > 40 toward
 * the same love interest.
 */
function triggerJealous(t: TriggerContext) {
  const { agent, activeTypes, nowMinutes, ctx } = t;
  if (!activeTypes.has('jealous') && activeTypes.has('infatuated')) {
    const infatuatedState = ctx.states.find(agent.id, 'infatuated');
    if (infatuatedState?.target_agent_id) {
      const loveInterestId = infatuatedState.target_agent_id;
      const loveInterestRels = db.select(PAIR_ROMANCE).from(relationships)
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
            started_at: nowMinutes,
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
}

/**
 * Social under 20 for an hour with no good conversation in the window
 * makes the agent lonely; `lowSocialSince` times the stretch.
 */
function triggerLonely(t: TriggerContext) {
  const { agent, agentNeeds, activeTypes, nowMinutes, tickSpeed } = t;
  if (!activeTypes.has('lonely') && agentNeeds) {
    if (agentNeeds.social < 20) {
      if (!lowSocialSince.has(agent.id)) {
        lowSocialSince.set(agent.id, nowMinutes);
      }
      const socialDuration = nowMinutes - lowSocialSince.get(agent.id)!;
      if (socialDuration >= 60) {
        // 60 game hours: what the old "last 60 minutes real-time" window meant at 1x
        // (one real second per game minute); kept, only made speed-independent.
        const sinceWindow = Date.now() - gameMinutesToMs(3600, tickSpeed);
        const positiveConvoRows = db
          .select({ participants: conversations.participants })
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
              started_at: nowMinutes,
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
}

/**
 * Long loneliness, sustained low mood, or heartbreak on top of stress
 * tips the agent into depression (neurotic agents sooner).
 */
function triggerDepressed(t: TriggerContext) {
  const { agent, personality, agentNeeds, activeTypes, nowMinutes, tickSpeed, ctx } = t;
  if (!activeTypes.has('depressed')) {
    let shouldDepress = false;
    let depressSource = '';

    // Lonely for > 3 days (4320 minutes)
    const lonelyState = ctx.states.find(agent.id, 'lonely');
    if (lonelyState && nowMinutes - lonelyState.started_at > 4320) {
      shouldDepress = true;
      depressSource = 'cascade:lonely';
    }

    // Mood < 15 for > 2 days (2880 minutes) — requires sustained low mood
    if (!shouldDepress && agentNeeds) {
      if (agentNeeds.mood < 15) {
        if (!lowMoodSince.has(agent.id)) {
          lowMoodSince.set(agent.id, nowMinutes);
        }
        const duration = nowMinutes - lowMoodSince.get(agent.id)!;
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
      if (lonelyState && nowMinutes - lonelyState.started_at > 2160) {
        shouldDepress = Math.random() < chancePerTick(0.5, tickSpeed);
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
          started_at: nowMinutes,
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
}

/**
 * A vain agent with two good conversations in the last game day becomes
 * confident.
 */
function triggerConfident(t: TriggerContext) {
  const { agent, personality, activeTypes, nowMinutes, tickSpeed } = t;
  if (!activeTypes.has('confident') && personality.vanity > 40) {
    // Tables stamped with Date.now(), so the game-time window is converted to
    // wall clock at the current speed. A fixed ms window covered four times the
    // game time at 4x.
    const sinceWindow = Date.now() - gameMinutesToMs(1440, tickSpeed);
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
          started_at: nowMinutes,
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
