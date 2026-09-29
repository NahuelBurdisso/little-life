import { db } from '../db';
import { agents, relationships, relationshipEvents, agentStates } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { getEffectivePersonality } from './states';
import { adjustReputation } from './reputationEngine';
import { recordGoalOutcome } from './goals/goalProgress';

// ─── Confrontation Engine ─────────────────────────────────────────────────────
// When agents with deep grudges (friendship < -40) encounter each other at the
// same location, there's a chance of public confrontation. Witnesses pick sides.
// Confrontations can resolve grudges or deepen them.

const confrontationCooldown = new Map<string, number>(); // pairKey → timestamp
const COOLDOWN_MS = 3600000; // 1 real hour between confrontations for same pair
let lastCleanup = 0;

function pairKey(a: number, b: number): string {
  return `${Math.min(a, b)}_${Math.max(a, b)}`;
}

/**
 * Drop confrontation cooldowns for a world replace.
 *
 * The values are wall-clock ms, so they are not stale in the unit sense — but the
 * keys are built from agent ids, which SQLite reuses after the wipe. Left in place,
 * a grudge pair from the previous world suppresses confrontations between the new
 * agents that inherit those ids for up to COOLDOWN_MS (and `cleanupCooldowns` only
 * prunes past COOLDOWN_MS * 2).
 */
export function clearConfrontationCooldowns(): void {
  confrontationCooldown.clear();
  lastCleanup = 0;
}

function cleanupCooldowns(): void {
  const now = Date.now();
  if (now - lastCleanup < COOLDOWN_MS) return;
  lastCleanup = now;
  for (const [key, ts] of confrontationCooldown) {
    if (now - ts > COOLDOWN_MS * 2) confrontationCooldown.delete(key);
  }
}

/** Called every 60 ticks to check for confrontation opportunities. */
export function confrontationCheck(_totalTicks: number): void {
  cleanupCooldowns();
  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const allRels = db.select().from(relationships).all();
  const now = Date.now();

  // Group agents by location
  const byLocation = new Map<number, typeof activeAgents>();
  for (const agent of activeAgents) {
    if (agent.current_location === null) continue;
    const group = byLocation.get(agent.current_location) ?? [];
    group.push(agent);
    byLocation.set(agent.current_location, group);
  }

  for (const [locationId, group] of byLocation) {
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const agentA = group[i];
        const agentB = group[j];
        const key = pairKey(agentA.id, agentB.id);

        // Check cooldown
        const lastConfront = confrontationCooldown.get(key);
        if (lastConfront && now - lastConfront < COOLDOWN_MS) continue;

        // Check grudge level
        const a = Math.min(agentA.id, agentB.id);
        const b = Math.max(agentA.id, agentB.id);
        const rel = allRels.find(r => r.agent_a === a && r.agent_b === b);
        if (!rel) continue;

        const avgFriendship = (rel.friendship_ab + rel.friendship_ba) / 2;
        if (avgFriendship > -40) continue; // not enemies

        // Confrontation probability scales with hostility
        const hostility = Math.abs(avgFriendship);
        let confrontChance = 0.03 + (hostility - 40) * 0.002; // 3% base + hostility scaling

        // Personality modifiers
        const persA = getEffectivePersonality(agentA.id);
        const persB = getEffectivePersonality(agentB.id);
        if (persA && persA.aggression > 60) confrontChance += 0.05;
        if (persB && persB.aggression > 60) confrontChance += 0.05;

        // Drunk agents confront more easily
        const statesA = db.select().from(agentStates).where(eq(agentStates.agent_id, agentA.id)).all();
        const statesB = db.select().from(agentStates).where(eq(agentStates.agent_id, agentB.id)).all();
        if (statesA.some(s => s.type === 'drunk')) confrontChance += 0.1;
        if (statesB.some(s => s.type === 'drunk')) confrontChance += 0.1;

        if (Math.random() > confrontChance) continue;

        // Confrontation happens!
        confrontationCooldown.set(key, now);
        resolveConfrontation(agentA, agentB, rel, locationId);
      }
    }
  }
}

/**
 * What a confrontation does for either side's goals (lib/goals/goalProgress.ts). Clearing the
 * air serves a befriend goal on both sides. A row that stays a row has a winner — the one who
 * brought more fight to it (effective aggression, ties to whoever started it) — and a grudge
 * gets more out of winning it than out of merely having had it.
 */
function recordConfrontationGoals(aId: number, bId: number, resolved: boolean): void {
  if (resolved) {
    recordGoalOutcome(aId, bId, 'confrontation_resolved');
    recordGoalOutcome(bId, aId, 'confrontation_resolved');
    return;
  }
  const aggression = (id: number) => getEffectivePersonality(id)?.aggression ?? 50;
  const [winner, loser] = aggression(bId) > aggression(aId) ? [bId, aId] : [aId, bId];
  recordGoalOutcome(winner, loser, 'confrontation_won');
  recordGoalOutcome(loser, winner, 'fought_target');
}

function resolveConfrontation(
  agentA: typeof agents.$inferSelect,
  agentB: typeof agents.$inferSelect,
  _rel: typeof relationships.$inferSelect,
  locationId: number,
): void {
  const now = Date.now();
  const outcome = Math.random();

  if (outcome < 0.3) {
    // RESOLUTION: They hash it out, grudge softens
    logActivity({
      type: 'drama',
      initiator: agentA.id,
      target: agentB.id,
      templateData: {
        description: `${agentA.name} and ${agentB.name} had a heated argument but managed to clear the air`,
      },
      metadata: { beat: 'reconciliation' },
    });

    db.insert(relationshipEvents).values({
      agent_a: agentA.id,
      agent_b: agentB.id,
      event_type: 'confrontation_resolved',
      description: `${agentA.name} and ${agentB.name} resolved their differences`,
      friendship_delta_ab: 15,
      friendship_delta_ba: 15,
      romance_delta_ab: 0,
      romance_delta_ba: 0,
      trust_delta_ab: 5,
      trust_delta_ba: 5,
      sentiment: 0.3,
      processed: false,
      timestamp: now,
    }).run();

  } else if (outcome < 0.7) {
    // ESCALATION: Fight worsens things
    logActivity({
      type: 'drama',
      initiator: agentA.id,
      target: agentB.id,
      templateData: {
        description: `${agentA.name} and ${agentB.name} had a public shouting match!`,
      },
      metadata: { beat: 'fight' },
    });

    db.insert(relationshipEvents).values({
      agent_a: agentA.id,
      agent_b: agentB.id,
      event_type: 'confrontation_escalated',
      description: `${agentA.name} and ${agentB.name} had a heated argument`,
      friendship_delta_ab: -10,
      friendship_delta_ba: -10,
      romance_delta_ab: 0,
      romance_delta_ba: 0,
      trust_delta_ab: -8,
      trust_delta_ba: -8,
      sentiment: -0.8,
      processed: false,
      timestamp: now,
    }).run();

    adjustReputation(agentA.id, -3);
    adjustReputation(agentB.id, -3);

  } else {
    // DRAMATIC: Physical confrontation — witnesses react
    logActivity({
      type: 'drama',
      initiator: agentA.id,
      target: agentB.id,
      templateData: {
        description: `${agentA.name} and ${agentB.name} got into a physical fight in public!`,
      },
      metadata: { beat: 'fight' },
    });

    db.insert(relationshipEvents).values({
      agent_a: agentA.id,
      agent_b: agentB.id,
      event_type: 'fight',
      description: `${agentA.name} and ${agentB.name} got into a physical fight`,
      friendship_delta_ab: -20,
      friendship_delta_ba: -20,
      romance_delta_ab: 0,
      romance_delta_ba: 0,
      trust_delta_ab: -15,
      trust_delta_ba: -15,
      sentiment: -1.0,
      processed: false,
      timestamp: now,
    }).run();

    adjustReputation(agentA.id, -8);
    adjustReputation(agentB.id, -8);
  }

  recordConfrontationGoals(agentA.id, agentB.id, outcome < 0.3);

  // `agentId`/`perpetratorId`/`victimId` are the fields the cascade engine excludes
  // when picking a witness. Without them the combatants could be selected as
  // witnesses to their own fight.
  simEvents.emit('confrontation:occurred', {
    agentId: agentA.id,
    perpetratorId: agentA.id,
    victimId: agentB.id,
    agentAId: agentA.id,
    agentBId: agentB.id,
    locationId,
  });
}
