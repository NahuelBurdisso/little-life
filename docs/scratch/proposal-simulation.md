# Proposal: Simulation Truth First
Branch: feat/procedural-world-phase2 | Priority: HIGH findings first, LOW last.

---

## 1. Grid / Data Fix Plan (A1–A9)

**Invariant definition** (enforced by new tests, section 2):
- `zone.furniture.tile` must hold grid value `2`.
- `zone.center` must hold grid value `0` or `3`.
- Chebyshev distance between `zone.center` and `zone.furniture.tile` must be `<= 1`.
- Every grid cell with value `2` must be referenced by exactly one zone's `furniture.tile`.

---

### A1 + A7 + A9 — divebar booth + orphan cells

Current grid (5w × 4h):
```
row0: [1, 1, 1, 1, 1]
row1: [1, 2, 0, 0, 1]   ← [1,1] = Bar Counter (OK)
row2: [1, 0, 0, 2, 1]   ← [3,2] = orphan (A9); booth center claims [3,2]
row3: [1, 1, 3, 1, 1]
```

The booth zone has `furniture.tile [3,1]` (floor, value 0 — A7) and `center [3,2]` (furniture
cell, value 2 — A1). The booth tile `[3,1]` is also floor, never furniture. Fix: move the
Booth Seat furniture cell from wherever it isn't to `[3,2]`, then set `center` to the
adjacent floor tile `[2,2]`.

**New divebar grid:**
```
row0: [1, 1, 1, 1, 1]
row1: [1, 2, 0, 0, 1]   ← [1,1] Bar Counter
row2: [1, 0, 0, 2, 1]   ← [3,2] Booth Seat  (no change to bytes)
row3: [1, 1, 3, 1, 1]
```
The grid bytes are already correct. Only the zone data changes:

```ts
// divebar booth zone — replace existing entry
{
  id: 'booth', name: 'Booth', label: 'Booth',
  tiles: [[2, 2], [3, 2]],
  center: [2, 2],          // floor tile, Chebyshev 1 from [3,2]
  furniture: { label: 'Booth Seat', tile: [3, 2] },  // grid value = 2 ✓
  maxOccupants: 2, color: 0x5C3D2E,
  allowedActions: ['drink', 'socialize', 'scheme'],
  visibility: 0.3,
  relativePosition: tilesToRelPos([[2, 2], [3, 2]]),
},
```
A9 (orphan `[3,2]`) is resolved — booth now owns it. A1, A7, A9 closed.

---

### A2 + A3 — home bed / kitchen furniture cells

Home has no `INTERIOR_GRIDS[home]` entry (intentional — 3×3 uses lerp fallback). However
`furniture.tile` pointing to e.g. `[0,0]` is meaningless and breaks the invariant because
no grid exists to validate against.

**Fix:** Mark home furniture tiles as `[-1, -1]` sentinel meaning "decorative / grid-exempt".
Add a single guard to the invariant test: skip Chebyshev check when `furniture.tile[0] === -1`.
This documents the exception without pretending the grid exists.

```ts
// home bed zone
furniture: { label: 'Bed', tile: [-1, -1] },   // grid-exempt sentinel
// home kitchen zone
furniture: { label: 'Stove', tile: [-1, -1] },
```

No grid changes. The renderer already uses zone data (not the grid) to decide whether to
draw the Bed sprite; the sentinel does not affect rendering.

---

### A4 — town_hall meeting_table furniture.tile

Current grid (6w × 5h):
```
row0: [1, 1, 1, 1, 1, 1]
row1: [1, 2, 0, 0, 0, 1]   ← [1,1] Mayor's Desk
row2: [1, 0, 0, 0, 2, 1]   ← [4,2] Filing Cabinet
row3: [1, 0, 0, 0, 0, 1]
row4: [1, 1, 1, 3, 1, 1]
```

`meeting_table` claims `furniture.tile [3,1]` which is `0` (floor). There is no furniture
cell in row 1 other than `[1,1]` (Mayor's Desk). The meeting table needs its own furniture
cell. Promote `[3,1]` to furniture (`2`), making it a visual table block; set `center` to
adjacent walkable `[2,1]` (still floor).

**New town_hall grid:**
```
row0: [1, 1, 1, 1, 1, 1]
row1: [1, 2, 0, 2, 0, 1]   ← [1,1] Mayor's Desk, [3,1] Meeting Table
row2: [1, 0, 0, 0, 2, 1]   ← [4,2] Filing Cabinet
row3: [1, 0, 0, 0, 0, 1]
row4: [1, 1, 1, 3, 1, 1]
```

```ts
// town_hall meeting_table zone
tiles: [[2, 1], [3, 1], [4, 1]],
center: [2, 1],              // floor tile ✓
furniture: { label: 'Meeting Table', tile: [3, 1] },  // grid value = 2 ✓
```

Agent stands at `[2,1]` facing right toward the table cell at `[3,1]`. Chebyshev = 1. A4 closed.

---

### A5 — town_hall records (Filing Cabinet Chebyshev 3)

Current: `records` zone has `center [1,3]` and `furniture.tile [4,2]`.
Chebyshev distance = max(|4-1|, |2-3|) = 3. Invariant requires ≤ 1.

`[4,2]` is already `2` in the new grid above. Move `center` to `[3,2]` (floor, Chebyshev 1
from `[4,2]`). Update tiles list to reflect the actual usable floor tiles near the cabinet.

```ts
// town_hall records zone
tiles: [[3, 2], [4, 2], [3, 3], [4, 3]],
center: [3, 2],              // floor tile ✓, Chebyshev 1 from [4,2] ✓
furniture: { label: 'Filing Cabinet', tile: [4, 2] },
```

A5 closed.

---

### A6 — workshop forge (no furniture cell in grid)

Current grid (5w × 4h):
```
row0: [1, 1, 1, 1, 1]
row1: [1, 2, 0, 2, 1]   ← [1,1] Workbench, [3,1] Tool Rack
row2: [1, 0, 0, 0, 1]
row3: [1, 1, 3, 1, 1]
```

Forge zone claims `furniture.tile [3,2]` which is `0` (floor). Fix: promote `[3,2]` to `2`.

**New workshop grid:**
```
row0: [1, 1, 1, 1, 1]
row1: [1, 2, 0, 2, 1]   ← [1,1] Workbench, [3,1] Tool Rack
row2: [1, 0, 0, 2, 1]   ← [3,2] Forge
row3: [1, 1, 3, 1, 1]
```

```ts
// workshop forge zone
tiles: [[2, 2], [3, 2]],
center: [2, 2],              // floor tile ✓, Chebyshev 1 from [3,2] ✓
furniture: { label: 'Forge', tile: [3, 2] },  // grid value = 2 ✓
```

A6 closed.

---

### A8 — prison orphan cell [3,1]

Current grid:
```
row1: [1, 2, 0, 2, 1]   ← [1,1] Guard Desk, [3,1] orphan
```

No zone's `furniture.tile` claims `[3,1]`. Two options: (a) assign it to `cell_1` zone as a
Bed/cot, or (b) convert it back to floor and tighten the cell zone. Option (a) is richer.

```ts
// prison cell_1 zone — add furniture claim
{
  id: 'cell_1', ...
  tiles: [[3, 1], [3, 2]],
  center: [3, 2],           // floor tile ✓
  furniture: { label: 'Guard Desk', tile: [3, 1] },
  // rename label to 'Cot' — but that requires a new furniture label; keep 'Guard Desk'
  // is wrong semantically. Better: rename zone to 'evidence_shelf', keep grid.
}
```

Simplest correct fix: rename the furniture in that cell to a new label `Bunk Bed` and add it
to the furniture label registry (needs textures.ts + interactionRegistry + test). Because
introducing a new label carries test-bundle cost (section 6 defines the rule), and this
finding is LOW priority, the minimum fix is to remove the orphan cell by converting it to
floor:

**New prison grid:**
```
row1: [1, 2, 0, 0, 1]   ← [3,1] demoted to floor
```

A8 closed with zero new labels.

---

## 2. Invariant Test Suite — `server/__tests__/interiorDataIntegrity.test.ts`

Follows the patterns of `interiorGrid.test.ts` (import from `../data/interiors`,
describe/it/expect, no async). Add alongside existing tests.

```ts
import { describe, it, expect } from 'vitest';
import { INTERIOR_GRIDS, INTERIOR_ZONES } from '../data/interiors';
import { FURNITURE_URLS } from '../../src/components/canvas/textures';        // re-export needed
import { INTERACTION_REGISTRY } from '../data/interactionRegistry';
import { ACTION_ZONE_REQUIREMENTS } from '../data/interiors';

// Helper: all zone furniture labels across all building types
function allFurnitureLabels(): string[] {
  return Object.values(INTERIOR_ZONES)
    .flat()
    .filter(z => z.furniture && z.furniture.tile[0] !== -1)
    .map(z => z.furniture!.label);
}

describe('furniture label coherence', () => {
  it('every furniture label with a real tile has a textures.ts entry OR is in ACTION_ZONE_REQUIREMENTS', () => {
    const actionZoneLabels = new Set(
      Object.values(ACTION_ZONE_REQUIREMENTS).flatMap(b => Object.values(b).flat())
    );
    for (const label of allFurnitureLabels()) {
      const key = label.toLowerCase().replace(/ /g, '_');
      const hasTexture = key in FURNITURE_URLS;                          // textures.ts
      const hasAction = actionZoneLabels.has(label);                     // interiors.ts zones
      // At minimum the zone it lives in must have an allowedAction; checked separately
      expect(hasTexture || hasAction, `label "${label}" has no texture and no zone action`).toBe(true);
    }
  });
});

describe('zone center walkability', () => {
  it('zone.center is a floor tile (0) in INTERIOR_GRIDS for closed buildings', () => {
    for (const [type, zones] of Object.entries(INTERIOR_ZONES)) {
      const grid = INTERIOR_GRIDS[type];
      if (!grid) continue;  // home / open areas exempt
      for (const zone of zones) {
        const [cx, cy] = zone.center;
        const cell = grid[cy]?.[cx];
        expect(cell, `${type}:${zone.id} center [${cx},${cy}] must be walkable (0 or 3)`).toSatisfy(
          (v: number) => v === 0 || v === 3
        );
      }
    }
  });

  it('zone.furniture.tile is a furniture cell (2) in INTERIOR_GRIDS', () => {
    for (const [type, zones] of Object.entries(INTERIOR_ZONES)) {
      const grid = INTERIOR_GRIDS[type];
      if (!grid) continue;
      for (const zone of zones) {
        if (!zone.furniture || zone.furniture.tile[0] === -1) continue;
        const [fx, fy] = zone.furniture.tile;
        expect(grid[fy]?.[fx], `${type}:${zone.id} furniture.tile [${fx},${fy}] must be 2`).toBe(2);
      }
    }
  });

  it('zone.center is Chebyshev <= 1 from zone.furniture.tile', () => {
    for (const [type, zones] of Object.entries(INTERIOR_ZONES)) {
      for (const zone of zones) {
        if (!zone.furniture || zone.furniture.tile[0] === -1) continue;
        const [cx, cy] = zone.center;
        const [fx, fy] = zone.furniture.tile;
        const cheby = Math.max(Math.abs(cx - fx), Math.abs(cy - fy));
        expect(cheby, `${type}:${zone.id} center too far from furniture`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('no orphan furniture cells', () => {
  it('every grid cell=2 is claimed by exactly one zone.furniture.tile', () => {
    for (const [type, grid] of Object.entries(INTERIOR_GRIDS)) {
      const zones = INTERIOR_ZONES[type] ?? [];
      const claimed = new Set(
        zones.filter(z => z.furniture && z.furniture.tile[0] !== -1)
             .map(z => `${z.furniture!.tile[0]},${z.furniture!.tile[1]}`)
      );
      for (let row = 0; row < grid.length; row++) {
        for (let col = 0; col < grid[row].length; col++) {
          if (grid[row][col] === 2) {
            expect(claimed.has(`${col},${row}`),
              `${type} cell [${col},${row}]=2 has no owner zone`).toBe(true);
          }
        }
      }
    }
  });
});
```

Note: `FURNITURE_URLS` must be re-exported from `textures.ts` (add `export const FURNITURE_URLS`
to the existing const). This is the single cross-boundary import required.

---

## 3. Agents Visibly Using Furniture Truthfully

### Standing tile

`decisions.ts:1227` already places the agent at `locPos + zone.center * 32 + 16`. After the
fixes in section 1, `zone.center` is always a walkable floor tile adjacent to the furniture.
Standing position is therefore already correct post-fix — no code change needed.

### Facing direction (not currently tracked)

Minimal derivation without adding a DB column:

**Client-side only.** In `AgentSprite.ts`, when rendering an agent whose `current_action.type`
is `sleeping`, `working`, `eating`, `craft`, `smith`, or `bake`, derive facing from:

```
facing = atan2(furniture.tile.y - center.y, furniture.tile.x - center.x)
```

Pass `zone.furniture.tile` and `zone.center` as part of the action payload already stored in
`current_action` (it carries `targetZone` + `targetBuildingType`). Look up the zone def
client-side from `INTERIOR_ZONES` (already imported by `BuildingRenderer`) and compute facing
locally. No server round-trip, no new DB column.

Store the computed facing in `AgentSprite` local state (a `number` in radians). Apply as a
rotation offset to the sprite. Since sprites are single-frame 32×32 circles, rotation has no
visual effect on the body — but it does rotate the state ring and mood ring, giving a
directional hint.

### Sleep / sit / use pose (C2)

Single-frame 32×32 agents cannot show directional sprites. Use **overlay glyphs** from the
existing art bible (Section 5, Action Communication) already spec'd but not yet wired:

| Action | Overlay |
|--------|---------|
| sleeping | `zz` text replaces initial; outline dims 40% |
| eating | fork glyph replaces initial |
| working / craft / smith | spinning arc (already spec'd) |
| sitting (socialize in booth/tavern) | no existing spec — add: lower the agent Y by 4px ("seated offset") |

Implementation: `AgentSprite.ts` reads `agent.current_action.type` and applies the overlay.
The sleeping `zz` and eating fork are already in the art bible; wire them in `AgentSprite`
label layer. The seated offset (4px) is a one-liner position nudge when `current_action.type`
is `socialize`/`drink`/`eat`/`gamble` inside a booth or tables zone.

---

## 4. Home Lerp Wall-Clip Fix (C3)

`movement.ts:235-256` falls through to lerp when `getInteriorGrid` returns null. For `home`,
this means a straight-line transition from door position to zone center, which clips through
the home's synthetic walls in the renderer.

**Fix:** Add a synthetic 3×3 interior grid for `home` to `INTERIOR_GRIDS`:

```ts
// Home — 3w × 3h. No real door cell (home entry is special-cased).
// Use col 1 row 2 as the logical door to satisfy the door-uniqueness test.
home: [
  [0, 0, 0],   // row 0: bed (left), stove (right) — all floor for A*
  [0, 0, 0],   // row 1: living room
  [0, 3, 0],   // row 2: door at col 1 (south edge)
],
```

All cells are `0` (no furniture cells in the 3×3 — home furniture is zone-data-only per
the A2/A3 fix). The door at `[1,2]` satisfies the existing test
`every closed-building grid has its door on the south edge`. The existing test
`home has no grid (uses lerp fallback)` must be **deleted or updated** — change it to:

```ts
it('home has a grid with door at south edge col 1', () => {
  const info = getInteriorGrid('home')!;
  expect(info).not.toBeNull();
  expect(info.doorTile).toEqual([1, 2]);
});
```

With a valid grid, `movement.ts:178-233` (the interior A* branch) fires for homes, routing
the agent through valid floor tiles instead of lerping through walls. The lerp fallback
(lines 235-256) becomes dead code for home but remains correct for any future building type
that genuinely lacks a grid.

**A* reachability check:** all 9 cells are `0` or `3`; no cell is `1` or `2`. Every zone
center (`[0,0]`, `[2,0]`, `[1,1]`) is reachable from door `[1,2]` in at most 2 steps.

---

## 5. Home Variety (C1)

Three grid variants, selected at world-gen time and stored in building metadata. Zone ids
and allowedActions are identical across variants — sim logic reads zones, not grids directly.

All use the `home` synthetic grid (section 4). Variant selection happens in
`worldgen/stages/interiors.ts` based on `rng.next() % 3`.

### Variant A — Studio (current layout, now named)
```
Bed [0,0][1,0] | Stove [2,0]
Living [0,1][1,1][2,1]
```
Bed zone left, kitchen zone right, shared living bottom row.

### Variant B — Split Bedroom
```
Bed [0,0]     | Living [1,0][2,0]
Kitchen [0,1] | Living [1,1][2,1]
```
Zone tile changes only; zone ids (`bed`, `kitchen`, `living`) unchanged.
```ts
// variant B zones (partial)
bed:     { tiles: [[0,0]], center: [0,0], furniture: { label:'Bed', tile:[-1,-1] } },
kitchen: { tiles: [[0,1]], center: [0,1], furniture: { label:'Stove', tile:[-1,-1] } },
living:  { tiles: [[1,0],[2,0],[1,1],[2,1]], center: [1,1] },
```

### Variant C — Loft
```
Living [0,0][1,0] | Bed [2,0]
Living [0,1]      | Kitchen [1,1][2,1]
```
```ts
bed:     { tiles: [[2,0]], center: [2,0], furniture: { label:'Bed', tile:[-1,-1] } },
kitchen: { tiles: [[1,1],[2,1]], center: [2,1], furniture: { label:'Stove', tile:[-1,-1] } },
living:  { tiles: [[0,0],[1,0],[0,1]], center: [0,1] },
```

Variant is stored as `building.metadata.homeVariant: 'A'|'B'|'C'` (integer in existing
`metadata` JSON column). `INTERIOR_ZONES` receives a new export
`HOME_ZONE_VARIANTS: Record<'A'|'B'|'C', ZoneDef[]>` replacing the single `home` key.
The existing `INTERIOR_ZONES.home` becomes an alias for variant A for backward compat.

---

## 6. Needs Outlets — Comfort Gap

### Current state
`needs.ts` decays `comfort` at `1.2×` during `working` and restores it via `idle` (`-1.0`),
`rest` (`-1.2`), and the zone activities `contemplate` (`-1.5`) and `jog` (`-1.8`). The park
`benches` zone already lists `comfort` in `allowedActions`. However `ACTION_ZONE_REQUIREMENTS`
has no entry for `comfort` → `findAvailableZone` never routes an agent there.

### Decision: use the park bench that already exists

The `park.benches` zone (`tiles [[0,3],[1,3]]`, `center [1,3]`) already supports `comfort`
and `people_watch`. No new furniture cell or sprite is needed. The fix is:

**1. Add to `ACTION_ZONE_REQUIREMENTS`:**
```ts
comfort: { park: ['benches'] },
```

**2. Add `comfort` action modifier to `needs.ts ACTION_MODIFIERS`:**
```ts
comfort: { hunger: 0.8, energy: -0.3, social: -0.5, comfort: -2.5, fun: -0.8 },
```

**3. Wire comfort as a driveable need:** In `decisions.ts`, add `comfort` to the need-threshold
decision list (alongside `hunger`, `energy`, `social`). When `agentNeeds.comfort < 35`, the
agent considers going to the park bench. The threshold keeps it optional — comfort is not
urgent.

**Test bundle** (one describe block added to `interiorDataIntegrity.test.ts`):
```ts
describe('comfort outlet reachability', () => {
  it('ACTION_ZONE_REQUIREMENTS has comfort mapped to park benches', () => {
    expect(ACTION_ZONE_REQUIREMENTS.comfort?.park).toContain('benches');
  });
  it('park benches zone allows comfort action', () => {
    const bench = INTERIOR_ZONES.park.find(z => z.id === 'benches');
    expect(bench?.allowedActions).toContain('comfort');
  });
});
```

No new furniture label, no new sprite, no new grid cell. Passes all three invariant gates
(label in zones, zone in ACTION_ZONE_REQUIREMENTS, no orphan cell).

---

## Summary — Change Surface

| File | Change |
|------|--------|
| `server/data/interiors.ts` | divebar booth center+tile; home bed/kitchen tile→[-1,-1]; town_hall grid+meeting_table+records zone; workshop grid+forge center; prison grid (demote orphan); home synthetic grid added; HOME_ZONE_VARIANTS export; ACTION_ZONE_REQUIREMENTS comfort entry |
| `server/engine/systems/needs.ts` | Add `comfort` action modifier row |
| `server/engine/systems/decisions.ts` | Add comfort to need-threshold list |
| `src/components/canvas/AgentSprite.ts` | Wire sleeping/eating/working overlays; seated Y offset; client-side facing derivation |
| `src/components/canvas/textures.ts` | Export `FURNITURE_URLS` (add `export`) |
| `server/__tests__/interiorGrid.test.ts` | Update home grid test |
| `server/__tests__/interiorDataIntegrity.test.ts` | New file (section 2 + comfort block) |
| `server/lib/worldgen/stages/interiors.ts` | HOME_ZONE_VARIANTS selection by rng |
