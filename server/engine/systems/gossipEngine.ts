/**
 * Gossip Engine — Centralized fact spread system
 *
 * Called once per tick. Handles all the ways shared_knowledge spread between agents:
 * 1. Public knowledge spread (co-located agents learn public shared_knowledge)
 * 2. Passive eavesdropping (agents at the same location as a conversation learn shared_knowledge)
 * 3. Active gossip sharing (curious agents proactively share shared_knowledge with friends)
 * 4. Secret discovery (curious agents piece together hidden information)
 * 5. Common knowledge threshold (a secret most of the town knows stops being one)
 *
 * To add a new spread mechanic: add it here. One file, one place.
 */

import { db } from '../../db';
import {
  agents,
  shared_knowledge,
  relationships,
  conversations,
  worldEvents,
  needs as needsTable,
  agentStates,
} from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { PersonalityProfile } from '../../lib/personality';
import { logActivity } from '../../lib/activityLogger';
import { getAgentStates } from '../../lib/states';
import { aggregateEventEffects } from '../../data/worldEventCatalog';
import { thatSentence } from '../../lib/factText';
import { isOwnSecret, mayBeToldTo, rumorReachedSubject } from '../../lib/gossip';

interface AgentInfo {
  id: number;
  name: string;
  gender: string | null;
  current_location: number | null;
  personality: PersonalityProfile | null;
}

/**
 * Add knowers to a fact and keep the in-memory snapshot in sync.
 *
 * `allFacts` is read once per tick and every spread mechanic below does a
 * read-modify-write against it. Without writing the result back onto the row,
 * two spreads of the same fact in one tick each write `[...original, theirId]`
 * and the earlier learner is silently erased.
 */
function addKnowers(fact: { id: number; known_by: unknown }, newKnowers: number[]): void {
  const knownBy = fact.known_by as number[];
  const updated = [...new Set([...knownBy, ...newKnowers])];
  if (updated.length === knownBy.length) return;
  db.update(shared_knowledge)
    .set({ known_by: updated })
    .where(eq(shared_knowledge.id, fact.id))
    .run();
  fact.known_by = updated;
}

/**
 * A secret more than half the town is repeating has stopped being a secret.
 * Mild facts (sensitivity 1) are public by construction and never qualify —
 * flipping them would just spam the log with "everyone knows Piet bakes bread".
 */
export function isCommonKnowledge(
  fact: { sensitivity: number; known_by: unknown },
  population: number,
): boolean {
  if (fact.sensitivity < 2 || population <= 0) return false;
  return (fact.known_by as number[]).length > population / 2;
}

/** How hard being found out hits the subject, per point of sensitivity. */
const EXPOSURE_MOOD_HIT = 6;

/** `nowMinutes`: the game-minute clock agent states are stamped in (lib/states.ts). */
export function gossipTick(nowMinutes: number): void {
  const allAgents: AgentInfo[] = db.select({
    id: agents.id,
    name: agents.name,
    gender: agents.gender,
    current_location: agents.current_location,
    personality: agents.personality,
  }).from(agents).where(eq(agents.is_active, true)).all() as AgentInfo[];

  const allFacts = db.select().from(shared_knowledge).where(eq(shared_knowledge.is_active, true)).all();
  if (allFacts.length === 0) return;

  // Check for gossip_boost from active events (e.g., mysterious_stranger)
  const activeEvents = db.select().from(worldEvents).where(eq(worldEvents.is_active, true)).all();
  const gossipMultiplier = aggregateEventEffects(activeEvents.map((e) => e.effects)).gossip_boost;

  // Build location groups
  const locationGroups = new Map<number, AgentInfo[]>();
  for (const agent of allAgents) {
    if (agent.current_location == null) continue;
    const group = locationGroups.get(agent.current_location) ?? [];
    group.push(agent);
    locationGroups.set(agent.current_location, group);
  }

  // ── 1. Public knowledge spread (sensitivity 1) ──────────────────────────
  // Co-located agents automatically learn public shared_knowledge about nearby people
  for (const fact of allFacts) {
    if (fact.sensitivity > 1) continue;

    const subjectAgent = allAgents.find(a => a.id === fact.subject_id);
    if (!subjectAgent?.current_location) continue;

    const coLocated = locationGroups.get(subjectAgent.current_location);
    if (!coLocated || coLocated.length === 0) continue;

    const knownBy = fact.known_by as number[];
    const newKnowers = coLocated.filter(a => !knownBy.includes(a.id)).map(a => a.id);
    if (newKnowers.length === 0) continue;

    addKnowers(fact, newKnowers);
  }

  // ── 2. Passive eavesdropping ────────────────────────────────────────────
  // Agents at the same location as an active conversation may learn discussed shared_knowledge
  // Check active conversations and see if non-participants are nearby
  const activeConvos = db.select().from(conversations)
    .where(eq(conversations.status, 'active')).all();

  for (const convo of activeConvos) {
    const participants = convo.participants as number[];
    if (!convo.location) continue;

    const nearby = locationGroups.get(convo.location);
    if (!nearby) continue;

    // Non-participants at the same location
    const eavesdroppers = nearby.filter(a => !participants.includes(a.id));
    if (eavesdroppers.length === 0) continue;

    // Each participant's known shared_knowledge may be overheard
    for (const pid of participants) {
      const participantFacts = allFacts.filter(f =>
        (f.known_by as number[]).includes(pid) && f.sensitivity <= 2
      );

      for (const fact of participantFacts) {
        for (const eavesdropper of eavesdroppers) {
          const knownBy = fact.known_by as number[];
          if (knownBy.includes(eavesdropper.id)) continue;

          // Eavesdrop chance: curiosity-driven
          const curiosity = eavesdropper.personality?.curiosity ?? 50;
          const chance = curiosity / 2500; // ~4% for max curiosity per tick, ~2% for average
          if (Math.random() > chance) continue;

          addKnowers(fact, [eavesdropper.id]);

          if (fact.sensitivity >= 2) {
            logActivity({
              type: 'drama',
              initiator: eavesdropper.id,
              target: fact.subject_id,
              templateData: { description: thatSentence(`${eavesdropper.name} overheard`, fact.content, [eavesdropper]) },
              metadata: { beat: 'gossip' },
            });
          }
              }
      }
    }
  }

  // ── 3. Active gossip sharing ───────────────────────────────────────────
  // Curious + dishonest agents proactively share shared_knowledge with co-located friends
  // Runs with low probability to avoid spamming
  for (const [, group] of locationGroups) {
    if (group.length < 2) continue;

    for (const agent of group) {
      if (!agent.personality) continue;
      const { curiosity, honesty, loyalty } = agent.personality;

      // Only gossip-prone agents share: curious + dishonest
      if (curiosity < 50 || honesty > 60) continue;
      if (Math.random() > 0.02 * gossipMultiplier) continue; // 2% per tick, boosted by events

      // Pick a random co-located agent to gossip with
      const targets = group.filter(a => a.id !== agent.id);
      if (targets.length === 0) continue;
      const target = targets[Math.floor(Math.random() * targets.length)];

      // Find a fact the agent knows but the target doesn't
      const shareable = allFacts.filter(f => {
        const knownBy = f.known_by as number[];
        if (!knownBy.includes(agent.id)) return false;
        if (knownBy.includes(target.id)) return false;
        // Nobody gossips about themselves. The subject always knows their own
        // secret, so without this Marco would "tell" the town that he is
        // secretly in love with Carlos (see isOwnSecret for pair facts).
        if (isOwnSecret(f, agent.id)) return false;
        // Nor to someone a confirmed fact is about (mayBeToldTo): Marco
        // telling Diego "Yuki spotted Diego" is not gossip. Unverified rumors
        // still reach their subject — that is the backlash scene.
        if (!mayBeToldTo(f, target.id)) return false;
        // Loyalty gate: loyal agents don't share shared_knowledge about friends
        if (loyalty > 60) {
          const rel = db.select({ friendship_ab: relationships.friendship_ab, friendship_ba: relationships.friendship_ba })
            .from(relationships).where(
              and(
                eq(relationships.agent_a, Math.min(agent.id, f.subject_id)),
                eq(relationships.agent_b, Math.max(agent.id, f.subject_id)),
              )
            ).get();
          const friendship = rel
            ? (agent.id < f.subject_id ? rel.friendship_ab : rel.friendship_ba)
            : 0;
          if (friendship > 50) return false;
        }
        // Sensitivity gate: high-sensitivity shared_knowledge need lower honesty
        if (f.sensitivity >= 3 && honesty > 30) return false;
        if (f.sensitivity >= 2 && honesty > 50) return false;
        return true;
      });

      if (shareable.length === 0) continue;

      const fact = shareable[Math.floor(Math.random() * shareable.length)];
      addKnowers(fact, [target.id]);
      // Telling someone a rumor about themselves: they know who said it.
      rumorReachedSubject(fact, agent.id, target.id);

      if (fact.sensitivity >= 2) {
        logActivity({
          type: 'drama',
          initiator: agent.id,
          target: target.id,
          agents: [agent.id, target.id, fact.subject_id],
          templateData: { description: thatSentence(`${agent.name} told ${target.name}`, fact.content, [agent, target]) },
          metadata: { beat: 'gossip' },
        });
      }
      }
  }

  // ── 4. Secret discovery ────────────────────────────────────────────────
  // Curious agents at locations may discover secrets about people there
  // (e.g., noticing someone sneaking around, overhearing whispers)
  for (const [, group] of locationGroups) {
    for (const agent of group) {
      if (!agent.personality || agent.personality.curiosity < 60) continue;
      if (Math.random() > 0.005 * gossipMultiplier) continue; // 0.5% per tick, boosted by events

      // Find secrets about co-located agents that this agent doesn't know
      const coLocatedIds = group.map(a => a.id).filter(id => id !== agent.id);
      const discoverable = allFacts.filter(f => {
        if ((f.known_by as number[]).includes(agent.id)) return false; // already knows
        if (!coLocatedIds.includes(f.subject_id)) return false;
        return f.sensitivity >= 2; // only discover non-public shared_knowledge
      });

      if (discoverable.length === 0) continue;

      const fact = discoverable[Math.floor(Math.random() * discoverable.length)];
      addKnowers(fact, [agent.id]);

      logActivity({
        type: 'drama',
        initiator: agent.id,
        target: fact.subject_id,
        templateData: { description: thatSentence(`${agent.name} discovered`, fact.content, [agent]) },
        metadata: { beat: 'gossip' },
      });
      }
  }

  // ── 5. Common knowledge threshold ──────────────────────────────────────
  // Spread used to saturate silently: once everyone knew, nothing happened.
  // Crossing the halfway mark is the moment the subject has to live with it.
  for (const fact of allFacts) {
    if (fact.is_public) continue;
    if (!isCommonKnowledge(fact, allAgents.length)) continue;

    db.update(shared_knowledge)
      .set({ is_public: true, revealed_at: Date.now() })
      .where(eq(shared_knowledge.id, fact.id))
      .run();
    fact.is_public = true;

    const subject = allAgents.find((a) => a.id === fact.subject_id);
    logActivity({
      type: 'drama',
      initiator: fact.subject_id,
      severity: Math.min(1, 0.5 + fact.sensitivity * 0.15),
      templateData: {
        description: thatSentence('The whole town now knows', fact.content),
      },
    });
    if (!subject) continue;

    const subjectNeeds = db
      .select()
      .from(needsTable)
      .where(eq(needsTable.agent_id, subject.id))
      .get();
    if (subjectNeeds) {
      db.update(needsTable)
        .set({ mood: Math.max(5, subjectNeeds.mood - EXPOSURE_MOOD_HIT * fact.sensitivity) })
        .where(eq(needsTable.agent_id, subject.id))
        .run();
    }

    // Reuse `stressed` rather than a bespoke `shamed` state: a new type would
    // need entries in the decay, effect and prompt tables to mean anything.
    if (!getAgentStates(subject.id).includes('stressed')) {
      db.insert(agentStates)
        .values({
          agent_id: subject.id,
          type: 'stressed',
          severity: Math.min(0.9, 0.3 + fact.sensitivity * 0.15),
          started_at: nowMinutes,
          duration: 999999, // conditional exit, same as the needs-driven variant
          source: 'knowledge:exposed',
          metadata: { factId: fact.id },
        })
        .run();
      logActivity({
        type: 'state_gained',
        initiator: subject.id,
        templateData: { agent: subject.name, state: 'stressed' },
      });
    }
  }
}
