# Procedural World — Phase 1: Generator Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a seeded, deterministic world-generation pipeline with a home-placement generator, SetupWizard preview UI, and refactor `MAP_WIDTH/MAP_HEIGHT` constants out of direct imports — per the approved spec at `docs/superpowers/specs/2026-04-16-procedural-world-framework-design.md`.

**Architecture:** A new `server/lib/worldgen/` module hosts a linear pipeline of pure-function stages. Each stage takes a frozen context + forked RNG + config and returns a partial. The `dimensions` and `homes` stages are real; the other four are stubs that return today's hardcoded data so Phases 2–5 can swap them in without touching the framework. The SetupWizard gains a "World Layout" step that calls a new `previewWorld` tRPC mutation. Runtime code reads map dimensions from `worldState` instead of a compile-time constant.

**Tech Stack:** TypeScript, Zod, tRPC, Drizzle (SQLite), React 19, Vitest, PIXI.js 8.

**Reference spec:** `docs/superpowers/specs/2026-04-16-procedural-world-framework-design.md` (read this first if unclear on any task).

---

## File Structure

### New files
| Path | Responsibility |
|---|---|
| `server/lib/worldgen/rng.ts` | mulberry32 PRNG, stringToSeed, randomBase62, makeRng, forkRng |
| `server/lib/worldgen/types.ts` | WorldContext, StageExtras, Stage, FitError, InteriorData, TerrainTile, GenResult, GenerateOptions |
| `server/lib/worldgen/config.ts` | MIN/MAX constants + WorldGenConfigSchema (Zod) |
| `server/lib/worldgen/pipeline.ts` | generateWorld, runStages, expandDimensions, peekBaseDimensions, MAX_EXPAND_ATTEMPTS, PIPELINE (ordered Stage array) |
| `server/lib/worldgen/index.ts` | Public re-exports (generateWorld, types, schema) |
| `server/lib/worldgen/stages/dimensions.ts` | Real dimensions stage |
| `server/lib/worldgen/stages/terrain.ts` | Stub |
| `server/lib/worldgen/stages/layout.ts` | Stub (calls getPublicBuildings) |
| `server/lib/worldgen/stages/homes.ts` | Real seeded home placement |
| `server/lib/worldgen/stages/interiors.ts` | Stub (returns INTERIOR_GRIDS lookup) |
| `server/lib/worldgen/stages/names.ts` | Stub |
| `server/lib/worldgen/__tests__/rng.test.ts` | RNG unit tests |
| `server/lib/worldgen/__tests__/dimensions.test.ts` | Dimensions stage tests |
| `server/lib/worldgen/__tests__/homes.test.ts` | Homes stage tests |
| `server/lib/worldgen/__tests__/pipeline.test.ts` | Pipeline integration tests |
| `server/lib/worldgen/__tests__/property.test.ts` | Property-based tests |
| `server/__tests__/setupInitialize.test.ts` | DB-level determinism integration test |
| `src/components/setup/WorldLayout.tsx` | New wizard step component |
| `src/components/setup/WorldPreview.tsx` | Canvas 2D schematic preview |

### Modified files
| Path | Changes |
|---|---|
| `server/data/maps.ts` | Rename `MAP_WIDTH/MAP_HEIGHT` → `DEFAULT_MAP_WIDTH/DEFAULT_MAP_HEIGHT`; keep `generateLocationsForAgentCount` intact (used by layout stub). |
| `server/db/seed.ts` | Update imports + references to renamed constants. |
| `server/routers/setup.ts` | Import worldgen module; extend `SetupConfigSchema` with `worldgen` field; refactor `seedWorld` to call `generateWorld`; add `previewWorld` mutation; update `resetToWizard` to use renamed constants. |
| `src/components/setup/types.ts` | Add `WorldGenConfig` type mirroring Zod schema; extend `SetupConfig` with `worldgen`; add default. |
| `src/components/setup/SetupWizard.tsx` | Insert `worldlayout` step between `preview` and `agents`; wire `worldgen` state; pass `worldgen` to `initMutation`. |
| `src/components/canvas/TilemapRenderer.ts` | Remove hardcoded `MAP_WIDTH_TILES/MAP_HEIGHT_TILES`; add `resize(w, h)` method; constructor starts at 0×0. |
| `src/components/canvas/GameCanvas.tsx` | Add `useEffect` that calls `tilemap.resize(...)` when worldState dimensions change; re-run `camera.setMapSize(...)` inside same effect. |

---

## Milestone 1 — Core framework primitives (RNG, types, config)

### Task 1: Seeded RNG module

**Files:**
- Create: `server/lib/worldgen/rng.ts`
- Create: `server/lib/worldgen/__tests__/rng.test.ts`

- [ ] **Step 1.1: Write failing tests**

Create `server/lib/worldgen/__tests__/rng.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stringToSeed, makeRng, forkRng, randomBase62 } from '../rng';

describe('stringToSeed', () => {
  it('is stable across calls for the same input', () => {
    expect(stringToSeed('hello')).toBe(stringToSeed('hello'));
  });

  it('produces different seeds for different inputs', () => {
    expect(stringToSeed('hello')).not.toBe(stringToSeed('world'));
  });

  it('returns a 32-bit unsigned integer', () => {
    const seed = stringToSeed('abc');
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 32);
  });
});

describe('makeRng / mulberry32', () => {
  it('produces deterministic sequences from the same seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('int(min, max) returns inclusive integers', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 100; i++) {
      const n = rng.int(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('shuffle preserves elements', () => {
    const rng = makeRng(1);
    const src = [1, 2, 3, 4, 5];
    const shuffled = rng.shuffle(src);
    expect([...shuffled].sort()).toEqual(src);
    expect(src).toEqual([1, 2, 3, 4, 5]); // original untouched
  });

  it('pick selects an element of the input', () => {
    const rng = makeRng(1);
    const choices = ['a', 'b', 'c'];
    const picked = rng.pick(choices);
    expect(choices).toContain(picked);
  });
});

describe('forkRng', () => {
  it('produces identical streams for the same (seed, label)', () => {
    const a = forkRng('master', 'homes');
    const b = forkRng('master', 'homes');
    expect(a.next()).toBe(b.next());
    expect(a.next()).toBe(b.next());
  });

  it('produces different streams for different labels', () => {
    const a = forkRng('master', 'homes');
    const b = forkRng('master', 'roads');
    expect(a.next()).not.toBe(b.next());
  });

  it('produces different streams for different master seeds', () => {
    const a = forkRng('alpha', 'homes');
    const b = forkRng('beta', 'homes');
    expect(a.next()).not.toBe(b.next());
  });
});

describe('randomBase62', () => {
  it('returns a string of the requested length', () => {
    expect(randomBase62(8)).toHaveLength(8);
    expect(randomBase62(16)).toHaveLength(16);
  });

  it('uses only base62 chars [0-9A-Za-z]', () => {
    expect(randomBase62(64)).toMatch(/^[0-9A-Za-z]+$/);
  });
});
```

- [ ] **Step 1.2: Run the tests to confirm they fail**

Run: `cd /d/proyects/little-life && npx vitest run server/lib/worldgen/__tests__/rng.test.ts`
Expected: FAIL — "Cannot find module '../rng'".

- [ ] **Step 1.3: Implement `rng.ts`**

Create `server/lib/worldgen/rng.ts`:

```ts
/**
 * Seeded PRNG for deterministic world generation.
 * Not cryptographically secure — content generation only.
 */

/** xmur3 string hash → uint32 seed. Stable across Node versions. */
export function stringToSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export interface RNG {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Pick a uniform random element. Throws on empty array. */
  pick<T>(arr: readonly T[]): T;
  /** Return a new array that's a uniform random permutation of `arr`. */
  shuffle<T>(arr: readonly T[]): T[];
  /** Pick an element weighted by each item's `weight` (must be > 0). */
  weightedPick<T>(opts: ReadonlyArray<{ item: T; weight: number }>): T;
}

/** mulberry32 PRNG. Deterministic from a uint32 seed. */
export function makeRng(seed: number): RNG {
  let state = seed >>> 0;
  function next(): number {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    int(min: number, max: number): number {
      if (max < min) throw new Error(`RNG.int: max (${max}) < min (${min})`);
      return Math.floor(next() * (max - min + 1)) + min;
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error('RNG.pick: empty array');
      return arr[Math.floor(next() * arr.length)];
    },
    shuffle<T>(arr: readonly T[]): T[] {
      const copy = arr.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    weightedPick<T>(opts: ReadonlyArray<{ item: T; weight: number }>): T {
      if (opts.length === 0) throw new Error('RNG.weightedPick: empty array');
      const total = opts.reduce((s, o) => s + o.weight, 0);
      if (total <= 0) throw new Error('RNG.weightedPick: non-positive total weight');
      let r = next() * total;
      for (const o of opts) {
        r -= o.weight;
        if (r <= 0) return o.item;
      }
      return opts[opts.length - 1].item;
    },
  };
}

/** Fork an RNG by master seed + label. Stages use forkRng(masterSeedStr, stage.name). */
export function forkRng(masterSeedStr: string, label: string): RNG {
  return makeRng(stringToSeed(`${masterSeedStr}:${label}`));
}

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Generate a random base62 string of the given length (uses Math.random,
 *  not seeded — this is what we use to generate a master seed when none is
 *  provided). */
export function randomBase62(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += BASE62_ALPHABET[Math.floor(Math.random() * BASE62_ALPHABET.length)];
  }
  return out;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `cd /d/proyects/little-life && npx vitest run server/lib/worldgen/__tests__/rng.test.ts`
Expected: PASS (all cases).

- [ ] **Step 1.5: Commit**

```bash
cd /d/proyects/little-life
git add server/lib/worldgen/rng.ts server/lib/worldgen/__tests__/rng.test.ts
git commit -m "feat(worldgen): seeded RNG primitive"
```

---

### Task 2: Worldgen types module

**Files:**
- Create: `server/lib/worldgen/types.ts`

- [ ] **Step 2.1: Implement `types.ts`**

Create `server/lib/worldgen/types.ts`:

```ts
import type { LocationSeed } from '../../data/maps';
import type { AgentConfig } from '../../../src/components/setup/types';
import type { RNG } from './rng';

/** Phase 3 may extend. Placeholder for Phase 1. */
export interface TerrainTile {
  x: number;
  y: number;
  kind: string;
}

/** Phase 4 may extend. Placeholder for Phase 1. */
export interface InteriorData {
  /** Cell codes per INTERIOR_GRIDS convention (1=wall, 2=furniture, 3=door, 0=floor),
   *  or null for buildings without an interior grid (homes, open areas). */
  grid: number[][] | null;
}

/** Mutable during pipeline execution; fields are filled in by each stage. */
export interface WorldContext {
  dimensions: { width: number; height: number } | null;
  terrainTiles: TerrainTile[] | null;
  publicBuildings: LocationSeed[] | null;
  homes: LocationSeed[] | null;
  interiors: Record<number, InteriorData> | null;
  names: Record<string, string> | null;
}

/** Data passed to stages beyond ctx/rng/cfg/agentCount. The framework owns
 *  what goes in here; stages opt in via Stage.needsAgents etc. */
export interface StageExtras {
  /** Agent configs from the wizard. The homes stage (§7.4 of spec) only
   *  reads .homeName, so a narrowed Array<{ homeName: string }> is acceptable. */
  agents?: Array<{ homeName: string } & Partial<AgentConfig>>;
  /** Framework-internal auto-expand pin. Injected by runStages ONLY when
   *  forwarding to the `dimensions` stage. Overrides all priority rules. */
  expandPin?: { width: number; height: number };
}

export interface Stage<Output extends Partial<WorldContext>> {
  name: string;
  /** Sanity check at pipeline boot: listed fields must be populated by earlier stages. */
  dependsOn: (keyof WorldContext)[];
  /** When true, runStages injects extras.agents from GenerateOptions.agents. */
  needsAgents?: boolean;
  run(
    ctx: Readonly<WorldContext>,
    rng: RNG,
    cfg: import('./config').WorldGenConfig,
    agentCount: number,
    extras: StageExtras,
  ): Output;
}

/** Thrown when spatial constraints cannot be met. Pipeline catches this
 *  to trigger expand-on-fail. Any other error propagates as a bug. */
export class FitError extends Error {
  constructor(public stage: string, public reason: string) {
    super(`[${stage}] ${reason}`);
    this.name = 'FitError';
  }
}

export interface GenResult {
  /** Master seed used (user-provided or framework-generated). */
  seed: string;
  dimensions: { width: number; height: number };
  /** publicBuildings ∪ homes, in that order. */
  locations: LocationSeed[];
  /** Row-major '0'/'1' string computed post-pipeline from `locations`. */
  collisionGrid: string;
}

export interface GenerateOptions {
  agents?: StageExtras['agents'];
}
```

- [ ] **Step 2.2: Run typecheck**

Run: `cd /d/proyects/little-life && npx tsc --noEmit server/lib/worldgen/types.ts 2>&1 | head -20`
Expected: no errors on new file. (Pre-existing noEmit failures unrelated to worldgen are OK.)

- [ ] **Step 2.3: Commit**

```bash
cd /d/proyects/little-life
git add server/lib/worldgen/types.ts
git commit -m "feat(worldgen): add types (WorldContext, Stage, FitError, GenResult)"
```

---

### Task 3: Config schema

**Files:**
- Create: `server/lib/worldgen/config.ts`

- [ ] **Step 3.1: Implement `config.ts`**

Create `server/lib/worldgen/config.ts`:

```ts
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
```

Note: `WorldGenConfigObjectSchema` is exported because downstream `previewWorld` tRPC input (Task 14) and `SetupConfigSchema.worldgen` (Task 9) both need the `ZodObject` form. Applying `.extend()` or `.default()` on the `.refine()`-wrapped schema would fail at runtime (`WorldGenConfigSchema.extend is not a function`) because `.extend()` is a `ZodObject` method, not a `ZodEffects` method. `.default()` is available on both — but for safety and consistency, both call sites use the inner object schema.

- [ ] **Step 3.2: Commit**

```bash
cd /d/proyects/little-life
git add server/lib/worldgen/config.ts
git commit -m "feat(worldgen): WorldGenConfigSchema + size constants"
```

---

## Milestone 2 — Stages (stubs + dimensions)

### Task 4: Dimensions stage (real)

**Files:**
- Create: `server/lib/worldgen/stages/dimensions.ts`
- Create: `server/lib/worldgen/__tests__/dimensions.test.ts`

- [ ] **Step 4.1: Write failing tests**

Create `server/lib/worldgen/__tests__/dimensions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { dimensionsStage } from '../stages/dimensions';
import { MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT } from '../config';
import { makeRng } from '../rng';
import type { WorldContext } from '../types';

const EMPTY_CTX: WorldContext = {
  dimensions: null, terrainTiles: null, publicBuildings: null,
  homes: null, interiors: null, names: null,
};
const RNG = makeRng(0);

function run(cfg: any, agentCount: number, extras: any = {}) {
  return dimensionsStage.run(EMPTY_CTX, RNG, cfg, agentCount, extras).dimensions!;
}

describe('dimensions stage', () => {
  it('medium tier returns 60×45', () => {
    expect(run({ sizeTier: 'medium', overrides: {} }, 15)).toEqual({ width: 60, height: 45 });
  });

  it('large tier returns 80×60', () => {
    expect(run({ sizeTier: 'large', overrides: {} }, 15)).toEqual({ width: 80, height: 60 });
  });

  it('custom tier returns customDimensions verbatim', () => {
    expect(
      run({ sizeTier: 'custom', customDimensions: { width: 55, height: 42 }, overrides: {} }, 15)
    ).toEqual({ width: 55, height: 42 });
  });

  it('auto formula scales with agent count', () => {
    // N=15 → 30 + ceil(1.8*15) = 30 + 27 = 57, clamped up to MIN_WIDTH=48 (57 > 48 OK)
    // height: 20 + ceil(1.3*15) = 20 + 20 = 40, >= MIN_HEIGHT=37 OK
    expect(run({ sizeTier: 'auto', overrides: {} }, 15)).toEqual({ width: 57, height: 40 });
  });

  it('auto formula clamps at MIN for low agent counts', () => {
    // N=1 → 30 + 2 = 32, clamped up to MIN_WIDTH=48
    //       20 + 2 = 22, clamped up to MIN_HEIGHT=37
    expect(run({ sizeTier: 'auto', overrides: {} }, 1)).toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT });
  });

  it('auto formula clamps at MAX for high agent counts', () => {
    // N=100 → clamps at MAX_WIDTH=90, MAX_HEIGHT=70
    expect(run({ sizeTier: 'auto', overrides: {} }, 100)).toEqual({ width: MAX_WIDTH, height: MAX_HEIGHT });
  });

  it('overrides.dimensions short-circuits everything below it', () => {
    const cfg = {
      sizeTier: 'medium' as const,
      overrides: { dimensions: { width: 99, height: 55 } },
    };
    expect(run(cfg, 15)).toEqual({ width: 99, height: 55 });
  });

  it('extras.expandPin has highest priority (beats overrides)', () => {
    const cfg = {
      sizeTier: 'medium' as const,
      overrides: { dimensions: { width: 99, height: 55 } },
    };
    expect(run(cfg, 15, { expandPin: { width: 70, height: 52 } })).toEqual({ width: 70, height: 52 });
  });
});
```

- [ ] **Step 4.2: Run tests to confirm failure**

Run: `cd /d/proyects/little-life && npx vitest run server/lib/worldgen/__tests__/dimensions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement `dimensions.ts`**

Create `server/lib/worldgen/stages/dimensions.ts`:

```ts
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
```

- [ ] **Step 4.4: Run tests to verify pass**

Run: `cd /d/proyects/little-life && npx vitest run server/lib/worldgen/__tests__/dimensions.test.ts`
Expected: PASS (all cases).

- [ ] **Step 4.5: Commit**

```bash
cd /d/proyects/little-life
git add server/lib/worldgen/stages/dimensions.ts server/lib/worldgen/__tests__/dimensions.test.ts
git commit -m "feat(worldgen): dimensions stage with tier priority chain"
```

---

### Task 5: Stub stages (terrain, layout, interiors, names)

**Files:**
- Create: `server/lib/worldgen/stages/terrain.ts`
- Create: `server/lib/worldgen/stages/layout.ts`
- Create: `server/lib/worldgen/stages/interiors.ts`
- Create: `server/lib/worldgen/stages/names.ts`

- [ ] **Step 5.1: Implement `terrain.ts`**

Create `server/lib/worldgen/stages/terrain.ts`:

```ts
import type { Stage, TerrainTile } from '../types';

/** Phase 3 replaces this with biome generation. Phase 1 returns empty array
 *  so the renderer uses its default grass background. */
export const terrainStage: Stage<{ terrainTiles: TerrainTile[] }> = {
  name: 'terrain',
  dependsOn: ['dimensions'],
  run() {
    return { terrainTiles: [] };
  },
};
```

- [ ] **Step 5.2: Implement `layout.ts`**

Create `server/lib/worldgen/stages/layout.ts`:

```ts
import { getPublicBuildings, generateLocationsForAgentCount } from '../../../data/maps';
import type { LocationSeed } from '../../../data/maps';
import { FitError, type Stage } from '../types';

const TILE_SIZE = 32;

/** Phase 2 replaces this with a real building placement generator. Phase 1
 *  returns the hardcoded MAP_LOCATIONS public buildings verbatim. */
export const layoutStage: Stage<{ publicBuildings: LocationSeed[] }> = {
  name: 'layout',
  dependsOn: ['dimensions'],
  run(ctx) {
    if (!ctx.dimensions) {
      throw new Error('layout: dimensions not populated');
    }
    // generateLocationsForAgentCount(0) returns public buildings only (agentCount=0 → no homes).
    // Filter to type !== 'home' so only public buildings remain.
    const publicBuildings = generateLocationsForAgentCount(0, 0)
      .filter((l) => l.type !== 'home');

    // FitError if hardcoded positions don't fit the current dimensions.
    const mapPxW = ctx.dimensions.width * TILE_SIZE;
    const mapPxH = ctx.dimensions.height * TILE_SIZE;
    for (const loc of publicBuildings) {
      const rightEdge = loc.position.x + loc.position.width;
      const bottomEdge = loc.position.y + loc.position.height;
      if (rightEdge > mapPxW || bottomEdge > mapPxH) {
        throw new FitError('layout', `map too small for ${loc.name} (needs ${rightEdge}×${bottomEdge}px, have ${mapPxW}×${mapPxH}px)`);
      }
    }
    return { publicBuildings };
  },
};

// Confirm `getPublicBuildings` is exported; if not, reveal a helpful message.
void getPublicBuildings;
```

- [ ] **Step 5.3: Implement `interiors.ts`**

Create `server/lib/worldgen/stages/interiors.ts`:

```ts
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
```

- [ ] **Step 5.4: Implement `names.ts`**

Create `server/lib/worldgen/stages/names.ts`:

```ts
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
```

- [ ] **Step 5.5: Commit**

```bash
cd /d/proyects/little-life
git add server/lib/worldgen/stages/terrain.ts server/lib/worldgen/stages/layout.ts server/lib/worldgen/stages/interiors.ts server/lib/worldgen/stages/names.ts
git commit -m "feat(worldgen): stub stages (terrain, layout, interiors, names)"
```

---

### Task 6: Homes stage (real)

**Files:**
- Create: `server/lib/worldgen/stages/homes.ts`
- Create: `server/lib/worldgen/__tests__/homes.test.ts`

- [ ] **Step 6.0: Export `HOME_DESCRIPTIONS` from `maps.ts`** _(prerequisite)_

The existing `server/data/maps.ts` declares `const HOME_DESCRIPTIONS = [...]` without `export`. The homes stage needs to import this array. Edit the line to add `export`:

```ts
// server/data/maps.ts (around line 349)
export const HOME_DESCRIPTIONS = [
  // … existing entries unchanged …
];
```

Run: `cd /d/proyects/little-life && grep -n "^export const HOME_DESCRIPTIONS" server/data/maps.ts`
Expected: one line of output confirming the export is present.

Commit:

```bash
cd /d/proyects/little-life
git add server/data/maps.ts
git commit -m "chore(maps): export HOME_DESCRIPTIONS for reuse"
```

- [ ] **Step 6.1: Write failing tests**

Create `server/lib/worldgen/__tests__/homes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { homesStage } from '../stages/homes';
import { forkRng } from '../rng';
import { FitError } from '../types';
import type { WorldContext } from '../types';
import type { LocationSeed } from '../../../data/maps';

function ctxWith(width: number, height: number, publicBuildings: LocationSeed[] = []): WorldContext {
  return {
    dimensions: { width, height },
    terrainTiles: [],
    publicBuildings,
    homes: null, interiors: null, names: null,
  };
}

const CFG = { seed: 'test', sizeTier: 'medium' as const, overrides: {} };

describe('homes stage', () => {
  it('is deterministic: same seed + ctx → same positions', () => {
    const ctx = ctxWith(60, 45);
    const rngA = forkRng('test', 'homes');
    const rngB = forkRng('test', 'homes');
    const a = homesStage.run(ctx, rngA, CFG, 10, {}).homes!;
    const b = homesStage.run(ctx, rngB, CFG, 10, {}).homes!;
    expect(a.map((h) => h.position)).toEqual(b.map((h) => h.position));
  });

  it('home count matches ceil(agents/2) with no floor', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    expect(homesStage.run(ctx, rng, CFG, 2, {}).homes!).toHaveLength(1);
  });

  it('home count grows to fit highest Home N agent reference', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const extras = { agents: [
      { homeName: 'Home 1' }, { homeName: 'Home 2' }, { homeName: 'Home 7' }
    ] };
    const homes = homesStage.run(ctx, rng, CFG, 2, extras).homes!;
    expect(homes).toHaveLength(7); // max(halfAgents=1, maxReferenced=7)
  });

  it('homes do not overlap public buildings', () => {
    // Put a dummy 3-tile wide public building at (100, 100) and verify no home overlaps.
    const pub: LocationSeed = {
      name: 'Block', type: 'shop',
      position: { x: 160, y: 160, width: 96, height: 96 },
      entry_point: { x: 208, y: 256 },
      capacity: 0, current_occupants: [], operating_hours: null,
      services: [], description: '', owner: null,
    };
    const ctx = ctxWith(60, 45, [pub]);
    const rng = forkRng('test', 'homes');
    const homes = homesStage.run(ctx, rng, CFG, 20, {}).homes!;
    for (const h of homes) {
      const hR = h.position.x + h.position.width;
      const hB = h.position.y + h.position.height;
      const pR = pub.position.x + pub.position.width;
      const pB = pub.position.y + pub.position.height;
      const overlaps = h.position.x < pR && hR > pub.position.x &&
                       h.position.y < pB && hB > pub.position.y;
      expect(overlaps).toBe(false);
    }
  });

  it('homes do not overlap each other', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const homes = homesStage.run(ctx, rng, CFG, 20, {}).homes!;
    for (let i = 0; i < homes.length; i++) {
      for (let j = i + 1; j < homes.length; j++) {
        const a = homes[i].position, b = homes[j].position;
        const aR = a.x + a.width, aB = a.y + a.height;
        const bR = b.x + b.width, bB = b.y + b.height;
        const overlaps = a.x < bR && aR > b.x && a.y < bB && aB > b.y;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('throws FitError when the map is too small for the requested count', () => {
    const ctx = ctxWith(48, 37); // minimum map
    const rng = forkRng('test', 'homes');
    // With ~20 agents → 10 homes, on a 48×37 map there likely aren't enough
    // non-overlapping 3×3 + 2-tile-spacing slots.
    expect(() => homesStage.run(ctx, rng, CFG, 80, {}).homes).toThrowError(FitError);
  });

  it('emits LocationSeed with correct shape', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const home = homesStage.run(ctx, rng, CFG, 4, {}).homes![0];
    expect(home.type).toBe('home');
    expect(home.name).toMatch(/^Home \d+$/);
    expect(home.position.width).toBe(96);
    expect(home.position.height).toBe(96);
    expect(home.capacity).toBe(2);
    expect(home.current_occupants).toEqual([]);
    expect(home.operating_hours).toBeNull();
    expect(home.owner).toBeNull();
    expect(home.services.length).toBeGreaterThan(0);
    // entry_point is south-center of footprint
    expect(home.entry_point.x).toBe(home.position.x + 48);
    expect(home.entry_point.y).toBe(home.position.y + home.position.height);
  });

  it('override path: pinned positions returned verbatim when valid', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const pinned = [{ x: 32, y: 32 }, { x: 32, y: 160 }];
    const cfg = { ...CFG, overrides: { homePositions: pinned } };
    const homes = homesStage.run(ctx, rng, cfg, 4, {}).homes!;
    expect(homes).toHaveLength(2);
    expect(homes[0].position.x).toBe(pinned[0].x);
    expect(homes[0].position.y).toBe(pinned[0].y);
  });

  it('override path: mismatched count throws FitError', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const cfg = { ...CFG, overrides: { homePositions: [{ x: 32, y: 32 }] } };
    expect(() => homesStage.run(ctx, rng, cfg, 10, {}).homes).toThrowError(FitError);
  });

  it('home footprint must stay within [1, width-1] × [1, height-1] border', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const homes = homesStage.run(ctx, rng, CFG, 20, {}).homes!;
    for (const h of homes) {
      const tx = h.position.x / 32;
      const ty = h.position.y / 32;
      expect(tx).toBeGreaterThanOrEqual(1);
      expect(ty).toBeGreaterThanOrEqual(1);
      expect(tx + 3).toBeLessThanOrEqual(60 - 1);
      expect(ty + 3).toBeLessThanOrEqual(45 - 1);
    }
  });
});
```

- [ ] **Step 6.2: Run tests to confirm failure**

Run: `cd /d/proyects/little-life && npx vitest run server/lib/worldgen/__tests__/homes.test.ts`
Expected: FAIL.

- [ ] **Step 6.3: Implement `homes.ts`**

Create `server/lib/worldgen/stages/homes.ts`:

```ts
import type { LocationSeed } from '../../../data/maps';
import { HOME_DESCRIPTIONS } from '../../../data/maps';
import { FitError, type Stage } from '../types';

const TILE = 32;
const HOME_TILES = 3;           // 3×3 tile footprint
const HOME_PX = HOME_TILES * TILE;
const PUBLIC_BUFFER = 2;        // tiles of buffer around public buildings
const HOME_SPACING = 2;         // min Chebyshev distance between home footprints

/**
 * Home services — matches what getDefaultServices('home') in maps.ts returns.
 * Kept inline here so we don't depend on maps.ts internals that may change.
 */
const HOME_SERVICES = [
  { needSatisfied: 'energy', amount: 8, cost: 0, itemRequired: null as string | null },
  { needSatisfied: 'comfort', amount: 5, cost: 0, itemRequired: null as string | null },
  { needSatisfied: 'hunger', amount: 10, cost: 0, itemRequired: 'food_raw' as string | null },
];

export const homesStage: Stage<{ homes: LocationSeed[] }> = {
  name: 'homes',
  dependsOn: ['dimensions', 'publicBuildings'],
  needsAgents: true,
  run(ctx, rng, cfg, agentCount, extras) {
    if (!ctx.dimensions || !ctx.publicBuildings) {
      throw new Error('homes: missing dimensions or publicBuildings');
    }
    const { width, height } = ctx.dimensions;

    // --- Compute homeCount (§7.4) ---
    const halfAgents = Math.ceil(agentCount / 2);
    let maxReferenced = 0;
    if (extras.agents) {
      maxReferenced = extras.agents.reduce((max, a) => {
        const match = a.homeName?.match(/Home (\d+)/);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);
    }
    const homeCount = Math.max(halfAgents, maxReferenced);
    if (homeCount === 0) return { homes: [] };

    // --- Override path ---
    if (cfg.overrides?.homePositions) {
      const pinned = cfg.overrides.homePositions;
      if (pinned.length !== homeCount) {
        throw new FitError('homes',
          `override length ${pinned.length} does not match homeCount ${homeCount}`);
      }
      // Validate each pin fits.
      const blocked = buildBlockedMask(ctx.publicBuildings, width, height);
      for (const p of pinned) {
        if (!pinFits(p, blocked, width, height)) {
          throw new FitError('homes',
            `pinned position at (${p.x}, ${p.y}) does not fit`);
        }
      }
      return { homes: pinned.map((p, i) => emitHome(p, i, rng)) };
    }

    // --- Normal path: enumerate candidates → shuffle → greedy pick ---
    const blocked = buildBlockedMask(ctx.publicBuildings, width, height);
    const candidates: Array<{ tx: number; ty: number }> = [];
    for (let ty = 1; ty + HOME_TILES <= height - 1; ty++) {
      for (let tx = 1; tx + HOME_TILES <= width - 1; tx++) {
        if (footprintClear(tx, ty, blocked, width)) {
          candidates.push({ tx, ty });
        }
      }
    }
    const shuffled = rng.shuffle(candidates);

    // Greedy select with Chebyshev spacing rule.
    const chosen: Array<{ tx: number; ty: number }> = [];
    for (const c of shuffled) {
      if (chosen.length >= homeCount) break;
      const tooClose = chosen.some((o) =>
        Math.max(Math.abs(o.tx - c.tx), Math.abs(o.ty - c.ty)) < HOME_TILES + HOME_SPACING);
      if (!tooClose) chosen.push(c);
    }

    if (chosen.length < homeCount) {
      throw new FitError('homes',
        `not enough spots for ${homeCount} homes (found ${chosen.length})`);
    }

    const homes: LocationSeed[] = chosen.map((c, i) =>
      emitHome({ x: c.tx * TILE, y: c.ty * TILE }, i, rng));
    return { homes };
  },
};

// --- Helpers ---

function buildBlockedMask(
  publicBuildings: LocationSeed[],
  width: number,
  height: number,
): boolean[] {
  const mask = new Array<boolean>(width * height).fill(false);
  // Map border (1-tile frame).
  for (let x = 0; x < width; x++) {
    mask[x] = true;
    mask[(height - 1) * width + x] = true;
  }
  for (let y = 0; y < height; y++) {
    mask[y * width] = true;
    mask[y * width + (width - 1)] = true;
  }
  // Public buildings + 2-tile buffer.
  for (const loc of publicBuildings) {
    const tx0 = Math.max(0, Math.floor(loc.position.x / TILE) - PUBLIC_BUFFER);
    const ty0 = Math.max(0, Math.floor(loc.position.y / TILE) - PUBLIC_BUFFER);
    const tx1 = Math.min(width - 1, Math.ceil((loc.position.x + loc.position.width) / TILE) + PUBLIC_BUFFER);
    const ty1 = Math.min(height - 1, Math.ceil((loc.position.y + loc.position.height) / TILE) + PUBLIC_BUFFER);
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        mask[ty * width + tx] = true;
      }
    }
  }
  return mask;
}

function footprintClear(tx: number, ty: number, blocked: boolean[], width: number): boolean {
  for (let dy = 0; dy < HOME_TILES; dy++) {
    for (let dx = 0; dx < HOME_TILES; dx++) {
      if (blocked[(ty + dy) * width + (tx + dx)]) return false;
    }
  }
  return true;
}

function pinFits(
  p: { x: number; y: number },
  blocked: boolean[],
  width: number,
  height: number,
): boolean {
  if (p.x % TILE !== 0 || p.y % TILE !== 0) return false;
  const tx = p.x / TILE, ty = p.y / TILE;
  if (tx < 1 || ty < 1 || tx + HOME_TILES > width - 1 || ty + HOME_TILES > height - 1) return false;
  return footprintClear(tx, ty, blocked, width);
}

function emitHome(
  pos: { x: number; y: number },
  idx: number,
  rng: import('../rng').RNG,
): LocationSeed {
  return {
    name: `Home ${idx + 1}`,
    type: 'home',
    position: { x: pos.x, y: pos.y, width: HOME_PX, height: HOME_PX },
    entry_point: { x: pos.x + HOME_PX / 2, y: pos.y + HOME_PX },
    capacity: 2,
    current_occupants: [],
    operating_hours: null,
    services: HOME_SERVICES.map((s) => ({ ...s })),
    description: rng.pick(HOME_DESCRIPTIONS),
    owner: null,
  };
}
```

Note: imports `HOME_DESCRIPTIONS` from `server/data/maps.ts`. The export was added in Step 6.0.

- [ ] **Step 6.5: Run tests to verify pass**

Run: `cd /d/proyects/little-life && npx vitest run server/lib/worldgen/__tests__/homes.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6.6: Commit**

```bash
cd /d/proyects/little-life
git add server/lib/worldgen/stages/homes.ts server/lib/worldgen/__tests__/homes.test.ts
git commit -m "feat(worldgen): seeded homes placement generator"
```

---

## Milestone 3 — Pipeline orchestrator

### Task 7: Pipeline module

**Files:**
- Create: `server/lib/worldgen/pipeline.ts`
- Create: `server/lib/worldgen/__tests__/pipeline.test.ts`
- Create: `server/lib/worldgen/index.ts`

- [ ] **Step 7.0: Widen `generateCollisionGridForLocations` signature** _(prerequisite — must run BEFORE pipeline.ts is written)_

The current signature at `server/data/maps.ts:427` is `generateCollisionGridForLocations(locs: MapLocationRaw[])` and uses the module-level `MAP_WIDTH` / `MAP_HEIGHT` inside. The pipeline needs to pass dynamic dimensions. Extend the signature to accept optional `mapWidth` / `mapHeight` parameters defaulting to the existing constants. Also: if Task 10 hasn't yet renamed the constants, keep the defaults pointing to `MAP_WIDTH` / `MAP_HEIGHT` for now; Task 10 updates them to `DEFAULT_MAP_WIDTH` / `DEFAULT_MAP_HEIGHT` later.

Edit `server/data/maps.ts:427`:

```ts
export function generateCollisionGridForLocations(
  locs: MapLocationRaw[],
  mapWidth: number = MAP_WIDTH,
  mapHeight: number = MAP_HEIGHT,
): string {
  const grid: number[][] = [];
  for (let y = 0; y < mapHeight; y++) {
    grid[y] = [];
    for (let x = 0; x < mapWidth; x++) {
      grid[y][x] = 0;
    }
  }
  // Body unchanged in logic — replace every internal `MAP_WIDTH` with
  // `mapWidth` and every internal `MAP_HEIGHT` with `mapHeight` so the
  // function fully honors the arguments. If the current body ranges over
  // `MAP_WIDTH` / `MAP_HEIGHT` in ~8 places, update each.
  // …existing body with renames applied…
}
```

Run: `cd /d/proyects/little-life && npx vitest run 2>&1 | tail -5`
Expected: existing tests still pass (defaults preserve current behavior).

Commit:

```bash
cd /d/proyects/little-life
git add server/data/maps.ts
git commit -m "refactor(maps): generateCollisionGridForLocations accepts explicit dimensions"
```

- [ ] **Step 7.1: Write failing pipeline tests**

Create `server/lib/worldgen/__tests__/pipeline.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { generateWorld } from '../pipeline';
import { MIN_WIDTH, MIN_HEIGHT, MAX_WIDTH, MAX_HEIGHT } from '../config';
import type { WorldGenConfig } from '../config';

const CFG_AUTO: WorldGenConfig = { sizeTier: 'auto', overrides: {} };

describe('generateWorld', () => {
  it('produces a GenResult with all fields populated', () => {
    const r = generateWorld({ ...CFG_AUTO, seed: 'hello' }, 10);
    expect(r.seed).toBe('hello');
    expect(r.dimensions.width).toBeGreaterThanOrEqual(MIN_WIDTH);
    expect(r.dimensions.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
    expect(r.locations.length).toBeGreaterThan(0);
    expect(typeof r.collisionGrid).toBe('string');
    expect(r.collisionGrid.length).toBe(r.dimensions.width * r.dimensions.height);
  });

  it('same seed → identical locations', () => {
    const a = generateWorld({ ...CFG_AUTO, seed: 'repeat' }, 13);
    const b = generateWorld({ ...CFG_AUTO, seed: 'repeat' }, 13);
    expect(a.locations.map((l) => ({ name: l.name, pos: l.position, ep: l.entry_point })))
      .toEqual(b.locations.map((l) => ({ name: l.name, pos: l.position, ep: l.entry_point })));
  });

  it('generates a random seed when none provided, returns it', () => {
    const r = generateWorld({ sizeTier: 'auto', overrides: {} }, 10);
    expect(r.seed).toMatch(/^[0-9A-Za-z]{8}$/);
  });

  it('auto-expands dimensions on FitError and retries', () => {
    // Use minimum dimensions, then request many agents so homes can't fit.
    const r = generateWorld({ sizeTier: 'auto', overrides: {} }, 40);
    expect(r.dimensions.width).toBeGreaterThanOrEqual(MIN_WIDTH);
  });

  it('aborts on FitError when custom tier is too small', () => {
    // Custom tier bypasses auto-expand (spec §4.3). The FitError from the
    // homes stage propagates unchanged rather than becoming "cap reached".
    expect(() => generateWorld(
      { sizeTier: 'custom', customDimensions: { width: MIN_WIDTH, height: MIN_HEIGHT }, overrides: {} },
      80, // too many agents for minimum map
    )).toThrowError(/\[homes\] not enough spots/);
  });

  it('does not leak expandPin into cfg.overrides after return', () => {
    const cfg = { ...CFG_AUTO, seed: 'leak-test' };
    const before = JSON.stringify(cfg);
    generateWorld(cfg, 40);
    expect(JSON.stringify(cfg)).toBe(before);
  });

  it('passes opts.agents through to the homes stage', () => {
    // Agent references Home 10 — home count must grow to 10 even though halfAgents=1.
    const r = generateWorld(
      { ...CFG_AUTO, seed: 'agents-test' },
      2,
      { agents: [{ homeName: 'Home 10' }] },
    );
    const homes = r.locations.filter((l) => l.type === 'home');
    expect(homes).toHaveLength(10);
  });

  it('collisionGrid has correct length and content', () => {
    const r = generateWorld({ ...CFG_AUTO, seed: 'grid' }, 10);
    expect(r.collisionGrid.length).toBe(r.dimensions.width * r.dimensions.height);
    expect(/^[01]+$/.test(r.collisionGrid)).toBe(true);
  });
});
```

- [ ] **Step 7.2: Run tests to confirm failure**

Run: `cd /d/proyects/little-life && npx vitest run server/lib/worldgen/__tests__/pipeline.test.ts`
Expected: FAIL.

- [ ] **Step 7.3: Implement `pipeline.ts`**

Create `server/lib/worldgen/pipeline.ts`:

```ts
import { forkRng, makeRng, randomBase62 } from './rng';
import { MAX_WIDTH, MAX_HEIGHT, type WorldGenConfig } from './config';
import {
  FitError,
  type WorldContext,
  type Stage,
  type StageExtras,
  type GenResult,
  type GenerateOptions,
} from './types';
import { dimensionsStage } from './stages/dimensions';
import { terrainStage } from './stages/terrain';
import { layoutStage } from './stages/layout';
import { homesStage } from './stages/homes';
import { interiorsStage } from './stages/interiors';
import { namesStage } from './stages/names';
import { generateCollisionGridForLocations } from '../../data/maps';
import type { LocationSeed } from '../../data/maps';

const MAX_EXPAND_ATTEMPTS = 3;
const EXPAND_FACTOR = 1.2;

/** Ordered pipeline — source of truth for stage order. */
const PIPELINE: Array<Stage<any>> = [
  dimensionsStage,
  terrainStage,
  layoutStage,
  homesStage,
  interiorsStage,
  namesStage,
];

// Pipeline-boot sanity check: every dependsOn must reference a field populated
// by an earlier stage. This catches misconfiguration at module init, not mid-run.
(function validatePipelineAtBoot() {
  const populated = new Set<keyof WorldContext>();
  // Map of field → first stage that produces it (declared by convention:
  // each stage's Output type includes the key it populates, reflected via name).
  // We approximate via a hardcoded mapping matching stage outputs.
  const STAGE_OUTPUTS: Record<string, (keyof WorldContext)[]> = {
    dimensions: ['dimensions'],
    terrain: ['terrainTiles'],
    layout: ['publicBuildings'],
    homes: ['homes'],
    interiors: ['interiors'],
    names: ['names'],
  };
  for (const stage of PIPELINE) {
    for (const dep of stage.dependsOn) {
      if (!populated.has(dep)) {
        throw new Error(
          `[worldgen] stage '${stage.name}' depends on '${String(dep)}' which no earlier stage produces`,
        );
      }
    }
    for (const out of STAGE_OUTPUTS[stage.name] ?? []) populated.add(out);
  }
})();

function emptyCtx(): WorldContext {
  return {
    dimensions: null, terrainTiles: null, publicBuildings: null,
    homes: null, interiors: null, names: null,
  };
}

/** Evaluate the dimensions stage priority chain without an expand pin.
 *  Relies on dimensions-stage invariants (no ctx, no rng). */
function peekBaseDimensions(cfg: WorldGenConfig, agentCount: number) {
  return dimensionsStage.run(emptyCtx(), makeRng(0), cfg, agentCount, {}).dimensions!;
}

/** Grow both axes by factor, clamp to MAX. Equal result to input means cap hit. */
function expandDimensions(
  dims: { width: number; height: number },
  factor: number,
): { width: number; height: number } {
  return {
    width:  Math.min(Math.ceil(dims.width  * factor), MAX_WIDTH),
    height: Math.min(Math.ceil(dims.height * factor), MAX_HEIGHT),
  };
}

function runStages(
  cfg: WorldGenConfig,
  agentCount: number,
  opts: GenerateOptions,
  expandPin: { width: number; height: number } | null,
): GenResult {
  const ctx = emptyCtx();
  const seed = cfg.seed!; // pipeline caller guarantees a seed

  for (const stage of PIPELINE) {
    const rng = forkRng(seed, stage.name);
    const extras: StageExtras = {};
    if (stage.needsAgents && opts.agents) extras.agents = opts.agents;
    if (stage.name === 'dimensions' && expandPin) extras.expandPin = expandPin;

    const partial = stage.run(ctx, rng, cfg, agentCount, extras);
    Object.assign(ctx, partial);
  }

  const publicBuildings = ctx.publicBuildings!;
  const homes = ctx.homes!;
  const locations: LocationSeed[] = [...publicBuildings, ...homes];

  // Derive collision grid. Converts LocationSeed → the raw shape
  // generateCollisionGridForLocations expects.
  const rawLocs = locations.map((l) => ({
    name: l.name,
    type: l.type,
    x: l.position.x,
    y: l.position.y,
    width: l.position.width,
    height: l.position.height,
    entryX: l.entry_point.x,
    entryY: l.entry_point.y,
    capacity: l.capacity,
    description: l.description,
  }));
  const collisionGrid = generateCollisionGridForLocations(
    rawLocs as any,
    ctx.dimensions!.width,
    ctx.dimensions!.height,
  );

  return {
    seed,
    dimensions: ctx.dimensions!,
    locations,
    collisionGrid,
  };
}

export function generateWorld(
  cfg: WorldGenConfig,
  agentCount: number,
  opts: GenerateOptions = {},
): GenResult {
  const seed = cfg.seed ?? randomBase62(8);
  let expandPin: { width: number; height: number } | null = null;

  for (let attempt = 0; attempt < MAX_EXPAND_ATTEMPTS; attempt++) {
    try {
      const started = Date.now();
      const result = runStages({ ...cfg, seed }, agentCount, opts, expandPin);
      console.log(
        `[worldgen] done seed=${seed} dims=${result.dimensions.width}×${result.dimensions.height} ` +
        `locations=${result.locations.length} attempts=${attempt + 1} elapsed=${Date.now() - started}ms`,
      );
      return result;
    } catch (e) {
      if (!(e instanceof FitError)) throw e;
      if (cfg.sizeTier === 'custom') throw e;

      const currentDims = expandPin ?? peekBaseDimensions(cfg, agentCount);
      const grown = expandDimensions(currentDims, EXPAND_FACTOR);
      if (grown.width === currentDims.width && grown.height === currentDims.height) {
        throw new Error('worldgen: dimensions cap reached, cannot fit content');
      }
      expandPin = grown;
      console.warn(
        `[worldgen] expand attempt ${attempt + 1}: ${e.message} → ${grown.width}×${grown.height}`,
      );
    }
  }
  throw new Error('worldgen: dimensions cap reached, cannot fit content');
}
```

- [ ] **Step 7.5: Implement `index.ts`**

Create `server/lib/worldgen/index.ts`:

```ts
export { generateWorld } from './pipeline';
export {
  WorldGenConfigSchema,
  WorldGenConfigObjectSchema,
  MIN_WIDTH,
  MAX_WIDTH,
  MIN_HEIGHT,
  MAX_HEIGHT,
} from './config';
export type { WorldGenConfig } from './config';
// FitError is a class (both a value AND a type). Export it as a value so
// downstream `instanceof FitError` checks work.
export { FitError } from './types';
export type { GenResult, GenerateOptions, Stage, WorldContext, StageExtras, TerrainTile, InteriorData } from './types';
```

- [ ] **Step 7.6: Run pipeline tests to verify pass**

Run: `cd /d/proyects/little-life && npx vitest run server/lib/worldgen/__tests__/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 7.7: Run all worldgen tests**

Run: `cd /d/proyects/little-life && npx vitest run server/lib/worldgen/`
Expected: PASS (rng, dimensions, homes, pipeline all green).

- [ ] **Step 7.8: Commit**

```bash
cd /d/proyects/little-life
git add server/lib/worldgen/pipeline.ts server/lib/worldgen/index.ts server/lib/worldgen/__tests__/pipeline.test.ts server/data/maps.ts
git commit -m "feat(worldgen): linear pipeline with expand-on-fail"
```

---

### Task 8: Property-based tests

**Files:**
- Create: `server/lib/worldgen/__tests__/property.test.ts`

- [ ] **Step 8.1: Implement property tests**

Create `server/lib/worldgen/__tests__/property.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateWorld } from '../pipeline';
import { MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT } from '../config';

const AGENT_COUNTS = [5, 13, 30];
const SEED_COUNT = 100; // 100 × 3 = 300 runs

describe('property: generateWorld invariants', () => {
  for (const n of AGENT_COUNTS) {
    it(`produces valid output for ${SEED_COUNT} random seeds (agents=${n})`, () => {
      for (let i = 0; i < SEED_COUNT; i++) {
        const seed = `prop-${n}-${i}`;
        const r = generateWorld({ sizeTier: 'auto', overrides: {}, seed }, n);
        expect(r.dimensions.width).toBeGreaterThanOrEqual(MIN_WIDTH);
        expect(r.dimensions.width).toBeLessThanOrEqual(MAX_WIDTH);
        expect(r.dimensions.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
        expect(r.dimensions.height).toBeLessThanOrEqual(MAX_HEIGHT);

        const homes = r.locations.filter((l) => l.type === 'home');
        // No floor; halfAgents for N=5 is 3.
        expect(homes.length).toBeGreaterThanOrEqual(Math.ceil(n / 2));

        // No overlap between any pair of locations.
        for (let a = 0; a < r.locations.length; a++) {
          for (let b = a + 1; b < r.locations.length; b++) {
            const la = r.locations[a].position, lb = r.locations[b].position;
            const overlap = la.x < lb.x + lb.width && la.x + la.width > lb.x &&
                            la.y < lb.y + lb.height && la.y + la.height > lb.y;
            expect(overlap).toBe(false);
          }
        }
      }
    });
  }
});
```

- [ ] **Step 8.2: Run**

Run: `cd /d/proyects/little-life && npx vitest run server/lib/worldgen/__tests__/property.test.ts`
Expected: PASS. If any case throws unexpectedly, investigate the failing seed and extend homes-stage logic.

- [ ] **Step 8.3: Commit**

```bash
cd /d/proyects/little-life
git add server/lib/worldgen/__tests__/property.test.ts
git commit -m "test(worldgen): property-based invariants across 300 seeds"
```

---

## Milestone 4 — Integrate with `setup.ts`

### Task 9: Extend `SetupConfigSchema` with `worldgen`

**Files:**
- Modify: `server/routers/setup.ts`

- [ ] **Step 9.1: Add import**

At the top of `server/routers/setup.ts`, add:

```ts
import { WorldGenConfigObjectSchema } from '../lib/worldgen/config';
import { generateWorld } from '../lib/worldgen';
```

Note: we import `WorldGenConfigObjectSchema` (the unwrapped `ZodObject`) rather than the refined `WorldGenConfigSchema`, because `.default()` applied via chain below works cleanly on `ZodObject` but behavior on `ZodEffects` is version-sensitive.

- [ ] **Step 9.2: Extend `SetupConfigSchema`**

Locate the `SetupConfigSchema = z.object({ ... })` block. Add `worldgen` as a defaulted field:

```ts
const SetupConfigSchema = z.object({
  agents: z.array(AgentConfigSchema),
  relationships: z.array(RelationshipConfigSchema),
  world: WorldConfigSchema,
  rules: RulesConfigSchema,
  worldgen: WorldGenConfigObjectSchema.default({
    sizeTier: 'auto',
    overrides: {},
  }),
});
```

The `.default(...)` at this level is what lets pre-Phase-1 saved configs parse (saved `setup_config` rows without a `worldgen` key get the default populated). The `sizeTier !== 'custom' || customDimensions` refinement is not enforced at this nesting level; it is enforced when standalone `WorldGenConfigSchema` is used (e.g., at the `previewWorld` tRPC input). The default value we supply is not `custom`, so it trivially satisfies the constraint anyway.

- [ ] **Step 9.3: Run typecheck**

Run: `cd /d/proyects/little-life && npx tsc --noEmit 2>&1 | grep "setup.ts" | head`
Expected: no new errors. (Pre-existing unused-var warnings from other files unaffected.)

- [ ] **Step 9.4: Commit**

```bash
cd /d/proyects/little-life
git add server/routers/setup.ts
git commit -m "feat(setup): extend SetupConfigSchema with worldgen field"
```

---

### Task 10: Rename `MAP_WIDTH`/`MAP_HEIGHT`

**Files:**
- Modify: `server/data/maps.ts`
- Modify: `server/db/seed.ts`
- Modify: `server/routers/setup.ts`

- [ ] **Step 10.1: Grep for all importers**

Run: `cd /d/proyects/little-life && grep -rn "MAP_WIDTH\|MAP_HEIGHT" server src --include="*.ts" --include="*.tsx"`

Expected locations (matches spec §9.1 audit):
- `server/data/maps.ts` (definition + internal use)
- `server/db/seed.ts` (lines ~24, ~325-326)
- `server/routers/setup.ts` (imports `MAP_WIDTH`, `MAP_HEIGHT` at top; uses at bottom for `resetToWizard`)
- `src/components/canvas/TilemapRenderer.ts` (local `MAP_WIDTH_TILES` — different variable, not an importer)

If grep shows any additional importers, note them and include in the rename.

- [ ] **Step 10.2: Rename in `maps.ts`**

In `server/data/maps.ts`:
- Change `export const MAP_WIDTH = 60;` → `export const DEFAULT_MAP_WIDTH = 60;`
- Change `export const MAP_HEIGHT = 45;` → `export const DEFAULT_MAP_HEIGHT = 45;`
- Replace every internal `MAP_WIDTH` with `DEFAULT_MAP_WIDTH` and `MAP_HEIGHT` with `DEFAULT_MAP_HEIGHT` inside the same file (`generateCollisionGrid`, `generateCollisionGridForLocations`).
- Keep backward-compat re-export for anything we might miss: add at end of file:
  ```ts
  /** @deprecated Use DEFAULT_MAP_WIDTH. Retained for one release for backward compatibility. */
  export const MAP_WIDTH = DEFAULT_MAP_WIDTH;
  /** @deprecated Use DEFAULT_MAP_HEIGHT. */
  export const MAP_HEIGHT = DEFAULT_MAP_HEIGHT;
  ```

- [ ] **Step 10.3: Update `server/db/seed.ts`**

Read the file around lines 24 and 325-326. Change import + references:

```ts
// line 24
import { LOCATIONS, DEFAULT_MAP_WIDTH, DEFAULT_MAP_HEIGHT, COLLISION_GRID } from '../data/maps';

// lines 325-326
map_width: DEFAULT_MAP_WIDTH,
map_height: DEFAULT_MAP_HEIGHT,
```

- [ ] **Step 10.4: Update `server/routers/setup.ts`**

Find the `MAP_WIDTH`/`MAP_HEIGHT` import and references. Replace with `DEFAULT_MAP_WIDTH`/`DEFAULT_MAP_HEIGHT`.

- [ ] **Step 10.5: Run existing tests to confirm nothing broke**

Run: `cd /d/proyects/little-life && npx vitest run 2>&1 | tail -10`
Expected: all tests pass. If `interiorGrid.test.ts`, `pathfindingCost.test.ts`, or others reference the old names, add them to the rename or keep the compat re-exports.

- [ ] **Step 10.6: Commit**

```bash
cd /d/proyects/little-life
git add server/data/maps.ts server/db/seed.ts server/routers/setup.ts
git commit -m "refactor(maps): rename MAP_WIDTH/MAP_HEIGHT → DEFAULT_MAP_*

Runtime reads go through worldState; constants now only used for presets
and fallback. Compat re-exports retained for one release."
```

---

### Task 11: Refactor `seedWorld` to use `generateWorld`

**Files:**
- Modify: `server/routers/setup.ts`

- [ ] **Step 11.1: Locate `seedWorld`**

`server/routers/setup.ts` has a `seedWorld(config: SetupConfig)` function near the top. Find the block that does:

```ts
let homesNeeded = Math.ceil(config.agents.length / 2);
for (const agent of config.agents) {
  const match = agent.homeName.match(/Home (\d+)/);
  if (match) homesNeeded = Math.max(homesNeeded, Number(match[1]));
}
const dynamicLocations = generateLocationsForAgentCount(config.agents.length, homesNeeded);
const homesRaw = generateHomes(homesNeeded);
const publicRaw = getPublicBuildings();
const allRawBuildings = [...homesRaw, ...publicRaw];
const dynamicCollisionGrid = generateCollisionGridForLocations(allRawBuildings);
```

- [ ] **Step 11.2: Replace with `generateWorld` call**

Delete the existing block:

```ts
// DELETE THESE LINES (setup.ts:175-184 area):
let homesNeeded = Math.ceil(config.agents.length / 2);
for (const agent of config.agents) {
  const match = agent.homeName.match(/Home (\d+)/);
  if (match) homesNeeded = Math.max(homesNeeded, Number(match[1]));
}
const dynamicLocations = generateLocationsForAgentCount(config.agents.length, homesNeeded);
const homesRaw = generateHomes(homesNeeded);
const publicRaw = getPublicBuildings();
const allRawBuildings = [...homesRaw, ...publicRaw];
const dynamicCollisionGrid = generateCollisionGridForLocations(allRawBuildings);
```

Replace with:

```ts
// Phase 1 worldgen: delegate location generation to the seeded pipeline.
const genResult = generateWorld(config.worldgen, config.agents.length, {
  agents: config.agents,
});
// Writeback the resolved seed so worldState.setup_config is deterministic for restart.
config.worldgen = { ...config.worldgen, seed: genResult.seed };

const dynamicLocations = genResult.locations;
const dynamicCollisionGrid = genResult.collisionGrid;
```

- [ ] **Step 11.3: Update the `worldState` insert**

Locate the `db.insert(worldState).values({ ... })` block further down in `seedWorld` (search for `db.insert(worldState)`). Update only these three fields:

```ts
// INSIDE the existing db.insert(worldState).values({ ... }) block:
// Replace:
//   map_width: MAP_WIDTH,
//   map_height: MAP_HEIGHT,
//   collision_grid: COLLISION_GRID,
// (or similar — the existing code may already use dynamicCollisionGrid for
//  collision_grid; if so, only change map_width and map_height)
// With:
map_width: genResult.dimensions.width,
map_height: genResult.dimensions.height,
collision_grid: dynamicCollisionGrid,
// setup_config: config as any,   ← keep this line unchanged; `config` now
//                                   has the enriched seed from Step 11.2.
```

Do NOT modify any other field in the `worldState` insert (season, weather, tax_pool, rules embedded in time, etc.). Scope this edit narrowly to the three dimension/collision fields plus keeping `setup_config: config as any` in place.

- [ ] **Step 11.4: Delete unused imports**

If `generateHomes`, `getPublicBuildings`, `generateLocationsForAgentCount` are no longer referenced in `setup.ts`, remove them from the import. (They remain used by the `layout` stub stage internally.)

- [ ] **Step 11.5: Run existing setup tests**

Run: `cd /d/proyects/little-life && npx vitest run server/`
Expected: all tests still pass.

- [ ] **Step 11.6: Manual smoke — dev server starts cleanly**

Run: `cd /d/proyects/little-life && npx tsx server/index.ts`
Wait ~5s. Expected output includes: "Simulation tick loop started" / "Server listening on ws://localhost:3001". Kill with Ctrl-C.

- [ ] **Step 11.7: Commit**

```bash
cd /d/proyects/little-life
git add server/routers/setup.ts
git commit -m "feat(setup): delegate location generation to worldgen pipeline"
```

---

### Task 12: Integration test — determinism via `initialize`

**Files:**
- Create: `server/__tests__/setupInitialize.test.ts`

Spec §11.3 requires an end-to-end test: calling `initialize` twice with the same seed produces identical `locations`-table rows. Two tiers of coverage below — implement both.

- [ ] **Step 12.1: Look at existing test patterns**

Run: `cd /d/proyects/little-life && ls server/__tests__/ && cat server/__tests__/pathfindingCost.test.ts` — inspect how existing tests reference the DB. Note whether the test suite imports `db` directly from `../db` (live SQLite) or uses a mock.

If the suite uses live SQLite for all tests (likely the case), each test run writes to `data/little-life.db` directly. Tests that write must do so carefully — clear related tables before and after.

- [ ] **Step 12.2: Write integration test**

Create `server/__tests__/setupInitialize.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { locations, worldState } from '../db/schema';
import { setupRouter } from '../routers/setup';
import { generateWorld } from '../lib/worldgen';

/**
 * Tier 1 (pipeline-level): verify generateWorld determinism at the exact
 * boundary seedWorld consumes.
 */
describe('generateWorld determinism (pipeline boundary)', () => {
  it('produces identical locations with same seed + agents', () => {
    const cfg = { sizeTier: 'auto' as const, overrides: {}, seed: 'deterministic-xyz' };
    const agents = [
      { homeName: 'Home 1' }, { homeName: 'Home 2' }, { homeName: 'Home 3' },
      { homeName: 'Home 4' }, { homeName: 'Home 5' },
    ];
    const a = generateWorld(cfg, 10, { agents });
    const b = generateWorld(cfg, 10, { agents });
    expect(a.locations.length).toBe(b.locations.length);
    for (let i = 0; i < a.locations.length; i++) {
      expect(a.locations[i].name).toBe(b.locations[i].name);
      expect(a.locations[i].type).toBe(b.locations[i].type);
      expect(a.locations[i].position).toEqual(b.locations[i].position);
      expect(a.locations[i].entry_point).toEqual(b.locations[i].entry_point);
    }
    expect(a.dimensions).toEqual(b.dimensions);
    expect(a.collisionGrid).toBe(b.collisionGrid);
    expect(a.seed).toBe(b.seed);
  });

  it('produces different locations with different seeds', () => {
    const base = { sizeTier: 'auto' as const, overrides: {} };
    const a = generateWorld({ ...base, seed: 'alpha' }, 10);
    const b = generateWorld({ ...base, seed: 'beta' }, 10);
    const aHomes = a.locations.filter((l) => l.type === 'home');
    const bHomes = b.locations.filter((l) => l.type === 'home');
    const samePositions = aHomes.every((h, i) =>
      h.position.x === bHomes[i]?.position.x && h.position.y === bHomes[i]?.position.y);
    expect(samePositions).toBe(false);
  });
});

/**
 * Tier 2 (DB-level): call setupRouter.initialize twice with the same
 * worldgen.seed and assert the `locations` rows are identical.
 *
 * This test writes to the real SQLite DB. It must be run in isolation
 * (don't run in parallel with the dev server). After the test completes,
 * the DB is left in the state of the second initialize call, which
 * subsequent runs / the next dev-server start will overwrite via another
 * initialize or the restart flow.
 */
describe('initialize DB determinism', () => {
  // Build a minimal valid SetupConfig. Adjust field shapes to match the
  // actual Zod schema in server/routers/setup.ts — grep for AgentConfigSchema
  // if any of these fields are required.
  function makeSetupConfig(seed: string) {
    return {
      agents: [
        // Use the lowest-detail agents that still pass the schema. If the
        // schema requires full personality/traits arrays, fetch a fixture
        // from server/data/agents.ts AGENT_SEEDS and adapt.
      ] as any,
      relationships: [] as any,
      world: { season: 'spring', weather: 'sunny', startHour: 9, startDay: 1 },
      rules: {} as any,
      worldgen: { sizeTier: 'auto' as const, overrides: {}, seed },
    };
  }

  it('same seed → same locations rows across two initialize calls', async () => {
    // Use the real tRPC caller pattern. If setupRouter.initialize expects
    // a Zod-parsed input (not raw), route through the router's createCaller.
    const caller = setupRouter.createCaller({} as any);
    const seed = 'integration-deterministic';

    await caller.initialize(makeSetupConfig(seed) as any);
    const first = db
      .select({
        name: locations.name, type: locations.type,
        position: locations.position, entry_point: locations.entry_point,
      })
      .from(locations)
      .all();

    await caller.initialize(makeSetupConfig(seed) as any);
    const second = db
      .select({
        name: locations.name, type: locations.type,
        position: locations.position, entry_point: locations.entry_point,
      })
      .from(locations)
      .all();

    expect(second).toEqual(first);

    // Also verify the worldState seed was persisted.
    const ws = db.select({ setup_config: worldState.setup_config }).from(worldState).get();
    expect((ws?.setup_config as any)?.worldgen?.seed).toBe(seed);
  });
});
```

If the Tier 2 test fails because the agent/relationship schema requires richer fixtures, either:
(a) flesh out `makeSetupConfig` with real data from `server/data/agents.ts::AGENT_SEEDS`, or
(b) mark the Tier 2 test `it.skip(...)` with a comment explaining why and rely on Tier 1 + manual QA.

- [ ] **Step 12.3: Run**

Run: `cd /d/proyects/little-life && npx vitest run server/__tests__/setupInitialize.test.ts`
Expected: Tier 1 PASS. Tier 2 PASS if agent fixtures work; otherwise `it.skip`ed with a rationale comment.

- [ ] **Step 12.4: Commit**

```bash
cd /d/proyects/little-life
git add server/__tests__/setupInitialize.test.ts
git commit -m "test(setup): determinism at pipeline + initialize boundaries"
```

---

## Milestone 5 — TilemapRenderer dynamic dimensions

### Task 13: Add `resize` method to TilemapRenderer

**Files:**
- Modify: `src/components/canvas/TilemapRenderer.ts`
- Modify: `src/components/canvas/GameCanvas.tsx`

- [ ] **Step 13.1: Modify TilemapRenderer constructor + add resize + make renderBackground idempotent**

Read the entire `src/components/canvas/TilemapRenderer.ts` first (it's short). Preserve the existing `TILE_SIZE` import from `../../lib/spriteConfig` — do NOT remove it. Only remove the `MAP_WIDTH_TILES` / `MAP_HEIGHT_TILES` module-level constants.

Refactor:

```ts
// server/components/canvas/TilemapRenderer.ts
import * as PIXI from 'pixi.js';
import { TILE_SIZE } from '../../lib/spriteConfig';   // KEEP THIS IMPORT
// Any other existing imports stay.

// DELETE these two lines at top-of-file:
// const MAP_WIDTH_TILES = 60;
// const MAP_HEIGHT_TILES = 45;

export class TilemapRenderer {
  container: PIXI.Container;
  private labelContainer: PIXI.Container;
  private occupancyContainer: PIXI.Container;
  private openAreaContainer: PIXI.Container;

  private mapWidth: number = 0;
  private mapHeight: number = 0;

  /** Current background child (rect fallback OR tiling sprite). Tracked so
   *  resize() can remove-and-replace idempotently. */
  private bg: PIXI.Container | PIXI.Graphics | PIXI.TilingSprite | null = null;
  /** Monotonic generation counter — async texture loads compare this at
   *  resolution to detect "I'm stale because resize() was called again". */
  private bgGeneration = 0;

  constructor(_app: PIXI.Application) {
    this.container = new PIXI.Container();
    this.labelContainer = new PIXI.Container();
    this.occupancyContainer = new PIXI.Container();
    this.openAreaContainer = new PIXI.Container();
    this.openAreaContainer.eventMode = 'none';

    // Empty initial state — background rendered by first resize() call.
    this.container.addChild(this.openAreaContainer);
    this.container.addChild(this.labelContainer);
    this.container.addChild(this.occupancyContainer);
  }

  /** Called when worldState dimensions become available or change. Idempotent. */
  resize(widthTiles: number, heightTiles: number): void {
    const newW = widthTiles * TILE_SIZE;
    const newH = heightTiles * TILE_SIZE;
    if (newW === this.mapWidth && newH === this.mapHeight) return;
    this.mapWidth = newW;
    this.mapHeight = newH;
    this.renderBackground();
  }

  getMapSize(): { width: number; height: number } {
    return { width: this.mapWidth, height: this.mapHeight };
  }

  // setOpenAreaZones, updateOccupancy, destroy: unchanged

  private renderBackground(): void {
    // Cancel any in-flight async texture swap and remove the current bg.
    this.bgGeneration++;
    const myGeneration = this.bgGeneration;
    if (this.bg) {
      this.container.removeChild(this.bg);
      this.bg.destroy();
      this.bg = null;
    }
    if (this.mapWidth === 0 || this.mapHeight === 0) return;

    // 1. Sync fallback — solid dark-earth rect, renders immediately.
    const fallback = new PIXI.Graphics();
    fallback.rect(0, 0, this.mapWidth, this.mapHeight).fill(0x2d2a24);
    this.bg = fallback;
    this.container.addChildAt(fallback, 0);

    // 2. Async grass texture swap, if available (existing pattern in this
    //    file). If a concurrent resize() bumps bgGeneration, we drop the
    //    loaded texture rather than replacing the current bg.
    // (If the existing file has a loader utility, reuse it. Otherwise stub.)
    // Example using the same pattern as the existing file:
    // import { Assets } from 'pixi.js';
    // Assets.load('/textures/terrain_grass.png').then((tex) => {
    //   if (this.bgGeneration !== myGeneration) return;  // stale; drop
    //   if (this.bg) { this.container.removeChild(this.bg); this.bg.destroy(); }
    //   const sprite = new PIXI.TilingSprite({
    //     texture: tex,
    //     width: this.mapWidth,
    //     height: this.mapHeight,
    //   });
    //   this.bg = sprite;
    //   this.container.addChildAt(sprite, 0);
    // }).catch(() => { /* keep fallback */ });
  }
}
```

If the existing `renderBackground` body uses a different helper (e.g. `getTerrainTexture` from a local module), adapt the async block above to match — the critical change is: track `this.bg` + `this.bgGeneration`, remove-before-replace, and stale-check in the async `.then`. Do NOT leave two bg children stacked after a rapid second `resize()` call.

- [ ] **Step 13.2: Wire into GameCanvas**

First confirm the correct tRPC query name:

```bash
cd /d/proyects/little-life
grep -rn "trpc.world\." src | head
```

Expected output includes `trpc.world.getState.useQuery()` (used in `src/hooks/useWorldState.ts`). Use that. If the codebase already has a `useWorldState` hook that wraps this query, prefer consuming it.

Edit `src/components/canvas/GameCanvas.tsx`:

```tsx
// Near the top of the component, alongside other refs/state:
const worldQuery = trpc.world.getState.useQuery();
const mapW = worldQuery.data?.map_width ?? 0;
const mapH = worldQuery.data?.map_height ?? 0;

// In place of the current hardcoded camera.setMapSize(...) call after
// tilemap creation, move into a useEffect keyed on scalar dims (not the
// data object itself — scalar deps prevent render loops when React Query
// returns a new object reference with identical values):
useEffect(() => {
  if (!tilemapRef.current || !cameraRef.current) return;
  if (mapW === 0 || mapH === 0) return;
  tilemapRef.current.resize(mapW, mapH);
  const size = tilemapRef.current.getMapSize();
  cameraRef.current.setMapSize(size.width, size.height);
}, [mapW, mapH]);
```

Remove any existing hardcoded `camera.setMapSize(...)` line that ran right after tilemap construction — its job is now done by this effect.

Verify by grep after the edit: `cd /d/proyects/little-life && grep -n "camera.setMapSize\|setMapSize" src/components/canvas/GameCanvas.tsx` — there should be exactly one usage, inside the new `useEffect`.

- [ ] **Step 13.3: Run the client dev server**

Run: `cd /d/proyects/little-life && npm run dev`
Wait for Vite + server to boot. Expected: no crash. Open browser to http://localhost:5173/, confirm:
- The town renders.
- No console errors about undefined map dimensions.
- Camera bounds appear correct (zoom all the way out, see the full map with margin).

Kill the dev server with Ctrl-C.

- [ ] **Step 13.4: Commit**

```bash
cd /d/proyects/little-life
git add src/components/canvas/TilemapRenderer.ts src/components/canvas/GameCanvas.tsx
git commit -m "refactor(renderer): drive tilemap dimensions from worldState"
```

---

## Milestone 6 — SetupWizard integration

### Task 14: Add `previewWorld` tRPC mutation

**Files:**
- Modify: `server/routers/setup.ts`

- [ ] **Step 14.1: Add the mutation**

Inside `setupRouter` (router construction), add:

```ts
// Note: extend() must be called on the ZodObject form. WorldGenConfigSchema
// is a ZodEffects (refine-wrapped) and does not expose .extend().
previewWorld: publicProcedure
  .input(
    WorldGenConfigObjectSchema.extend({
      agentCount: z.number().int().min(1),
      previewAgentHomes: z
        .array(z.object({ homeName: z.string() }))
        .optional(),
    }),
  )
  .mutation(({ input }) => {
    const { agentCount, previewAgentHomes, ...cfg } = input;
    return generateWorld(cfg, agentCount, { agents: previewAgentHomes });
  }),
```

Add `WorldGenConfigObjectSchema` to the import added in Step 9.1 if not already there:

```ts
import { WorldGenConfigObjectSchema } from '../lib/worldgen/config';
```

- [ ] **Step 14.2: Typecheck**

Run: `cd /d/proyects/little-life && npx tsc --noEmit 2>&1 | grep "setup.ts" | head`
Expected: no new errors.

- [ ] **Step 14.3: Commit**

```bash
cd /d/proyects/little-life
git add server/routers/setup.ts
git commit -m "feat(setup): add previewWorld mutation"
```

---

### Task 15: Client types + WorldGenConfig defaults

**Files:**
- Modify: `src/components/setup/types.ts`

- [ ] **Step 15.1: Add WorldGenConfig type + defaults**

Append to `src/components/setup/types.ts`:

```ts
// ─── Worldgen ────────────────────────────────────────────────────────────────

export interface WorldGenOverrides {
  dimensions?: { width: number; height: number };
  homePositions?: Array<{ x: number; y: number }>;
}

export interface WorldGenConfig {
  seed?: string;
  sizeTier: 'medium' | 'large' | 'auto' | 'custom';
  customDimensions?: { width: number; height: number };
  overrides: WorldGenOverrides;
}

export const DEFAULT_WORLDGEN: WorldGenConfig = {
  sizeTier: 'auto',
  overrides: {},
};

// Size bounds — keep in sync with server/lib/worldgen/config.ts
export const WORLDGEN_MIN_WIDTH = 48;
export const WORLDGEN_MAX_WIDTH = 90;
export const WORLDGEN_MIN_HEIGHT = 37;
export const WORLDGEN_MAX_HEIGHT = 70;
```

Extend the existing `SetupConfig` interface to include `worldgen`:

```ts
export interface SetupConfig {
  agents: AgentConfig[];
  relationships: RelationshipConfig[];
  world: WorldConfig;
  rules: RulesConfig;
  worldgen: WorldGenConfig;  // NEW
}
```

- [ ] **Step 15.2: Commit**

```bash
cd /d/proyects/little-life
git add src/components/setup/types.ts
git commit -m "feat(setup/types): add WorldGenConfig + default"
```

---

### Task 16: `WorldPreview` canvas component

**Files:**
- Create: `src/components/setup/WorldPreview.tsx`

- [ ] **Step 16.1: Implement the component**

Create `src/components/setup/WorldPreview.tsx`:

```tsx
import { useEffect, useRef } from 'react';

interface GenLocation {
  name: string;
  type: string;
  position: { x: number; y: number; width: number; height: number };
  entry_point: { x: number; y: number };
}

interface GenResultLite {
  seed: string;
  dimensions: { width: number; height: number };
  locations: GenLocation[];
}

interface WorldPreviewProps {
  result: GenResultLite | null;
  /** Canvas display size in CSS pixels. */
  size?: { width: number; height: number };
}

const BG = '#2d2a24';
const HOME_COLOR = '#6b5b45';
const HOME_LABEL = '#a09070';
const DOOR_COLOR = '#c8a84b';
const BUILDING_COLORS: Record<string, string> = {
  shop: '#5a5040',
  tavern: '#7a4f35',
  clinic: '#d8e8e0',
  town_hall: '#7a6a4a',
  bakery: '#6B5B4A',
  workshop: '#4a4a42',
  prison: '#6A6A6A',
  farm: '#6b7c3a',
  park: '#4a6b3a',
  town_square: '#8a7a5a',
};

export function WorldPreview({ result, size = { width: 320, height: 240 } }: WorldPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, size.width, size.height);

    if (!result) {
      ctx.fillStyle = '#8a7f65';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Finish setup to preview world', size.width / 2, size.height / 2);
      return;
    }

    // Scale world px → canvas px. World is dimensions.width * 32 px wide.
    const worldW = result.dimensions.width * 32;
    const worldH = result.dimensions.height * 32;
    const scale = Math.min(size.width / worldW, size.height / worldH);
    const offsetX = (size.width - worldW * scale) / 2;
    const offsetY = (size.height - worldH * scale) / 2;

    const toCanvasX = (x: number) => offsetX + x * scale;
    const toCanvasY = (y: number) => offsetY + y * scale;

    // Map frame.
    ctx.strokeStyle = '#3d3a2e';
    ctx.strokeRect(offsetX, offsetY, worldW * scale, worldH * scale);

    // Buildings.
    for (const loc of result.locations) {
      const isHome = loc.type === 'home';
      ctx.fillStyle = isHome ? HOME_COLOR : (BUILDING_COLORS[loc.type] ?? '#4a3f2e');
      ctx.fillRect(
        toCanvasX(loc.position.x),
        toCanvasY(loc.position.y),
        loc.position.width * scale,
        loc.position.height * scale,
      );

      // Home number label
      if (isHome) {
        const match = loc.name.match(/Home (\d+)/);
        if (match) {
          ctx.fillStyle = HOME_LABEL;
          ctx.font = '6px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            match[1],
            toCanvasX(loc.position.x + loc.position.width / 2),
            toCanvasY(loc.position.y + loc.position.height / 2),
          );
        }
      }

      // Entry point dot
      ctx.fillStyle = DOOR_COLOR;
      ctx.beginPath();
      ctx.arc(toCanvasX(loc.entry_point.x), toCanvasY(loc.entry_point.y), 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [result, size.width, size.height]);

  return (
    <canvas
      ref={canvasRef}
      width={size.width}
      height={size.height}
      style={{ border: '1px solid #3d3a2e', imageRendering: 'pixelated' }}
    />
  );
}
```

- [ ] **Step 16.2: Commit**

```bash
cd /d/proyects/little-life
git add src/components/setup/WorldPreview.tsx
git commit -m "feat(setup): WorldPreview canvas component"
```

---

### Task 17: `WorldLayout` wizard step

**Files:**
- Create: `src/components/setup/WorldLayout.tsx`

- [ ] **Step 17.1: Implement the component**

Create `src/components/setup/WorldLayout.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { trpc } from '../../lib/trpc';
import { WorldPreview } from './WorldPreview';
import {
  type WorldGenConfig,
  type AgentConfig,
  WORLDGEN_MIN_WIDTH,
  WORLDGEN_MAX_WIDTH,
  WORLDGEN_MIN_HEIGHT,
  WORLDGEN_MAX_HEIGHT,
} from './types';

interface WorldLayoutProps {
  config: WorldGenConfig;
  onChange: (cfg: WorldGenConfig) => void;
  agents: AgentConfig[];
}

function randomSeed(len = 8): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export function WorldLayout({ config, onChange, agents }: WorldLayoutProps) {
  const previewMutation = trpc.setup.previewWorld.useMutation();
  const [previewResult, setPreviewResult] = useState<any>(null);
  const [seedDraft, setSeedDraft] = useState<string>(config.seed ?? '');

  const agentCount = agents.length;
  const previewAgentHomes = agents.map((a) => ({ homeName: a.homeName }));

  // Auto-preview on mount + whenever scalar config changes. Note: depend on
  // scalar values, NOT objects like config.customDimensions or
  // previewAgentHomes — object identity changes on every render and would
  // cause a mutation-fire loop.
  const customW = config.customDimensions?.width ?? 0;
  const customH = config.customDimensions?.height ?? 0;
  // Stable, value-based signature for the agent list so reordering triggers refresh.
  const homeNamesKey = agents.map((a) => a.homeName).join('|');

  useEffect(() => {
    if (agentCount === 0) {
      setPreviewResult(null);
      return;
    }
    previewMutation.mutate(
      {
        ...config,
        agentCount,
        previewAgentHomes,
      },
      {
        onSuccess: (result) => {
          setPreviewResult(result);
          // If the preview generated a seed, surface it so the user sees what was used.
          if (!config.seed && result.seed) setSeedDraft(result.seed);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.seed, config.sizeTier, customW, customH, agentCount, homeNamesKey]);

  const handleRegenerate = () => {
    const seed = seedDraft.trim() || randomSeed();
    setSeedDraft(seed);
    onChange({ ...config, seed });
  };

  const handleSeedCommit = () => {
    onChange({ ...config, seed: seedDraft.trim() || undefined });
  };

  const handleCopySeed = async () => {
    if (!seedDraft) return;
    await navigator.clipboard.writeText(seedDraft);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-white">World Layout</h2>

      <div className="flex gap-8">
        <div className="flex-1 space-y-4">
          {/* Seed input */}
          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wide">Seed</label>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm font-mono"
                placeholder="blank = random per regenerate"
                value={seedDraft}
                onChange={(e) => setSeedDraft(e.target.value)}
                onBlur={handleSeedCommit}
              />
              <button
                onClick={handleCopySeed}
                disabled={!seedDraft}
                className="px-2 py-1 text-xs text-gray-400 hover:text-white disabled:opacity-30"
                title="Copy seed to clipboard"
              >
                copy
              </button>
            </div>
          </div>

          {/* Size tier */}
          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wide">Size</label>
            <select
              className="mt-1 w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
              value={config.sizeTier}
              onChange={(e) => onChange({ ...config, sizeTier: e.target.value as WorldGenConfig['sizeTier'] })}
            >
              <option value="auto">Auto (scales with agents)</option>
              <option value="medium">Medium (60 × 45)</option>
              <option value="large">Large (80 × 60)</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          {config.sizeTier === 'custom' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Width</label>
                <input
                  type="number"
                  min={WORLDGEN_MIN_WIDTH} max={WORLDGEN_MAX_WIDTH}
                  className="mt-1 w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
                  value={config.customDimensions?.width ?? WORLDGEN_MIN_WIDTH}
                  onChange={(e) =>
                    onChange({
                      ...config,
                      customDimensions: {
                        width: Number(e.target.value),
                        height: config.customDimensions?.height ?? WORLDGEN_MIN_HEIGHT,
                      },
                    })
                  }
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Height</label>
                <input
                  type="number"
                  min={WORLDGEN_MIN_HEIGHT} max={WORLDGEN_MAX_HEIGHT}
                  className="mt-1 w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
                  value={config.customDimensions?.height ?? WORLDGEN_MIN_HEIGHT}
                  onChange={(e) =>
                    onChange({
                      ...config,
                      customDimensions: {
                        width: config.customDimensions?.width ?? WORLDGEN_MIN_WIDTH,
                        height: Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleRegenerate}
              disabled={agentCount === 0 || previewMutation.isPending}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm disabled:opacity-30"
            >
              Regenerate
            </button>
            {previewMutation.isPending && (
              <span className="text-xs text-gray-500 self-center">Generating…</span>
            )}
          </div>

          {previewMutation.error && (
            <div className="text-xs text-red-400">{previewMutation.error.message}</div>
          )}
        </div>

        <WorldPreview result={previewResult} />
      </div>
    </div>
  );
}
```

- [ ] **Step 17.2: Commit**

```bash
cd /d/proyects/little-life
git add src/components/setup/WorldLayout.tsx
git commit -m "feat(setup): WorldLayout wizard step"
```

---

### Task 18: Wire step into `SetupWizard`

**Files:**
- Modify: `src/components/setup/SetupWizard.tsx`

- [ ] **Step 18.1: Add imports + state**

In `SetupWizard.tsx`:

```tsx
import { WorldLayout } from './WorldLayout';
import { DEFAULT_WORLDGEN, type WorldGenConfig } from './types';
```

Add a state variable inside the component:

```tsx
const [worldgen, setWorldgen] = useState<WorldGenConfig>(DEFAULT_WORLDGEN);
```

- [ ] **Step 18.2: Insert step into STEPS list**

Between `'preview'` and `'agents'`:

```tsx
const STEPS = [
  { id: 'scenario', label: 'Scenario', icon: 'S' },
  { id: 'preview', label: 'Preview', icon: 'P' },
  { id: 'worldlayout', label: 'World Layout', icon: 'L' },  // NEW
  { id: 'agents', label: 'Agents', icon: 'A' },
  { id: 'relationships', label: 'Relationships', icon: 'R' },
  { id: 'world', label: 'World', icon: 'W' },
  { id: 'rules', label: 'Rules', icon: 'S' },
] as const;
```

- [ ] **Step 18.3: Render the step**

Add inside the content area:

```tsx
{step === 'worldlayout' && (
  <WorldLayout config={worldgen} onChange={setWorldgen} agents={agents} />
)}
```

- [ ] **Step 18.4: Pass `worldgen` to initMutation**

Modify `handleStart`:

```tsx
await initMutation.mutateAsync({ agents, relationships, world, rules, worldgen });
```

- [ ] **Step 18.5: Run dev server, manual smoke**

Run: `cd /d/proyects/little-life && npm run dev`
Open http://localhost:5173/. Navigate through the wizard:
- Step forward from Scenario → Preview → World Layout.
- World Layout step renders with preview canvas.
- Click Regenerate a few times — layout changes visibly.
- Type a seed ("hello"), Regenerate → specific layout. Clear seed, Regenerate → new random.
- Switch size tier — preview updates.
- Switch to Custom → width/height inputs appear, editable.
- Go back to Agents, forward through to Review, click Start Simulation. World loads with the chosen layout.

Kill dev server.

- [ ] **Step 18.6: Commit**

```bash
cd /d/proyects/little-life
git add src/components/setup/SetupWizard.tsx
git commit -m "feat(setup): integrate WorldLayout step into SetupWizard"
```

---

## Milestone 7 — Full test pass + release notes

### Task 19: Run complete test suite

- [ ] **Step 19.1: Run all tests**

Run: `cd /d/proyects/little-life && npx vitest run 2>&1 | tail -20`
Expected: all tests pass. Required baseline: existing 333 + new worldgen tests (~40 unit + 3 property cases + 2 integration) = ~380 total. If any existing test breaks, halt and investigate before continuing.

- [ ] **Step 19.2: Manual QA checklist (spec §11.5)**

Run dev server. Walk through:

1. ✅ Wizard → Auto size, seed blank → preview renders → Regenerate → layout changes.
2. ✅ Type seed `hello` → Regenerate → specific layout. Refresh page + same seed → identical layout.
3. ✅ Custom size at MIN (48×37) with 30 agents → FitError surfaces as clear error.
4. ✅ Auto + 30 agents → formula produces ~84×59; layout fits.
5. ✅ Initialize → restart → identical world (via devtools watch agent positions across restart).
6. ✅ Load a pre-Phase-1 saved world (if you have one) → one-time layout shift on first restart.

If manual QA passes, continue. If something fails, investigate before the release commit.

---

### Task 20: Release notes + memory entry

**Files:**
- Modify: `C:\Users\nahue\.claude\projects\D--Claude\memory\project_little_life.md`

- [ ] **Step 20.1: Append phase note to project memory**

Append a section to the Little Life memory file:

```markdown
## Phase 10 — Procedural World Framework (2026-04-16)

- New `server/lib/worldgen/` module: seeded linear pipeline with pure-function stages. Phase 1 ships real `dimensions` + `homes` generators; `terrain`, `layout`, `interiors`, `names` are stubs that return today's hardcoded data.
- Hybrid seed: user-typed or auto-generated `randomBase62(8)`, persisted in `worldState.setup_config.worldgen.seed`. Same seed → identical `locations` rows on restart.
- `SetupWizard` gains "World Layout" step between Preview and Agents. Seed input + size tier (Medium/Large/Auto/Custom) + Canvas-2D schematic preview + Regenerate button (mutation, not query — avoids React Query caching).
- Constants `MAP_WIDTH`/`MAP_HEIGHT` renamed → `DEFAULT_MAP_WIDTH`/`DEFAULT_MAP_HEIGHT`. Compat re-exports kept for one release. `TilemapRenderer` refactored to `resize(w, h)` driven from `worldState`.
- Auto-expand on FitError (20% per attempt, max 3 attempts, cap at MAX_WIDTH=90 / MAX_HEIGHT=70). No-change detection aborts early.
- One-time migration: pre-Phase-1 saved worlds get a new random seed on first restart → one-time home layout shift. All other state preserved.
- Tests: ~40 new unit + 300-case property suite + 2 integration, 380 total passing.
- Phase 2 (Settlement Layout: building mix + placement + roads) follows its own spec cycle.
```

- [ ] **Step 20.2: Final commit**

Memory file lives outside the project repo (at `C:\Users\nahue\.claude\projects\D--Claude\memory\project_little_life.md`) so it is NOT staged via the project's `git add`. If there are any remaining unstaged files from this phase inside the project repo, stage them explicitly by name (never `git add .`):

```bash
cd /d/proyects/little-life
git status                             # inspect unstaged changes
# git add <specific files>             # only files confirmed to belong to Phase 1
git commit -m "docs(worldgen): Phase 1 complete — release note

Seeded world generation framework shipped:
- server/lib/worldgen pipeline with dimensions + homes stages
- SetupWizard World Layout step with preview + Regenerate
- MAP_WIDTH/HEIGHT refactor with compat re-exports
- One-time layout shift on first restart for pre-Phase-1 saved worlds

See docs/superpowers/specs/2026-04-16-procedural-world-framework-design.md
for design, docs/superpowers/plans/2026-04-16-procedural-world-framework.md
for the implementation plan.

Phase 2 (Settlement Layout) kicks off with a new spec."
```

---

## Notes for executors

- **TDD discipline**: write every test BEFORE its implementation. Verify the test fails before writing code. This is the most reliable way to catch the subtle bugs in this spec (off-by-one in the home fit predicate, `expandPin` leaking into `cfg.overrides`, etc.).
- **Commits are cheap**: commit per task step if unsure. Merge later via interactive rebase if desired.
- **If a step doesn't fit reality**: a reference in this plan (line numbers, function names) may have drifted since the plan was written. Search + confirm before blindly editing. Re-read the spec when in doubt.
- **Don't widen scope**: every temptation to "just also fix Phase 2 while I'm here" is wrong. Phase 2 ships via its own spec cycle.
- **Related skills**: @superpowers:test-driven-development (for writing tests), @superpowers:systematic-debugging (if any task breaks existing tests).
