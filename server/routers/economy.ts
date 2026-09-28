import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { economy } from '../db/schema';

export const economyRouter = router({
  getTownStats: publicProcedure.query(() => {
    const economies = db.select().from(economy).all();
    const agentCount = economies.length;
    const totalMoney = economies.reduce((sum, e) => sum + e.money, 0);
    const averageMoney = agentCount > 0 ? totalMoney / agentCount : 0;

    return { totalMoney, averageMoney, agentCount };
  }),
});
