import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { deleteSave, listSaves, loadSave, saveWorld, SaveRejectedError } from '../lib/saves';

/** Save ids as lib/saves.ts builds them; anything else never reaches the disk. */
const SaveIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/);

/**
 * A refusal about the file (newer build, not a save, gone) is the player's to
 * read, not a server fault: BAD_REQUEST carries the message to the dialog.
 */
function asTrpcError(err: unknown): never {
  if (err instanceof SaveRejectedError) throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  throw err;
}

export const savesRouter = router({
  /** Every save, newest first. Not wired to a channel: the dialog reads it on open. */
  list: publicProcedure.query(() => listSaves()),

  /** Copy the running world into a new slot. Pauses the game for the copy. */
  save: publicProcedure
    .input(z.object({ name: z.string().max(80) }))
    .mutation(({ input }) => saveWorld(input.name).catch(asTrpcError)),

  /**
   * Replace the running world with a save. Unsaved progress is lost — the
   * dialog confirms first. On failure the current world is left as it was.
   */
  load: publicProcedure
    .input(z.object({ id: SaveIdSchema }))
    .mutation(({ input }) => loadSave(input.id).catch(asTrpcError)),

  /** Delete a save's files (never the live DB). The dialog confirms first. */
  delete: publicProcedure
    .input(z.object({ id: SaveIdSchema }))
    .mutation(async ({ input }) => ({ deleted: await deleteSave(input.id) })),
});
