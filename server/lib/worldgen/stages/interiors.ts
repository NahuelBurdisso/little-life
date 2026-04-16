import { INTERIOR_GRIDS } from '../../../data/interiors';
import type { Stage, InteriorData } from '../types';

/** Phase 4 replaces this with per-building variation. Phase 1 looks up
 *  INTERIOR_GRIDS by building type. */
export const interiorsStage: Stage<{ interiors: Record<number, InteriorData> }> = {
  name: 'interiors',
  dependsOn: ['publicBuildings', 'homes'],
  run(ctx) {
    if (!ctx.publicBuildings || !ctx.homes) {
      throw new Error('interiors: missing publicBuildings or homes');
    }
    const result: Record<number, InteriorData> = {};
    let idx = 0;
    for (const loc of [...ctx.publicBuildings, ...ctx.homes]) {
      // Locations don't yet have DB IDs at generation time; use insertion
      // index as a synthetic key. Final DB-mapped lookup happens at
      // consumption time (not Phase 1 scope).
      result[idx++] = { grid: INTERIOR_GRIDS[loc.type] ?? null };
    }
    return { interiors: result };
  },
};
