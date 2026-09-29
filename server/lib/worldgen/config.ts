import { z } from 'zod';

// Exported constants — see spec §6.1 for rationale.
// MIN values sized for proportional road grid + largest core building (town_square 9×8).
// MAX values cap auto-growth for performance + visual sanity.
/** Tile size in pixels — single source of truth for all worldgen stages. */
export const TILE = 32;

/**
 * Spacing constants shared by every placement stage. These used to be private to
 * `layout.ts`, which let `homes.ts` drift to a 1-tile border and violate the
 * 2-tile rule in most seeds, and let `roads.ts` derive zone bounds that included
 * permanently-blocked road-buffer tiles.
 */
/** Clear tiles reserved around every building footprint. */
export const BUILDING_GAP = 2;
/** Clear tiles reserved either side of a road. */
export const ROAD_BUFFER = 1;
/** Minimum clear tiles between any building and the map edge. */
export const BORDER_BUFFER = 2;

/**
 * Hard cap on how many agents a world may be generated for. Lives here rather
 * than in the wizard so the server can enforce it too — `setup.previewWorld` is
 * a public procedure and took an unbounded count.
 */
export const MAX_AGENTS = 32;

export const MIN_WIDTH = 56;
export const MAX_WIDTH = 90;
export const MIN_HEIGHT = 43;
export const MAX_HEIGHT = 70;

/**
 * Base size each fixed `sizeTier` resolves to, in tiles.
 *
 * Single source of truth: these numbers were written out three times — here in
 * `dimensions.ts`'s priority-4 branch, in a private `TIER_DIMENSIONS` in
 * `WorldLayout.tsx`, and again in that file's `<option>` labels — so changing a
 * tier meant the dropdown could go on advertising the old size.
 *
 * This is the size before the pipeline's auto-expand ladder, which still grows a
 * tier when the content does not fit. `WorldLayout` compares it against the
 * generated size to tell the user when that happened.
 */
export const TIER_DIMENSIONS = {
  medium: { width: 60, height: 45 },
  large: { width: 80, height: 60 },
} as const;

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
   *  write here (see pipeline.ts).
   *
   *  `overrides.dimensions` is a *base size*, not a hard pin: `pipeline.ts`
   *  exempts only `sizeTier: 'custom'` from the auto-expand ladder, so a size
   *  set here is still grown when the content does not fit. Users who want a
   *  size the generator may not grow must use sizeTier='custom' +
   *  customDimensions. */
  overrides: z.object({
    /** Bounded exactly like `customDimensions`. Unbounded, this reached the
     *  public `setup.previewWorld` mutation: {400,400} was accepted and built a
     *  160,000-tile collision grid, ~25× the 90×70 cap. */
    dimensions: z.object({
      width: z.number().int().min(MIN_WIDTH).max(MAX_WIDTH),
      height: z.number().int().min(MIN_HEIGHT).max(MAX_HEIGHT),
    }).optional(),
    homePositions: z.array(z.object({
      x: z.number().int(),
      y: z.number().int(),
    })).optional(),
  }).default({}),
  /** Assign `Home N` labels to the chosen plots from the relationship graph
   *  (rivals near, secret lovers apart — see `social.ts`). Plot selection is the
   *  same either way; `false` keeps labels in selection order. Only has an
   *  effect when the caller passes `GenerateOptions.social`. */
  socialPlacement: z.boolean().default(true),
  /** Road network style. `grid` is the fixed two-by-two street grid every town
   *  had before; `organic` grows lanes from settlement seeds on an interest map
   *  (see `stages/organicRoads.ts`), so every seed gives a different town shape.
   *  Defaults to `grid` so configs saved before the option existed rebuild the
   *  same town. */
  layoutStyle: z.enum(['grid', 'organic']).default('grid'),
});

export const WorldGenConfigSchema = WorldGenConfigObjectSchema.refine(
  (cfg) => cfg.sizeTier !== 'custom' || !!cfg.customDimensions,
  { message: "sizeTier='custom' requires customDimensions" }
);

/**
 * `socialPlacement` is optional on the type even though the schema defaults it:
 * every parsed config carries it, but worldgen is also driven directly with
 * hand-built literals (db/seed.ts, seed-world.ts, the whole test suite), and a
 * required field would break all of them for a flag whose absence already has a
 * meaning. Readers treat anything but an explicit `false` as on.
 *
 * `layoutStyle` is optional for the same reason; readers treat anything but an
 * explicit `'organic'` as the grid.
 */
export type WorldGenConfig =
  Omit<z.infer<typeof WorldGenConfigSchema>, 'socialPlacement' | 'layoutStyle'> & {
    socialPlacement?: boolean;
    layoutStyle?: LayoutStyle;
  };

export type LayoutStyle = 'grid' | 'organic';
