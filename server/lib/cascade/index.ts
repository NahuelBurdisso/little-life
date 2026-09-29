// server/lib/cascade/index.ts
import { RippleEngine } from './RippleEngine';
import { WitnessAmplifier } from './WitnessAmplifier';
import { TensionTracker } from './TensionTracker';
import { SnapResolver } from './SnapResolver';
import { simEvents } from '../simEvents';
import { db } from '../../db';
import { agents, agentStates, goals, worldState } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import type { PersonalityProfile } from '../personality';
import { gameMinutes } from '../gameClock';
import { snapThresholdScale } from '../worldRules';
import type { SnapshotStore } from '../../engine/snapshotCodec';

// ─── Singleton instances ────────────────────────────────────────────────────

let rippleEngine: RippleEngine | null = null;
let witnessAmplifier: WitnessAmplifier | null = null;
let tensionTracker: TensionTracker | null = null;
let snapResolver: SnapResolver | null = null;

/** Agents already counted as asleep, so `onSleep` relief fires once per sleep. */
const sleepingAgents = new Set<number>();

/**
 * A checkpoint handed to `tensionSnapshotStore.restore` before `initCascade`
 * has created the tracker. Held here and applied by `initCascade`, so the
 * boot order in server/index.ts (restore after init) is a convenience rather
 * than a trap that silently drops every agent's tension.
 */
let pendingTensionRestore: unknown = undefined;

/**
 * Tension checkpoint (server/engine/simSnapshots.ts). Tension builds over game
 * days toward a snap — the town's big dramatic release — and a restart used to
 * reset every agent to zero, defusing all of them at once. The snap cooldown
 * stamp goes along so a restart cannot license an immediate second snap.
 */
export const tensionSnapshotStore: SnapshotStore = {
  key: 'tension',
  version: 1,
  // No tracker yet: skip the write rather than overwrite a good checkpoint
  // with an empty one.
  serialize: () => tensionTracker ? tensionTracker.serialize() : pendingTensionRestore,
  restore(data) {
    if (tensionTracker) tensionTracker.restore(data);
    else pendingTensionRestore = data;
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getCurrentTick(): number {
  const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  return (world?.time as any)?.totalTicks ?? 0;
}

// ─── initCascade ────────────────────────────────────────────────────────────

export function initCascade(): void {
  // Create instances
  tensionTracker = new TensionTracker();
  witnessAmplifier = new WitnessAmplifier();
  snapResolver = new SnapResolver();
  rippleEngine = new RippleEngine(); // registers simEvents listeners in constructor

  if (pendingTensionRestore !== undefined) {
    tensionTracker.restore(pendingTensionRestore);
    pendingTensionRestore = undefined;
  }

  // Wire sub-systems into engine
  rippleEngine.setTensionTracker(tensionTracker);
  rippleEngine.setWitnessAmplifier(witnessAmplifier);

  // ─── Direct tension listeners ──────────────────────────────────────────────

  // Stressed while already stressed → +5 tension
  simEvents.on('state:triggered', (payload: any) => {
    if (!tensionTracker) return;
    if (payload?.state !== 'stressed') return;

    const agentId = payload?.agentId;
    if (agentId == null) return;

    // Check if they were already stressed (cascade metadata indicates a new state,
    // but if it already existed, the RippleEngine wouldn't have inserted it)
    const existingStates = db.select({ type: agentStates.type })
      .from(agentStates)
      .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, 'stressed')))
      .all();

    // If there are 2+ stressed states, or the source is cascade but the state already existed
    if (existingStates.length >= 2 || (payload?._cascade && existingStates.length >= 1)) {
      tensionTracker.addTension(agentId, 5, {
        event: 'state:triggered',
        description: 'stressed while already stressed',
        tick: getCurrentTick(),
      });
    }
  });

  // Need critical → +8 tension
  simEvents.on('need:critical', (payload: any) => {
    if (!tensionTracker) return;
    const agentId = payload?.agentId;
    if (agentId == null) return;

    tensionTracker.addTension(agentId, 8, {
      event: 'need:critical',
      description: `critical need: ${payload?.action ?? 'unknown'}`,
      tick: getCurrentTick(),
    });
  });

  // Positive conversation → tension relief
  simEvents.on('conversation:ended', (payload: any) => {
    if (!tensionTracker) return;
    const agentId = payload?.agentId;
    if (agentId == null) return;

    const sentiment = payload?.sentiment ?? 0;
    if (sentiment > 0.3) {
      tensionTracker.onPositiveConversation(agentId);
    }
  });

  console.log('Cascade system initialized');
}

// ─── cascadeTick ────────────────────────────────────────────────────────────

export function cascadeTick(): void {
  if (!rippleEngine || !tensionTracker) return;

  // Tension drift and the snap cooldown run on game minutes (TensionTracker).
  const world = db.select({ time: worldState.time, tick_speed: worldState.tick_speed })
    .from(worldState).limit(1).get();
  const nowMinutes = world?.time ? gameMinutes(world.time) : 0;
  const elapsedMinutes = world?.tick_speed ?? 1;
  // Still the tick for the snap's cascade metadata (chain ids, `currentTick`).
  const currentTick = world?.time?.totalTicks ?? 0;
  // "Drama Intensity": tempers run shorter (or longer) for the whole town.
  const snapScale = snapThresholdScale();

  // 1. Reset per-tick counter
  rippleEngine.resetTickCounter();

  // 2. Process any queued events
  rippleEngine.processQueue();

  // 3. Run tension tickUpdate for all active agents
  const activeAgents = db.select({
    id: agents.id,
    personality: agents.personality,
    current_action: agents.current_action,
  })
    .from(agents)
    .where(eq(agents.is_active, true))
    .all();

  for (const agent of activeAgents) {
    // Rest bleeds off tension. Without this, `onSleep` had no call site at all
    // and sleeping did nothing to defuse an agent heading for a snap. Fire once
    // per sleep, not once per tick asleep — the latter would zero out tension
    // every night.
    const isSleeping = (agent.current_action as { type?: string } | null)?.type === 'sleeping';
    if (isSleeping && !sleepingAgents.has(agent.id)) {
      tensionTracker.onSleep(agent.id);
      sleepingAgents.add(agent.id);
    } else if (!isSleeping) {
      sleepingAgents.delete(agent.id);
    }

    // Get agent's active states
    const stateRows = db.select({ type: agentStates.type })
      .from(agentStates)
      .where(eq(agentStates.agent_id, agent.id))
      .all();
    const activeStates = stateRows.map(s => s.type);

    // Update tension
    tensionTracker.tickUpdate(agent.id, activeStates, elapsedMinutes);

    // 4. Check snap threshold
    const personality = agent.personality as PersonalityProfile | null;
    if (personality && snapResolver && tensionTracker.shouldSnap(agent.id, personality, nowMinutes, snapScale)) {
      // Snapshot the grievances before recording the snap — recordSnap clears them.
      const tensionSources = tensionTracker.getSources(agent.id);

      // Record the snap
      tensionTracker.recordSnap(agent.id, nowMinutes);

      // Get context for the snap prompt
      const agentRow = db.select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .get();

      const agentGoals = db.select({ type: goals.type })
        .from(goals)
        .where(and(eq(goals.agent_id, agent.id), eq(goals.status, 'active')))
        .all();

      // Build personality summary
      const p = personality;
      const traits: string[] = [];
      if (p.aggression > 60) traits.push('aggressive');
      if (p.neuroticism > 60) traits.push('neurotic');
      if (p.impulsiveness > 60) traits.push('impulsive');
      if (p.warmth > 60) traits.push('warm');
      if (p.morality > 60) traits.push('moral');
      if (p.loyalty > 60) traits.push('loyal');

      // Queue async snap resolution (fire and forget)
      void snapResolver.resolveSnap({
        agentName: agentRow?.name ?? `Agent#${agent.id}`,
        personalitySummary: traits.length > 0 ? traits.join(', ') : 'balanced',
        tensionSources,
        activeStates,
        activeGoals: agentGoals.map(g => g.type),
      }).then(action => {
        return snapResolver!.executeSnapAction(agent.id, action, tensionSources, {
          chainId: `snap_${agent.id}_${currentTick}`,
          currentTick,
        });
      }).catch(err => {
        console.error(`[cascade] Snap resolution failed for agent ${agent.id}:`, err);
      });
    }
  }

  // 5. Cleanup cooldowns for inactive agents
  const activeIds = new Set(activeAgents.map(a => a.id));
  rippleEngine.cleanupCooldowns(activeIds);
}

// ─── resetCascade ────────────────────────────────────────────────────────────

export function resetCascade(): void {
  if (rippleEngine) {
    rippleEngine.resetCooldowns();
    rippleEngine.resetTickCounter();
    // Pending events carry raw agent ids. Ids restart at 1 after a world wipe,
    // so a leftover item is not discarded as stale — it lands on whichever
    // *different* agent now holds that id.
    rippleEngine.clearQueue();
  }
  if (tensionTracker) {
    tensionTracker.reset();
  }
  pendingTensionRestore = undefined;
  sleepingAgents.clear();
}
