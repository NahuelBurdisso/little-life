import { db } from '../../db';
import {
  agents,
  agentStates,
  needs as needsTable,
  relationships,
  conversations,
  locations,
  worldState,
  shared_knowledge,
} from '../../db/schema';
import { logActivity } from '../../lib/activityLogger';
import { eq, and, gt, or } from 'drizzle-orm';
import { PersonalityProfile } from '../../lib/personality';
import { clamp } from '../../lib/utils';
import {
  STATE_DEFINITIONS,
  StateType,
  clearEffectivePersonalities,
  setEffectivePersonality,
  type AgentStateRow,
} from '../../lib/states';
import { emitter } from '../emitter';
import { createFact, deactivateStaleFacts } from '../../lib/gossip';
import { simEvents, type SimEventPayloads } from '../../lib/simEvents';
import { checkDeathTriggers, processAgentDeath } from '../../lib/lifeEventsEngine';
import { isDeathEnabled } from '../../lib/worldRules';
import { chancePerTick, dayChanged, gameMinutes } from '../../lib/gameClock';
import { foodCount } from '../../lib/economyEngine';
import { gameMinutesToMs } from '../../lib/worldClock';
import { rollStateDuration } from '../../lib/stateDurations';
import {
  asRecord,
  listMapToRecord,
  numberMapToRecord,
  restoreIdListMap,
  restoreIdNumberMap,
  restoreKeyNumberMap,
  type SnapshotStore,
} from '../snapshotCodec';
import { createStatesTickContext, type AgentRow, type StatesTickContext } from './states/context';
import { evaluateTriggers } from './states/triggers';
import { processStateEffects } from './states/effects';
import {
  alcoholRecoveredAt,
  brokeSince,
  drunkHistory,
  gamblingCooldowns,
  gamblingHistory,
  lowMoodSince,
  lowSocialSince,
  sickRecoveredAt,
  stressRemovedAt,
} from './states/trackers';

// The handlers moved to ./states/; these are re-exported so importers of
// engine/systems/states keep working.
export { contagionChancePerMinute, HOME_REST_RECOVERY, seductionTargets } from './states/effects';
export { environmentSickChancePerMinute } from './states/triggers';

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
const CONDITIONAL_EXIT_GRACE_MINUTES = 60;

let previouslyActiveAgents = new Set<number>();

// The per-agent trackers live in ./states/trackers.ts, shared with the handlers.

/**
 * Drop all per-agent tracking for a world replace.
 *
 * Every tracker map (./states/trackers.ts) is keyed by agent id and holds game-minute values. SQLite reuses
 * rowids after a DELETE while `totalTicks` restarts at 0, so surviving entries
 * both belong to a stranger and sit in the future — `now - since` goes
 * negative and the cooldowns/duration gates they guard never fire again.
 */
export function clearStatesTrackers(): void {
  previouslyActiveAgents = new Set();
  stressRemovedAt.clear();
  gamblingCooldowns.clear();
  lowMoodSince.clear();
  lowSocialSince.clear();
  sickRecoveredAt.clear();
  drunkHistory.clear();
  alcoholRecoveredAt.clear();
  brokeSince.clear();
  gamblingHistory.clear();
}

/**
 * Checkpoint of the trackers in ./states/trackers.ts (server/engine/simSnapshots.ts).
 *
 * The ones that matter are the multi-day ones: drunk and gambling histories
 * (alcoholism and gambling addiction are detected over days of episodes),
 * alcohol recovery (relapse window), broke-since (in_debt after days of being
 * broke) and sickness immunity. A restart used to wipe all of them, so an agent
 * one binge away from alcoholism was reset to a clean slate. The hour-scale
 * ones (stress re-trigger, low mood/social durations, gambling pair cooldowns)
 * ride along because they share the file and the format; every value is a game
 * minute, and the game clock is itself persisted, so they stay valid.
 *
 * Not saved: `previouslyActiveAgents`, which is rebuilt from the agents table on
 * the first tick (an empty set just means no removals are reported that tick).
 */
export const statesTrackersSnapshotStore: SnapshotStore = {
  key: 'stateTrackers',
  version: 1,
  serialize: () => ({
    stressRemovedAt: numberMapToRecord(stressRemovedAt),
    gamblingCooldowns: numberMapToRecord(gamblingCooldowns),
    lowMoodSince: numberMapToRecord(lowMoodSince),
    lowSocialSince: numberMapToRecord(lowSocialSince),
    sickRecoveredAt: numberMapToRecord(sickRecoveredAt),
    drunkHistory: listMapToRecord(drunkHistory),
    alcoholRecoveredAt: numberMapToRecord(alcoholRecoveredAt),
    brokeSince: numberMapToRecord(brokeSince),
    gamblingHistory: listMapToRecord(gamblingHistory),
  }),
  restore(data) {
    const d = asRecord(data) ?? {};
    restoreIdNumberMap(stressRemovedAt, d.stressRemovedAt);
    restoreKeyNumberMap(gamblingCooldowns, d.gamblingCooldowns);
    restoreIdNumberMap(lowMoodSince, d.lowMoodSince);
    restoreIdNumberMap(lowSocialSince, d.lowSocialSince);
    restoreIdNumberMap(sickRecoveredAt, d.sickRecoveredAt);
    restoreIdListMap(drunkHistory, d.drunkHistory);
    restoreIdNumberMap(alcoholRecoveredAt, d.alcoholRecoveredAt);
    restoreIdNumberMap(brokeSince, d.brokeSince);
    restoreIdListMap(gamblingHistory, d.gamblingHistory);
  },
};

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export function statesTick() {
  const world = db.select().from(worldState).limit(1).all()[0];
  if (!world) return;

  // CLOCK: two clocks on purpose. Agent states (`started_at`, `duration`), the
  // trackers (./states/trackers.ts) and every duration in this phase are GAME MINUTES — they
  // were ticks, so at 4x every state lasted four times its game-time length
  // (a 2-4 h drunk spell ran 8-16 game hours, three broke days took twelve).
  // `currentTick` is kept only for the memory stream, which is tick-stamped.
  const currentTick = world.time.totalTicks as number;
  const nowMinutes = gameMinutes(world.time);
  const weather = world.weather as string;
  const season = world.time.season as string;

  clearEffectivePersonalities();

  const allAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const currentActiveIds = new Set(allAgents.map((a) => a.id));
  const removedAgentIds = [...previouslyActiveAgents].filter((id) => !currentActiveIds.has(id));
  previouslyActiveAgents = currentActiveIds;

  const pendingCascades: CascadeEntry[] = [];
  const ctx = createStatesTickContext();

  // ── Pass 1: Per-agent processing ──────────────────────────────────────────
  // Every step re-reads the agent's rows from `ctx.states`: each step can end
  // or start states (and so can the simEvents listeners it fires), and the
  // snapshot goes back to the table exactly when that happened.
  for (const agent of allAgents) {
    // 1a. Expire time-bounded states
    expireTimedStates(agent, ctx.states.forAgent(agent.id), nowMinutes, pendingCascades);

    // 1b. Check conditional exits (stressed, lonely, depressed, infatuated)
    const agentNeeds = ctx.needsOf(agent.id);
    checkConditionalExits(ctx.states.forAgent(agent.id), agentNeeds, agent, nowMinutes, world.tick_speed, ctx);

    // 1c. Evaluate triggers for new states
    const activeTypes = new Set(ctx.states.forAgent(agent.id).map((s) => s.type));
    evaluateTriggers(
      agent,
      agentNeeds,
      activeTypes,
      nowMinutes,
      weather,
      season,
      removedAgentIds,
      allAgents,
      world.tick_speed,
      ctx,
    );

    // 1d. Compute effective personality from all current states
    if (agent.personality) {
      const effective = computeEffectivePersonality(
        agent.personality as PersonalityProfile,
        ctx.states.forAgent(agent.id),
      );
      setEffectivePersonality(agent.id, effective);
    }
  }

  // ── Pass 2: Cascades ──────────────────────────────────────────────────────
  applyCascades(pendingCascades, nowMinutes, ctx);

  // ── Pass 3: Side effects ──────────────────────────────────────────────────
  for (const agent of allAgents) {
    processStateEffects(agent, ctx.states.forAgent(agent.id), allAgents, nowMinutes, currentTick, world.tick_speed, ctx);
  }

  // ── Blackmail self-expose: honest victims have a small daily chance to expose ──
  // Once per game day, on the day rollover. `currentTick % 1440 < 2` rolled on
  // two consecutive ticks (doubling the chance) and every 1440 TICKS, which is
  // every 4 game days at 4x.
  if (dayChanged(world.pending_transitions)) exposeBlackmailOnDayChange();

  // Public-knowledge spread is the gossip phase's job (gossipEngine.ts); it
  // used to run here too, doubling the work without changing the outcome.
  deactivateStaleFacts();

  // ── Death check — runs after all state processing ────────────────────
  // The wizard's "Death Enabled" rule (B20). Off means no one dies of anything
  // here — starvation, illness, drink, age or accident; the causes' states
  // (sick, alcoholic, ...) still run their course, they just aren't fatal.
  if (isDeathEnabled()) runDeathChecks(allAgents, nowMinutes, season, world.tick_speed, ctx);

  emitter.markDirty('agents.all');
}

// ─── Pass 1a: expiry ──────────────────────────────────────────────────────────

/** Fixed-length states of the intimacy layer that end without a feed row (see `expireTimedStates`). */
const QUIET_EXPIRY_STATES: ReadonlySet<StateType> = new Set<StateType>(['afterglow', 'guilty', 'suspicious']);

/** Delete the agent's time-bounded states whose duration has run out. */
function expireTimedStates(
  agent: AgentRow,
  stateRows: readonly AgentStateRow[],
  nowMinutes: number,
  pendingCascades: CascadeEntry[],
) {
  for (const state of stateRows) {
    const def = STATE_DEFINITIONS[state.type as StateType];
    if (def?.conditionalExit) continue; // handled in 1b
    if (state.started_at + state.duration > nowMinutes) continue;

    // Track sickness recovery for immunity cooldown
    if (QUIET_EXPIRY_STATES.has(state.type as StateType)) {
      // A night's afterglow, a guilty conscience and a suspicion are private: the
      // feed neither announces them (lib/intimacy inserts them directly, no
      // `state_gained` row) nor says "X is no longer afterglow".
    } else if (state.type === 'sick') {
      sickRecoveredAt.set(agent.id, nowMinutes);
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
        metadata: { beat: 'release' },
      });
      releaseFromJail(agent, state);
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

/**
 * A served sentence becomes news. The comment above promised a gossip fact for
 * a long time and nothing made one, so the town never heard its prisoner was
 * back on the street. The fact is known to the arresting constable (the state's
 * target) and to everyone who knew of the arrest: they are the ones who would
 * notice. `crime:released` lets later systems react (a welcome home, a wary
 * neighbour); nothing listens yet.
 */
function releaseFromJail(agent: AgentRow, state: AgentStateRow): void {
  const arrestKnowers = db.select({ known_by: shared_knowledge.known_by }).from(shared_knowledge)
    .where(and(
      eq(shared_knowledge.type, 'arrest'),
      eq(shared_knowledge.subject_id, agent.id),
      eq(shared_knowledge.is_active, true),
    ))
    .all()
    .flatMap((f) => f.known_by as number[]);
  const constableId = state.target_agent_id;
  const hours = Math.max(1, Math.round(state.duration / 60));
  createFact('released', agent.id, null, 1,
    [agent.id, ...(constableId != null ? [constableId] : []), ...arrestKnowers],
    'event', { detail: `${hours} ${hours === 1 ? 'hour' : 'hours'}` });
  const prisonId = (state.metadata as { prison_id?: number } | null)?.prison_id ?? agent.current_location ?? null;
  const payload: SimEventPayloads['crime:released'] = { agentId: agent.id, locationId: prisonId };
  simEvents.emit('crime:released', payload);
}

// ─── Day change: blackmail self-exposure ──────────────────────────────────────

/** Honest blackmail victims have a small daily chance to expose the secret themselves. */
function exposeBlackmailOnDayChange() {
  const blackmailFacts = db.select().from(shared_knowledge)
    .where(and(eq(shared_knowledge.type, 'blackmail'), eq(shared_knowledge.is_active, true)))
    .all();
  for (const fact of blackmailFacts) {
    const victimId = fact.target_id;
    if (!victimId) continue;
    const victim = db.select({ personality: agents.personality, name: agents.name }).from(agents).where(eq(agents.id, victimId)).get();
    if (!victim?.personality) continue;
    const honesty = victim.personality.honesty ?? 50;
    if (honesty > 60 && Math.random() < 0.05) {
      // Self-expose: make the secret public, deactivate blackmail
      db.update(shared_knowledge).set({ is_active: false }).where(eq(shared_knowledge.id, fact.id)).run();
      simEvents.emit('state:triggered', { agentId: victimId, state: 'relieved', cause: 'exposed blackmail secret publicly' });
      logActivity({ type: 'drama', initiator: victimId, templateData: { description: `${victim.name} publicly exposed their blackmailer's leverage, ending the blackmail.` }, metadata: { beat: 'blackmail' } });
    }
  }
}

// ─── Death check ──────────────────────────────────────────────────────────────

/** Runs after all state processing, so a death never cuts a side effect short. */
function runDeathChecks(
  allAgents: AgentRow[],
  nowMinutes: number,
  season: string,
  tickSpeed: number,
  ctx: StatesTickContext,
) {
  // Agents who died this tick, so the same agent is never processed twice.
  const diedThisTick = new Set<number>();
  for (const agent of allAgents) {
    // Through the snapshot, which re-reads after any needs write: a death
    // (processAgentDeath) fires listeners that can touch the survivors' needs.
    const agentNeeds = ctx.needsOf(agent.id);
    if (!agentNeeds) continue;

    const states = ctx.states.forAgent(agent.id);
    const action = agent.current_action?.type ?? 'idle';
    const isOutdoors = agent.current_location == null;

    const deathCause = checkDeathTriggers(
      { id: agent.id, name: agent.name, age: agent.age },
      nowMinutes, states, agentNeeds, ctx.jobOf(agent.id) ?? '', action, isOutdoors, season, tickSpeed,
    );

    if (deathCause && !diedThisTick.has(agent.id)) {
      diedThisTick.add(agent.id);
      processAgentDeath(agent.id, agent.name, deathCause, nowMinutes);
    }
  }
}

// ─── computeEffectivePersonality ──────────────────────────────────────────────

function computeEffectivePersonality(
  base: PersonalityProfile,
  states: ReadonlyArray<{ type: string; severity: number }>,
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

// ─── checkConditionalExits ────────────────────────────────────────────────────

/**
 * Whether a state's natural exit is on hold (`metadata.holdUntil`, game minutes).
 * A feeling the player stirred (lib/godPowers.ts) holds for a while before its
 * exit condition applies: a stirred crush on someone the agent barely likes has
 * romance < 40 from the start and would otherwise vanish the moment the grace
 * period ends, before it could color a single conversation.
 */
export function isHeld(metadata: unknown, nowMinutes: number): boolean {
  const holdUntil = (metadata as Record<string, unknown> | null)?.holdUntil;
  return typeof holdUntil === 'number' && nowMinutes < holdUntil;
}

function checkConditionalExits(
  stateRows: readonly AgentStateRow[],
  agentNeeds: typeof needsTable.$inferSelect | undefined,
  agent: typeof agents.$inferSelect,
  nowMinutes: number,
  /** Game minutes per tick, for windows over wall-clock-stamped tables. */
  tickSpeed: number,
  ctx: StatesTickContext,
) {
  for (const state of stateRows) {
    if (!STATE_DEFINITIONS[state.type as StateType]?.conditionalExit) continue;

    // A state created while its exit condition already holds would be deleted on
    // the very next tick. That silently no-op'd every cascade rule that grants
    // `stressed` (arrest, blackmail, humiliation, ...) to an agent whose needs
    // happened to be fine. Give every conditional state a minimum lifetime.
    if (nowMinutes - state.started_at < CONDITIONAL_EXIT_GRACE_MINUTES) continue;
    if (isHeld(state.metadata, nowMinutes)) continue;

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
        // Look back 10 game hours (enough to catch recent conversations): the old
        // "10 minutes real-time" at 1x, now speed-independent.
        const sinceWindow = Date.now() - gameMinutesToMs(600, tickSpeed);
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
        // Exit path 2: sustained high mood (mood > 55 for 120+ minutes = natural recovery)
        if (agentNeeds && agentNeeds.mood > 55) {
          const elapsed = nowMinutes - state.started_at;
          if (elapsed > 120) {
            shouldExit = true;
          }
        }
        // Exit path 3: long duration (depression lifts after ~2 game days even without help)
        const maxDepressedMinutes = 2880; // ~2 game days
        if (nowMinutes - state.started_at > maxDepressedMinutes) {
          // OR, not assignment: a plain `=` let this arm overwrite the exit that
          // path 2 had already granted, so past the two-day mark a recovered
          // agent was pushed back into depression 95% of the time and the state
          // became effectively permanent.
          shouldExit = shouldExit || Math.random() < chancePerTick(0.05, tickSpeed); // 5% per game minute after 2 days
        }
        break;
      }

      case 'infatuated': {
        if (!state.target_agent_id) {
          // No love-interest link to evaluate. Pass 1a skips conditional-exit
          // states entirely, so without this fallback the state is permanent.
          shouldExit = state.started_at + state.duration <= nowMinutes;
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
        const meta = state.metadata ?? {};
        if (meta.recoveryTriggered) {
          shouldExit = true;
          break;
        }
        // Recovery path 2: rock bottom (money = 0, no food)
        const eco = ctx.economyOf(agent.id);
        if (eco && eco.money <= 0) {
          const hasFood = foodCount(eco.inventory) > 0;
          if (!hasFood && Math.random() < chancePerTick(0.01, tickSpeed)) { // 1% per game minute
            shouldExit = true;
          }
        }
        break;
      }

      case 'jealous': {
        const meta = state.metadata ?? {};
        const loveInterestId = meta.loveInterestId as number | undefined;
        const rivalId = meta.rivalId as number | undefined;
        if (!loveInterestId || !rivalId) {
          // Jealousy from a source that didn't record the triangle (e.g. a
          // cascade rule). Exiting immediately would delete it the very next
          // tick, so let it run out its duration instead.
          shouldExit = state.started_at + state.duration <= nowMinutes;
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
          const elapsed = nowMinutes - state.started_at;
          if (elapsed > 2160 && Math.random() < chancePerTick(0.03, tickSpeed)) shouldExit = true; // 3%/game minute
        }
        break;
      }

      case 'in_debt': {
        const eco = ctx.economyOf(agent.id);
        shouldExit = eco != null && eco.money > 20;
        if (shouldExit) brokeSince.delete(agent.id);
        break;
      }

      default:
        break;
    }

    if (shouldExit) {
      if (state.type === 'stressed') {
        stressRemovedAt.set(agent.id, nowMinutes);
      }
      if (state.type === 'alcoholic') {
        alcoholRecoveredAt.set(agent.id, nowMinutes);
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

/**
 * Insert the states that expiries queued in pass 1a (drunk -> hungover, drunk
 * -> angry). One level only: it used to take a depth and recurse on a list of
 * further cascades that nothing ever filled.
 */
function applyCascades(
  cascades: CascadeEntry[],
  nowMinutes: number,
  ctx: StatesTickContext,
) {
  for (const cascade of cascades) {
    // Check if this state already exists for the agent
    if (ctx.states.find(cascade.agentId, cascade.stateType)) continue;

    const severity = cascade.severity ?? 0.5;
    // Shared with the ripple engine's cascade states (lib/stateDurations.ts):
    // hungover 3-6 h, angry 3-12 h, sick 6-18 h, depressed open-ended.
    const duration = rollStateDuration(cascade.stateType) ?? 240;

    db.insert(agentStates)
      .values({
        agent_id: cascade.agentId,
        type: cascade.stateType,
        severity,
        started_at: nowMinutes,
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
  }
}
