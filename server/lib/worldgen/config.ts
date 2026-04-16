import { z } from 'zod';

// Exported constants — see spec §6.1 for rationale.
// MIN values match the bounding box of the hardcoded public buildings in
// server/data/maps.ts (Clinic east edge tile 48, Farm/Park south edge tile 37).
// MAX values cap auto-growth for performance + visual sanity.
export const MIN_WIDTH = 48;
export const MAX_WIDTH = 90;
export const MIN_HEIGHT = 37;
export const MAX_HEIGHT = 70;

/**
 * Inner object schema — exposed separately because callers that want to
 * .extend() the schema cannot do so on a ZodEffects (post-refine) wrapper.
 * Use this variant when composing larger schemas; use WorldGenConfigSchema
 * (below) as the validated form.
 */
export const WorldGenConfigObjectSchema = z.object({
  /** Master seed string. Blank → pipeline generates a random one. */
  seed: z.string().optional(),
  /** Preset size tier. 'custom' requires customDimensions. */
  sizeTier: z.enum(['medium', 'large', 'auto', 'custom']).default('auto'),
  /** Used only when sizeTier === 'custom'. Bounded to [MIN_*, MAX_*]. */
  customDimensions: z.object({
    width: z.number().int().min(MIN_WIDTH).max(MAX_WIDTH),
    height: z.number().int().min(MIN_HEIGHT).max(MAX_HEIGHT),
  }).optional(),
  /** User-facing override channel. Framework-internal auto-expand does NOT
   *  write here (see pipeline.ts). Users who want to pin dimensions should
   *  use sizeTier='custom' + customDimensions. */
  overrides: z.object({
    dimensions: z.object({
      width: z.number().int(),
      height: z.number().int(),
    }).optional(),
    homePositions: z.array(z.object({
      x: z.number().int(),
      y: z.number().int(),
    })).optional(),
  }).default({}),
});

export const WorldGenConfigSchema = WorldGenConfigObjectSchema.refine(
  (cfg) => cfg.sizeTier !== 'custom' || !!cfg.customDimensions,
  { message: "sizeTier='custom' requires customDimensions" }
);

export type WorldGenConfig = z.infer<typeof WorldGenConfigSchema>;
