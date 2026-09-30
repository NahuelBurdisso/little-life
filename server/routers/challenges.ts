import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { emitter } from '../engine/emitter';
import { abandonChallenge, aimAtPair, chooseChallenge, getChallengeView } from '../lib/challenges/service';

/**
 * Optional player goals (lib/challenges/). `list` is the whole tab — offers,
 * running challenges with their progress, history — in one round trip;
 * `offers` is the same view for callers that only want the menu (the wizard).
 * Freshness: the `challenges` channel fires on every choose/abandon and on
 * every hourly check that moved something.
 */
export const challengesRouter = router({
  list: publicProcedure.query(() => getChallengeView()),

  offers: publicProcedure.query(() => getChallengeView()?.offers ?? []),

  choose: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => chooseChallenge(input.id)),

  // The player's own goal for a pair, from the pair dossier (lib/challenges/aim.ts).
  aimAtPair: publicProcedure
    .input(z.object({
      a: z.number().int(),
      b: z.number().int(),
      aim: z.enum(['marry', 'befriend', 'sunder']),
    }))
    .mutation(({ input }) => aimAtPair(input.a, input.b, input.aim)),

  abandon: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => abandonChallenge(input.id)),

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('challenges', opts.signal)) {
      yield data;
    }
  }),
});
