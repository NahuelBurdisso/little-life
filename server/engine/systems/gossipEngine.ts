/**
 * Gossip Engine — Centralized fact spread system
 *
 * Called once per tick. Handles all the ways shared_knowledge spread between agents:
 * 1. Public knowledge spread (co-located agents learn public shared_knowledge)
 * 2. Passive eavesdropping (agents at the same location as a conversation learn shared_knowledge)
 * 3. Active gossip sharing (curious agents proactively share shared_knowledge with friends)
 * 4. Secret discovery (curious agents piece together hidden information)
 * 5. Observation-based learning (witnessing actions creates knowledge)
 *
 * To add a new spread mechanic: add it here. One file, one place.
 */

import { db } from '../../db';
import { agents, shared_knowledge, relationships, conversations } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { PersonalityProfile } from '../../lib/personality';
import { logActivity } from '../../lib/activityLogger';

interface AgentInfo {
  id: number;
  name: string;
  current_location: number | null;
  personality: PersonalityProfile | null;
}

export function gossipTick(_currentTick: number): void {
  const allAgents: AgentInfo[] = db.select({
    id: agents.id,
    name: agents.name,
    current_location: agents.current_location,
    personality: agents.personality,
  }).from(agents).where(eq(agents.is_active, true)).all() as AgentInfo[];

  const allFacts = db.select().from(shared_knowledge).where(eq(shared_knowledge.is_active, true)).all();
  if (allFacts.length === 0) return;

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

    db.update(shared_knowledge)
      .set({ known_by: [...new Set([...knownBy, ...newKnowers])] })
      .where(eq(shared_knowledge.id, fact.id))
      .run();
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
          const chance = curiosity / 5000; // ~1% for max curiosity per tick
          if (Math.random() > chance) continue;

          const updated = [...new Set([...knownBy, eavesdropper.id])];
          db.update(shared_knowledge).set({ known_by: updated }).where(eq(shared_knowledge.id, fact.id)).run();

          if (fact.sensitivity >= 2) {
            logActivity({
              type: 'drama',
              initiator: eavesdropper.id,
              target: fact.subject_id,
              templateData: { description: `${eavesdropper.name} overheard something about ${fact.content}.` },
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
      if (Math.random() > 0.02) continue; // 2% per tick per gossiper

      // Pick a random co-located agent to gossip with
      const targets = group.filter(a => a.id !== agent.id);
      if (targets.length === 0) continue;
      const target = targets[Math.floor(Math.random() * targets.length)];

      // Find a fact the agent knows but the target doesn't
      const shareable = allFacts.filter(f => {
        const knownBy = f.known_by as number[];
        if (!knownBy.includes(agent.id)) return false;
        if (knownBy.includes(target.id)) return false;
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
      const knownBy = fact.known_by as number[];
      db.update(shared_knowledge).set({ known_by: [...new Set([...knownBy, target.id])] })
        .where(eq(shared_knowledge.id, fact.id)).run();

      if (fact.sensitivity >= 2) {
        logActivity({
          type: 'drama',
          initiator: agent.id,
          target: target.id,
          agents: [agent.id, target.id, fact.subject_id],
          templateData: { description: `${agent.name} told ${target.name} that ${fact.content}.` },
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
      if (Math.random() > 0.005) continue; // 0.5% per tick — rare

      // Find secrets about co-located agents that this agent doesn't know
      const coLocatedIds = group.map(a => a.id).filter(id => id !== agent.id);
      const discoverable = allFacts.filter(f => {
        if (!(f.known_by as number[]).includes(agent.id) === false) return false; // already knows
        if ((f.known_by as number[]).includes(agent.id)) return false;
        if (!coLocatedIds.includes(f.subject_id)) return false;
        return f.sensitivity >= 2; // only discover non-public shared_knowledge
      });

      if (discoverable.length === 0) continue;

      const fact = discoverable[Math.floor(Math.random() * discoverable.length)];
      const knownBy = fact.known_by as number[];
      db.update(shared_knowledge).set({ known_by: [...new Set([...knownBy, agent.id])] })
        .where(eq(shared_knowledge.id, fact.id)).run();

      logActivity({
        type: 'drama',
        initiator: agent.id,
        target: fact.subject_id,
        templateData: { description: `${agent.name} discovered that ${fact.content}.` },
      });
      }
  }

}
