import type { Stage } from '../types';

/** Phase 5 replaces this with a seeded name generator. Phase 1 returns
 *  each location's existing name keyed by the same name (identity map).
 *  Kept in the pipeline to reserve the contract for Phase 5. */
export const namesStage: Stage<{ names: Record<string, string> }> = {
  name: 'names',
  dependsOn: ['publicBuildings', 'homes'],
  run(ctx) {
    if (!ctx.publicBuildings || !ctx.homes) {
      throw new Error('names: missing publicBuildings or homes');
    }
    const names: Record<string, string> = {};
    for (const loc of [...ctx.publicBuildings, ...ctx.homes]) {
      names[loc.name] = loc.name;
    }
    return { names };
  },
};
