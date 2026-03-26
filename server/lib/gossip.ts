import { db } from '../db';
import { agents, facts, relationships, agentStates, economy, conversations, relationshipEvents } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { PersonalityProfile } from './personality';

// ─── Fact Content Templates ───────────────────────────────────────────────────

const FACT_TEMPLATES: Record<string, (subjectName: string, targetName?: string) => string> = {
  crush: (s, t) => `${s} has a crush on ${t ?? 'someone'}`,
  heartbreak: (s, t) => `${s} is heartbroken over ${t ?? 'someone'}`,
  drunk_incident: (s, t) => `${s} got drunk and said terrible things to ${t ?? 'someone'}`,
  grudge: (s, t) => `${s} holds a grudge against ${t ?? 'someone'}`,
  affair: (s, t) => `${s} and ${t ?? 'someone'} are getting suspiciously close`,
  financial: (s) => `${s} is struggling with money`,
  secret_told: (s, t) => `${s} confided something personal to ${t ?? 'someone'}`,
  work_issue: (s) => `${s} keeps skipping work`,
  sickness: (s) => `${s} is sick`,
  reputation: (s) => `People have been having bad interactions with ${s} lately`,
  theft: (s, t) => `${s} was caught stealing from ${t ?? 'someone'}`,
  blackmail: (s, t) => `${s} is blackmailing ${t ?? 'someone'}`,
  gambling_loss: (s) => `${s} lost big gambling at the tavern`,
  rumor: (s) => `There are rumors going around about ${s}`,
  seduction: (s, t) => `${s} is using ${t ?? 'someone'} for personal gain`,
  confession: (s, t) => `${s} confessed something to ${t ?? 'someone'}`,
  alcoholic: (s) => `${s} has a serious drinking problem`,
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
  source: string
): number | null {
  const subjectName = getAgentName(subjectId);
  const targetName = targetId != null ? getAgentName(targetId) : undefined;

  const template = FACT_TEMPLATES[type];
  const content = template ? template(subjectName, targetName) : `${subjectName}: ${type}`;

  // Check for existing duplicate (same type + subject + target)
  // For low-churn types (sickness, financial, work_issue), also check inactive facts
  // created recently to prevent duplicate spam
  const checkInactiveToo = ['sickness', 'financial', 'work_issue'].includes(type);
  const existing = db
    .select({ id: facts.id })
    .from(facts)
    .where(
      and(
        eq(facts.type, type),
        eq(facts.subject_id, subjectId),
        ...(checkInactiveToo ? [] : [eq(facts.is_active, true)]),
        ...(targetId != null
          ? [eq(facts.target_id, targetId)]
          : [])
      )
    )
    .get();

  if (existing) {
    // If there's an inactive duplicate, reactivate it instead of creating new
    if (checkInactiveToo) {
      const inactive = db
        .select({ id: facts.id, is_active: facts.is_active })
        .from(facts)
        .where(
          and(
            eq(facts.type, type),
            eq(facts.subject_id, subjectId),
            eq(facts.is_active, false),
            ...(targetId != null ? [eq(facts.target_id, targetId)] : [])
          )
        )
        .get();
      if (inactive) {
        db.update(facts)
          .set({ is_active: true, known_by: knownBy, created_at: Date.now() })
          .where(eq(facts.id, inactive.id))
          .run();
        return inactive.id;
      }
    }
    return null;
  }

  const result = db
    .insert(facts)
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
    .select({ type: facts.type })
    .from(facts)
    .where(and(eq(facts.subject_id, agentId), eq(facts.is_active, true)))
    .all();
  return activeFacts.filter((f) => NEGATIVE_FACT_TYPES.includes(f.type)).length;
}

export function getHiddenSinCount(agentId: number): number {
  const hiddenFacts = db
    .select({ type: facts.type, known_by: facts.known_by })
    .from(facts)
    .where(and(eq(facts.subject_id, agentId), eq(facts.is_active, true)))
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
): typeof facts.$inferSelect[] {
  const allActive = db
    .select()
    .from(facts)
    .where(eq(facts.is_active, true))
    .orderBy(desc(facts.sensitivity), desc(facts.created_at))
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

    // Loyalty gate: skip facts about the speaker's friends
    if (personality.loyalty > 60) {
      const friendshipWithSubject = getRelationshipFriendship(speakerId, fact.subject_id);
      if (friendshipWithSubject > 50) return false;
    }

    return true;
  });

  // Sort: sensitivity desc, then relevance to listener (facts about listener or their friends first)
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
  speakerFacts: typeof facts.$inferSelect[]
): void {
  const combinedText = messages.join(' ').toLowerCase();

  for (const fact of speakerFacts) {
    const subjectName = getAgentName(fact.subject_id).toLowerCase();
    if (!combinedText.includes(subjectName)) continue;

    const knownBy: number[] = fact.known_by as number[];
    if (knownBy.includes(listenerId)) continue;

    const updated = [...new Set([...knownBy, listenerId])];

    db.update(facts)
      .set({ known_by: updated })
      .where(eq(facts.id, fact.id))
      .run();
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

      const rumorFacts = db.select().from(facts)
        .where(and(eq(facts.type, 'rumor'), eq(facts.is_active, true))).all();
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
          db.update(facts).set({ is_active: false }).where(eq(facts.id, rumor.id)).run();
        }
      }
    }
  }
}

// ─── spreadPublicKnowledge ────────────────────────────────────────────────────

export function spreadPublicKnowledge(): void {
  const publicFacts = db
    .select()
    .from(facts)
    .where(and(eq(facts.is_active, true), eq(facts.sensitivity, 1)))
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
      db.update(facts)
        .set({ known_by: updated })
        .where(eq(facts.id, fact.id))
        .run();
    }
  }
}

// ─── deactivateStaleFacts ─────────────────────────────────────────────────────

export function deactivateStaleFacts(): void {
  const activeFacts = db
    .select()
    .from(facts)
    .where(eq(facts.is_active, true))
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
          .where(eq(conversations.status, 'completed'))
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
        // Theft facts expire after ~2 hours real time
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
      db.update(facts)
        .set({ is_active: false })
        .where(eq(facts.id, fact.id))
        .run();
    }
  }
}
