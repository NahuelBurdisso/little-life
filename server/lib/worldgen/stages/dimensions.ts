import { MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT, TIER_DIMENSIONS } from '../config';
import type { Stage } from '../types';

/** Agent count at which the auto size starts growing past MIN_WIDTH/MIN_HEIGHT. */
const MIN_AGENTS_FOR_GROWTH = 13;

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
    // Priority 2 — user-pinned override (persisted).
    // This sets the *base* size only. `pipeline.ts` exempts `sizeTier: 'custom'`
    // from the auto-expand ladder but not this, so a pin here is still grown
    // when the content does not fit. See the note on `overrides` in config.ts.
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
    // Priority 4 — fixed tier preset. Sizes live in config.ts because the setup
    // wizard advertises them in its dropdown and used to hardcode its own copy.
    if (cfg.sizeTier === 'medium') return { dimensions: { ...TIER_DIMENSIONS.medium } };
    if (cfg.sizeTier === 'large')  return { dimensions: { ...TIER_DIMENSIONS.large } };
    // Priority 5 — auto formula.
    //
    // Grows from the minimum size by the *content* an extra agent adds, which is
    // half a home: `ceil(n/2)` homes of 3×3 with a 2-tile gap ring, so ~12 tiles
    // per agent, taken at a little over double that to leave slack for the
    // BUILDING_GAP rings the homes stage reserves around public buildings.
    //
    // The formula used to be `30 + 1.8n` by `20 + 1.3n`, which grows the *area*
    // by ~215 tiles per agent at n=30 — about eighteen times the content being
    // added. Content density therefore fell as the town grew and the surplus
    // showed up as empty field: measured share of the map that is walkable, not
    // road, not inside an open-area plot and more than 3 tiles from any doorway
    // was 45.8% at 13 agents, 51.8% at 20, 63.8% at 30 and 65.9% at 32, with the
    // median 30-agent world containing a single connected 500-tile void. It is
    // now 45.8 / 46.7 / 46.9 / 46.0% — flat across town size, with 0 FitErrors in
    // 400 seeds at every count.
    //
    // The `- MIN_AGENTS_FOR_GROWTH` term is what keeps small towns at the
    // minimum: below it the map is already sized by MIN_WIDTH/MIN_HEIGHT, which
    // exist to keep the 3×3 zone grid non-degenerate rather than to hold content.
    const extra = Math.max(0, agentCount - MIN_AGENTS_FOR_GROWTH);
    const width = Math.min(MIN_WIDTH + Math.ceil(0.30 * extra), MAX_WIDTH);
    const height = Math.min(MIN_HEIGHT + Math.ceil(0.24 * extra), MAX_HEIGHT);
    return { dimensions: { width, height } };
  },
};
