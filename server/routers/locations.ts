import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { locations } from '../db/schema';

export const locationsRouter = router({
  getAll: publicProcedure.query(() => {
    return db.select().from(locations).all();
  }),
});
