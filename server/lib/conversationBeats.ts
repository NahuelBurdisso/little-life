/**
 * The drama beats a conversation can end in — insult, fight, flirt, confession, reconciliation,
 * breakup — shared by both conversation tiers.
 *
 * They used to live inline in the LLM tier's completion (`finishCompletedConversation`,
 * engine/systems/conversations.ts), so a template chat could never produce one. With the LLM
 * off (the soak, a player without a GPU) or saturated (templates are ~25% of chats even with
 * it on), the town's drama came from gossip and almost nothing else: a 30-day soak saw 2 beat
 * types, no insults, flirts, confessions or reconciliations. Pulled out here so the template
 * tier's outcome rules (`templateBeats.ts`) emit exactly the rows, facts, events and memories
 * the LLM tier does — the feed, chronicle, goals and memory can't tell which tier it came from.
 *
 * Each helper does the beat's effects only; WHEN a beat happens is the caller's decision (the
 * LLM tier reads it off the transcript's sentiment, the template tier off the pair's state).
 */
import { db } from '../db';
import { agentStates, needs, relationshipEvents, relationships, shared_knowledge } from '../db/schema';
import { and, eq, or } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { createFact } from './gossip';
import { getAgentStates } from './states';
import { withoutMilestoneTags } from './marriage';
import type { PersonalityProfile } from './personality';
import { recordGoalOutcome } from './goals/goalProgress';
import { getPairIntimacy } from './intimacy/state';

/** The bits of an agent row a beat needs. */
export interface BeatAgent {
  id: number;
  name: string;
  current_location?: number | null;
  personality?: unknown;
}

type RelRow = typeof relationships.$inferSelect;

export function pairRelationship(a: number, b: number): RelRow | undefined {
  return db.select().from(relationships)
    .where(and(eq(relationships.agent_a, Math.min(a, b)), eq(relationships.agent_b, Math.max(a, b))))
    .get();
}

/**
 * A relationship event between two agents with `fromA`'s deltas toward `fromB` and back, written
 * in the table's (lower id, higher id) order so relationships.ts applies them the right way.
 */
export function insertPairEvent(
  fromId: number,
  toId: number,
  eventType: string,
  description: string,
  deltas: {
    friendshipFrom: number; friendshipTo: number;
    romanceFrom?: number; romanceTo?: number;
    trustFrom?: number; trustTo?: number;
  },
  sentiment: number,
  /** Game minute the beat happened, when the caller has it; otherwise the insert trigger stamps the world clock. */
  gameMinute?: number,
): void {
  const fromIsA = fromId < toId;
  const [a, b] = fromIsA ? [fromId, toId] : [toId, fromId];
  const pick = (from: number, to: number): [number, number] => (fromIsA ? [from, to] : [to, from]);
  const [fAB, fBA] = pick(deltas.friendshipFrom, deltas.friendshipTo);
  const [rAB, rBA] = pick(deltas.romanceFrom ?? 0, deltas.romanceTo ?? 0);
  const [tAB, tBA] = pick(deltas.trustFrom ?? 0, deltas.trustTo ?? 0);
  db.insert(relationshipEvents).values({
    agent_a: a, agent_b: b, event_type: eventType, description,
    friendship_delta_ab: fAB, friendship_delta_ba: fBA,
    romance_delta_ab: rAB, romance_delta_ba: rBA,
    trust_delta_ab: tAB, trust_delta_ba: tBA,
    sentiment, processed: false, timestamp: Date.now(),
    ...(gameMinute != null ? { game_minute: gameMinute } : {}),
  }).run();
}

/** `aggressor` insulted `target`: the interaction event (goals, cascade) and the drama row. */
export function emitInsultBeat(aggressor: BeatAgent, target: BeatAgent, description?: string): void {
  simEvents.emit('interaction:completed', {
    agentId: aggressor.id,
    perpetratorId: aggressor.id,
    victimId: target.id,
    action: 'insult',
    locationId: aggressor.current_location,
  });
  logActivity({
    type: 'drama',
    initiator: aggressor.id,
    target: target.id,
    templateData: { description: description ?? `${aggressor.name} insulted ${target.name} during a heated argument` },
    metadata: { beat: 'insult' },
  });
}

/** `aggressor` started a fight with `target`. */
export function emitFightBeat(aggressor: BeatAgent, target: BeatAgent, description?: string): void {
  simEvents.emit('interaction:completed', {
    agentId: aggressor.id,
    perpetratorId: aggressor.id,
    victimId: target.id,
    action: 'confrontation',
    locationId: aggressor.current_location,
  });
  logActivity({
    type: 'drama',
    initiator: aggressor.id,
    target: target.id,
    templateData: { description: description ?? `${aggressor.name} started a fight with ${target.name}` },
    metadata: { beat: 'fight' },
  });
}

/** `flirter` flirted with `target`. */
export function emitFlirtBeat(flirter: BeatAgent, target: BeatAgent, description?: string): void {
  simEvents.emit('interaction:completed', {
    agentId: flirter.id,
    perpetratorId: flirter.id,
    victimId: target.id,
    action: 'flirt',
    locationId: flirter.current_location,
  });
  logActivity({
    type: 'drama',
    initiator: flirter.id,
    target: target.id,
    templateData: { description: description ?? `${flirter.name} flirted with ${target.name} after their conversation` },
    metadata: { beat: 'flirt' },
  });
}

/** The grave secrets the LLM tier's confession has always been about. */
export const GRAVE_SINS: ReadonlySet<string> = new Set(['theft', 'affair', 'blackmail']);

/**
 * Secrets someone might own up to over small talk: the grave sins plus the small misdeeds a
 * calm town produces (lib/smallMisdeeds.ts). Only ones few people know — a secret the whole
 * town has heard is no confession.
 */
export const CONFESSABLE_TYPES: ReadonlySet<string> = new Set([
  ...GRAVE_SINS, 'drunk_incident', 'debt', 'lie', 'white_lie', 'broken_promise',
]);

/** A secret of `agentId`'s worth confessing: active, about them, known by two people at most. */
export function findConfessableSin(agentId: number, types: ReadonlySet<string> = CONFESSABLE_TYPES) {
  return db.select().from(shared_knowledge)
    .where(and(eq(shared_knowledge.subject_id, agentId), eq(shared_knowledge.is_active, true))).all()
    .find((f) => types.has(f.type) && (f.known_by as number[]).length <= 2);
}

/**
 * `confessor` owns up to `sin` to `listener`: the listener learns it, a `confession` fact and
 * relationship event, the confessor's relief (mood up, stress down) and the drama row. The
 * listener's reaction follows their personality: a strict moralist thinks less of them but
 * trusts them more for the honesty; a warm one draws closer.
 */
export function performConfession(
  confessor: BeatAgent,
  listener: BeatAgent,
  sin: typeof shared_knowledge.$inferSelect,
): void {
  const knownBy = [...new Set([...(sin.known_by as number[]), listener.id])];
  db.update(shared_knowledge).set({ known_by: knownBy }).where(eq(shared_knowledge.id, sin.id)).run();
  createFact('confession', confessor.id, listener.id, 2, [confessor.id, listener.id], 'confided', {
    relatedFact: sin.content,
  });

  const listenerPersonality = listener.personality as PersonalityProfile | null | undefined;
  let friendshipDelta = 0;
  let trustDelta = 5;
  if (listenerPersonality) {
    if (listenerPersonality.morality > 60) {
      friendshipDelta = -5;
      trustDelta = 8;
    } else if (listenerPersonality.warmth > 60) {
      friendshipDelta = 2;
    }
  }
  // The trust lands in the confessor -> listener direction, as it always has.
  insertPairEvent(confessor.id, listener.id, 'confession', `${confessor.name} confessed a secret to ${listener.name}`, {
    friendshipFrom: friendshipDelta, friendshipTo: friendshipDelta, trustFrom: trustDelta, trustTo: 0,
  }, 0.3);

  const confessorNeeds = db.select().from(needs).where(eq(needs.agent_id, confessor.id)).get();
  if (confessorNeeds) {
    db.update(needs).set({
      mood: Math.min(100, confessorNeeds.mood + 15),
      stress: Math.max(0, confessorNeeds.stress - 10),
    }).where(eq(needs.agent_id, confessor.id)).run();
  }

  logActivity({
    type: 'drama',
    initiator: confessor.id,
    target: listener.id,
    templateData: { description: `${confessor.name} confessed a secret to ${listener.name}.` },
    metadata: { beat: 'confession' },
  });
}

/**
 * `forgiver` and `forgiven` make up: the grudge tag goes, both warm up (+15 friendship, +5
 * trust), the drama row. `MEND_EVENT` in storyBeats.ts — the chronicle turns a rivalry that gets
 * one of these into a reconciliation arc.
 */
export function performReconciliation(
  rel: RelRow,
  forgiver: BeatAgent,
  forgiven: BeatAgent,
  /** The feed line, when someone else brought it about (a peacemaker, lib/factions). */
  opts: { description?: string; initiator?: number } = {},
): void {
  const tags = rel.tags as string[];
  db.update(relationships).set({ tags: tags.filter((t) => t !== 'grudge') }).where(eq(relationships.id, rel.id)).run();
  db.insert(relationshipEvents).values({
    agent_a: rel.agent_a, agent_b: rel.agent_b,
    event_type: 'reconciliation',
    description: `${forgiver.name} and ${forgiven.name} reconciled`,
    friendship_delta_ab: 15, friendship_delta_ba: 15,
    romance_delta_ab: 0, romance_delta_ba: 0,
    trust_delta_ab: 5, trust_delta_ba: 5,
    sentiment: 0.7, processed: false, timestamp: Date.now(),
  }).run();
  logActivity({
    type: 'drama',
    initiator: opts.initiator ?? forgiver.id,
    target: forgiven.id,
    ...(opts.initiator != null ? { agents: [opts.initiator, forgiver.id, forgiven.id] } : {}),
    templateData: { description: opts.description ?? `${forgiver.name} and ${forgiven.name} have reconciled.` },
    metadata: { beat: 'reconciliation' },
  });
  // Making up is what a befriend (or courtship) goal on either side was hoping for.
  recordGoalOutcome(forgiver.id, forgiven.id, 'reconciled');
  recordGoalOutcome(forgiven.id, forgiver.id, 'reconciled');
}

/**
 * `discoverer`, partnered with `partner`, knows of an affair of theirs, and they have just
 * talked. Their personality decides: an aggressive one breaks up in a rage (rivals, grudge,
 * heartbroken + angry, the `breakup` beat); a loyal one forgives but trusts less; anyone else
 * ends it quietly. Returns false when there is no affair to react to (or no partnership).
 */
export function reactToPartnerAffair(discoverer: BeatAgent, partner: BeatAgent, nowMinutes: number): boolean {
  const partnerRel = pairRelationship(discoverer.id, partner.id);
  if (!partnerRel || partnerRel.status !== 'partners') return false;

  // The partner is a party to the affair on either side: the states phase and the ripple rules
  // store it as (subject: whoever was seen, target: the other), so "Ben and Ana are getting
  // close" has Ben as subject when Ben strayed and as target when it was Ana. Matching only the
  // subject missed half of them. A fact the discoverer is themselves part of (their own
  // courtship with this very partner, or with anyone) is not a betrayal by the partner.
  //
  // Once per betrayal, not per conversation: a partner who forgave stays `partners`, so without this the
  // same fact matched at every later conversation (a soak logged 96 discoveries for ~25 pairs, 8 for one,
  // each a new memory, a pivotal beat and another -30 trust). The pair's own `affair_discovered` beat, by
  // this discoverer, marks when they reacted. News is either
  //  - a fact born after that beat (events and facts both stamp real ms): a loyal partner who forgave one
  //    affair meets a different one as a new betrayal; or
  //  - a newer ACT of the same pair: the fact dedupes per pair (learnFact adds knowers to the one row), so
  //    a second night has no row and no newer `created_at`; the pair's intimacy state stamps the act
  //    instead (lastKissAt / lastTrystAt, game minutes, whichever is later) and the beat carries the game
  //    minute it was written at. Merely talking on changes neither, so nothing re-fires.
  // `known_by` still gates both: the act only counts for someone who holds the affair fact.
  const reactions = db.select({ ts: relationshipEvents.timestamp, minute: relationshipEvents.game_minute })
    .from(relationshipEvents)
    .where(and(
      eq(relationshipEvents.event_type, 'affair_discovered'),
      eq(relationshipEvents.agent_a, Math.min(discoverer.id, partner.id)),
      eq(relationshipEvents.agent_b, Math.max(discoverer.id, partner.id)),
      eq(relationshipEvents.description, `${discoverer.name} found out about ${partner.name}'s affair`),
    )).all();
  const lastReaction = reactions.reduce((latest, e) => Math.max(latest, e.ts), -Infinity);
  const lastReactionMinute = reactions.reduce((latest, e) => Math.max(latest, e.minute ?? nowMinutes), -Infinity);
  /** Game minute of the newest kiss or night between the partner and the other side of the fact. */
  const lastActMinute = (f: { subject_id: number; target_id: number | null }): number => {
    const other = f.subject_id === partner.id ? f.target_id : f.subject_id;
    if (other == null) return -Infinity;
    const s = getPairIntimacy(partner.id, other);
    return Math.max(s?.lastKissAt ?? -Infinity, s?.lastTrystAt ?? -Infinity);
  };
  const affairFacts = db.select().from(shared_knowledge)
    .where(and(eq(shared_knowledge.type, 'affair'), eq(shared_knowledge.is_active, true),
      or(eq(shared_knowledge.subject_id, partner.id), eq(shared_knowledge.target_id, partner.id)))).all()
    .filter((f) => f.subject_id !== discoverer.id && f.target_id !== discoverer.id)
    .filter((f) => (f.known_by as number[]).includes(discoverer.id))
    .filter((f) => f.created_at > lastReaction || lastActMinute(f) > lastReactionMinute);
  if (affairFacts.length === 0) return false;
  return applyAffairFallout(discoverer, partner, partnerRel, nowMinutes);
}

/**
 * What a betrayal does to the couple, by the discoverer's character: an aggressive one breaks up
 * in a rage (rivals, grudge, heartbroken + angry, the `breakup` beat); a loyal one forgives but
 * trusts less; anyone else ends it quietly. Shared by `reactToPartnerAffair` (a fact they
 * learnt) and the suspicion confrontation (lib/intimacy/suspicion.ts: a partner's nights away,
 * questioned and answered so badly the suspicion is taken as true), which passes its own
 * `breakupLine` for the rage's drama row. Returns false (nothing changes) without a personality.
 */
export function applyAffairFallout(
  discoverer: BeatAgent,
  partner: BeatAgent,
  partnerRel: RelRow,
  nowMinutes: number,
  breakupLine?: string,
): boolean {
  const personality = discoverer.personality as PersonalityProfile | null | undefined;
  if (!personality) return false;
  const pid = discoverer.id;
  const otherId = partner.id;

  // Whatever they do about it, they found out: the memory that will surface in their reflections and
  // a beat on the pair's story (zero deltas, since each branch below moves the numbers itself; the
  // sentiment makes it pivotal, so the chronicle keeps it). The forgiving branch used to leave
  // nothing at all, so a partner who chose to stay had no story and no memory of the day they learned.
  simEvents.emit('life:milestone', {
    agentId: pid,
    description: `I found out that ${partner.name} has been unfaithful to me.`,
    valence: -0.9, importance: 9, relatedAgentId: otherId,
  });
  insertPairEvent(pid, otherId, 'affair_discovered', `${discoverer.name} found out about ${partner.name}'s affair`,
    { friendshipFrom: 0, friendshipTo: 0 }, -0.8, nowMinutes);

  if (personality.aggression > 60) {
    // A real breakup: the engagement or marriage goes with it (the relationship phase keeps a
    // `married` pair at `partners` otherwise).
    db.update(relationships).set({
      status: 'rivals',
      status_since_minute: nowMinutes,
      romance_ab: 0, romance_ba: 0,
      tags: [...withoutMilestoneTags(partnerRel.tags as string[]).filter((t) => t !== 'partner'), 'grudge'],
    }).where(eq(relationships.id, partnerRel.id)).run();

    if (!getAgentStates(pid).includes('heartbroken')) {
      db.insert(agentStates).values({
        agent_id: pid, type: 'heartbroken', severity: 0.8,
        started_at: nowMinutes, duration: Math.floor(2880 + Math.random() * 4320),
        target_agent_id: otherId, source: 'event:affair_discovery', metadata: null,
      }).run();
    }
    if (!getAgentStates(pid).includes('angry')) {
      db.insert(agentStates).values({
        agent_id: pid, type: 'angry', severity: 0.9,
        started_at: nowMinutes, duration: Math.floor(480 + Math.random() * 720),
        target_agent_id: otherId, source: 'event:affair_discovery', metadata: null,
      }).run();
    }

    logActivity({
      type: 'drama',
      initiator: pid,
      target: otherId,
      templateData: { description: breakupLine ?? `${discoverer.name} discovered ${partner.name}'s affair and broke up!` },
      metadata: { beat: 'breakup' },
    });
  } else if (personality.loyalty > 60) {
    // Forgiveness path: trust drop but keep partnership
    const trustField = pid < otherId ? 'trust_ab' : 'trust_ba';
    const currentTrust = pid < otherId ? partnerRel.trust_ab : partnerRel.trust_ba;
    db.update(relationships).set({
      [trustField]: Math.max(0, currentTrust - 30),
    }).where(eq(relationships.id, partnerRel.id)).run();
  } else {
    // Default: quiet breakup
    db.update(relationships).set({
      status: 'acquaintances',
      status_since_minute: nowMinutes,
      romance_ab: 0, romance_ba: 0,
      // `partner` goes in the same write (the rage branch does the same): left behind, the pair
      // read as partnered until the next updateTags pass.
      tags: withoutMilestoneTags(partnerRel.tags as string[]).filter((t) => t !== 'partner'),
    }).where(eq(relationships.id, partnerRel.id)).run();
  }
  return true;
}
