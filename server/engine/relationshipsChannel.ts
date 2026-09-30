/**
 * The `relationships.all` channel: dirty only when the relationships table was
 * actually written since the last flush.
 *
 * Why (playtest #3): the client refetched `relationships.getGraph` on every
 * `agents.all` flush — needs and movement mark that channel every tick, so at
 * 4x the whole graph went over the wire ~4 times a second (5,700 calls in 21
 * real minutes) while relationships change a few times a game hour. Dozens of
 * places write relationships (conversations, gifts, cascade rules, nudges, the
 * hourly decay), so instead of a markDirty at each of them, the table's TEMP
 * trigger counter (db/index.ts getTableWriteVersion) is read at flush time: a
 * write from anywhere, inside or outside the tick, is announced by the next
 * flush, and one forgotten call site can't leave the graph stale.
 */
import { getTableWriteVersion } from '../db';
import { emitter } from './emitter';

export const RELATIONSHIPS_CHANNEL = 'relationships.all';

let lastSeen: number | null = null;

/** Mark the channel when the counter moved. */
function markRelationshipsIfWritten(): void {
  const version = getTableWriteVersion('relationships');
  if (lastSeen !== version) {
    lastSeen = version;
    emitter.markDirty(RELATIONSHIPS_CHANNEL);
  }
}

emitter.addFlushHook(markRelationshipsIfWritten);
