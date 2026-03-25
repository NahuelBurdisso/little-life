import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { economy, economyTransactions } from '../db/schema';
import { eq, or, desc } from 'drizzle-orm';
import { z } from 'zod';

export const economyRouter = router({
  getAgentEconomy: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      return db
        .select()
        .from(economy)
        .where(eq(economy.agent_id, input.agentId))
        .get() ?? null;
    }),

  getTransactions: publicProcedure
    .input(
      z.object({
        agentId: z.number(),
        limit: z.number().optional().default(20),
      })
    )
    .query(({ input }) => {
      return db
        .select()
        .from(economyTransactions)
        .where(
          or(
            eq(economyTransactions.from_agent, input.agentId),
            eq(economyTransactions.to_agent, input.agentId)
          )
        )
        .orderBy(desc(economyTransactions.timestamp))
        .limit(input.limit)
        .all();
    }),

  getTownStats: publicProcedure.query(() => {
    const economies = db.select().from(economy).all();
    const agentCount = economies.length;
    const totalMoney = economies.reduce((sum, e) => sum + e.money, 0);
    const averageMoney = agentCount > 0 ? totalMoney / agentCount : 0;

    return { totalMoney, averageMoney, agentCount };
  }),
});
