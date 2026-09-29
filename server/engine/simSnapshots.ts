import { eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { simSnapshots, worldState } from '../db/schema';
import { gameMinutes } from '../lib/gameClock';
import type { SnapshotStore } from './snapshotCodec';

// ─── Sim snapshots ────────────────────────────────────────────────────────────
// A lot of simulation state lives in module-level Maps rather than in tables:
// hobby skills, the favor ledger, tension, mood momentum, personality drift
// baselines, the states-phase trackers. All of it used to die with the process,
// so every server restart quietly reset hobbies to level 0, forgave every debt,
// defused every agent heading for a snap and — worst — re-anchored the ±15
// personality drift cap on the already-drifted value, making drift unbounded
// across restarts.
//
// Rather than giving each of those a table (and a schema migration) of its own,
// each store implements `SnapshotStore` (./snapshotCodec.ts) and is checkpointed
// as one JSON blob in `sim_snapshots`. The list of persisted stores is kept next
// to the per-world cache reset in `worldCaches.ts`, so the two lifecycles — "a
// world was replaced, forget it" and "the process restarted, remember it" — are
// maintained side by side.
//
// When it runs:
//   - every game hour from the tick (game time, not ticks, so the cadence holds
//     at every speed);
//   - on graceful shutdown, after the tick loop has stopped;
//   - right before a world replace, so the rollback path gets the latest state;
//   - at boot and after every per-world cache clear, to load it back.
// A crash loses at most one game hour of accumulation, which is fine for state
// that changes on the scale of days.
//
// World scoping: the rows are also wiped by `ALL_TABLES` on a world replace,
// but each row additionally carries `world_state.id`. That id is AUTOINCREMENT,
// so a later world does not get it again (unlike agent ids, which SQLite
// reuses): a row that somehow survives into another world — `seed.ts --reset`,
// a hand-edited DB — is ignored rather than handing a stranger someone's skills.

function currentWorld(): { id: number; minute: number } | null {
  const row = db.select({ id: worldState.id, time: worldState.time }).from(worldState).limit(1).get();
  if (!row) return null;
  return { id: row.id, minute: gameMinutes(row.time) };
}

/**
 * Write every store's current content. Never throws: it runs from the tick,
 * from shutdown and from setup, and a failed checkpoint must not take any of
 * those down with it. Returns how many stores were written.
 *
 * Safe to call inside an open transaction (the drift write-through does, from
 * a simEvents listener): better-sqlite3 turns the nested transaction into a
 * savepoint, and the checkpoint then commits or rolls back with the change
 * that triggered it.
 */
export function saveSnapshots(stores: readonly SnapshotStore[]): number {
  try {
    const world = currentWorld();
    if (!world) return 0;
    const now = Date.now();
    let written = 0;
    db.transaction((tx) => {
      for (const store of stores) {
        let data: unknown;
        try {
          data = store.serialize();
        } catch (err) {
          console.warn(`[snapshots] serialize '${store.key}' failed:`, (err as Error).message);
          continue;
        }
        if (data === undefined) continue;
        const row = { world_id: world.id, version: store.version, game_minute: world.minute, data, saved_at: now };
        tx.insert(simSnapshots)
          .values({ key: store.key, ...row })
          .onConflictDoUpdate({ target: simSnapshots.key, set: row })
          .run();
        written++;
      }
    });
    return written;
  } catch (err) {
    console.warn('[snapshots] save failed:', (err as Error).message);
    return 0;
  }
}

/**
 * Load every store from the current world's rows. A store without a row (a new
 * world, a store added since the last save) or with a row from another format
 * version is left as it is — callers load right after a cache clear, so that
 * means empty. Never throws, for the same reason as `saveSnapshots`.
 * Returns how many stores were restored.
 */
export function loadSnapshots(stores: readonly SnapshotStore[]): number {
  try {
    const world = currentWorld();
    if (!world) return 0;
    // Rows from another world can only be leftovers; drop them so they cannot
    // linger forever under a key no store writes any more.
    db.delete(simSnapshots).where(ne(simSnapshots.world_id, world.id)).run();
    const rows = db.select().from(simSnapshots).where(eq(simSnapshots.world_id, world.id)).all();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    let restored = 0;
    for (const store of stores) {
      const row = byKey.get(store.key);
      if (!row || row.version !== store.version) continue;
      try {
        store.restore(row.data);
        restored++;
      } catch (err) {
        console.warn(`[snapshots] restore '${store.key}' failed:`, (err as Error).message);
      }
    }
    return restored;
  } catch (err) {
    console.warn('[snapshots] load failed:', (err as Error).message);
    return 0;
  }
}
