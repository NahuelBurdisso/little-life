import { db } from '../../db';
import { worldState } from '../../db/schema';

/**
 * The running world's generator seed (`setup_config.worldgen.seed`), the salt
 * for per-pair chemistry so a Restart with a new seed reshuffles who clicks.
 * Falls back to 0 for a world with no recorded seed. One indexed single-row
 * read, cheap enough to call once per finished conversation; deliberately not
 * cached, so a world replace or save load can never leave a stale seed behind.
 */
export function currentWorldSeed(): string | number {
  const row = db.select({ setup_config: worldState.setup_config }).from(worldState).limit(1).get();
  const seed = (row?.setup_config as { worldgen?: { seed?: unknown } } | null)?.worldgen?.seed;
  return typeof seed === 'string' || typeof seed === 'number' ? seed : 0;
}
