import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { conversations, relationshipEvents, agents, shared_knowledge } from '../db/schema';
import { eq, desc, and, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';

export const conversationsRouter = router({
  getActive: publicProcedure.query(() => {
    return db
      .select()
      .from(conversations)
      .where(eq(conversations.status, 'active'))
      .all();
  }),

  getAll: publicProcedure
    .input(z.object({ limit: z.number().optional().default(100) }))
    .query(({ input }) => {
      const allConvos = db
        .select()
        .from(conversations)
        .where(eq(conversations.status, 'ended'))
        .orderBy(desc(conversations.ended_at))
        .limit(input.limit)
        .all();

      // Resolve participant names
      const agentCache = new Map<number, string>();
      for (const c of allConvos) {
        for (const pid of c.participants as number[]) {
          if (!agentCache.has(pid)) {
            const a = db.select({ name: agents.name }).from(agents).where(eq(agents.id, pid)).get();
            if (a) agentCache.set(pid, a.name);
          }
        }
      }

      return allConvos.map(c => {
        const msgs = c.messages as Array<{ speakerId?: number; text: string }>;
        const participantNames = (c.participants as number[]).map(id => agentCache.get(id) ?? `Agent ${id}`);
        return {
          id: c.id,
          participants: c.participants,
          participantNames,
          topic: c.topic,
          sentiment: c.sentiment,
          turnCount: msgs.length,
          preview: msgs[0]?.text?.substring(0, 100) ?? '',
          startedAt: c.started_at,
          endedAt: c.ended_at,
          triggerReason: c.trigger_reason,
        };
      });
    }),

  getRecent: publicProcedure
    .input(
      z.object({
        limit: z.number().optional().default(10),
      })
    )
    .query(({ input }) => {
      return db
        .select()
        .from(conversations)
        .where(eq(conversations.status, 'ended'))
        .orderBy(desc(conversations.ended_at))
        .limit(input.limit)
        .all();
    }),

  getImpact: publicProcedure
    .input(z.object({ conversationId: z.number() }))
    .query(({ input }) => {
      const convo = db.select().from(conversations)
        .where(eq(conversations.id, input.conversationId)).get();
      if (!convo) return null;

      const participantIds = convo.participants as number[];
      const startedAt = convo.started_at;
      const endedAt = convo.ended_at ?? Date.now();

      // Find relationship events between these participants around this time window
      const relEvents = db.select().from(relationshipEvents)
        .where(and(
          gte(relationshipEvents.timestamp, startedAt - 5000),
          lte(relationshipEvents.timestamp, endedAt + 5000)
        ))
        .all()
        .filter(e => participantIds.includes(e.agent_a) && participantIds.includes(e.agent_b));

      // Get participant names
      const names: Record<number, string> = {};
      for (const pid of participantIds) {
        const agent = db.select({ name: agents.name }).from(agents).where(eq(agents.id, pid)).get();
        if (agent) names[pid] = agent.name;
      }

      // Find shared_knowledge created during this conversation
      const createdFacts = db.select().from(shared_knowledge)
        .where(and(
          gte(shared_knowledge.created_at, startedAt - 5000),
          lte(shared_knowledge.created_at, endedAt + 5000)
        ))
        .all()
        .filter(f => participantIds.includes(f.subject_id) || (f.target_id != null && participantIds.includes(f.target_id)));

      // Compute total relationship deltas
      let totalFriendshipDelta = 0;
      let totalRomanceDelta = 0;
      let totalTrustDelta = 0;
      for (const e of relEvents) {
        totalFriendshipDelta += (e.friendship_delta_ab + e.friendship_delta_ba) / 2;
        totalRomanceDelta += (e.romance_delta_ab + e.romance_delta_ba) / 2;
        totalTrustDelta += (e.trust_delta_ab + e.trust_delta_ba) / 2;
      }

      return {
        conversation: convo,
        names,
        relationshipEvents: relEvents.map(e => ({
          event_type: e.event_type,
          description: e.description,
          friendshipDelta: (e.friendship_delta_ab + e.friendship_delta_ba) / 2,
          romanceDelta: (e.romance_delta_ab + e.romance_delta_ba) / 2,
          trustDelta: (e.trust_delta_ab + e.trust_delta_ba) / 2,
          sentiment: e.sentiment,
        })),
        createdFacts: createdFacts.map(f => ({
          type: f.type,
          content: f.content,
          sensitivity: f.sensitivity,
        })),
        totals: {
          friendship: Math.round(totalFriendshipDelta * 10) / 10,
          romance: Math.round(totalRomanceDelta * 10) / 10,
          trust: Math.round(totalTrustDelta * 10) / 10,
          sentiment: convo.sentiment ?? 0,
          turns: (convo.messages as any[])?.length ?? 0,
        },
      };
    }),

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('conversations', opts.signal)) {
      yield data;
    }
  }),
});
