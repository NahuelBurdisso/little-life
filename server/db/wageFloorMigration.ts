import type Database from 'better-sqlite3';
import { GAME_MINUTE_STAMPS_VERSION } from './clockMigration';

/**
 * One-shot: raise every active resident's wage to the wage floor (E5).
 *
 * Salaries live on each world's `economy` rows, copied from the seed table when
 * the world was made, so raising the table's lowest wages (musician $14,
 * retiree $15, shop assistant $16 → $20) never reached a world that already
 * existed: its low earners kept living on the pantry meal. A wage of 0 is left
 * alone — it means "no job", and the treasury stipend is that resident's floor.
 *
 * Shares `PRAGMA user_version` with the clock rebase (clockMigration.ts), whose
 * steps are versions 1-2; this is version 3. It waits for the rebase: marking
 * the file 3 first would make the rebase believe it had already run. Idempotent
 * and race-safe like the rebase: the version is re-read inside an IMMEDIATE
 * transaction, and the UPDATE and the bump commit together. A file without the
 * tables yet has no old wages and is simply marked current.
 */
export const WAGE_FLOOR_VERSION = 3;

function userVersion(sqlite: Database.Database): number {
  return sqlite.pragma('user_version', { simple: true }) as number;
}

export function raiseWagesToFloor(sqlite: Database.Database, floor: number): void {
  const before = userVersion(sqlite);
  if (before >= WAGE_FLOOR_VERSION || before < GAME_MINUTE_STAMPS_VERSION) return;

  sqlite.transaction(() => {
    if (userVersion(sqlite) >= WAGE_FLOOR_VERSION) return; // another connection got here first
    let changes = 0;
    try {
      changes = sqlite.prepare(
        `UPDATE economy SET salary = ? WHERE salary > 0 AND salary < ? ` +
        `AND agent_id IN (SELECT id FROM agents WHERE is_active = 1)`,
      ).run(floor, floor).changes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/no such table/i.test(message)) throw err;
    }
    if (changes > 0) console.log(`[db] Raised ${changes} wage(s) to the $${floor} floor (user_version ${WAGE_FLOOR_VERSION})`);
    sqlite.pragma(`user_version = ${WAGE_FLOOR_VERSION}`);
  }).immediate();
}
