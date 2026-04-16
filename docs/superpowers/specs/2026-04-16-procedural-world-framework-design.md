# Procedural World — Phase 1: Generator Framework

**Date:** 2026-04-16
**Status:** Design approved, pending implementation plan
**Scope:** Phase 1 of 5. Later phases (Settlement Layout, Terrain & Open Areas, Interior Variation, Naming) each ship as their own spec.

---

## 1. Purpose

Little Life's world today is hardcoded in `server/data/maps.ts` (public buildings at fixed pixel coords) and `server/data/interiors.ts` (identical grid per building type). Home count adapts to agent count, but positions are two fixed rows. There is no seed, no reproducibility, and no extension point for adding procedural variation to layout, terrain, or interiors.

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
  types.ts              # Stage, WorldContext, GenConfig, GenResult, FitError
  rng.ts                # mulberry32 PRNG + string→seed hash + forkRng
  config.ts             # Zod WorldGenConfigSchema + defaults
  pipeline.ts           # orchestrator: runs stages in order, handles expand-on-fail
  stages/
    dimensions.ts       # real: size tier → width/height
    terrain.ts          # stub: returns empty terrainTiles (current behavior)
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

- `server/routers/setup.ts` — `initialize` mutation calls `generateWorld(...)` instead of `generateLocationsForAgentCount(...)`. New `previewWorld` query calls same function without persisting.
- `src/components/SetupWizard/*` — new **World Layout** step between Scenario and Agents.

---

## 4. Pipeline contract

### 4.1 Linear stages

Stages run in fixed order. Each receives a frozen `WorldContext` and a forked RNG; returns a partial that's merged into ctx:

```
1. dimensions   → { width, height }
2. terrain      → { terrainTiles }                          (stub)
3. layout       → { publicBuildings: LocationSeed[] }       (stub)
4. homes        → { homes: LocationSeed[] }                 (real, Phase 1)
5. interiors    → { interiors: Record<locId, InteriorData> } (stub)
6. names        → { names: Record<slot, string> }            (stub)
```

### 4.2 Stage type

```ts
// types.ts
export interface WorldContext {
  dimensions: { width: number; height: number } | null;
  terrainTiles: TerrainTile[] | null;
  publicBuildings: LocationSeed[] | null;
  homes: LocationSeed[] | null;
  interiors: Record<number, InteriorData> | null;
  names: Record<string, string> | null;
}

export interface Stage<Output extends Partial<WorldContext>> {
  name: string;
  dependsOn: (keyof WorldContext)[];
  run(
    ctx: Readonly<WorldContext>,
    rng: RNG,
    cfg: WorldGenConfig,
    agentCount: number,
  ): Output;
}
```

**Rules**:
- Pure function. No `Math.random` — use injected `rng`. No DB access. No mutating `ctx`.
- Return value replaces matching keys in ctx; cannot unset fields.
- `dependsOn` statically checked at pipeline boot (all declared dependencies must be populated by earlier stages). Misconfiguration fails fast, not at runtime.
- Stage may read `cfg.overrides[stage.name]` and short-circuit its own logic, returning the pinned value (validated first).

### 4.3 Pipeline orchestration

```ts
// pipeline.ts
export function generateWorld(cfg: WorldGenConfig, agentCount: number): GenResult {
  const seed = cfg.seed ?? randomBase62(8);
  let currentCfg = { ...cfg, seed };

  for (let attempt = 0; attempt < MAX_EXPAND_ATTEMPTS; attempt++) {
    try {
      return runStages(currentCfg, agentCount);
    } catch (e) {
      if (!(e instanceof FitError)) throw e;              // bugs propagate
      if (currentCfg.sizeTier === 'custom') throw e;      // respect user size
      currentCfg = expandDimensions(currentCfg, 1.2);
      console.warn(`[worldgen] expand attempt ${attempt + 1}: ${e.message}`);
    }
  }
  throw new Error('worldgen: dimensions cap reached, cannot fit content');
}
```

`MAX_EXPAND_ATTEMPTS = 3`. Expansion writes back into `cfg.overrides.dimensions` so the `dimensions` stage short-circuits on next attempt. `expandDimensions` clamps at each tier's upper bound.

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
  locations: LocationSeed[];                // publicBuildings + homes, merged
  collisionGrid: string;                    // computed post-pipeline from locations
}
```

`collisionGrid` is computed once after all stages succeed, by calling the existing `generateCollisionGridForLocations` helper on `locations`. It is not a stage output; it is a derivation.

---

## 5. Seeded RNG

### 5.1 Primitive

`mulberry32` — 32-bit PRNG. Deterministic, 4 lines, good enough for content generation.

### 5.2 Seed derivation

```ts
// rng.ts
export function stringToSeed(s: string): number {
  // xmur3 hash → uint32
}

export function randomBase62(len: number): string { ... }

export interface RNG {
  next(): number;                                    // [0, 1)
  int(min: number, max: number): number;             // inclusive
  pick<T>(arr: T[]): T;
  shuffle<T>(arr: T[]): T[];
  weightedPick<T>(opts: { item: T; weight: number }[]): T;
}

export function makeRng(seed: number): RNG { ... }
export function forkRng(masterSeed: number, label: string): RNG {
  return makeRng(stringToSeed(`${masterSeed}:${label}`));
}
```

### 5.3 Per-stage fork

Every stage gets `forkRng(masterSeed, stage.name)`. Adding or reordering stages does not shift downstream random streams, so a given `(seed, stage)` pair always produces the same sequence across framework versions. Critical for reproducibility.

### 5.4 Seed persistence

- Schema: `WorldGenConfigSchema.seed: z.string().optional()`.
- Pipeline: if absent, generates `randomBase62(8)` and returns it in `GenResult.seed`.
- Persistence: `seedWorld()` writes `genResult.seed` into `worldState.setup_config.worldgen.seed` before DB insert. Restart reads it back, guaranteeing identical world.
- Reset to Wizard: clears `worldState.setup_config`, so next initialize starts fresh.

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
  overrides: z.object({
    dimensions: z.object({ width: z.number(), height: z.number() }).optional(),
    homePositions: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
    // later phases add entries here
  }).default({}),
});
```

Cross-field validation: when `sizeTier === 'custom'`, `customDimensions` must be present. Enforced with a `.refine`.

### 6.1 Size tier → dimensions (tiles)

| Tier    | Width × Height                              |
|---------|---------------------------------------------|
| small   | 40 × 30                                     |
| medium  | 60 × 45                                     |
| large   | 80 × 60                                     |
| auto    | `clamp(30 + ⌈1.8·N⌉, 40, 90) × clamp(20 + ⌈1.3·N⌉, 30, 70)` |
| custom  | `customDimensions`                          |

`N` = agentCount. Constants `MIN_WIDTH=40, MAX_WIDTH=90, MIN_HEIGHT=30, MAX_HEIGHT=70` exported for UI & tests.

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

Defaults to `{ sizeTier: 'auto', overrides: {} }` so saved pre-Phase-1 configs still parse.

---

## 7. Stage implementations

### 7.1 `dimensions` stage (real)

- Priority: `overrides.dimensions` > `sizeTier === 'custom'` > tier preset > `auto` formula.
- Pure, no RNG usage.
- Never throws FitError (upstream source of truth for size).

### 7.2 `terrain` stage (stub)

- Returns `{ terrainTiles: [] }` — no per-tile terrain data today. Renderer keeps its current grass-texture background.
- No RNG usage. Phase 3 replaces with a biome generator.

### 7.3 `layout` stage (stub)

- Returns `{ publicBuildings: getPublicBuildings().map(toLocationSeed) }` — current 10 public buildings at their hardcoded positions.
- No RNG usage.
- If `ctx.dimensions` is smaller than the bounding box of hardcoded positions (e.g., `small` tier), throws FitError → pipeline expands. Phase 2 replaces with real placement.

### 7.4 `homes` stage (real — Phase 1 deliverable)

Inputs: `dimensions`, `publicBuildings`, `agentCount`, optional `overrides.homePositions`.

**Algorithm**:
1. `homeCount = max(5, ⌈agentCount / 2⌉)`.
2. Build blocked mask: all tiles covered by public buildings + 2-tile buffer + 1-tile map border.
3. Enumerate candidate top-left positions `(tx, ty)` where a 3×3 tile home footprint fits (no overlap with blocked mask) AND the tile south of the footprint is free (for door approach).
4. `rng.shuffle(candidates)`.
5. Greedy-select until `homeCount` reached, rejecting candidates within 2 tiles of an already-selected home (spacing rule).
6. If fewer than `homeCount` selected → `throw new FitError('homes', 'not enough spots')`. Orchestrator expands and retries.
7. Emit `LocationSeed` per home:
   - `name: 'Home N'` (counter, real naming in Phase 5)
   - `type: 'home'`
   - `position: { x: tx*32, y: ty*32, width: 96, height: 96 }`
   - `entry_point: { x: tx*32 + 48, y: (ty+3)*32 }` (south-center)
   - `capacity: 2`, `operating_hours: null`, `services: home services`
   - `description` from a pool (hardcoded list in `homes.ts` for Phase 1; Phase 5 generates names + descriptions together)

**Override path** (`cfg.overrides.homePositions`):
- Validate each position fits (not overlapping public buildings, not out of bounds).
- Length must match `homeCount`. Mismatch → FitError with clear reason.
- Return positions verbatim; skip RNG path.

### 7.5 `interiors` stage (stub)

- For each location in `publicBuildings ∪ homes`, return `{ [locId]: { grid: INTERIOR_GRIDS[type] ?? null } }`.
- Phase 4 replaces with per-building variation.

### 7.6 `names` stage (stub)

- Merges hand-authored names from `MAP_LOCATIONS` with home counters. Returns `{ slot → displayName }`.
- Phase 5 replaces with seeded generator.

---

## 8. SetupWizard integration

### 8.1 New step: World Layout

Insert between Scenario and Agents:

```
Scenario → World Layout → Agents → Relationships → Review → Start
```

### 8.2 Controls

| Control               | Bound to                    | Behavior                                                                                      |
|-----------------------|-----------------------------|-----------------------------------------------------------------------------------------------|
| Seed input            | `worldgen.seed`             | Optional. Blank = random per regenerate click. Typed value pins seed.                         |
| Size tier select      | `worldgen.sizeTier`         | Small / Medium / Large / Auto / Custom                                                        |
| Custom w/h inputs     | `worldgen.customDimensions` | Shown only when tier=Custom. Validated against min/max.                                       |
| 🎲 Regenerate button  | —                           | Calls `tRPC setup.previewWorld` with current config. Assigns blank seed to new random string. |
| Preview canvas        | —                           | Displays `GenResult` as schematic. Updates on wizard field changes + Regenerate clicks.       |
| Copy seed             | —                           | Copies current `seed` to clipboard.                                                           |

### 8.3 tRPC additions

```ts
// setup router
previewWorld: publicProcedure
  .input(WorldGenConfigSchema.extend({ agentCount: z.number().int().min(1) }))
  .query(({ input }) => {
    const { agentCount, ...cfg } = input;
    return generateWorld(cfg, agentCount);
  }),
```

Read-only query (no DB side-effects). Invoked on wizard mount + every Regenerate click.

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

`seedWorld()` now:
1. Calls `generateWorld(input.worldgen, input.agents.length)`.
2. Assigns `input.worldgen.seed = result.seed` (captures generated seed).
3. Inserts `result.locations` into `locations` table (replacing `dynamicLocations` derivation).
4. Inserts `worldState` with `map_width = result.dimensions.width`, `map_height = result.dimensions.height`, `collision_grid = result.collisionGrid`, and `setup_config = input` (now includes persisted seed).
5. Everything else in `seedWorld()` unchanged.

### 8.5 Preview renderer

- A new React component: `src/components/SetupWizard/WorldPreview.tsx`.
- Uses HTML Canvas 2D (not PixiJS — no need to mount a second engine).
- Renders at ~320×240 px from `GenResult`:
  - Map background: solid dark earth (#2d2a24).
  - Public buildings: colored rects per type, 1–2 px labels.
  - Homes: smaller rects, numbered.
  - Entry points: tiny gold dots.
- Redraws on prop change. Light (< 1 ms per redraw).

### 8.6 Empty state

If `agentCount` hasn't been set yet (user still on Scenario step), preview shows: "Finish Scenario step to preview world." The Regenerate button is disabled.

---

## 9. Backward compatibility

- `MAP_WIDTH` / `MAP_HEIGHT` constants renamed to `DEFAULT_MAP_WIDTH` / `DEFAULT_MAP_HEIGHT`, used only by the `medium` tier preset and for fallback in early-boot code paths.
- Runtime reads dimensions from `worldState.map_width/height` (already the pattern).
- `generateLocationsForAgentCount` stays in `maps.ts` for use by the `layout` stub stage and `setupGenerator` drama preview, but is no longer called from `setup.ts`.
- Existing saved configs (from pre-Phase-1 wizard runs) parse cleanly thanks to `worldgen` default. On restart, the config object gains a seed on first new-seed initialize.

---

## 10. Failure handling

| Failure                              | Handling                                                         |
|--------------------------------------|------------------------------------------------------------------|
| Stage throws `FitError`              | Orchestrator expands dimensions by 20%, retries up to 3 times.    |
| Stage throws non-FitError (bug)      | Propagates out of `generateWorld`, surfaces to tRPC error.        |
| `sizeTier === 'custom'` + FitError   | No expansion; aborts. User chose exact size, framework respects it. |
| Expansion cap reached                | Throws `Error('worldgen: dimensions cap reached, cannot fit content')`. Wizard shows error, user adjusts. |
| `dependsOn` violation                | Throws at pipeline boot (before first stage runs). Dev-visible.   |
| Override validation fails            | Throws `FitError` with reason referencing the override.           |
| Zod schema validation fails at input | tRPC returns validation error before pipeline starts.             |

All retries log at `warn`. Pipeline start/end log at `info` with seed, timing, final dimensions, final location count.

---

## 11. Testing

### 11.1 Unit tests

`server/lib/worldgen/__tests__/`:

- **`rng.test.ts`** (~6 tests): `stringToSeed` stable across runs; `mulberry32` distribution sanity; `forkRng` produces distinct streams for distinct labels, identical stream for same `(seed, label)`.
- **`dimensions.test.ts`** (~8 tests): each tier at agent counts 1/5/15/50; custom passes through; overrides short-circuit; auto formula clamps at MIN / MAX bounds.
- **`homes.test.ts`** (~10 tests): determinism (100 same-seed runs identical); no overlaps with public buildings; no overlaps between homes; 2-tile spacing honored; override path validates & returns verbatim; FitError raised when candidates exhausted; expand-retry produces larger map; home count matches `max(5, ceil(agents/2))`.
- **`pipeline.test.ts`** (~8 tests): stage order verified; `dependsOn` mismatch throws at boot; FitError triggers expand; non-FitError propagates; expansion cap hit → clear error; `custom` tier does not expand; final `GenResult` shape complete; logs emitted at each boundary.

### 11.2 Property-based tests

`property.test.ts` — ~200 random seeds, `agents ∈ {5, 13, 30}`: `generateWorld` never throws beyond MAX_EXPAND; output invariants (no overlaps, homes count correct, dimensions within `[MIN, MAX]`).

### 11.3 Integration test

Extend `server/__tests__/setup.test.ts` (or new `setupInitialize.test.ts`): calling `initialize` twice with same `worldgen.seed` produces identical `locations` rows in SQLite.

### 11.4 Existing tests

All 333 existing tests remain green. Affected files:
- `interiorGrid.test.ts` — unchanged (grids still come from `INTERIOR_GRIDS` via stub stage).
- `pathfindingCost.test.ts` — unchanged.
- `setupGenerator.test.ts` — unchanged (drama generator independent).

### 11.5 Manual QA

1. Wizard → Size=Auto, seed blank → preview renders → Regenerate → layout changes.
2. Type seed `hello` → Regenerate → specific layout. Full page refresh + same seed → identical layout.
3. Size=Custom with 200×200 → preview renders large; auto-expand does not apply.
4. Size=Small + 30 agents → FitError auto-expand → succeeds at larger-than-small dimensions; warning in console.
5. `initialize` → `restart` → identical world. `resetToWizard` → different world possible on next initialize.

---

## 12. Rollout

1. Implement framework + stub stages + `dimensions` + `homes` (no wizard changes yet). All tests pass. `initialize` still works via a temporary call path.
2. Swap `setup.ts` `seedWorld` to use `generateWorld`. Integration tests pass.
3. Add `previewWorld` tRPC query + `WorldPreview` component + World Layout wizard step. Manual QA pass.
4. Commit & merge. Memory entry logged.

Phase 2 kickoff begins with a new spec following this same process.

---

## 13. Open questions

None — all brainstorming questions resolved. Implementation plan follows in a companion document.
