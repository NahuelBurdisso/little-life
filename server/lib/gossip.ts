import { db } from '../db';
import { agents, shared_knowledge, relationships, agentStates, economy, conversations, relationshipEvents } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { PersonalityProfile } from './personality';
import { simEvents } from './simEvents';

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
    `${s} got drunk and said terrible things to ${t ?? 'someone'}`,
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
  rumor: (s, _t, ctx) =>
    ctx?.detail ? `Rumor about ${s}: ${ctx.detail}` :
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
};

// ─── getAgentName ─────────────────────────────────────────────────────────────

export function getAgentName(agentId: number): string {
  const row = db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  return row?.name ?? `Agent#${agentId}`;
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

export function createFact(
  type: string,
  subjectId: number,
  targetId: number | null,
  sensitivity: number,
  knownBy: number[],
  source: string,
  context?: FactContext,
): number | null {
  const subjectName = getAgentName(subjectId);
  const targetName = targetId != null ? getAgentName(targetId) : undefined;

  const generator = FACT_GENERATORS[type];
  const ctx = context ?? {};
  const content = generator ? generator(subjectName, targetName, ctx) : `${subjectName}: ${type}`;

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
];

export function getNegativeFactCount(agentId: number): number {
  const activeFacts = db
    .select({ type: shared_knowledge.type })
    .from(shared_knowledge)
    .where(and(eq(shared_knowledge.subject_id, agentId), eq(shared_knowledge.is_active, true)))
    .all();
  return activeFacts.filter((f) => NEGATIVE_FACT_TYPES.includes(f.type)).length;
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
  shareable.sort((a, b) => {
    if (b.sensitivity !== a.sensitivity) return b.sensitivity - a.sensitivity;

    const aRelevant =
      a.subject_id === listenerId ||
      a.target_id === listenerId ||
      getRelationshipFriendship(listenerId, a.subject_id) > 50;
    const bRelevant =
      b.subject_id === listenerId ||
      b.target_id === listenerId ||
      getRelationshipFriendship(listenerId, b.subject_id) > 50;

    if (aRelevant && !bRelevant) return -1;
    if (!aRelevant && bRelevant) return 1;

    return b.created_at - a.created_at;
  });

  return shareable.slice(0, 3);
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

    if (fact.sensitivity >= 2) {
      const listenerName = getAgentName(listenerId);
      logActivity({
        type: 'drama',
        initiator: listenerId,
        target: fact.subject_id,
        templateData: { description: `${listenerName} learned that ${fact.content}.` },
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

// ─── spreadPublicKnowledge ────────────────────────────────────────────────────

export function spreadPublicKnowledge(): void {
  const publicFacts = db
    .select()
    .from(shared_knowledge)
    .where(and(eq(shared_knowledge.is_active, true), eq(shared_knowledge.sensitivity, 1)))
    .all();

  if (publicFacts.length === 0) return;

  // Load all agents with their current location
  const allAgents = db
    .select({ id: agents.id, current_location: agents.current_location })
    .from(agents)
    .where(eq(agents.is_active, true))
    .all();

  // Build a map: locationId -> agentIds
  const locationMap = new Map<number, number[]>();
  for (const agent of allAgents) {
    if (agent.current_location == null) continue;
    const existing = locationMap.get(agent.current_location) ?? [];
    existing.push(agent.id);
    locationMap.set(agent.current_location, existing);
  }

  for (const fact of publicFacts) {
    // Find subject's current location
    const subjectAgent = allAgents.find((a) => a.id === fact.subject_id);
    if (!subjectAgent?.current_location) continue;

    const coLocated = locationMap.get(subjectAgent.current_location) ?? [];
    if (coLocated.length === 0) continue;

    const knownBy: number[] = fact.known_by as number[];
    const updated = [...new Set([...knownBy, ...coLocated])];

    if (updated.length !== knownBy.length) {
      db.update(shared_knowledge)
        .set({ known_by: updated })
        .where(eq(shared_knowledge.id, fact.id))
        .run();
    }
  }
}

// ─── deactivateStaleFacts ─────────────────────────────────────────────────────

export function deactivateStaleFacts(): void {
  const activeFacts = db
    .select()
    .from(shared_knowledge)
    .where(eq(shared_knowledge.is_active, true))
    .all();

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
        // Deactivate if no negative conversations involving subject in last 1440 ticks (1440000 ms)
        const cutoff = Date.now() - 1_440_000;
        const negConvs = db
          .select({ id: conversations.id, participants: conversations.participants, sentiment: conversations.sentiment, ended_at: conversations.ended_at })
          .from(conversations)
          .where(eq(conversations.status, 'ended'))
          .all()
          .filter((c) => {
            const participants: number[] = c.participants as number[];
            const endedAt = c.ended_at ?? 0;
            return participants.includes(fact.subject_id) && c.sentiment < 0 && endedAt > cutoff;
          });

        if (negConvs.length === 0) stale = true;
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
