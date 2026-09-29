import { db } from '../db';
import { agents, shared_knowledge, relationships, agentStates, economy, conversations, relationshipEvents } from '../db/schema';
import { eq, and, desc, gt, lt } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { PersonalityProfile } from './personality';
import { simEvents } from './simEvents';
import { cliqueIdOf } from './cliques';
import { thatSentence, type FactSelf } from './factText';
import { gameMinutesNow } from './worldClock';
import { affairInvolvesMarriage, affairSensitivity } from './marriage';

// ─── Fact Content Templates ───────────────────────────────────────────────────

// --- Fact Context: optional details passed when creating a fact ---

export interface FactContext {
  detail?: string;       // specific detail (e.g. "stole food_raw", "about their past")
  location?: string;     // where it happened
  witness?: string;      // who saw it
  quote?: string;        // actual words said
  relatedFact?: string;  // content of a related fact (for confessions referencing a sin)
  item?: string;         // item involved (theft, purchase)
}

// --- Fact Content Generator ---
// Rich context-aware templates. To add a new fact type: add one entry here.

const FACT_GENERATORS: Record<string, (s: string, t: string | undefined, ctx?: FactContext) => string> = {
  crush: (s, t) =>
    `${s} has a crush on ${t ?? 'someone'}`,
  heartbreak: (s, t) =>
    `${s} is heartbroken over ${t ?? 'someone'}`,
  drunk_incident: (s, t, ctx) =>
    ctx?.quote ? `${s} got drunk and told ${t ?? 'someone'}: "${ctx.quote}"` :
    t ? `${s} got drunk and said terrible things to ${t}` :
    `${s} got drunk and made a scene`,
  grudge: (s, t, ctx) =>
    ctx?.detail ? `${s} holds a grudge against ${t ?? 'someone'} — ${ctx.detail}` :
    `${s} holds a grudge against ${t ?? 'someone'}`,
  affair: (s, t) =>
    `${s} and ${t ?? 'someone'} are getting suspiciously close`,
  financial: (s, _t, ctx) =>
    ctx?.detail ? `${s} is struggling with money — ${ctx.detail}` :
    `${s} is struggling with money`,
  secret_told: (s, t, ctx) =>
    ctx?.quote ? `${s} confided to ${t ?? 'someone'}: "${ctx.quote}"` :
    ctx?.detail ? `${s} shared a secret with ${t ?? 'someone'} — ${ctx.detail}` :
    `${s} confided something personal to ${t ?? 'someone'}`,
  work_issue: (s, _t, ctx) =>
    ctx?.detail ? `${s} keeps skipping work — ${ctx.detail}` :
    `${s} keeps skipping work`,
  sickness: (s) =>
    `${s} is sick`,
  reputation: (s, _t, ctx) =>
    ctx?.detail ? `${s} has a bad reputation — ${ctx.detail}` :
    `People have been having bad interactions with ${s} lately`,
  theft: (s, t, ctx) =>
    ctx?.item ? `${s} was caught stealing ${ctx.item} from ${t ?? 'someone'}${ctx?.location ? ' at ' + ctx.location : ''}` :
    `${s} was caught stealing from ${t ?? 'someone'}`,
  blackmail: (s, t, ctx) =>
    ctx?.relatedFact ? `${s} is blackmailing ${t ?? 'someone'} over: ${ctx.relatedFact}` :
    `${s} is blackmailing ${t ?? 'someone'}`,
  gambling_loss: (s, _t, ctx) =>
    ctx?.detail ? `${s} lost ${ctx.detail} gambling at the tavern` :
    `${s} lost big gambling at the tavern`,
  // `detail` is a predicate ("got into a heated confrontation with Tom") so the
  // rumor reads as a claim about the subject that gossip lines can splice after
  // "that". The old "Rumor about X: <detail>" shape was a label, not a claim.
  rumor: (s, _t, ctx) =>
    ctx?.detail ? `${s} ${ctx.detail}${ctx.witness ? `, according to ${ctx.witness}` : ''}` :
    `There are rumors going around about ${s}`,
  seduction: (s, t, ctx) =>
    ctx?.detail ? `${s} is manipulating ${t ?? 'someone'} — ${ctx.detail}` :
    `${s} is using ${t ?? 'someone'} for personal gain`,
  confession: (s, t, ctx) =>
    ctx?.relatedFact ? `${s} confessed to ${t ?? 'someone'}: "${ctx.relatedFact}"` :
    ctx?.quote ? `${s} confessed to ${t ?? 'someone'}: "${ctx.quote}"` :
    `${s} confessed something to ${t ?? 'someone'}`,
  alcoholic: (s) =>
    `${s} has a serious drinking problem`,
  death: (s, _t, ctx) =>
    ctx?.detail ? `${s} has died — ${ctx.detail}` :
    `${s} has passed away`,
  arrest: (s, _t, ctx) =>
    ctx?.detail ? `${s} was arrested: ${ctx.detail}` :
    `${s} was arrested`,
  conspiracy: (s, t, ctx) =>
    ctx?.detail ? `${s} and ${t ?? 'someone'} are plotting something — ${ctx.detail}` :
    `${s} and ${t ?? 'someone'} were seen scheming together`,
  political_dissent: (s, _t, ctx) =>
    ctx?.detail ? `${s} publicly protested — ${ctx.detail}` :
    `${s} spoke out against the authorities`,
  speech: (s, _t, ctx) =>
    ctx?.detail ? `${s} gave a public speech: ${ctx.detail}` :
    `${s} addressed the town from the podium`,
  escape: (s) =>
    `${s} escaped from prison`,
  escape_failed: (s) =>
    `${s} tried to escape prison but failed`,
  contraband: (s, t, ctx) =>
    ctx?.detail ? `${s} was caught smuggling ${ctx.detail} to ${t ?? 'a prisoner'}` :
    `${s} smuggled something to ${t ?? 'a prisoner'}`,
  hobby_expert: (s, _t, ctx) =>
    ctx?.detail ? `${s} is really skilled at ${ctx.detail}` :
    `${s} has become quite talented at their hobby`,
  gift_given: (s, t, ctx) =>
    ctx?.detail ? `${s} gave ${ctx.detail} to ${t ?? 'someone'}` :
    `${s} was very generous with ${t ?? 'someone'}`,
  secret_shared: (s, t, ctx) =>
    ctx?.detail ? `${ctx.detail.replace(/[.!]+$/, '')} — told in confidence to ${t ?? 'someone'}` :
    `${s} confided something personal to ${t ?? 'someone'}`,
  confrontation: (s, t) =>
    `${s} and ${t ?? 'someone'} got into a public confrontation`,
  hoarding: (s) =>
    `${s} is hoarding supplies`,
  // confrontation_witness_gossip creates this; without a generator the fact
  // read "Marco Rivera: fight".
  fight: (s, t) =>
    `${s} got into a fight with ${t ?? 'someone'}`,
  // Life milestones (lib/milestonesEngine.ts): subject is the one who proposed.
  engagement: (s, t) =>
    `${s} and ${t ?? 'someone'} are engaged to be married`,
  proposal_rejected: (s, t) =>
    `${s} asked ${t ?? 'someone'} to marry them and was turned down`,
  wedding: (s, t) =>
    `${s} and ${t ?? 'someone'} got married`,
};

/**
 * Fact types where the target took part as much as the subject: an affair,
 * a plot, a fight. For these the target's own secret is at stake too, so the
 * own-secret filter covers them — Carlos doesn't gossip about his own affair
 * with Marco any more than Marco does.
 */
const PARTICIPANT_TARGET_TYPES = new Set([
  'affair', 'conspiracy', 'confrontation', 'fight',
  // A turned-down proposal is the target's story as much as the subject's.
  'proposal_rejected',
]);

/**
 * Whether spreading this fact would be `agentId` gossiping about themselves.
 * Owning up is a separate, deliberate act (the confession path in
 * conversations.ts), not idle gossip.
 */
export function isOwnSecret(
  fact: { subject_id: number; target_id: number | null; type: string },
  agentId: number,
): boolean {
  if (fact.subject_id === agentId) return true;
  return fact.target_id === agentId && PARTICIPANT_TARGET_TYPES.has(fact.type);
}

/**
 * Whether `listenerId` may be told this fact as gossip. Nobody is told a
 * confirmed fact about themselves as if it were news about someone else (G7:
 * "Marco told Diego that Yuki spotted Diego…"): they either lived it or it is
 * a sighting of them, and either way the scene is a confrontation, not gossip.
 *
 * The one deliberate exception is an UNVERIFIED rumor — a fabricated one,
 * including the player's `start_rumor` god power (godPowers.ts). Hearing that
 * one about yourself is the point: `rumorReachedSubject` turns it into anger
 * at the teller, so it must still be allowed to reach its subject.
 */
export function mayBeToldTo(
  fact: { subject_id: number; target_id: number | null; type: string; reliability: string | null },
  listenerId: number,
): boolean {
  if (!isOwnSecret(fact, listenerId)) return true;
  return fact.reliability === 'unverified';
}

/**
 * What a jealous agent says about their rival. The jealousy trigger knows who
 * the rival is and who they are both after, so the rumor can name it instead
 * of the contentless "There are rumors going around about X". Undefined when
 * the love interest is unknown — createFact then falls back to that generic line.
 */
export function jealousRumorContext(loveInterestName: string | undefined): FactContext | undefined {
  return loveInterestName ? { detail: `is only stringing ${loveInterestName} along` } : undefined;
}

// ─── getAgentName ─────────────────────────────────────────────────────────────

export function getAgentName(agentId: number): string {
  const row = db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  return row?.name ?? `Agent#${agentId}`;
}

/** Name + gender, for feed lines that turn the person's own name into a pronoun. */
export function getAgentSelf(agentId: number): FactSelf {
  const row = db
    .select({ name: agents.name, gender: agents.gender })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  return { name: row?.name ?? `Agent#${agentId}`, gender: row?.gender ?? null };
}

// ─── getRelationshipFriendship ────────────────────────────────────────────────

export function getRelationshipFriendship(agentA: number, agentB: number): number {
  // relationships always stored with agent_a < agent_b
  const [lo, hi] = agentA < agentB ? [agentA, agentB] : [agentB, agentA];
  const row = db
    .select({
      friendship_ab: relationships.friendship_ab,
      friendship_ba: relationships.friendship_ba,
    })
    .from(relationships)
    .where(and(eq(relationships.agent_a, lo), eq(relationships.agent_b, hi)))
    .get();

  if (!row) return 0;
  // return friendship value from agentA's perspective toward agentB
  return agentA < agentB ? row.friendship_ab : row.friendship_ba;
}

// ─── createFact ───────────────────────────────────────────────────────────────

/** The sentence a fact of `type` is stored as (pure; exported for tests). */
export function renderFact(type: string, subjectName: string, targetName?: string, context?: FactContext): string {
  const generator = FACT_GENERATORS[type];
  return generator ? generator(subjectName, targetName, context ?? {}) : `${subjectName}: ${type}`;
}

export function createFact(
  type: string,
  subjectId: number,
  targetId: number | null,
  sensitivity: number,
  knownBy: number[],
  source: string,
  context?: FactContext,
): number | null {
  // A fact about someone and themselves reads "Priya got drunk and said
  // terrible things to Priya" (the drunk_incident ripple rule targets 'self').
  if (targetId === subjectId) targetId = null;
  // The same rule builds known_by as [actor, target], i.e. [X, X] for a
  // self-targeted fact; every knower once.
  knownBy = [...new Set(knownBy)];
  // Every affair secret goes through here (the states phase's sighting, ripple
  // rules, witnesses), so this is the one place that knows whether it betrays
  // a marriage — and it is judged when the secret is born, which is when it
  // is worth the most. Weddings raise affairs already known (milestonesEngine).
  if (type === 'affair') sensitivity = affairSensitivity(sensitivity, affairInvolvesMarriage(subjectId, targetId));
  const subjectName = getAgentName(subjectId);
  const targetName = targetId != null ? getAgentName(targetId) : undefined;

  const content = renderFact(type, subjectName, targetName, context);

  // Check for existing duplicate (same type + subject + target)
  // For low-churn types (sickness, financial, work_issue), also check inactive shared_knowledge
  // created recently to prevent duplicate spam
  const checkInactiveToo = ['sickness', 'financial', 'work_issue'].includes(type);
  const existing = db
    .select({ id: shared_knowledge.id })
    .from(shared_knowledge)
    .where(
      and(
        eq(shared_knowledge.type, type),
        eq(shared_knowledge.subject_id, subjectId),
        ...(checkInactiveToo ? [] : [eq(shared_knowledge.is_active, true)]),
        ...(targetId != null
          ? [eq(shared_knowledge.target_id, targetId)]
          : [])
      )
    )
    .get();

  if (existing) {
    // If there's an inactive duplicate, reactivate it instead of creating new
    if (checkInactiveToo) {
      const inactive = db
        .select({ id: shared_knowledge.id, is_active: shared_knowledge.is_active })
        .from(shared_knowledge)
        .where(
          and(
            eq(shared_knowledge.type, type),
            eq(shared_knowledge.subject_id, subjectId),
            eq(shared_knowledge.is_active, false),
            ...(targetId != null ? [eq(shared_knowledge.target_id, targetId)] : [])
          )
        )
        .get();
      if (inactive) {
        db.update(shared_knowledge)
          .set({ is_active: true, known_by: knownBy, created_at: Date.now() })
          .where(eq(shared_knowledge.id, inactive.id))
          .run();
        return inactive.id;
      }
    }
    return null;
  }

  const result = db
    .insert(shared_knowledge)
    .values({
      type,
      subject_id: subjectId,
      target_id: targetId,
      content,
      sensitivity,
      known_by: knownBy,
      created_at: Date.now(),
      is_active: true,
      source,
    })
    .run();

  return Number(result.lastInsertRowid);
}

// ─── getNegativeFactCount / getHiddenSinCount ─────────────────────────────────

const NEGATIVE_FACT_TYPES = [
  'theft', 'blackmail', 'gambling_loss', 'rumor',
  'reputation', 'work_issue', 'drunk_incident', 'grudge',
  'affair', 'arrest', 'seduction',
];

export function getNegativeFactCount(agentId: number): number {
  const activeFacts = db
    .select({ type: shared_knowledge.type })
    .from(shared_knowledge)
    .where(and(eq(shared_knowledge.subject_id, agentId), eq(shared_knowledge.is_active, true)))
    .all();
  return activeFacts.filter((f) => NEGATIVE_FACT_TYPES.includes(f.type)).length;
}

/**
 * Negative-fact count for every subject at once, from a list of facts the
 * caller already loaded. The decisions phase prices one count per co-located
 * agent per agent (`getNegativeFactCount` above is one query each) and already
 * holds the whole active `shared_knowledge` table for the arrest check, so it
 * counts from that instead. Same rule as `getNegativeFactCount`: active facts
 * whose type is in `NEGATIVE_FACT_TYPES`.
 */
export function countNegativeFactsBySubject(
  facts: ReadonlyArray<{ subject_id: number; type: string; is_active?: boolean | null }>,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const f of facts) {
    if (f.is_active === false || !NEGATIVE_FACT_TYPES.includes(f.type)) continue;
    counts.set(f.subject_id, (counts.get(f.subject_id) ?? 0) + 1);
  }
  return counts;
}

export function getHiddenSinCount(agentId: number): number {
  const hiddenFacts = db
    .select({ type: shared_knowledge.type, known_by: shared_knowledge.known_by })
    .from(shared_knowledge)
    .where(and(eq(shared_knowledge.subject_id, agentId), eq(shared_knowledge.is_active, true)))
    .all()
    .filter((f) =>
      ['theft', 'affair', 'blackmail'].includes(f.type) &&
      (f.known_by as number[]).length <= 2
    );
  return hiddenFacts.length;
}

// ─── getShareableFacts ────────────────────────────────────────────────────────

export function getShareableFacts(
  speakerId: number,
  listenerId: number,
  personality: PersonalityProfile
): typeof shared_knowledge.$inferSelect[] {
  const allActive = db
    .select()
    .from(shared_knowledge)
    .where(eq(shared_knowledge.is_active, true))
    .orderBy(desc(shared_knowledge.sensitivity), desc(shared_knowledge.created_at))
    .all();

  const shareable = allActive.filter((fact) => {
    const knownBy: number[] = fact.known_by as number[];

    // Speaker must know this fact
    if (!knownBy.includes(speakerId)) return false;
    // Listener must not already know it
    if (knownBy.includes(listenerId)) return false;
    // A speaker's own secrets are not gossip. Offering them here fed them to the
    // LLM as "things you could gossip about" and let spreadGossip leak them the
    // moment the speaker said their own name. Confessing is a separate path.
    if (isOwnSecret(fact, speakerId)) return false;
    // Nor is a confirmed fact about the listener (see mayBeToldTo). The
    // relevance sort below puts facts about the listener FIRST, so without this
    // the LLM was handed "tell Diego that Yuki spotted Diego" as its best gossip.
    if (!mayBeToldTo(fact, listenerId)) return false;

    // Personality gates
    if (fact.sensitivity >= 2 && personality.honesty > 60) return false;
    if (fact.sensitivity >= 3 && personality.morality > 60) return false;

    // Loyalty gate: skip shared_knowledge about the speaker's friends
    if (personality.loyalty > 60) {
      const friendshipWithSubject = getRelationshipFriendship(speakerId, fact.subject_id);
      if (friendshipWithSubject > 50) return false;
    }

    return true;
  });

  // Sort: sensitivity desc, then relevance to listener (shared_knowledge about listener or their friends first)
  // Circle membership counts as relevance too: news about someone in your own
  // group travels through that group first, which is what makes a clique feel
  // like one rather than a list of names.
  const listenerClique = cliqueIdOf(listenerId);
  const inListenerCircle = (subjectId: number) =>
    listenerClique != null && cliqueIdOf(subjectId) === listenerClique;

  // Relevance is resolved once per fact, before the sort. It was previously
  // computed inside the comparator, where the `getRelationshipFriendship` call
  // meant O(n log n) relationship SELECTs on a function called for every agent
  // on every tick (the `hasGossip` check in decisions.ts) — and the comparator
  // re-derived the same answer for the same fact on every comparison it took part
  // in. Precomputing also makes the ordering a stable function of the data, which
  // a comparator doing I/O is not guaranteed to be.
  const relevance = new Map<number, boolean>();
  for (const fact of shareable) {
    relevance.set(
      fact.id,
      fact.subject_id === listenerId ||
        fact.target_id === listenerId ||
        inListenerCircle(fact.subject_id) ||
        getRelationshipFriendship(listenerId, fact.subject_id) > 50,
    );
  }

  shareable.sort((a, b) => {
    if (b.sensitivity !== a.sensitivity) return b.sensitivity - a.sensitivity;

    const aRelevant = relevance.get(a.id)!;
    const bRelevant = relevance.get(b.id)!;

    if (aRelevant && !bRelevant) return -1;
    if (!aRelevant && bRelevant) return 1;

    return b.created_at - a.created_at;
  });

  return shareable.slice(0, 3);
}

// ─── Rumor backlash ───────────────────────────────────────────────────────────

/** How long the subject stays angry at whoever told them: past the 480-minute grudge mark in states.ts. */
const BACKLASH_ANGER_MINUTES = 600;

/**
 * The subject of an unverified rumor just heard it — from `tellerId`. They get
 * angry at the teller (the messenger is who's in front of them), and the angry
 * state's own effect in states.ts turns that into a lasting `grudge` after 480
 * game minutes, which in turn feeds confrontations (confrontationEngine). A
 * relationship event knocks trust and friendship now, so the sting shows before
 * the grudge does. Confirmed facts (a theft someone saw) don't do this: being
 * told the truth about yourself is a different scene.
 *
 * Called by every path where a fact moves from one agent to another by being
 * told: the gossip tick's active sharing and `spreadGossip` in conversations.
 */
export function rumorReachedSubject(
  fact: { id: number; subject_id: number; reliability: string | null; content: string },
  tellerId: number,
  listenerId: number,
): void {
  if (fact.reliability !== 'unverified') return;
  if (listenerId !== fact.subject_id || tellerId === listenerId) return;

  const subjectName = getAgentName(listenerId);
  const tellerName = getAgentName(tellerId);
  const [a, b] = [Math.min(listenerId, tellerId), Math.max(listenerId, tellerId)];
  const fromA = listenerId === a;
  db.insert(relationshipEvents).values({
    agent_a: a,
    agent_b: b,
    event_type: 'rumor_backlash',
    description: `${subjectName} heard ${tellerName} repeating a rumor about them`,
    friendship_delta_ab: fromA ? -10 : 0,
    friendship_delta_ba: fromA ? 0 : -10,
    romance_delta_ab: 0,
    romance_delta_ba: 0,
    trust_delta_ab: fromA ? -25 : 0,
    trust_delta_ba: fromA ? 0 : -25,
    sentiment: -0.6,
    processed: false,
    timestamp: Date.now(),
  }).run();

  const alreadyAngry = db.select({ id: agentStates.id }).from(agentStates)
    .where(and(eq(agentStates.agent_id, listenerId), eq(agentStates.type, 'angry'))).get();
  if (!alreadyAngry) {
    db.insert(agentStates).values({
      agent_id: listenerId,
      type: 'angry',
      severity: 0.7,
      started_at: gameMinutesNow(),
      duration: BACKLASH_ANGER_MINUTES,
      target_agent_id: tellerId,
      source: 'gossip:rumor_about_self',
      metadata: { factId: fact.id },
    }).run();
    simEvents.emit('state:triggered', {
      agentId: listenerId,
      state: 'angry',
      cause: `heard ${tellerName} spreading lies about them`,
    });
  }

  logActivity({
    type: 'drama',
    initiator: listenerId,
    target: tellerId,
    severity: 0.4,
    templateData: { description: `${subjectName} heard what ${tellerName} has been saying about them and is furious.` },
  });

  // Only player-planted rumors are `unverified` (godPowers.startRumor), so this
  // is the moment a planted rumor comes home; lib/playerOutcomes.ts tells the
  // player it did.
  simEvents.emit('rumor:reached_subject', { factId: fact.id, subjectId: listenerId, tellerId });
}

// ─── spreadGossip ─────────────────────────────────────────────────────────────

export function spreadGossip(
  _speakerId: number,
  listenerId: number,
  messages: string[],
  speakerFacts: typeof shared_knowledge.$inferSelect[]
): void {
  const combinedText = messages.join(' ').toLowerCase();

  for (const fact of speakerFacts) {
    const subjectName = getAgentName(fact.subject_id).toLowerCase();
    if (!combinedText.includes(subjectName)) continue;

    const knownBy: number[] = fact.known_by as number[];
    if (knownBy.includes(listenerId)) continue;

    const updated = [...new Set([...knownBy, listenerId])];

    db.update(shared_knowledge)
      .set({ known_by: updated })
      .where(eq(shared_knowledge.id, fact.id))
      .run();

    const speakerName = getAgentName(_speakerId);
    simEvents.emit('gossip:learned', { agentId: listenerId, sourceName: speakerName, content: fact.content });
    simEvents.emit('gossip:shared', { agentId: _speakerId, otherName: getAgentName(listenerId), content: fact.content });
    rumorReachedSubject(fact, _speakerId, listenerId);

    if (fact.sensitivity >= 2) {
      const listener = getAgentSelf(listenerId);
      logActivity({
        type: 'drama',
        initiator: listenerId,
        target: fact.subject_id,
        templateData: { description: thatSentence(`${listener.name} learned`, fact.content, [listener]) },
        metadata: { beat: 'gossip' },
      });
    }
  }

  // Rumor discovery: if both agents know a rumor, they may compare notes and discover the fabricator
  const speakerPersonality = db.select({ personality: agents.personality }).from(agents).where(eq(agents.id, _speakerId)).get();
  const listenerPersonality = db.select({ personality: agents.personality }).from(agents).where(eq(agents.id, listenerId)).get();
  if (speakerPersonality && listenerPersonality) {
    const sp = speakerPersonality.personality as PersonalityProfile | null;
    const lp = listenerPersonality.personality as PersonalityProfile | null;
    if (sp && lp) {
      const avgHonesty = (sp.honesty + lp.honesty) / 2;
      const discoveryChance = 0.1 * avgHonesty / 100;

      const rumorFacts = db.select().from(shared_knowledge)
        .where(and(eq(shared_knowledge.type, 'rumor'), eq(shared_knowledge.is_active, true))).all();
      for (const rumor of rumorFacts) {
        const knownBy = rumor.known_by as number[];
        if (!knownBy.includes(listenerId) || !knownBy.includes(_speakerId)) continue;
        if (rumor.source !== 'fabricated') continue;
        const fabricatorId = knownBy[0]; // fabricator is first in known_by
        if (fabricatorId === listenerId || fabricatorId === _speakerId) continue;

        if (Math.random() < discoveryChance) {
          // Both discover the manipulator
          for (const discoverer of [listenerId, _speakerId]) {
            const [ordA, ordB] = [Math.min(discoverer, fabricatorId), Math.max(discoverer, fabricatorId)];
            db.insert(relationshipEvents).values({
              agent_a: ordA, agent_b: ordB,
              event_type: 'confrontation',
              description: `Discovered that ${getAgentName(fabricatorId)} spread rumors`,
              friendship_delta_ab: discoverer === ordA ? -20 : 0,
              friendship_delta_ba: discoverer === ordA ? 0 : -20,
              romance_delta_ab: 0, romance_delta_ba: 0,
              trust_delta_ab: discoverer === ordA ? -40 : 0,
              trust_delta_ba: discoverer === ordA ? 0 : -40,
              sentiment: -0.7, processed: false, timestamp: Date.now(),
            }).run();
          }
          createFact('reputation', fabricatorId, null, 1, [listenerId, _speakerId], 'discovered');
          db.update(shared_knowledge).set({ is_active: false }).where(eq(shared_knowledge.id, rumor.id)).run();
        }
      }
    }
  }
}

// Public-knowledge spread (co-located agents learn sensitivity-1 facts about
// each other) lives in engine/systems/gossipEngine.ts, section 1. A second
// copy here used to run from the states phase as well, so every tick did the
// same full fact scan and known_by writes twice.

// ─── deactivateStaleFacts ─────────────────────────────────────────────────────

export function deactivateStaleFacts(): void {
  const activeFacts = db
    .select()
    .from(shared_knowledge)
    .where(eq(shared_knowledge.is_active, true))
    .all();

  /**
   * Subjects with a recent negative conversation, computed once per pass.
   *
   * The `reputation` case below used to read every ended conversation ever held
   * and filter in JS — once for each reputation fact, on a table that is only
   * ever appended to, on every tick. Bounding `ended_at` and `sentiment` in SQL
   * lets it ride `idx_conversations_status_ended` and stop at the recent window,
   * and hoisting it out of the loop turns N scans into one.
   *
   * Built lazily: a town with no reputation facts should not pay for it at all.
   */
  let recentlyDisliked: Set<number> | null = null;
  const subjectsWithNegativeConversations = (): Set<number> => {
    if (recentlyDisliked) return recentlyDisliked;
    const cutoff = Date.now() - 1_440_000;
    const rows = db
      .select({ participants: conversations.participants })
      .from(conversations)
      .where(
        and(
          eq(conversations.status, 'ended'),
          gt(conversations.ended_at, cutoff),
          lt(conversations.sentiment, 0),
        ),
      )
      .all();
    recentlyDisliked = new Set(rows.flatMap((r) => r.participants as number[]));
    return recentlyDisliked;
  };

  for (const fact of activeFacts) {
    let stale = false;

    switch (fact.type) {
      case 'crush': {
        // Deactivate if no active infatuated state for subject targeting the same target
        const state = db
          .select({ id: agentStates.id })
          .from(agentStates)
          .where(
            and(
              eq(agentStates.agent_id, fact.subject_id),
              eq(agentStates.type, 'infatuated'),
              ...(fact.target_id != null ? [eq(agentStates.target_agent_id, fact.target_id)] : [])
            )
          )
          .get();
        if (!state) stale = true;
        break;
      }

      case 'heartbreak': {
        // Deactivate if no active heartbroken state for subject
        const state = db
          .select({ id: agentStates.id })
          .from(agentStates)
          .where(
            and(
              eq(agentStates.agent_id, fact.subject_id),
              eq(agentStates.type, 'heartbroken')
            )
          )
          .get();
        if (!state) stale = true;
        break;
      }

      case 'sickness': {
        const state = db
          .select({ id: agentStates.id })
          .from(agentStates)
          .where(
            and(
              eq(agentStates.agent_id, fact.subject_id),
              eq(agentStates.type, 'sick')
            )
          )
          .get();
        if (!state) stale = true;
        break;
      }

      case 'financial': {
        const eco = db
          .select({ money: economy.money })
          .from(economy)
          .where(eq(economy.agent_id, fact.subject_id))
          .get();
        if (eco && eco.money > 30) stale = true;
        break;
      }

      case 'work_issue': {
        // Deactivate if the agent is currently working (they showed up)
        const agentRow = db
          .select({ current_action: agents.current_action })
          .from(agents)
          .where(eq(agents.id, fact.subject_id))
          .get();
        const actionType = (agentRow?.current_action as any)?.type;
        if (actionType === 'working') {
          stale = true;
        }
        break;
      }

      case 'reputation': {
        // Deactivate if no negative conversations involving subject in the last
        // 1_440_000 ms of wall clock.
        if (!subjectsWithNegativeConversations().has(fact.subject_id)) stale = true;
        break;
      }

      case 'alcoholic': {
        const state = db.select({ id: agentStates.id }).from(agentStates)
          .where(and(eq(agentStates.agent_id, fact.subject_id), eq(agentStates.type, 'alcoholic'))).get();
        if (!state) stale = true;
        break;
      }

      case 'theft': {
        // Theft shared_knowledge expire after ~2 hours real time
        if (Date.now() - fact.created_at > 7_200_000) stale = true;
        break;
      }

      case 'blackmail': {
        // Deactivate if victim has no money
        if (fact.target_id) {
          const victimEco = db.select({ money: economy.money }).from(economy)
            .where(eq(economy.agent_id, fact.target_id)).get();
          if (victimEco && victimEco.money < 10) stale = true;
        }
        break;
      }

      case 'gambling_loss': {
        // Gambling losses fade after ~1.2 hours real time
        if (Date.now() - fact.created_at > 4_320_000) stale = true;
        break;
      }

      case 'rumor': {
        // Rumors expire after ~2.8 hours real time
        if (Date.now() - fact.created_at > 10_080_000) stale = true;
        break;
      }

      case 'seduction': {
        if (Date.now() - fact.created_at > 7_200_000) stale = true;
        break;
      }

      case 'confession': {
        if (Date.now() - fact.created_at > 4_320_000) stale = true;
        break;
      }
    }

    if (stale) {
      db.update(shared_knowledge)
        .set({ is_active: false })
        .where(eq(shared_knowledge.id, fact.id))
        .run();
    }
  }
}
