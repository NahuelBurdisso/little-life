import type Database from 'better-sqlite3';
import { assignOrientations, type OrientationRelationship } from '../lib/intimacy/orientation';
import { makeRng, stringToSeed } from '../lib/worldgen/rng';

/**
 * Every start (and save load): give agents whose `orientation` is NULL one.
 *
 * Worlds from before the intimacy layer, and any insert path that did not
 * assign one, leave NULL rows; the eligibility gate reads NULL as straight, so
 * without this an old town would have no gay or bi residents at all. Runs the
 * same pure `assignOrientations` as the seeders, against the relationships the
 * world already has, so a seeded same-gender crush keeps its orientation.
 *
 * Deterministic: the rng is seeded from the ids being filled, and only NULL rows
 * are written, so a second run matches nothing (idempotent, no user_version).
 * Everyone (not just the NULL rows) goes into the assignment so genders of
 * crush targets are known; already-set rows are simply not written back.
 * Raw `sqlite` handle and plain SQL: this runs inside `initSchema`, before the
 * drizzle client exists.
 */
export function backfillOrientations(sqlite: Database.Database): number {
  const all = sqlite.prepare('SELECT id, gender, orientation FROM agents').all() as Array<{
    id: number; gender: string; orientation: string | null;
  }>;
  const missing = all.filter((a) => a.orientation === null);
  if (missing.length === 0) return 0;

  const rels = sqlite
    .prepare('SELECT agent_a, agent_b, romance_ab, romance_ba FROM relationships')
    .all() as OrientationRelationship[];
  const seed = stringToSeed(`orientation|${missing.map((a) => a.id).sort((x, y) => x - y).join(',')}`);
  const assigned = assignOrientations(all, rels, makeRng(seed));

  const write = sqlite.prepare('UPDATE agents SET orientation = ? WHERE id = ? AND orientation IS NULL');
  sqlite.transaction(() => {
    for (const a of missing) write.run(assigned.get(a.id), a.id);
  })();
  console.log(`[db] Assigned an orientation to ${missing.length} resident(s)`);
  return missing.length;
}
