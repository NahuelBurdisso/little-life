import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { facts } from '../db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

export const factsRouter = router({
  getKnownBy: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      return db.select().from(facts)
        .where(eq(facts.is_active, true))
        .all()
        .filter(f => (f.known_by as number[]).includes(input.agentId));
    }),
});
