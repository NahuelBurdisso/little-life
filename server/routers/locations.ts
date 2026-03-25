import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { locations, agents } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

export const locationsRouter = router({
  getAll: publicProcedure.query(() => {
    return db.select().from(locations).all();
  }),

  getOccupants: publicProcedure
    .input(z.object({ locationId: z.number() }))
    .query(({ input }) => {
      const location = db
        .select()
        .from(locations)
        .where(eq(locations.id, input.locationId))
        .get();

      if (!location) return null;

      const occupantIds = location.current_occupants as number[];
      const occupants =
        occupantIds.length > 0
          ? db
              .select()
              .from(agents)
              .where(inArray(agents.id, occupantIds))
              .all()
          : [];

      return { location, occupants };
    }),
});
