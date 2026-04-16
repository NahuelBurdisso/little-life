# Procedural World — Phase 1: Generator Framework

**Date:** 2026-04-16
**Status:** Design approved, pending implementation plan
**Scope:** Phase 1 of 5. Later phases (Settlement Layout, Terrain & Open Areas, Interior Variation, Naming) each ship as their own spec.

---

## 1. Purpose

Little Life's world today is hardcoded in `server/data/maps.ts` (public buildings at fixed pixel coords) and `server/data/interiors.ts` (identical grid per building type). Home count adapts to agent count, but positions sit in two fixed rows. There is no seed, no reproducibility, and no extension point for adding procedural variation to layout, terrain, or interiors.

Phase 1 builds the **framework** that later phases plug into: a deterministic, seeded, linear pipeline of pure-function stages; a wizard-exposed preview/regenerate UX; and one real generator (home placement) to validate the whole stack end-to-end.

By the end of Phase 1:
- Each run of the simulation can be reproduced from a seed string.
- The SetupWizard has a "World Layout" step with seed input, size tier, and a mini preview.
- Home positions vary per seed instead of sitting in two fixed rows.
- Phase 2–5 generators can be added by replacing stub stages without touching the framework.

---

## 2. Non-goals

- Building placement logic beyond homes (that's Phase 2).
- Terrain/biome generation, open-area variation (Phase 3).
- Interior grid variation per building (Phase 4).
- Procedural naming of businesses (Phase 5).
- Client-side pipeline execution, live-streaming stage updates, complex preview animation.
- Multi-biome maps, elevation, rivers beyond the hardcoded park tile.
- Save/share of seeds across projects (local worldState only).

---

## 3. Architecture

New module tree:

```
server/lib/worldgen/
  index.ts              # public: generateWorld(config, agentCount) → GenResult
  types.ts              # Stage, WorldContext, GenConfig, GenResult, FitError, TerrainTile
  rng.ts                # mulberry32 PRNG + string→seed hash + forkRng
  config.ts             # Zod WorldGenConfigSchema + defaults
  pipeline.ts           # orchestrator: runs stages in order, handles expand-on-fail
  stages/
    dimensions.ts       # real: size tier → width/height
    terrain.ts          # stub: returns empty terrainTiles (Phase 3 replaces)
    layout.ts           # stub: returns getPublicBuildings() positions
    homes.ts            # real: seeded home placement (Phase 1 demo)
    interiors.ts        # stub: returns INTERIOR_GRIDS[type] per building
    names.ts            # stub: returns hand-authored names from MAP_LOCATIONS
  __tests__/
    rng.test.ts
    dimensions.test.ts
    homes.test.ts
    pipeline.test.ts
    property.test.ts
```

Integration points:
- `server/routers/setup.ts` — `initialize` mutation calls `generateWorld(...)` in place of `generateLocationsForAgentCount(...)`. New `previewWorld` **mutation** calls the same function without persisting.
- `src/components/setup/` — new **World Layout** step file as a sibling of `AgentEditor.tsx`, `WorldSettings.tsx`, `SimulationPreview.tsx`. New `WorldPreview.tsx` sibling for the mini preview component. Wired into `SetupWizard.tsx` step ordering.

---

## 4. Pipeline contract

### 4.1 Linear stages

Stages run in fixed order defined by the pipeline array in `pipeline.ts` (that array is the single source of truth for ordering). Each stage receives a frozen `WorldContext` and a forked RNG; returns a partial that is merged into ctx:

```
1. dimensions   → { width, height }
2. terrain      → { terrainTiles }                          (stub)
3. layout       → { publicBuildings: LocationSeed[] }        (stub)
4. homes        → { homes: LocationSeed[] }                  (real, Phase 1)
5. interiors    → { interiors: Record<locId, InteriorData> } (stub)
6. names        → { names: Record<slot, string> }            (stub)
```

### 4.2 Stage type

```ts
// types.ts
export interface TerrainTile { // placeholder — Phase 3 may extend
  x: number;
  y: number;
  kind: string;
}

export interface WorldContext {
  dimensions: { width: number; height: number } | null;
  terrainTiles: TerrainTile[] | null;
  publicBuildings: LocationSeed[] | null;
  homes: LocationSeed[] | null;
  interiors: Record<number, InteriorData> | null;
  names: Record<string, string> | null;
}

export interface StageExtras {
  /** Agent configs from the wizard. Present when called from `initialize`;
   *  may be absent or synthesized from `previewAgentHomes` when called from
   *  `previewWorld` during wizard editing (see §8.3). Only stages that
   *  declare `needsAgents: true` receive this.
   *  The homes stage (§7.4) only reads `.homeName`; implementers may
   *  accept a narrower shape `Array<{ homeName: string }>` for preview
   *  where full AgentConfig isn't available. */
  agents?: Array<{ homeName: string } & Partial<AgentConfig>>;
  /** Framework-internal auto-expand pin. Injected by `runStages` ONLY
   *  when forwarding to the `dimensions` stage, never to other stages.
   *  When present, overrides all other dimension priority rules (§7.1). */
  expandPin?: { width: number; height: number };
}

export interface Stage<Output extends Partial<WorldContext>> {
  name: string;
  /** Sanity check asserted at pipeline module initialization (runtime, but
   *  before any stage runs). All listed fields must have been populated by
   *  earlier stages in the pipeline array. This is NOT TypeScript-enforced
   *  ordering — the fixed pipeline array in pipeline.ts is the source of
   *  truth; dependsOn only asserts that the chosen order is valid. */
  dependsOn: (keyof WorldContext)[];
  /** When true, the orchestrator injects `extras.agents` (or equivalent)
   *  into this stage's run. Framework owns which stages see agent data;
   *  agents remain opaque to generators that don't opt in. */
  needsAgents?: boolean;
  run(
    ctx: Readonly<WorldContext>,
    rng: RNG,
    cfg: WorldGenConfig,
    agentCount: number,
    extras: StageExtras,
  ): Output;
}
```

**Rules**:
- Pure function. No `Math.random` — use injected `rng`. No DB access. No mutating `ctx`.
- Return value replaces matching keys in ctx; cannot unset fields.
- Any stage may short-circuit by reading `cfg.overrides[stage.name]` (user-provided pin) and returning the pinned value after validation.
- The first stage in the pipeline (`dimensions`) has `dependsOn: []`. It runs first by position in the array; there is no separate "first stage" marker.

### 4.3 Pipeline orchestration

```ts
// pipeline.ts
const MAX_EXPAND_ATTEMPTS = 3;

export interface GenerateOptions {
  /** Agent configs (or narrowed home-name slice) if available. `initialize`
   *  always provides full configs. `previewWorld` provides them only while
   *  the user is past the Agents wizard step (see §8.3). */
  agents?: StageExtras['agents'];
}
// Note: a lower-bound on homeCount for the agents-absent preview case is
// carried on WorldGenConfig itself as `cfg.minHomeCountHint` (§6), not on
// `GenerateOptions`. Single channel, no duplication.

export function generateWorld(
  cfg: WorldGenConfig,
  agentCount: number,
  opts: GenerateOptions = {},
): GenResult {
  const seed = cfg.seed ?? randomBase62(8);

  // Transient expand state — NEVER written into cfg.overrides (which is
  // persisted into worldState.setup_config). Expand-driven dimension pins
  // live only for the lifetime of this call.
  let expandedDims: { width: number; height: number } | null = null;

  for (let attempt = 0; attempt < MAX_EXPAND_ATTEMPTS; attempt++) {
    try {
      return runStages({ ...cfg, seed }, agentCount, opts, expandedDims);
    } catch (e) {
      if (!(e instanceof FitError)) throw e;              // bugs propagate
      if (cfg.sizeTier === 'custom') throw e;             // respect user size
      const currentDims = expandedDims ?? peekBaseDimensions(cfg, agentCount);
      const grown = expandDimensions(currentDims, 1.2);
      if (grown.width === currentDims.width && grown.height === currentDims.height) {
        // clamp hit — further expansion is a no-op; abort now instead of wasting retries
        throw new Error('worldgen: dimensions cap reached, cannot fit content');
      }
      expandedDims = grown;
      console.warn(`[worldgen] expand attempt ${attempt + 1}: ${e.message}`);
    }
  }
  throw new Error('worldgen: dimensions cap reached, cannot fit content');
}

/** Evaluate the `dimensions` stage's priority chain (§7.1) WITHOUT any
 *  expand pin. Used by the expand loop to compute the first-attempt
 *  dimensions for cap comparison. Pure, no RNG. */
function peekBaseDimensions(cfg: WorldGenConfig, agentCount: number) {
  return dimensionsStage.run(
    { /* empty ctx */ } as any, null as any, cfg, agentCount, {}
  ).dimensions!;
}

/** Inside runStages, each stage call passes `extras = { agents: opts.agents }`
 *  only when `stage.needsAgents === true`. For stages with
 *  `needsAgents=false`, `extras` is `{}`. This threads `opts.agents` through
 *  the pipeline to stages that opt in (Phase 1: `homes`). */
```

Notes:
- The expand loop hands `expandedDims` into `runStages` via a parameter. Inside, the `dimensions` stage consults `expandedDims` before its normal priority chain (see §7.1). This keeps expansion data entirely internal to a single `generateWorld` call and prevents it from leaking into `cfg.overrides`, which IS persisted.
- Bounds: `expandDimensions` clamps width ≤ `MAX_WIDTH` and height ≤ `MAX_HEIGHT` (see §6.1). If both axes already equal the cap, the loop detects the fixed point and aborts immediately rather than consuming all 3 attempts.
- Non-`FitError` exceptions propagate unmodified — framework assumes they indicate bugs, not fit failures.
- Agents injection: for each stage, `runStages` builds `extras` per stage's opt-in flags. Concretely:
    - `extras.agents = opts.agents` iff `stage.needsAgents === true`.
    - `extras.expandPin = expandedDims` iff `stage.name === 'dimensions'` and `expandedDims !== null`. All other stages receive `extras.expandPin = undefined`.
    - Lower-bound for home count when `extras.agents` is absent lives on `cfg.minHomeCountHint` (§6), not on `extras`, so it flows naturally through the normal `cfg` argument.

### 4.4 FitError

```ts
export class FitError extends Error {
  constructor(public stage: string, public reason: string) {
    super(`[${stage}] ${reason}`);
  }
}
```

Thrown only when spatial constraints cannot be met. All other errors are bugs and propagate.

### 4.5 GenResult

```ts
export interface GenResult {
  seed: string;                             // master seed used (user or generated)
  dimensions: { width: number; height: number };
  locations: LocationSeed[];                // publicBuildings + homes, merged in order
  collisionGrid: string;                    // computed post-pipeline from locations
}
```

`collisionGrid` is computed once after all stages succeed by calling the existing `generateCollisionGridForLocations` helper on `locations`. It is not a stage output; it is a post-pipeline derivation.

---

## 5. Seeded RNG

### 5.1 Primitive

`mulberry32` — 32-bit PRNG. Deterministic, good enough for content generation (not cryptographic).

### 5.2 Seed derivation

```ts
// rng.ts
export function stringToSeed(s: string): number {
  // xmur3 hash → uint32
}

export function randomBase62(len: number): string { /* … */ }

export interface RNG {
  next(): number;                                    // [0, 1)
  int(min: number, max: number): number;             // inclusive
  pick<T>(arr: T[]): T;
  shuffle<T>(arr: T[]): T[];
  weightedPick<T>(opts: { item: T; weight: number }[]): T;
}

export function makeRng(seed: number): RNG { /* … */ }
export function forkRng(masterSeedStr: string, label: string): RNG {
  return makeRng(stringToSeed(`${masterSeedStr}:${label}`));
}
```

### 5.3 Per-stage fork

Every stage gets `forkRng(masterSeedStr, stage.name)`. Adding or reordering stages does not shift downstream random streams, so a given `(seed, stage)` pair always produces the same sequence across framework versions. Critical for reproducibility across minor framework changes.

### 5.4 Seed persistence and writeback

- Schema: `WorldGenConfigSchema.seed: z.string().optional()`.
- Pipeline: if absent, generates `randomBase62(8)` and returns it in `GenResult.seed`.
- Persistence inside `seedWorld(input)`:

  ```ts
  const result = generateWorld(
    input.worldgen,
    input.agents.length,
    { agents: input.agents },   // full agents → enables homes-stage maxReferenced rule
  );
  // Enrich input in place with the seed used. setup_config is inserted with
  // this enriched value, so restart reads back the exact same seed.
  input.worldgen = { ...input.worldgen, seed: result.seed };
  // … insert locations + worldState (which includes input as setup_config)
  ```

  `seedWorld` mutates the caller's `input` in place (consistent with the current implementation pattern). This keeps the writeback colocated with the DB insert.

- `restart` mutation: reads `worldState.setup_config`, re-parses with `SetupConfigSchema`, which now includes `worldgen.seed`. Same seed → identical `locations` (see §11 testing caveats for what else remains deterministic vs. not).

- `resetToWizard`: clears `worldState.setup_config`. Next `initialize` starts fresh.

### 5.5 Pre-Phase-1 config migration (backward compatibility)

Pre-Phase-1 saved configs (from running worlds that already exist in user databases before this spec is implemented) have no `worldgen` field. Schema default (`{ sizeTier: 'auto', overrides: {} }`) makes the parse succeed, but `worldgen.seed` is absent, so `generateWorld` generates a fresh random seed. Consequence: **the first `restart` after upgrading produces a different home layout from the pre-upgrade world.** All non-home state is preserved (agents, relationships, memories — those come from `config.agents`/`config.relationships`, not from the world generator).

This one-time shift is acceptable. The spec does not include a backfill migration because:
1. Pre-Phase-1 home layout was two fixed rows, which is visually recognizable but not simulation-significant — pathfinding still finds agents' homes by name.
2. After the first post-upgrade `initialize` or `restart`, the enriched config is written back with a seed; subsequent restarts are deterministic.
3. Building a backfill requires reverse-engineering the fixed-row layout into an equivalent seed, which is impossible without either pinning positions via `overrides.homePositions` or extending the schema with a legacy flag — both add complexity for a one-time event.

The implementation plan should add a release note capturing this behavior for any user with saved worlds.

---

## 6. Config schema

New schema, layered into existing `SetupConfigSchema`:

```ts
// config.ts
export const WorldGenConfigSchema = z.object({
  seed: z.string().optional(),
  sizeTier: z.enum(['small', 'medium', 'large', 'auto', 'custom']).default('auto'),
  customDimensions: z.object({
    width: z.number().int().min(20).max(200),
    height: z.number().int().min(15).max(200),
  }).optional(),
  /** User-facing override channel. Framework-internal auto-expand does NOT
   *  write here; see §4.3. Users who want to pin dimensions should use
   *  sizeTier='custom' + customDimensions. */
  overrides: z.object({
    dimensions: z.object({ width: z.number(), height: z.number() }).optional(),
    homePositions: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  }).default({}),
  /** Wizard-provided hint to keep preview home count aligned with initialize
   *  when the full agents[] list isn't threaded in (see §7.4 and §8.3).
   *  Computed client-side from the draft agent list. Persisted through
   *  worldgen config so restart preserves preview intent. */
  minHomeCountHint: z.number().int().min(0).optional(),
}).refine(
  (cfg) => cfg.sizeTier !== 'custom' || !!cfg.customDimensions,
  { message: "sizeTier='custom' requires customDimensions" }
);
```

### 6.1 Size tier → dimensions (tiles)

| Tier    | Width × Height                                                                   |
|---------|----------------------------------------------------------------------------------|
| small   | 40 × 30                                                                          |
| medium  | 60 × 45                                                                          |
| large   | 80 × 60                                                                          |
| auto    | `Math.min(Math.max(30 + Math.ceil(1.8 * N), MIN_WIDTH), MAX_WIDTH)` × `Math.min(Math.max(20 + Math.ceil(1.3 * N), MIN_HEIGHT), MAX_HEIGHT)` |
| custom  | `customDimensions`                                                               |

`N` = `agentCount`. Exported constants: `MIN_WIDTH = 40`, `MAX_WIDTH = 90`, `MIN_HEIGHT = 30`, `MAX_HEIGHT = 70`. Used by the `dimensions` stage, the expand-on-fail clamp, and wizard UI controls.

### 6.2 Integration with SetupConfigSchema

```ts
export const SetupConfigSchema = z.object({
  agents: ...,
  relationships: ...,
  world: WorldConfigSchema,
  rules: ...,
  worldgen: WorldGenConfigSchema,   // NEW
});
```

Defaults to `{ sizeTier: 'auto', overrides: {} }` so pre-Phase-1 saved configs parse; see §5.5 for migration semantics.

---

## 7. Stage implementations

### 7.1 `dimensions` stage (real)

Priority order, highest to lowest:

1. `extras.expandPin` (framework-internal auto-expand state, injected by `runStages` only for this stage — §4.3).
2. `cfg.overrides.dimensions` (user-pinned, persisted).
3. `cfg.sizeTier === 'custom'` → `cfg.customDimensions` (schema guarantees present).
4. `cfg.sizeTier` in `{ small, medium, large }` → preset from the §6.1 table.
5. `cfg.sizeTier === 'auto'` → formula from the §6.1 table.

Pure, no RNG. Never throws FitError (always produces dimensions).

### 7.2 `terrain` stage (stub)

Returns `{ terrainTiles: [] }`. Renderer keeps its current grass-texture background. Phase 3 replaces with biome generation. No RNG usage.

### 7.3 `layout` stage (stub)

Returns `{ publicBuildings: toLocationSeed(getPublicBuildings()) }` — the current 10 public buildings at their hardcoded positions. No RNG usage.

If `ctx.dimensions` is smaller than the bounding box of the hardcoded positions (`max(x + width)` and `max(y + height)` over all public buildings), throws `FitError('layout', 'map too small for hardcoded public buildings')`. Pipeline auto-expands and retries. Phase 2 replaces this stub with real placement.

### 7.4 `homes` stage (real — Phase 1 deliverable)

**Inputs**: `ctx.dimensions`, `ctx.publicBuildings`, `agentCount`, `extras.agents` (injected via `needsAgents: true` — see §4.3), optional `cfg.overrides.homePositions`, optional `cfg.minHomeCountHint` (carried from `previewWorld` input — see §8.3).

**Count formula** (preserves existing `seedWorld` contract for agent-to-home assignments):

```ts
const halfAgents = Math.ceil(agentCount / 2);

// Scan existing agent configs for references like "Home N" — preserve the
// same rule seedWorld uses today (see server/routers/setup.ts lines 175-179).
// If any agent's homeName field references a home number larger than
// halfAgents, the count grows to fit the largest index.
let maxReferenced = 0;
if (extras.agents) {
  // initialize path: agents array fully known.
  maxReferenced = extras.agents.reduce((max, a) => {
    const match = a.homeName.match(/Home (\d+)/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
} else if (cfg.minHomeCountHint !== undefined) {
  // previewWorld path: client precomputed the hint from its local agent
  // list (if user has reached/past the Agents wizard step). Treat hint as
  // a lower bound equivalent to `maxReferenced`.
  maxReferenced = cfg.minHomeCountHint;
}
// Neither available (preview before Agents step): use halfAgents alone.

const homeCount = Math.max(5, halfAgents, maxReferenced);
```

**Preview/initialize consistency**: to guarantee the preview renders the same home count the eventual `initialize` will produce, the wizard computes `minHomeCountHint` client-side from the current draft agent list (same `Home N` regex) and includes it in the `previewWorld` tRPC input. See §8.3.

**Algorithm**:
1. Compute `homeCount` as above.
2. Build blocked mask: all tiles covered by `publicBuildings` + 2-tile buffer + 1-tile map border on all sides.
3. Enumerate candidate top-left tile positions `(tx, ty)` where:
   - A 3×3 tile home footprint fits (no overlap with blocked mask).
   - `tx + 2 ≤ width - 2` — east edge of footprint stays inside the 1-tile map border.
   - `ty + 2 ≤ height - 2` — south edge of footprint stays inside the 1-tile map border.
   - `ty + 3 ≤ height - 1` — south door-approach tile (at row `ty + 3`) is within map bounds (automatically satisfied by the border predicate above; stated for clarity).
4. `rng.shuffle(candidates)` using `forkRng(seed, 'homes')`.
5. Greedy select until `homeCount` reached, rejecting any candidate whose footprint is within 2 tiles (Chebyshev distance) of an already-selected home.
6. If fewer than `homeCount` homes selected → `throw new FitError('homes', 'not enough spots for N homes')`. Orchestrator expands and retries.
7. Emit `LocationSeed` per home (shape must match existing `LocationSeed` — see `server/data/maps.ts:262`):

    ```ts
    {
      name: `Home ${i + 1}`,
      type: 'home',
      position: { x: tx * 32, y: ty * 32, width: 96, height: 96 },
      entry_point: { x: tx * 32 + 48, y: (ty + 3) * 32 },
      capacity: 2,
      current_occupants: [],
      operating_hours: null,          // homes have no hours
      services: getDefaultServices('home'),
      description: rng.pick(HOME_DESCRIPTIONS),  // reuse existing pool from maps.ts
      owner: null,
    }
    ```

**Override path** (`cfg.overrides.homePositions`):
- Length must equal `homeCount`. Mismatch → `FitError('homes', 'override length N does not match homeCount M')`.
- Each pinned position validated: footprint fits in `dimensions`, does not overlap `publicBuildings` + buffer, south approach tile within bounds.
- Validation failure → `FitError('homes', 'pinned position at (x,y) does not fit')`.
- On success: emit `LocationSeed[]` as above using the pinned positions; skip shuffle + greedy selection. RNG is still forked (for the `description` picks) so deterministic descriptions still hold.

#### 7.4.1 `homes` stage opt-ins

Declares `needsAgents: true` in its Stage definition (§4.2). At call time the orchestrator supplies `extras.agents` when available; the count formula above handles the absent case via `cfg.minHomeCountHint`. No change to `Stage.run` signature — the `extras` parameter is already defined in §4.2.

### 7.5 `interiors` stage (stub)

For each location in `publicBuildings ∪ homes`, returns `{ [locId]: { grid: INTERIOR_GRIDS[loc.type] ?? null } }`. Phase 4 replaces with per-building variation.

### 7.6 `names` stage (stub)

Returns `{ slot → displayName }` mapping — for homes: `'Home N'` → `'Home N'`; for public buildings: uses names from `MAP_LOCATIONS` (via `getPublicBuildings()`). Phase 5 replaces with seeded name generator.

---

## 8. SetupWizard integration

### 8.1 New step

Insert between Scenario and Agent Editor in `src/components/setup/SetupWizard.tsx`:

```
Preset → Scenario → World Layout [NEW] → Agents → Relationships → Review → Start
```

New file: `src/components/setup/WorldLayout.tsx`, structured like the existing step files (`AgentEditor.tsx`, `WorldSettings.tsx`, `SimulationPreview.tsx`).

### 8.2 Controls

| Control               | Bound to                    | Behavior                                                                                              |
|-----------------------|-----------------------------|-------------------------------------------------------------------------------------------------------|
| Seed input            | `worldgen.seed`             | Optional. Blank = fresh random per Regenerate click. Typed value pins seed across regenerates.        |
| Size tier select      | `worldgen.sizeTier`         | Small / Medium / Large / Auto / Custom                                                                |
| Custom w/h inputs     | `worldgen.customDimensions` | Shown only when tier=Custom. Min/max from §6.1 constants.                                             |
| Regenerate button     | —                           | On click: if seed is blank, generate a fresh client-side random string and set it; then call `setup.previewWorld` with current wizard config. |
| Preview canvas        | —                           | Displays `GenResult` as schematic. Updates on wizard field changes + Regenerate clicks.               |
| Copy seed             | —                           | Copies current `seed` to clipboard.                                                                   |

**React Query caching note**: because a fresh random seed is generated client-side before each blank-seed Regenerate click, the tRPC input changes per click, so React Query's default per-input cache naturally produces a fresh result. See §8.3 for the chosen tRPC verb.

### 8.3 tRPC additions

```ts
// server/routers/setup.ts
previewWorld: publicProcedure
  .input(WorldGenConfigSchema.extend({
    agentCount: z.number().int().min(1),
    // Optional — included when the wizard has draft agents with homeName
    // references. Keeps preview home count aligned with the eventual
    // initialize path (see §7.4).
    previewAgentHomes: z.array(z.object({ homeName: z.string() })).optional(),
  }))
  .mutation(({ input }) => {
    const { agentCount, previewAgentHomes, ...cfg } = input;
    return generateWorld(cfg, agentCount, { agents: previewAgentHomes as any });
  }),
```

**Verb choice: `mutation`, not `query`.** Reasons:
- Semantics are "compute and return"; idempotent w.r.t. inputs but not cached by React Query.
- If a user leaves `seed` blank, the server generates a new seed each call. A `query` would be aggressively cached by TanStack Query (same input key ⇒ cached result), causing Regenerate to no-op on the client.
- Using a mutation side-steps cache entirely. Standard tRPC pattern for "run a computation now, return result, no DB effect."

**Agents injection alignment**: the wizard passes `previewAgentHomes` — a minimal slice of draft agents containing only the `homeName` field — so the `homes` stage's count formula (§7.4) computes `maxReferenced` identically in preview and initialize. When the wizard step order has the user on the World Layout step *before* the Agents step (the default), `previewAgentHomes` is absent; the count formula falls back to `max(5, halfAgents)`. The wizard can also persist `minHomeCountHint` into the config as a belt-and-suspenders (§6 schema).

Called on wizard mount (with empty seed to get an initial preview) and on every Regenerate click.

### 8.4 `initialize` mutation changes

```ts
initialize: publicProcedure
  .input(SetupConfigSchema)
  .mutation(async ({ input }) => {
    clearAllTables();
    const result = seedWorld(input);
    return { ok: true, ...result };
  })
```

`seedWorld(input: SetupConfig): { agentCount: number; locationCount: number }` changes:

1. Call `generateWorld(input.worldgen, input.agents.length, { agents: input.agents })`. The third argument threads the agent list into the `homes` stage so the `maxReferenced` rule (§7.4) sees agent-to-home assignments at initialize time.
2. **Writeback**: `input.worldgen = { ...input.worldgen, seed: result.seed };` (mutation of `input` in place — consistent with existing pattern where `setup_config` is inserted as `config as any`).
3. Insert `result.locations` into `locations` table. Each location has its `services`, `operating_hours`, `current_occupants: []`, `owner: null` pre-filled by the `homes` stage (§7.4) and by the `layout` stub for public buildings. **Removes** the current `generateLocationsForAgentCount(...)` call and the `generateHomes(...)` / `getPublicBuildings()` separation in setup.ts lines 175-184.
4. Insert `worldState` with `map_width = result.dimensions.width`, `map_height = result.dimensions.height`, `collision_grid = result.collisionGrid`, `setup_config = input` (now includes the persisted seed).
5. Everything else in `seedWorld()` unchanged (needs, economy, relationships, backstory memories, templates, activity log).

### 8.5 Preview renderer

New React component: `src/components/setup/WorldPreview.tsx`.

- Renders into an HTML `<canvas>` (Canvas 2D API, not PixiJS — no need to mount a second engine in the wizard).
- Default size ~320×240 px, responsive to container.
- Input: `{ result: GenResult | null }` prop. Null → "Generating…" placeholder.
- Rendering:
  - Map background: solid dark earth (#2d2a24).
  - Public buildings: colored rects per type, 1–2 px labels using `ctx.font = '8px monospace'`.
  - Homes: smaller rects, numbered.
  - Entry points: tiny gold dots.
- Redraws synchronously on prop change. No animation loop.

### 8.6 Empty state

If `agentCount` is 0 (user skipped or hasn't reached Scenario step), preview shows: "Finish Scenario step to preview world." The Regenerate button is disabled.

---

## 9. Backward compatibility

### 9.1 Constants rename

`MAP_WIDTH` and `MAP_HEIGHT` in `server/data/maps.ts` renamed to `DEFAULT_MAP_WIDTH` and `DEFAULT_MAP_HEIGHT`. Used only by:

- The `medium` tier preset in `dimensions` stage.
- `setup.ts` `resetToWizard` mutation (placeholder worldState written when no setup has run).
- Tests and any fallback paths in renderers.

All runtime reads of map dimensions go through `worldState.map_width` / `worldState.map_height` (already the pattern). **Call-site audit** required during implementation — known importers:

- `server/routers/setup.ts` (initialize + resetToWizard).
- `server/data/maps.ts` (internal use in `generateCollisionGrid`).
- `server/db/seed.ts` (lines ~24, ~325–326) — imports both constants. Must be updated to either read from `worldState` or take dimensions as parameters.
- `src/components/canvas/TilemapRenderer.ts` — hardcodes `MAP_WIDTH_TILES = 60` / `MAP_HEIGHT_TILES = 45` locally (no import). Must be refactored to read from the loaded `worldState` (or receive dimensions via prop) so it does not render stale bounds on non-medium worlds.
- Any test that references `MAP_WIDTH` / `MAP_HEIGHT`.

Intentionally skipped during the audit: `scripts/generate-map-json.cjs` declares its own local constants (not imported from `maps.ts`); `data/maps/default.ts` is unreferenced dead code. The implementation plan must still include a grep pass to catch any additional importers before the rename lands.

`generateLocationsForAgentCount` stays in `maps.ts` and is called by the `layout` stub stage to source the hardcoded public buildings. No longer called from `setup.ts`.

### 9.2 Saved config migration

See §5.5 — pre-Phase-1 saved worlds generate a new random seed on first restart, producing a one-time home layout change. All other state preserved.

---

## 10. Failure handling

| Failure                                     | Handling                                                                                 |
|---------------------------------------------|------------------------------------------------------------------------------------------|
| Stage throws `FitError`                     | Orchestrator applies expand-on-fail (§4.3), up to 3 attempts.                            |
| Expand produces no-change (cap hit)         | Abort immediately with "dimensions cap reached" error. No further retries.               |
| Stage throws non-FitError                   | Propagates out of `generateWorld`, surfaces to tRPC error.                               |
| `sizeTier === 'custom'` + FitError          | No expansion; abort immediately. User chose exact size.                                  |
| `dependsOn` sanity-check violation          | Throws at pipeline module init, before any generation. Dev-visible.                      |
| Override validation fails                   | Stage throws `FitError` with a reason that references the override.                      |
| Zod schema validation fails at input        | tRPC returns validation error before pipeline starts.                                    |

All retries log at `warn`. Pipeline start/end log at `info` with seed, timing, final dimensions, final location count.

---

## 11. Testing

### 11.1 Unit tests

`server/lib/worldgen/__tests__/`:

- **`rng.test.ts`** (~6 tests): `stringToSeed` stable across runs; `mulberry32` distribution sanity; `forkRng` produces distinct streams for distinct labels; `forkRng` produces identical stream for same `(seed, label)`.
- **`dimensions.test.ts`** (~8 tests): each tier at agent counts 1/5/15/50; custom passes through; `overrides.dimensions` short-circuits; auto formula clamps at both MIN and MAX.
- **`homes.test.ts`** (~10 tests): determinism (same seed → same positions over 100 runs); no overlaps with public buildings; no overlaps between homes; 2-tile spacing honored; override path validates & returns verbatim; FitError raised when candidates exhausted; expand-retry produces larger map; home count matches `max(5, ceil(agents/2), maxReferenced)`; `minHomeCountHint` substitutes for agents when `extras.agents` absent; map-border predicate rejects footprints at `ty + 2 > height - 2` or `tx + 2 > width - 2`.
- **`pipeline.test.ts`** (~10 tests): stage order verified against the pipeline array; `dependsOn` mismatch throws at boot; FitError triggers expand; non-FitError propagates unmodified; expansion cap hit → clear error on first no-change; custom tier does not expand; `previewWorld`-style invocation does not persist; final `GenResult` shape complete; logs emitted at each boundary; `expandedDims` never leaks into `cfg.overrides`.

### 11.2 Property-based tests

`property.test.ts` — ~200 random seeds, `agents ∈ {5, 13, 30}`: `generateWorld` never throws beyond MAX_EXPAND; output invariants hold (no overlaps, correct home count, dimensions within `[MIN, MAX]`).

### 11.3 Integration test

Extend `server/__tests__/setup.test.ts` (or add `setupInitialize.test.ts`): calling `initialize` twice with same `worldgen.seed` produces identical **locations-table rows** (name, type, position, entry_point per row).

**Caveats the test must acknowledge:**
- Other tables (`needs`, `economy`) contain values derived from `Math.random()` in `seedWorld` (see setup.ts lines 289-320). Those rows remain non-deterministic by design and are excluded from the equality assertion.
- `worldState.last_tick_completed = Date.now()` — also excluded.
- The assertion scope is specifically `locations` and `worldState.{map_width, map_height, collision_grid, setup_config.worldgen.seed}`.

### 11.4 Existing tests

Existing test suite remains green. Affected files verified unchanged:
- `interiorGrid.test.ts` — unchanged (grids come from `INTERIOR_GRIDS` via stub stage).
- `pathfindingCost.test.ts` — unchanged.
- `setupGenerator.test.ts` — unchanged (drama generator independent).

### 11.5 Manual QA

1. Wizard → Size=Auto, seed blank → preview renders → Regenerate → layout changes.
2. Type seed `hello` → Regenerate → specific layout. Full page refresh + same seed input → identical layout on next Regenerate.
3. Size=Custom with 200×200 → preview renders large; auto-expand does not apply (verify by setting tiny `customDimensions` at a count that doesn't fit — should see hard abort with clear error).
4. Size=Small + 30 agents → FitError auto-expand → succeeds at larger-than-small dimensions; warning in console.
5. `initialize` → `restart` → identical world. `resetToWizard` → different world possible on next initialize.
6. Load a pre-Phase-1 saved world → confirm one-time layout shift on first restart (§5.5).

---

## 12. Rollout

1. Implement framework + stub stages + `dimensions` + `homes` + RNG + config. All unit + property tests pass.
2. Swap `setup.ts` `seedWorld` to use `generateWorld`. Integration tests pass. Existing suite still green.
3. Add `previewWorld` tRPC mutation + `WorldPreview` component + `WorldLayout` wizard step. Manual QA pass.
4. Document the §5.5 pre-Phase-1 migration behavior in the commit message and release notes.
5. Commit & merge. Memory entry logged.

Phase 2 begins with a new spec cycle following the same process.

---

## 13. Open questions

Closed after spec review pass.
