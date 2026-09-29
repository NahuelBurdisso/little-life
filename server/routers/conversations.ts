import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { conversations, agents } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';
import { computeConversationImpact } from '../lib/conversationImpact';

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

  /** What a finished conversation did to its participants (lib/conversationImpact.ts). */
  getImpact: publicProcedure
    .input(z.object({ conversationId: z.number() }))
    .query(({ input }) => computeConversationImpact(input.conversationId)),

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('conversations', opts.signal)) {
      yield data;
    }
  }),
});
