import { db } from '../db';
import { agents, relationships, relationshipEvents, agentStates } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { getEffectivePersonality } from './states';
import { adjustReputation } from './reputationEngine';
import { recordGoalOutcome } from './goals/goalProgress';
import { MINUTES_PER_HOUR } from './gameClock';
import { gameMinutesNow } from './worldClock';
import { isAdultAge } from './intimacy/eligibility';

// ─── Confrontation Engine ─────────────────────────────────────────────────────
// When two residents with a feud — a sour pair (average friendship at or below
// FEUD_FRIENDSHIP) or one carrying a `grudge`/`rival` tag — find themselves at
// the same location, there's a chance of a public confrontation. Witnesses pick
// sides. Confrontations can resolve grudges or deepen them.
//
// The cascade asks for confrontations too (heartbreak, jealousy, theft, anger,
// a drunk, a snap, a witness stepping in: `interaction:completed` with
// `action: 'confrontation'`). Those used to go nowhere — a memory line and a goal
// tick, no scene, no relationship change — so the town's grievances piled up
// without ever being aired. `initConfrontationListeners` turns them into the same
// scene the hourly check stages: now if the two are together, otherwise at their
// next meeting within PENDING_WAIT_MINUTES.

/**
 * Pairs at or below this average friendship are hostile enough to have it out.
 * It was -40, a line playtests showed almost no pair ever crossed (one pair in 32
 * game days), so the engine that should air grievances almost never ran.
 */
export const FEUD_FRIENDSHIP = -20;
/** Relationship tags (pair-level, `relationships.tags`) that mark a feud whatever the numbers say. */
const FEUD_TAGS: readonly string[] = ['grudge', 'rival'];

/**
 * GAME MINUTES between two confrontations of the same pair, and the rest an agent
 * gets after one before the cascade may drag them into another. It was one real
 * hour of Date.now() — 60 game hours at 1x, but 15 at 4x and "forever" while
 * paused — so the same 60 game hours, now on the clock the story runs on.
 */
export const COOLDOWN_MINUTES = 60 * MINUTES_PER_HOUR;
/** How long a cascade confrontation between two people apart waits for them to meet. */
export const PENDING_WAIT_MINUTES = 12 * MINUTES_PER_HOUR;

const confrontationCooldown = new Map<string, number>(); // pairKey → game minute of the last one
/**
 * Agent id → game minute of their last confrontation. Only cascade requests read
 * it: a scene emits `confrontation:occurred`, a witness may intervene against its
 * perpetrator (`interaction:completed` again, but a *new* pair), and without a
 * per-person rest one brawl could chain through the whole tavern.
 */
const agentLastConfrontation = new Map<number, number>();
/** Cascade confrontations waiting for the two to meet: pairKey → who starts it and until when. */
const pendingConfrontations = new Map<string, { initiatorId: number; targetId: number; until: number }>();

function pairKey(a: number, b: number): string {
  return `${Math.min(a, b)}_${Math.max(a, b)}`;
}

/**
 * Drop confrontation cooldowns and pending scenes for a world replace. The keys
 * are agent ids, which SQLite reuses after the wipe: left in place, a grudge pair
 * from the previous world would mute (or, pending, stage a scene between) the new
 * agents that inherit those ids. The stamps are game minutes, and a new world's
 * clock can start earlier than the old one's, which would read as "just now".
 */
export function clearConfrontationCooldowns(): void {
  confrontationCooldown.clear();
  agentLastConfrontation.clear();
  pendingConfrontations.clear();
}

/** Forget stamps long past (or from a clock that went backwards), so the maps stay small. */
function cleanupCooldowns(nowMinutes: number): void {
  for (const [key, at] of confrontationCooldown) {
    if (nowMinutes - at > COOLDOWN_MINUTES * 2 || at > nowMinutes) confrontationCooldown.delete(key);
  }
  for (const [id, at] of agentLastConfrontation) {
    if (nowMinutes - at > COOLDOWN_MINUTES * 2 || at > nowMinutes) agentLastConfrontation.delete(id);
  }
  for (const [key, p] of pendingConfrontations) {
    if (nowMinutes > p.until) pendingConfrontations.delete(key);
  }
}

function pairOnCooldown(a: number, b: number, nowMinutes: number): boolean {
  const last = confrontationCooldown.get(pairKey(a, b));
  return last != null && nowMinutes - last < COOLDOWN_MINUTES;
}

function agentOnCooldown(id: number, nowMinutes: number): boolean {
  const last = agentLastConfrontation.get(id);
  return last != null && nowMinutes - last < COOLDOWN_MINUTES;
}

function markConfronted(a: number, b: number, nowMinutes: number): void {
  confrontationCooldown.set(pairKey(a, b), nowMinutes);
  agentLastConfrontation.set(a, nowMinutes);
  agentLastConfrontation.set(b, nowMinutes);
  pendingConfrontations.delete(pairKey(a, b));
}

/**
 * The pair has just made peace (a mediated reconciliation, lib/factions): the
 * same rest a confrontation gives, so the hourly roll doesn't stage a brawl
 * between them the next time they share a room, while their numbers are still
 * climbing back out of feud territory. A pending cascade scene goes too.
 */
export function notePeaceMade(a: number, b: number, nowMinutes: number): void {
  confrontationCooldown.set(pairKey(a, b), nowMinutes);
  pendingConfrontations.delete(pairKey(a, b));
}

/** What the hourly roll needs to know about a co-located pair. */
export interface ConfrontationOdds {
  avgFriendship: number;
  tags: readonly string[];
  aggressionA?: number | null;
  aggressionB?: number | null;
  drunkA?: boolean;
  drunkB?: boolean;
}

/**
 * The chance a co-located pair has it out on one hourly check, or 0 when they
 * have no feud. Hostility counts from the feud line, not from zero: the old
 * `0.03 + (hostility - 40) * 0.002` gave a pair at -40 its 3% and anyone warmer
 * nothing. Now -20 is the 3% base and -100 reaches 15%, the same ceiling as
 * before. A tagged pair above the line (a grudge between people still on
 * speaking terms) rolls the base only.
 */
export function confrontationChance(o: ConfrontationOdds): number {
  const feudTagged = o.tags.some((t) => FEUD_TAGS.includes(t));
  if (o.avgFriendship > FEUD_FRIENDSHIP && !feudTagged) return 0;
  const hostility = Math.max(0, FEUD_FRIENDSHIP - o.avgFriendship);
  let chance = 0.03 + hostility * 0.0015;
  // Personality modifiers
  if ((o.aggressionA ?? 0) > 60) chance += 0.05;
  if ((o.aggressionB ?? 0) > 60) chance += 0.05;
  // Drunk agents confront more easily
  if (o.drunkA) chance += 0.1;
  if (o.drunkB) chance += 0.1;
  return Math.min(1, chance);
}

type AgentRow = typeof agents.$inferSelect;
type RelRow = typeof relationships.$inferSelect;

function pairRel(allRels: RelRow[], x: number, y: number): RelRow | undefined {
  const a = Math.min(x, y);
  const b = Math.max(x, y);
  return allRels.find((r) => r.agent_a === a && r.agent_b === b);
}

function isDrunk(agentId: number): boolean {
  return db.select({ type: agentStates.type }).from(agentStates)
    .where(eq(agentStates.agent_id, agentId)).all()
    .some((s) => s.type === 'drunk');
}

/**
 * Called once per game hour (engine/tick.ts) inside a transaction: stage the
 * cascade confrontations whose pair has met since, then roll for every feuding
 * pair sharing a location.
 */
export function confrontationCheck(nowMinutes: number): void {
  cleanupCooldowns(nowMinutes);
  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const byId = new Map(activeAgents.map((a) => [a.id, a]));
  const allRels = db.select().from(relationships).all();

  // Cascade scenes waiting for their pair: they are together now, so it happens.
  for (const [key, p] of [...pendingConfrontations]) {
    const initiator = byId.get(p.initiatorId);
    const target = byId.get(p.targetId);
    if (!initiator || !target) { pendingConfrontations.delete(key); continue; }
    const where = initiator.current_location;
    if (where == null || where !== target.current_location) continue;
    if (pairOnCooldown(initiator.id, target.id, nowMinutes)) { pendingConfrontations.delete(key); continue; }
    markConfronted(initiator.id, target.id, nowMinutes);
    resolveConfrontation(initiator, target, where, { goals: 'resolved_only' });
  }

  // Group agents by location
  const byLocation = new Map<number, AgentRow[]>();
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
        if (pairOnCooldown(agentA.id, agentB.id, nowMinutes)) continue;

        const rel = pairRel(allRels, agentA.id, agentB.id);
        if (!rel) continue;

        const chance = confrontationChance({
          avgFriendship: (rel.friendship_ab + rel.friendship_ba) / 2,
          tags: (rel.tags as string[] | null) ?? [],
          aggressionA: getEffectivePersonality(agentA.id)?.aggression,
          aggressionB: getEffectivePersonality(agentB.id)?.aggression,
          drunkA: isDrunk(agentA.id),
          drunkB: isDrunk(agentB.id),
        });
        if (chance <= 0 || Math.random() > chance) continue;

        // Confrontation happens!
        markConfronted(agentA.id, agentB.id, nowMinutes);
        resolveConfrontation(agentA, agentB, locationId);
      }
    }
  }
}

/** The cast of an `interaction:completed` event, as far as a confrontation reads it. */
export interface ConfrontationRequest {
  agentId?: number | null;
  perpetratorId?: number | null;
  victimId?: number | null;
  action?: string;
  _cascade?: unknown;
}

/**
 * Who a cascade confrontation is between. The event's agent always starts it. The
 * ripple rules and the snap make that agent the perpetrator and the other party
 * the victim; a witness who intervenes (WitnessAmplifier) keeps the original
 * cast, so the one they square up to is the perpetrator. Null when the event
 * names nobody else (a snap without a culprit): there is no one to confront.
 */
export function confrontationCast(p: ConfrontationRequest): { initiatorId: number; targetId: number } | null {
  if (p.agentId == null) return null;
  const targetId = p.perpetratorId != null && p.perpetratorId !== p.agentId ? p.perpetratorId : p.victimId;
  if (targetId == null || targetId === p.agentId) return null;
  return { initiatorId: p.agentId, targetId };
}

export type CascadeConfrontationOutcome = 'resolved' | 'pending' | 'cooldown' | 'skipped';

/**
 * Turn a cascade confrontation into a scene. Only `_cascade`-tagged events: the
 * conversation beats (`emitFightBeat`) emit the same action for a fight that
 * already has its feed row and relationship event, and must not be staged twice.
 * Both cooldowns apply, so a chain of rules (or a witness stepping in on the
 * scene this just staged) can't spam the same people.
 */
export function handleCascadeConfrontation(payload: ConfrontationRequest, nowMinutes: number): CascadeConfrontationOutcome {
  if (payload?.action !== 'confrontation' || payload._cascade == null) return 'skipped';
  const cast = confrontationCast(payload);
  if (!cast) return 'skipped';
  const initiator = db.select().from(agents).where(eq(agents.id, cast.initiatorId)).get();
  const target = db.select().from(agents).where(eq(agents.id, cast.targetId)).get();
  if (!initiator?.is_active || !target?.is_active) return 'skipped';
  if (pairOnCooldown(initiator.id, target.id, nowMinutes)
    || agentOnCooldown(initiator.id, nowMinutes) || agentOnCooldown(target.id, nowMinutes)) return 'cooldown';

  const where = initiator.current_location;
  if (where != null && where === target.current_location) {
    markConfronted(initiator.id, target.id, nowMinutes);
    resolveConfrontation(initiator, target, where, { goals: 'resolved_only' });
    return 'resolved';
  }
  // Apart: it keeps until they next share a room (confrontationCheck). A newer
  // grievance of the same pair replaces the older one rather than queueing twice.
  // Not the conversation queue: its scheduler drops an ordinary entry whose pair
  // is apart on first sight, and a queued chat has no outcome of its own.
  pendingConfrontations.set(pairKey(initiator.id, target.id), {
    initiatorId: initiator.id, targetId: target.id, until: nowMinutes + PENDING_WAIT_MINUTES,
  });
  return 'pending';
}

/** Cascade confrontations still waiting for their pair to meet (copies). */
export function pendingConfrontationPairs(): Array<{ initiatorId: number; targetId: number; until: number }> {
  return [...pendingConfrontations.values()].map((p) => ({ ...p }));
}

let listenersRegistered = false;

/**
 * Listen for cascade confrontations. Once per process (server/index.ts), not at
 * import: tests that import the engine for its helpers must not start staging
 * scenes from every `interaction:completed` another test emits. simEvents is
 * synchronous, so the listener runs inside the emitter's transaction when there
 * is one (nested = a savepoint); the snap path emits after an await, outside any.
 */
export function initConfrontationListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;
  simEvents.on('interaction:completed', (payload: ConfrontationRequest) => {
    if (payload?.action !== 'confrontation' || payload._cascade == null) return;
    try {
      db.transaction(() => { handleCascadeConfrontation(payload, gameMinutesNow()); });
    } catch (err) {
      console.error('[confrontation] cascade confrontation failed:', err);
    }
  });
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

interface ResolveOptions {
  /**
   * 'all' (the hourly check) credits every outcome. A cascade confrontation's
   * `interaction:completed` has already credited the initiator a 'fought_target'
   * (engine/systems/goals.ts), so only a reconciliation — which that event can't
   * know about — is credited on top, instead of counting the same row twice.
   */
  goals?: 'all' | 'resolved_only';
}

function resolveConfrontation(
  agentA: AgentRow,
  agentB: AgentRow,
  locationId: number,
  opts: ResolveOptions = {},
): void {
  const now = Date.now();
  const outcome = Math.random();
  // Nobody under 18 comes to blows in the feed: with a minor on either side the
  // worst it gets is a shouting match. Fail-closed like every age check
  // (isAdultAge): a missing age reads as a minor.
  const physicalAllowed = isAdultAge(agentA.age) && isAdultAge(agentB.age);

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

  } else if (outcome < 0.7 || !physicalAllowed) {
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

  const resolved = outcome < 0.3;
  if (resolved || opts.goals !== 'resolved_only') recordConfrontationGoals(agentA.id, agentB.id, resolved);

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
