import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { shared_knowledge, agents, relationships } from '../db/schema';
import { and, eq, gte, or } from 'drizzle-orm';
import { z } from 'zod';
import { isOwnSecret } from '../lib/gossip';
import { isAdultAge, isAdultsOnlyFact } from '../lib/intimacy/eligibility';
import { MARRIED_TAG } from '../lib/marriage';

/** Most secrets the letter picker offers: it is a menu, not the secret network. */
const LETTERABLE_LIMIT = 8;
/** Beats any friendship score (0-100 both ways), so a partner's secrets always lead. */
const PARTNER_BONUS = 1000;

export const knowledgeRouter = router({
  /** What does a specific agent know? */
  getKnownBy: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      return db.select().from(shared_knowledge)
        .where(eq(shared_knowledge.is_active, true))
        .all()
        .filter(f => (f.known_by as number[]).includes(input.agentId));
    }),

  /** All active secrets (sensitivity >= 2) with who knows what */
  getSecretNetwork: publicProcedure.query(() => {
    const allFacts = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.is_active, true), gte(shared_knowledge.sensitivity, 2)))
      .all();

    // Enrich with agent names. Only living agents count: `totalAgents` is the
    // denominator of the spread bar, and removed agents used to inflate it so a
    // fully-spread secret never read as fully spread.
    const allAgents = db.select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.is_active, true))
      .all();
    const nameMap = new Map(allAgents.map(a => [a.id, a.name]));

    return allFacts.map(f => {
      // Drop knowers who are no longer in town, so knownByCount/totalAgents is
      // a ratio over the same population and can never exceed 1.
      const knowers = (f.known_by as number[]).filter(id => nameMap.has(id));
      return {
        id: f.id,
        type: f.type,
        content: f.content,
        sensitivity: f.sensitivity,
        isPublic: f.is_public,
        revealedAt: f.revealed_at,
        subjectName: nameMap.get(f.subject_id) ?? null,
        targetName: f.target_id ? nameMap.get(f.target_id) ?? null : null,
        knownByNames: knowers.map(id => nameMap.get(id)!),
        knownByCount: knowers.length,
        totalAgents: allAgents.length,
      };
    });
  }),

  /**
   * Secrets the player could send `recipientId` in an anonymous letter (godPowers.ts
   * `sendAnonymousLetter`), for the picker in the nudge menu. The secret network's
   * filter (live, sensitivity >= 2) minus what the letter would refuse: already
   * public, already known to the recipient, the recipient's own, and a romance fact
   * when the recipient is a minor. Fresh on every open (the client only enables it
   * while the picker is showing), because who knows what changes by the minute.
   *
   * Ranked by what the recipient has at stake: a secret about their partner or
   * spouse first (the affair is the point of the power), then about their closest
   * ties (friendship and romance, both ways), then the rest by sensitivity and recency.
   */
  getLetterable: publicProcedure
    .input(z.object({ recipientId: z.number() }))
    .query(({ input }) => {
      const recipient = db.select({ id: agents.id, age: agents.age }).from(agents)
        .where(and(eq(agents.id, input.recipientId), eq(agents.is_active, true))).get();
      if (!recipient) return [];
      const adult = isAdultAge(recipient.age);

      const names = new Map(
        db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.is_active, true)).all()
          .map((a) => [a.id, a.name] as const),
      );

      // Per other resident: how much the recipient cares, partners far above everyone.
      const stake = new Map<number, number>();
      const rels = db.select().from(relationships)
        .where(or(eq(relationships.agent_a, recipient.id), eq(relationships.agent_b, recipient.id))).all();
      for (const r of rels) {
        const other = r.agent_a === recipient.id ? r.agent_b : r.agent_a;
        const closeness = Math.max(0, (r.friendship_ab + r.friendship_ba) / 2 + (r.romance_ab + r.romance_ba) / 2);
        const partner = r.status === 'partners' || r.tags.includes(MARRIED_TAG);
        stake.set(other, closeness + (partner ? PARTNER_BONUS : 0));
      }

      return db.select().from(shared_knowledge)
        .where(and(
          eq(shared_knowledge.is_active, true),
          eq(shared_knowledge.is_public, false),
          gte(shared_knowledge.sensitivity, 2),
        ))
        .all()
        .filter((f) =>
          !(f.known_by as number[]).includes(recipient.id)
          && !isOwnSecret(f, recipient.id)
          && (adult || !isAdultsOnlyFact(f))
          // A secret about someone who has left town is not one to write about.
          && names.has(f.subject_id))
        .map((f) => ({
          f,
          rank: Math.max(stake.get(f.subject_id) ?? 0, f.target_id != null ? stake.get(f.target_id) ?? 0 : 0),
        }))
        .sort((x, y) => y.rank - x.rank || y.f.sensitivity - x.f.sensitivity || y.f.id - x.f.id)
        .slice(0, LETTERABLE_LIMIT)
        .map(({ f }) => ({
          factId: f.id,
          content: f.content,
          subjectName: names.get(f.subject_id)!,
          sensitivity: f.sensitivity,
        }));
    }),
});
