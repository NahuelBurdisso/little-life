import { MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT } from '../config';
import type { Stage } from '../types';

/**
 * The `dimensions` stage produces the map's width & height in tiles.
 *
 * Hard invariants (relied on by peekBaseDimensions in pipeline.ts):
 * - Does not read ctx.
 * - Does not use rng.
 * - Never throws FitError.
 * - Pure and referentially transparent for fixed (cfg, agentCount, extras.expandPin).
 */
export const dimensionsStage: Stage<{ dimensions: { width: number; height: number } }> = {
  name: 'dimensions',
  dependsOn: [],
  run(_ctx, _rng, cfg, agentCount, extras) {
    // Priority 1 — framework auto-expand pin
    if (extras.expandPin) {
      return { dimensions: { ...extras.expandPin } };
    }
    // Priority 2 — user-pinned override (persisted)
    if (cfg.overrides?.dimensions) {
      return { dimensions: { ...cfg.overrides.dimensions } };
    }
    // Priority 3 — custom tier
    if (cfg.sizeTier === 'custom') {
      if (!cfg.customDimensions) {
        // Schema refinement should prevent this, but be defensive.
        throw new Error('dimensions: sizeTier=custom with no customDimensions');
      }
      return { dimensions: { ...cfg.customDimensions } };
    }
    // Priority 4 — fixed tier preset
    if (cfg.sizeTier === 'medium') return { dimensions: { width: 60, height: 45 } };
    if (cfg.sizeTier === 'large')  return { dimensions: { width: 80, height: 60 } };
    // Priority 5 — auto formula
    const width = Math.min(Math.max(30 + Math.ceil(1.8 * agentCount), MIN_WIDTH), MAX_WIDTH);
    const height = Math.min(Math.max(20 + Math.ceil(1.3 * agentCount), MIN_HEIGHT), MAX_HEIGHT);
    return { dimensions: { width, height } };
  },
};
