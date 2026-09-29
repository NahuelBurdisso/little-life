import { router, publicProcedure } from '../trpc';
import { z } from 'zod';
import { emitter } from '../engine/emitter';
import { getIssue, listIssues, writeIssue } from '../lib/gazette';

export const gazetteRouter = router({
  /** Newest editions first (headline only). */
  list: publicProcedure
    .input(z.object({ limit: z.number().optional() }).optional())
    .query(({ input }) => listIssues(input?.limit ?? 30)),

  /** One edition; the latest when no id is given. */
  get: publicProcedure
    .input(z.object({ id: z.number().optional() }).optional())
    .query(({ input }) => getIssue(input?.id)),

  /**
   * Print an edition now, covering everything since the last one. Resolves
   * when it is written: `{ id: null }` on a quiet day, a failed model call, or
   * an edition already on the press.
   */
  printNow: publicProcedure.mutation(async () => ({ id: await writeIssue() })),

  onNewIssue: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('gazette', opts.signal)) {
      yield data;
    }
  }),
});
