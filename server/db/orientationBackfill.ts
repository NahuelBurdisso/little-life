import type Database from 'better-sqlite3';
import { assignOrientations, SEEDED_CRUSH_THRESHOLD, type OrientationRelationship } from '../lib/intimacy/orientation';
import { canBeAttractedTo, isAdultAge } from '../lib/intimacy/eligibility';
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

/**
 * Every start (and save load): widen an orientation that walls off a seeded
 * romance to `bi`.
 *
 * Before `assignOrientations` counted opposite-gender targets, a man seeded in
 * love with a woman could still roll `gay` (and the reverse), and the eligibility
 * gate then refused the very couple the town was built around. Saves made in that
 * window keep the wrong value forever (the backfill only fills NULL rows), so this
 * heals them: for every relationship where one adult feels more than a crush
 * (`SEEDED_CRUSH_THRESHOLD`) for another adult they are not drawn to, that
 * person becomes `bi`. Adults only, so it never widens the pull of a minor; those
 * rows are `repairMinorRomance`'s. Idempotent: once bi they no longer match.
 */
export function repairOrientationConflicts(sqlite: Database.Database): number {
  const rels = sqlite
    .prepare(`SELECT r.agent_a, r.agent_b, r.romance_ab, r.romance_ba
              FROM relationships r
              WHERE r.romance_ab > ? OR r.romance_ba > ?`)
    .all(SEEDED_CRUSH_THRESHOLD, SEEDED_CRUSH_THRESHOLD) as OrientationRelationship[];
  if (rels.length === 0) return 0;

  const people = new Map(
    (sqlite.prepare('SELECT id, gender, age, orientation FROM agents').all() as Array<{
      id: number; gender: string; age: number | null; orientation: string | null;
    }>).map((a) => [a.id, a]),
  );

  const widen = new Set<number>();
  const check = (who: number, whom: number, romance: number) => {
    if (romance <= SEEDED_CRUSH_THRESHOLD) return;
    const me = people.get(who);
    const them = people.get(whom);
    if (!me || !them || me.orientation === null || me.orientation === 'bi') return;
    if (!isAdultAge(me.age) || !isAdultAge(them.age)) return;
    if (!canBeAttractedTo(me, them)) widen.add(who);
  };
  for (const r of rels) {
    check(r.agent_a, r.agent_b, r.romance_ab);
    check(r.agent_b, r.agent_a, r.romance_ba);
  }
  if (widen.size === 0) return 0;

  const write = sqlite.prepare("UPDATE agents SET orientation = 'bi' WHERE id = ?");
  sqlite.transaction(() => {
    for (const id of widen) write.run(id);
  })();
  console.log(`[db] Widened the orientation of ${widen.size} resident(s) to keep a seeded romance possible`);
  return widen.size;
}
