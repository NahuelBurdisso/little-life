# Interior Pathfinding & Zone-Bound Actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-building interior collision grids with A* pathfinding, zone capacity, and zone-bound action requirements — then polish visuals and expand interactions.

**Architecture:** Extend existing `INTERIOR_ZONES` in `server/data/interiors.ts` with tile-based grid data and a new `ZoneDef` interface. Reuse existing A* from `server/lib/pathfinding.ts` by converting interior 2D grids to flat strings. Movement system gains interior/exterior grid switching. Decision system gains zone requirement checks. Open areas register terrain costs on the world grid. New zone-specific actions added in tiers (bind existing → simple new → drama).

**Tech Stack:** TypeScript, SQLite + Drizzle ORM, PixiJS 8, Vitest

**Spec:** `docs/superpowers/specs/2026-04-15-interior-pathfinding-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `server/lib/interiorGrid.ts` | Interior grid conversion, zone lookup, occupancy tracking, A* helpers |
| `server/engine/systems/zoneActions.ts` | Tier 2+3 zone-specific action effect implementations |
| `server/__tests__/interiorGrid.test.ts` | Grid conversion, zone lookup, home fallback, capacity |
| `server/__tests__/pathfindingCost.test.ts` | Terrain cost modifiers, seasonal recalculation |
| `server/__tests__/zoneActions.test.ts` | Zone binding validation, tier 2 effects |

### Modified Files
| File | Changes |
|------|---------|
| `server/data/interiors.ts` | New `ZoneDef` interface, grid arrays per building type, `ACTION_ZONE_REQUIREMENTS` map, open area zone defs. Keep backward-compatible `relativePosition` computed from tiles. |
| `server/lib/pathfinding.ts` | Add optional `costMap` parameter to `computeAStarPath` for terrain costs. ~15 lines changed. |
| `server/engine/systems/movement.ts` | Interior grid switching on door arrival, zone-center pathfinding inside buildings, keep home lerp. Extract interior logic to `interiorGrid.ts` helper. |
| `server/engine/systems/decisions.ts` | Zone requirement check before action assignment. Import `ACTION_ZONE_REQUIREMENTS`. |
| `server/engine/systems/states.ts` | Zone requirement checks for gambling (tavern:tables), treatment (clinic:exam_room). |
| `server/lib/interactionConstants.ts` | Add `requiredZone?: Record<string, string[]>` to `InteractionDef` (spec deviation: Record instead of string[] for per-building granularity). |
| `server/data/interactionRegistry.ts` | Add `requiredZone` to existing defs, add tier 3 interaction defs. |
| `server/data/activityRegistry.ts` | Activity log entries for new actions. |
| `server/lib/memory/descriptionTemplates.ts` | Memory templates for new actions. |
| `src/components/canvas/BuildingRenderer.ts` | Floor textures, furniture sprites, wall shadows. Import updated `ZoneDef`. |
| `src/components/canvas/SpritePool.ts` | Agent glow when inside building. |
| `src/components/canvas/TilemapRenderer.ts` | Open area floor textures (farm, park, town square zone colors). |
| `server/lib/planning/PlanDecomposer.ts` | Register new tier 2/3 action types in LLM plan inference. |
| `server/lib/cascade/rippleRules.ts` | Ripple rules for tier 3 drama actions (scheme, protest, escape, etc.). |
| `server/data/goalRegistry.ts` | Zone constraints on goal interactions. |
| `server/index.ts` | Call `reconstructZoneOccupancy()` on server startup. |

---

## Sub-project 1: Interior Grid & Pathfinding

### Task 1: ZoneDef Interface & Grid Data

**Files:**
- Modify: `server/data/interiors.ts`
- Test: `server/__tests__/interiorGrid.test.ts`

- [ ] **Step 1: Write failing test for ZoneDef and grid data**

```ts
// server/__tests__/interiorGrid.test.ts
import { describe, it, expect } from 'vitest';
import { INTERIOR_ZONES, INTERIOR_GRIDS, type ZoneDef } from '../../data/interiors';

describe('Interior grid data', () => {
  it('every building type with zones has a grid', () => {
    for (const [type, zones] of Object.entries(INTERIOR_ZONES)) {
      if (zones.length > 0) {
        expect(INTERIOR_GRIDS[type], `missing grid for ${type}`).toBeDefined();
      }
    }
  });

  it('grid dimensions match expected sizes', () => {
    expect(INTERIOR_GRIDS.shop.length).toBe(4);       // 4 rows
    expect(INTERIOR_GRIDS.shop[0].length).toBe(5);    // 5 cols
    expect(INTERIOR_GRIDS.tavern.length).toBe(4);     // 4 rows
    expect(INTERIOR_GRIDS.tavern[0].length).toBe(6);  // 6 cols
    expect(INTERIOR_GRIDS.town_hall.length).toBe(5);  // 5 rows
    expect(INTERIOR_GRIDS.town_hall[0].length).toBe(6); // 6 cols
  });

  it('every grid has exactly one door tile (type 3)', () => {
    for (const [type, grid] of Object.entries(INTERIOR_GRIDS)) {
      const doorCount = grid.flat().filter(c => c === 3).length;
      expect(doorCount, `${type} should have exactly 1 door`).toBe(1);
    }
  });

  it('home has no grid (uses lerp fallback)', () => {
    expect(INTERIOR_GRIDS.home).toBeUndefined();
  });

  it('ZoneDef has required fields', () => {
    const shopZones = INTERIOR_ZONES.shop as ZoneDef[];
    expect(shopZones[0].id).toBeDefined();
    expect(shopZones[0].tiles).toBeDefined();
    expect(shopZones[0].center).toBeDefined();
    expect(shopZones[0].maxOccupants).toBeDefined();
    expect(shopZones[0].allowedActions).toBeDefined();
    expect(shopZones[0].visibility).toBeDefined();
  });

  it('backward compat: relativePosition still works', () => {
    const shopZones = INTERIOR_ZONES.shop as ZoneDef[];
    expect(shopZones[0].relativePosition).toBeDefined();
    expect(shopZones[0].relativePosition.x).toBeTypeOf('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/proyects/little-life && npx vitest run server/__tests__/interiorGrid.test.ts`
Expected: FAIL — `INTERIOR_GRIDS` not exported, `ZoneDef` not exported

- [ ] **Step 3: Implement ZoneDef and grid data**

Replace `server/data/interiors.ts` with the new `ZoneDef` interface, grid arrays, and backward-compatible `relativePosition`. Key design:

```ts
const TILE_SIZE = 32;

export interface ZoneDef {
  id: string;
  name: string;   // display label (keeps compat with BuildingRenderer)
  label: string;
  tiles: [number, number][];
  center: [number, number];
  maxOccupants: number;
  color: number;
  allowedActions: string[];
  visibility: number;
  furniture?: { label: string; tile: [number, number] }; // text sprite + grid position (used in Task 7)
  // Computed for backward compatibility with BuildingRenderer
  relativePosition: { x: number; y: number; width: number; height: number };
}

// Helper: compute relativePosition from tile coords
function tilestoRelPos(tiles: [number, number][]): { x: number; y: number; width: number; height: number } {
  const xs = tiles.map(t => t[0]);
  const ys = tiles.map(t => t[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX * TILE_SIZE + 8,
    y: minY * TILE_SIZE + 8,
    width: (maxX - minX + 1) * TILE_SIZE - 16,
    height: (maxY - minY + 1) * TILE_SIZE - 16,
  };
}
```

Grid arrays for each building type (except home). Cell types: 0=floor, 1=wall, 2=furniture, 3=door.

Example — Shop (5×4):
```ts
export const INTERIOR_GRIDS: Record<string, number[][]> = {
  shop: [
    [1, 1, 1, 3, 1],  // top wall, door at col 3
    [2, 0, 1, 0, 0],  // counter(furniture) | wall | shelves area
    [0, 0, 0, 0, 2],  // storage area | display with furniture
    [1, 1, 1, 1, 1],  // bottom wall
  ],
  // ... tavern (6×4), clinic (5×4), bakery (5×4), workshop (5×4), town_hall (6×5), prison (5×4)
};
```

Each building type needs: grid array + ZoneDef array with tiles, center, maxOccupants, allowedActions, visibility. Keep `INTERIOR_ZONES` export name but change type to `Record<string, ZoneDef[]>`. The `name` field on `ZoneDef` matches old `BuildingZone.name` for renderer compat.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/proyects/little-life && npx vitest run server/__tests__/interiorGrid.test.ts`
Expected: PASS

- [ ] **Step 5: Verify BuildingRenderer still compiles**

Run: `cd D:/proyects/little-life && npx tsc --noEmit 2>&1 | grep -i "interiors\|BuildingRenderer"`
Expected: No new errors (relativePosition + name + color still present)

- [ ] **Step 6: Commit**

```bash
git add server/data/interiors.ts server/__tests__/interiorGrid.test.ts
git commit -m "feat: add ZoneDef interface and interior grid data for all building types"
```

---

### Task 2: Grid Conversion Helper

**Files:**
- Create: `server/lib/interiorGrid.ts`
- Test: `server/__tests__/interiorGrid.test.ts` (extend)

- [ ] **Step 1: Write failing test for grid-to-collision-string conversion**

```ts
// Add to server/__tests__/interiorGrid.test.ts
import { gridToCollisionString, getInteriorGrid } from '../../lib/interiorGrid';

describe('gridToCollisionString', () => {
  it('converts 2D grid to flat collision string', () => {
    const grid = [
      [1, 3, 1],
      [0, 0, 2],
      [1, 1, 1],
    ];
    const result = gridToCollisionString(grid);
    // 1→'1', 3→'0' (door=walkable), 0→'0', 2→'1' (furniture=blocked)
    expect(result).toBe('101001111');
  });

  it('returns dimensions', () => {
    const grid = [[1, 3], [0, 0]];
    const result = gridToCollisionString(grid);
    expect(result.length).toBe(4);
  });
});

describe('getInteriorGrid', () => {
  it('returns null for home (lerp fallback)', () => {
    expect(getInteriorGrid('home')).toBeNull();
  });

  it('returns grid info for shop', () => {
    const info = getInteriorGrid('shop');
    expect(info).not.toBeNull();
    expect(info!.collisionString).toBeDefined();
    expect(info!.width).toBe(5);
    expect(info!.height).toBe(4);
    expect(info!.doorTile).toBeDefined();
  });

  it('caches result (same reference on second call)', () => {
    const a = getInteriorGrid('shop');
    const b = getInteriorGrid('shop');
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/proyects/little-life && npx vitest run server/__tests__/interiorGrid.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement interiorGrid.ts**

```ts
// server/lib/interiorGrid.ts
import { INTERIOR_GRIDS } from '../data/interiors';

export interface InteriorGridInfo {
  collisionString: string;
  width: number;
  height: number;
  doorTile: [number, number];
  raw: number[][];
}

const cache = new Map<string, InteriorGridInfo>();

export function gridToCollisionString(grid: number[][]): string {
  let s = '';
  for (const row of grid) {
    for (const cell of row) {
      // 0=floor(walkable), 1=wall(blocked), 2=furniture(blocked), 3=door(walkable)
      s += (cell === 0 || cell === 3) ? '0' : '1';
    }
  }
  return s;
}

export function getInteriorGrid(buildingType: string): InteriorGridInfo | null {
  if (cache.has(buildingType)) return cache.get(buildingType)!;

  const grid = INTERIOR_GRIDS[buildingType];
  if (!grid) return null;

  const height = grid.length;
  const width = grid[0].length;
  const collisionString = gridToCollisionString(grid);

  // Find door tile
  let doorTile: [number, number] = [0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (grid[y][x] === 3) {
        doorTile = [x, y];
        break;
      }
    }
  }

  const info: InteriorGridInfo = { collisionString, width, height, doorTile, raw: grid };
  cache.set(buildingType, info);
  return info;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/proyects/little-life && npx vitest run server/__tests__/interiorGrid.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/interiorGrid.ts server/__tests__/interiorGrid.test.ts
git commit -m "feat: add interior grid conversion helper with caching"
```

---

### Task 3: Zone Occupancy Tracker

**Files:**
- Modify: `server/lib/interiorGrid.ts`
- Test: `server/__tests__/interiorGrid.test.ts` (extend)

- [ ] **Step 1: Write failing test for zone occupancy**

```ts
import { ZoneOccupancy } from '../../lib/interiorGrid';

describe('ZoneOccupancy', () => {
  let occ: ZoneOccupancy;
  beforeEach(() => { occ = new ZoneOccupancy(); });

  it('tracks agent entering zone', () => {
    occ.enter(1, 'shop', 'counter');
    expect(occ.getOccupants('shop', 'counter')).toEqual([1]);
  });

  it('tracks agent leaving zone', () => {
    occ.enter(1, 'shop', 'counter');
    occ.leave(1);
    expect(occ.getOccupants('shop', 'counter')).toEqual([]);
  });

  it('reports zone full when at capacity', () => {
    occ.enter(1, 'tavern', 'booth');
    occ.enter(2, 'tavern', 'booth');
    expect(occ.isFull('tavern', 'booth', 2)).toBe(true);
  });

  it('reports zone not full when under capacity', () => {
    occ.enter(1, 'tavern', 'tables');
    expect(occ.isFull('tavern', 'tables', 4)).toBe(false);
  });

  it('auto-removes agent from old zone on re-enter', () => {
    occ.enter(1, 'shop', 'counter');
    occ.enter(1, 'shop', 'shelves');
    expect(occ.getOccupants('shop', 'counter')).toEqual([]);
    expect(occ.getOccupants('shop', 'shelves')).toEqual([1]);
  });

  it('findAgentZone returns current zone', () => {
    occ.enter(1, 'shop', 'counter');
    expect(occ.findAgentZone(1)).toEqual({ building: 'shop', zone: 'counter' });
  });

  it('findAgentZone returns null for unknown agent', () => {
    expect(occ.findAgentZone(999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/proyects/little-life && npx vitest run server/__tests__/interiorGrid.test.ts`
Expected: FAIL — `ZoneOccupancy` not exported

- [ ] **Step 3: Implement ZoneOccupancy**

Add to `server/lib/interiorGrid.ts`:

```ts
export class ZoneOccupancy {
  // zoneKey ("shop:counter") → Set of agent IDs
  private zones = new Map<string, Set<number>>();
  // agentId → zoneKey they're currently in
  private agentZone = new Map<number, string>();

  private key(building: string, zone: string): string {
    return `${building}:${zone}`;
  }

  enter(agentId: number, building: string, zone: string): void {
    // Remove from previous zone if any
    this.leave(agentId);
    const k = this.key(building, zone);
    if (!this.zones.has(k)) this.zones.set(k, new Set());
    this.zones.get(k)!.add(agentId);
    this.agentZone.set(agentId, k);
  }

  leave(agentId: number): void {
    const k = this.agentZone.get(agentId);
    if (k) {
      this.zones.get(k)?.delete(agentId);
      this.agentZone.delete(agentId);
    }
  }

  getOccupants(building: string, zone: string): number[] {
    return [...(this.zones.get(this.key(building, zone)) ?? [])];
  }

  isFull(building: string, zone: string, maxOccupants: number): boolean {
    return (this.zones.get(this.key(building, zone))?.size ?? 0) >= maxOccupants;
  }

  findAgentZone(agentId: number): { building: string; zone: string } | null {
    const k = this.agentZone.get(agentId);
    if (!k) return null;
    const [building, zone] = k.split(':');
    return { building, zone };
  }

  clear(): void {
    this.zones.clear();
    this.agentZone.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/proyects/little-life && npx vitest run server/__tests__/interiorGrid.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/interiorGrid.ts server/__tests__/interiorGrid.test.ts
git commit -m "feat: add ZoneOccupancy tracker for interior capacity management"
```

---

### Task 4: Interior Pathfinding in Movement System

**Files:**
- Modify: `server/engine/systems/movement.ts`
- Modify: `server/lib/interiorGrid.ts` (add singleton export)

This is the core integration. Movement system needs to:
1. Detect when agent arrives at a building door
2. Switch to interior grid for pathfinding to target zone
3. Track zone occupancy on arrival
4. Keep existing lerp for homes (3×3 too small)

- [ ] **Step 1: Export singleton ZoneOccupancy instance**

Add to `server/lib/interiorGrid.ts`:

```ts
export const zoneOccupancy = new ZoneOccupancy();
```

- [ ] **Step 2: Add interior pathfinding to movement.ts**

Modify `movement.ts` — replace the current interior handling (lines 293-327) with interior grid awareness:

```ts
import { getInteriorGrid, zoneOccupancy } from '../../lib/interiorGrid';
import { INTERIOR_ZONES } from '../../data/interiors';
import type { ZoneDef } from '../../data/interiors';
```

In the path computation section (where agent is inside a closed building), add:

```ts
// Check if destination is inside same building → use interior A*
const interiorGrid = getInteriorGrid(insideBuilding.type);
if (interiorGrid && destIsInsideSameBuilding) {
  // Convert agent position to interior tile coords
  const relX = agent.position.x - insideBuilding.position.x;
  const relY = agent.position.y - insideBuilding.position.y;
  // A* on interior grid
  path = computeAStarPath(
    { x: relX, y: relY },
    { x: targetZoneCenter.x, y: targetZoneCenter.y },
    interiorGrid.collisionString,
    interiorGrid.width,
    interiorGrid.height,
    CONFIG.MOVEMENT.TILE_SIZE,
  );
  // Convert back to world coords
  path = path.map(([px, py]) => [
    px + insideBuilding.position.x,
    py + insideBuilding.position.y,
  ]);
}
```

On zone arrival, update occupancy:

```ts
// When agent arrives at zone center (within threshold)
const zones = INTERIOR_ZONES[insideBuilding.type] as ZoneDef[];
const arrivedZone = zones.find(z => {
  const [cx, cy] = z.center;
  const worldCx = insideBuilding.position.x + cx * TILE_SIZE + TILE_SIZE / 2;
  const worldCy = insideBuilding.position.y + cy * TILE_SIZE + TILE_SIZE / 2;
  return distance(agent.position, { x: worldCx, y: worldCy }) < CONFIG.MOVEMENT.ARRIVAL_THRESHOLD_PX;
});
if (arrivedZone) {
  zoneOccupancy.enter(agent.id, insideBuilding.type, arrivedZone.id);
}
```

On building exit, clear occupancy:

```ts
// When agent leaves building
zoneOccupancy.leave(agent.id);
```

- [ ] **Step 3: Write unit test for interior path computation**

The movement system integration is the highest-risk change. Add a focused test for the interior-to-world coordinate conversion logic:

```ts
// server/__tests__/interiorGrid.test.ts — add:
import { computeAStarPath } from '../../lib/pathfinding';

describe('interior pathfinding integration', () => {
  it('computes path on interior grid and converts to world coords', () => {
    const info = getInteriorGrid('shop');
    expect(info).not.toBeNull();

    // Simulate agent at door tile, pathfinding to a walkable tile
    const doorWorldX = 100 + info!.doorTile[0] * 32 + 16; // building at x=100
    const doorWorldY = 200 + info!.doorTile[1] * 32 + 16; // building at y=200

    // Interior A*: use relative coords
    const relStartX = info!.doorTile[0] * 32 + 16;
    const relStartY = info!.doorTile[1] * 32 + 16;
    const relEndX = 2 * 32 + 16; // some walkable interior tile
    const relEndY = 2 * 32 + 16;

    const path = computeAStarPath(
      { x: relStartX, y: relStartY },
      { x: relEndX, y: relEndY },
      info!.collisionString,
      info!.width,
      info!.height,
      32,
    );

    // Convert to world coords
    const worldPath = path.map(([px, py]) => [px + 100, py + 200]);
    expect(worldPath.length).toBeGreaterThan(0);
    // All waypoints should be within building bounds
    for (const [wx, wy] of worldPath) {
      expect(wx).toBeGreaterThanOrEqual(100);
      expect(wx).toBeLessThanOrEqual(100 + info!.width * 32);
      expect(wy).toBeGreaterThanOrEqual(200);
      expect(wy).toBeLessThanOrEqual(200 + info!.height * 32);
    }
  });
});
```

- [ ] **Step 4: Test manually**

Run: `cd D:/proyects/little-life && npm run dev`
Observe: Agents should walk to door, then pathfind inside buildings to zone centers. Homes still use lerp. No crashes.

- [ ] **Step 5: Run existing test suite**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All existing tests pass (no regressions)

- [ ] **Step 6: Commit**

```bash
git add server/engine/systems/movement.ts server/lib/interiorGrid.ts server/__tests__/interiorGrid.test.ts
git commit -m "feat: interior A* pathfinding in movement system with zone occupancy"
```

---

### Task 5: Zone Capacity Enforcement

**Files:**
- Modify: `server/engine/systems/decisions.ts`
- Modify: `server/lib/interiorGrid.ts` (add `findAvailableZone` helper)

- [ ] **Step 1: Add findAvailableZone helper**

```ts
// server/lib/interiorGrid.ts
import { INTERIOR_ZONES } from '../data/interiors';
import type { ZoneDef } from '../data/interiors';

export function findAvailableZone(
  buildingType: string,
  actionType: string,
): ZoneDef | null {
  const zones = INTERIOR_ZONES[buildingType] as ZoneDef[] | undefined;
  if (!zones) return null;

  // Find zone that allows this action and isn't full
  for (const zone of zones) {
    if (zone.allowedActions.includes(actionType) &&
        !zoneOccupancy.isFull(buildingType, zone.id, zone.maxOccupants)) {
      return zone;
    }
  }
  return null;
}
```

- [ ] **Step 2: Add fallback zone map and wait timeout logic**

The spec requires: when a zone is full, agents try an alternate zone, or wait up to 20 ticks, then leave.

```ts
// server/lib/interiorGrid.ts — add:

// Fallback zones: if primary zone is full, try these instead
const ZONE_FALLBACKS: Record<string, string[]> = {
  'tavern:tables': ['tavern:bar'],
  'tavern:booth': ['tavern:tables'],
  'bakery:display': ['bakery:prep_table'],
  'shop:shelves': ['shop:display'],
  'clinic:exam_room': ['clinic:patient_bed'],
};

export function findAvailableZoneWithFallback(
  buildingType: string,
  actionType: string,
): ZoneDef | null {
  const zones = INTERIOR_ZONES[buildingType] as ZoneDef[] | undefined;
  if (!zones) return null;

  // Primary: find zone that allows this action and isn't full
  for (const zone of zones) {
    if (zone.allowedActions.includes(actionType) &&
        !zoneOccupancy.isFull(buildingType, zone.id, zone.maxOccupants)) {
      return zone;
    }
  }

  // Fallback: check fallback map
  for (const zone of zones) {
    if (zone.allowedActions.includes(actionType)) {
      const key = `${buildingType}:${zone.id}`;
      const fallbacks = ZONE_FALLBACKS[key];
      if (fallbacks) {
        for (const fbId of fallbacks) {
          const fbZone = zones.find(z => z.id === fbId);
          if (fbZone && !zoneOccupancy.isFull(buildingType, fbZone.id, fbZone.maxOccupants)) {
            return fbZone;
          }
        }
      }
    }
  }

  return null; // caller should queue wait or redirect agent elsewhere
}

// Zone wait timeout constant (spec: 20 ticks)
export const ZONE_WAIT_TIMEOUT_TICKS = 20;
```

- [ ] **Step 3: Add zone check in decisions.ts**

In the action assignment flow, before queuing an action that requires a zone:

```ts
import { findAvailableZoneWithFallback, ZONE_WAIT_TIMEOUT_TICKS } from '../../lib/interiorGrid';

// Before assigning action:
const targetZone = findAvailableZoneWithFallback(locationTypeAtTarget, actionType);
if (!targetZone) {
  // All zones full — assign short idle (wait) with timeout
  // If agent has been waiting > ZONE_WAIT_TIMEOUT_TICKS, pick different location or go idle elsewhere
  const waitTicks = (agent.current_action as any)?._zoneWaitTicks ?? 0;
  if (waitTicks >= ZONE_WAIT_TIMEOUT_TICKS) {
    // Timeout: force leave building, go idle
    continue;
  }
  // Queue short wait
  action = { type: 'idle', _zoneWaitTicks: waitTicks + 1 };
  continue;
}
// Include zone target in the action queue entry
action.targetZone = targetZone.id;
```

- [ ] **Step 4: Test zone capacity manually**

Run simulation, observe: When tavern tables are full (4 agents), new arrivals should go to bar zone or leave after 20 ticks. No infinite waiting.

- [ ] **Step 5: Commit**

```bash
git add server/lib/interiorGrid.ts server/engine/systems/decisions.ts
git commit -m "feat: zone capacity enforcement with fallback zones and wait timeout"
```

---

## Sub-project 2: Visual Polish

### Task 6: Floor Textures & Wall Shadows

**Files:**
- Modify: `src/components/canvas/BuildingRenderer.ts`

- [ ] **Step 1: Add floor material colors per building type**

```ts
const FLOOR_MATERIALS: Record<string, number> = {
  home: 0x5C4033,      // wood
  tavern: 0x5C4033,    // wood
  bakery: 0x6B5B4A,    // wood (lighter)
  shop: 0x6B5B4A,      // wood
  clinic: 0xB0B0B0,    // stone
  town_hall: 0xA0A0A0, // stone
  prison: 0x808080,    // stone (dark)
  workshop: 0x7A6B5A,  // dirt/wood
};
```

- [ ] **Step 2: Replace flat zone rectangles with textured floors**

In `renderInterior()`, draw building floor first, then zone-specific overlays with reduced alpha.

- [ ] **Step 3: Add wall shadow (2px dark border inside building bounds)**

```ts
// After drawing walls
g.rect(pos.x + 2, pos.y + 2, pos.width - 4, pos.height - 4);
g.fill({ color: 0x000000, alpha: 0.15 });
```

- [ ] **Step 4: Test visually**

Run dev, verify buildings look better. No rendering glitches.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/BuildingRenderer.ts
git commit -m "feat: floor texture differentiation and wall shadows for buildings"
```

---

### Task 7: Furniture Sprites

**Files:**
- Modify: `src/components/canvas/BuildingRenderer.ts`
- Modify: `server/data/interiors.ts` (add `furniture` field to ZoneDef)

- [ ] **Step 1: Populate furniture data on existing ZoneDef entries**

The `furniture` field was already added to `ZoneDef` in Task 1. Now populate it on each zone that has furniture tiles (type `2` in the grid). Example:

```ts
// In INTERIOR_ZONES.shop:
{ id: 'counter', ..., furniture: { label: 'Desk', tile: [0, 1] } },
// In INTERIOR_ZONES.tavern:
{ id: 'bar', ..., furniture: { label: 'Keg', tile: [0, 1] } },
{ id: 'stage', ..., furniture: { label: 'Stage', tile: [4, 1] } },
// etc. for all zones with blocked/furniture tiles
```

- [ ] **Step 2: Render furniture as text sprites at blocked tiles**

In BuildingRenderer, for each zone with `furniture`, render a PIXI.Text sprite at the tile position:

```ts
for (const zone of zones) {
  if (zone.furniture) {
    const [tx, ty] = zone.furniture.tile;
    const text = new PIXI.Text({ text: zone.furniture.label, style: furnitureStyle });
    text.position.set(
      pos.x + tx * TILE_SIZE + TILE_SIZE / 2,
      pos.y + ty * TILE_SIZE + TILE_SIZE / 2,
    );
    text.anchor.set(0.5);
    interiorContainer.addChild(text);
  }
}
```

Furniture labels: `"Bed"`, `"Oven"`, `"Desk"`, `"Keg"`, `"Anvil"`, etc. — short text, not emoji (cross-platform consistency in PixiJS).

- [ ] **Step 3: Test visually**

Run dev, verify furniture labels appear at correct positions inside buildings.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/BuildingRenderer.ts server/data/interiors.ts
git commit -m "feat: furniture text sprites in interior zones"
```

---

### Task 8: Agent Interior Glow

**Files:**
- Modify: `src/components/canvas/SpritePool.ts`

- [ ] **Step 1: Add glow circle behind agent sprite when inside building**

When rendering agent that has `current_location` set to a closed building:

```ts
// Add a slightly larger circle behind the agent sprite with additive blending
const glow = new PIXI.Graphics();
glow.circle(0, 0, radius * 1.6);
glow.fill({ color: agentColor, alpha: 0.15 });
glow.blendMode = 'add';
container.addChildAt(glow, 0); // behind the main sprite
```

- [ ] **Step 2: Test visually**

Run dev, verify agents have subtle glow when inside buildings. Glow disappears outdoors.

- [ ] **Step 3: Commit**

```bash
git add src/components/canvas/SpritePool.ts
git commit -m "feat: agent glow indicator when inside buildings"
```

---

## Sub-project 3: Open Area Structure

### Task 9: Terrain Cost Support in A*

**Files:**
- Modify: `server/lib/pathfinding.ts`
- Test: `server/__tests__/pathfindingCost.test.ts`

- [ ] **Step 1: Write failing test for terrain costs**

```ts
// server/__tests__/pathfindingCost.test.ts
import { describe, it, expect } from 'vitest';
import { computeAStarPath } from '../../lib/pathfinding';

describe('A* with terrain costs', () => {
  it('prefers low-cost path over short high-cost path', () => {
    // 5×3 grid: all walkable, middle row has cost 3.0
    const grid = '000000000000000';
    const costMap = new Float32Array([
      1, 1, 1, 1, 1,
      3, 3, 3, 3, 3,  // expensive middle row
      1, 1, 1, 1, 1,
    ]);
    const path = computeAStarPath(
      { x: 16, y: 16 },   // top-left area
      { x: 144, y: 16 },  // top-right area
      grid, 5, 3, 32,
      costMap,
    );
    // Path should stay in top row (cost 1) rather than cutting through middle (cost 3)
    expect(path.every(([, py]) => py < 48)).toBe(true);
  });

  it('works without costMap (backward compatible)', () => {
    const grid = '000000000';
    const path = computeAStarPath(
      { x: 16, y: 16 },
      { x: 80, y: 80 },
      grid, 3, 3, 32,
    );
    expect(path.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/proyects/little-life && npx vitest run server/__tests__/pathfindingCost.test.ts`
Expected: FAIL — `computeAStarPath` doesn't accept `costMap`

- [ ] **Step 3: Add costMap parameter to computeAStarPath**

```ts
export function computeAStarPath(
  startPixel: { x: number; y: number },
  endPixel: { x: number; y: number },
  collisionGrid: string,
  mapWidth: number,
  mapHeight: number,
  tileSize: number,
  costMap?: Float32Array,  // NEW: optional per-tile movement cost multiplier
): number[][] {
```

Change `isBlocked` to also return cost:

```ts
function getTileCost(x: number, y: number): number {
  if (x < 0 || x >= mapWidth || y < 0 || y >= mapHeight) return Infinity;
  if (collisionGrid[y * mapWidth + x] === '1') return Infinity;
  return costMap ? costMap[y * mapWidth + x] : 1.0;
}
```

Change the neighbor loop:

```ts
const tileCost = getTileCost(nx, ny);
if (tileCost === Infinity) continue;
// ...diagonal checks...
const tentativeG = current.g + cost * tileCost;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/proyects/little-life && npx vitest run server/__tests__/pathfindingCost.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite for regressions**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add server/lib/pathfinding.ts server/__tests__/pathfindingCost.test.ts
git commit -m "feat: optional terrain cost map in A* pathfinding"
```

---

### Task 10: Open Area Zone Definitions

**Files:**
- Modify: `server/data/interiors.ts`

- [ ] **Step 1: Add zone definitions for farm, park, town_square**

Replace the empty arrays with full `ZoneDef[]` entries. These don't use `INTERIOR_GRIDS` (they're on the world grid), but they use `INTERIOR_ZONES` for zone metadata.

Example — Farm:
```ts
farm: [
  { id: 'crops_north', name: 'Crop Field', label: 'Crops', tiles: [[0,0],[1,0],[2,0],[3,0],[0,1],[1,1],[2,1],[3,1]], center: [2, 1], maxOccupants: 2, color: 0x4a7a2a, allowedActions: ['working', 'plant', 'harvest'], visibility: 1.0, relativePosition: computeRelPos(...) },
  { id: 'coop', name: 'Chicken Coop', label: 'Coop', tiles: [[0,3],[1,3]], center: [1, 3], maxOccupants: 1, color: 0xd69e2e, allowedActions: ['collect_eggs', 'feed_animals'], visibility: 0.8, ... },
  // ... barn, well, rest_spot
],
```

Similar for park (riverside, grove, benches, garden, path) and town_square (market_stalls, fountain, plaza, podium, seating).

- [ ] **Step 2: Register terrain costs for open areas**

Add a new export to `server/data/interiors.ts`:

```ts
export interface TerrainCostDef {
  buildingType: string;
  tileCosts: Map<string, number>; // "tileX,tileY" → cost multiplier
  blockedTiles: [number, number][]; // river, trees
}

export function getOpenAreaTerrainCosts(season: string): TerrainCostDef[] { ... }
```

- [ ] **Step 3: Test zone definitions exist**

Add to `server/__tests__/interiorGrid.test.ts`:

```ts
it('farm has 5 zones', () => {
  expect((INTERIOR_ZONES.farm as ZoneDef[]).length).toBe(5);
});
it('park has 5 zones', () => {
  expect((INTERIOR_ZONES.park as ZoneDef[]).length).toBe(5);
});
it('town_square has 5 zones', () => {
  expect((INTERIOR_ZONES.town_square as ZoneDef[]).length).toBe(5);
});
```

- [ ] **Step 4: Run tests**

Run: `cd D:/proyects/little-life && npx vitest run server/__tests__/interiorGrid.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/data/interiors.ts server/__tests__/interiorGrid.test.ts
git commit -m "feat: open area zone definitions for farm, park, town square"
```

---

### Task 11: Seasonal Terrain Cost Recalculation

**Files:**
- Modify: `server/engine/tick.ts`
- Modify: `server/lib/interiorGrid.ts`

- [ ] **Step 1: Add terrain cost application to world grid**

In `interiorGrid.ts`, add:

```ts
export function applyOpenAreaCosts(
  collisionGrid: string,
  mapWidth: number,
  mapHeight: number,
  season: string,
  openAreaLocations: Array<{ type: string; position: { x: number; y: number; width: number; height: number } }>,
): { grid: string; costMap: Float32Array } {
  const gridChars = collisionGrid.split('');
  const costMap = new Float32Array(mapWidth * mapHeight).fill(1.0);

  for (const loc of openAreaLocations) {
    const terrainCosts = getOpenAreaTerrainCosts(season);
    const areaCosts = terrainCosts.find(t => t.buildingType === loc.type);
    if (!areaCosts) continue;

    // Convert location-relative tile coords to world tile coords
    const baseCol = Math.floor(loc.position.x / 32);
    const baseRow = Math.floor(loc.position.y / 32);

    // Apply blocked tiles (river, trees)
    for (const [relX, relY] of areaCosts.blockedTiles) {
      const worldIdx = (baseRow + relY) * mapWidth + (baseCol + relX);
      if (worldIdx >= 0 && worldIdx < gridChars.length) {
        gridChars[worldIdx] = '1';
      }
    }

    // Apply cost modifiers (crop tiles etc.)
    for (const [key, cost] of areaCosts.tileCosts.entries()) {
      const [relX, relY] = key.split(',').map(Number);
      const worldIdx = (baseRow + relY) * mapWidth + (baseCol + relX);
      if (worldIdx >= 0 && worldIdx < costMap.length) {
        costMap[worldIdx] = cost;
      }
    }
  }

  return { grid: gridChars.join(''), costMap };
}
```

- [ ] **Step 2: Call on season change in tick.ts**

In tick.ts, after detecting `season_changed` transition:

```ts
if (transitions.some(t => t.type === 'season_changed')) {
  // Recalculate terrain costs
  const result = applyOpenAreaCosts(world.collision_grid, world.map_width, newTime.season, openAreaLocations);
  // Store updated grid + cost map
}
```

- [ ] **Step 3: Write test for seasonal changes**

```ts
// server/__tests__/pathfindingCost.test.ts
describe('seasonal terrain costs', () => {
  it('crop tiles cost 1.5x in summer', () => { ... });
  it('crop tiles cost 1.0x in winter', () => { ... });
  it('river tiles always blocked', () => { ... });
});
```

- [ ] **Step 4: Run tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/interiorGrid.ts server/engine/tick.ts server/__tests__/pathfindingCost.test.ts
git commit -m "feat: seasonal terrain cost recalculation for open areas"
```

---

## Sub-project 4: Zone-Bound Actions

### Task 12: ACTION_ZONE_REQUIREMENTS Map

**Files:**
- Modify: `server/data/interiors.ts`
- Modify: `server/lib/interactionConstants.ts`

- [ ] **Step 1: Add ACTION_ZONE_REQUIREMENTS**

```ts
// server/data/interiors.ts
export const ACTION_ZONE_REQUIREMENTS: Record<string, Record<string, string[]>> = {
  // action → building_type → allowed zone IDs
  sleeping: { home: ['bed'] },
  eating: { home: ['kitchen'], tavern: ['tables'], bakery: ['display'] },
  working: {
    shop: ['counter', 'storage'],
    tavern: ['bar', 'stage'],
    bakery: ['oven', 'prep_table'],
    clinic: ['reception', 'exam_room', 'medicine'],
    workshop: ['workbench', 'forge'],
    town_hall: ['mayors_desk'],
    prison: ['guard_desk'],
    farm: ['crops_north', 'crops_south'],
  },
  gambling: { tavern: ['tables'] },
};
```

- [ ] **Step 2: Add requiredZone to InteractionDef**

**Note:** The spec says `requiredZone?: string[]` but that is insufficient -- we need to know which zones are valid *per building type* (e.g., flirt is allowed at `tavern:booth` but not `tavern:bar`). Using `Record<string, string[]>` keyed by building type. This is a deliberate improvement over the spec.

```ts
// server/lib/interactionConstants.ts
export interface InteractionDef {
  // ... existing fields
  requiredZone?: Record<string, string[]>; // building_type → zone IDs
}
```

- [ ] **Step 3: Add requiredZone to existing interactions in registry**

```ts
// server/data/interactionRegistry.ts
flirt: {
  // ... existing
  requiredZone: { tavern: ['booth'], park: ['grove_west', 'grove_east'] },
},
blackmail: {
  // ... existing
  requiredZone: { tavern: ['booth'], shop: ['storage'] },
},
pickpocket: {
  // ... existing
  requiredZone: { shop: ['shelves'], town_square: ['market_north', 'market_south'] },
},
```

- [ ] **Step 4: Commit**

```bash
git add server/data/interiors.ts server/lib/interactionConstants.ts server/data/interactionRegistry.ts
git commit -m "feat: zone requirement maps for actions and interactions"
```

---

### Task 13: Zone Check in Decision System

**Files:**
- Modify: `server/engine/systems/decisions.ts`
- Test: `server/__tests__/zoneActions.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// server/__tests__/zoneActions.test.ts
import { describe, it, expect } from 'vitest';
import { resolveZoneForAction } from '../../lib/interiorGrid';

describe('resolveZoneForAction', () => {
  it('returns zone for sleeping at home', () => {
    const zone = resolveZoneForAction('sleeping', 'home');
    expect(zone).not.toBeNull();
    expect(zone!.id).toBe('bed');
  });

  it('returns null for action with no zone requirement', () => {
    const zone = resolveZoneForAction('idle', 'tavern');
    expect(zone).toBeNull();
  });

  it('returns null for unknown building type', () => {
    const zone = resolveZoneForAction('sleeping', 'unknown');
    expect(zone).toBeNull();
  });
});
```

- [ ] **Step 2: Implement resolveZoneForAction**

```ts
// server/lib/interiorGrid.ts
import { ACTION_ZONE_REQUIREMENTS, INTERIOR_ZONES, type ZoneDef } from '../data/interiors';

export function resolveZoneForAction(
  actionType: string,
  buildingType: string,
): ZoneDef | null {
  const req = ACTION_ZONE_REQUIREMENTS[actionType];
  if (!req) return null;
  const allowedZoneIds = req[buildingType];
  if (!allowedZoneIds) return null;

  const zones = INTERIOR_ZONES[buildingType] as ZoneDef[] | undefined;
  if (!zones) return null;

  // Find first allowed zone that isn't full
  for (const zoneId of allowedZoneIds) {
    const zone = zones.find(z => z.id === zoneId);
    if (zone && !zoneOccupancy.isFull(buildingType, zone.id, zone.maxOccupants)) {
      return zone;
    }
  }
  return null;
}
```

- [ ] **Step 3: Wire into decisions.ts**

In the action assignment flow, after scoring and before queuing:

```ts
import { resolveZoneForAction } from '../../lib/interiorGrid';

// When assigning action at a location:
const targetLocation = allLocations.find(l => l.id === targetLocationId);
if (targetLocation) {
  const zone = resolveZoneForAction(actionType, targetLocation.type);
  if (zone) {
    // Set zone center as destination within the building
    const zoneWorldX = targetLocation.position.x + zone.center[0] * TILE_SIZE + TILE_SIZE / 2;
    const zoneWorldY = targetLocation.position.y + zone.center[1] * TILE_SIZE + TILE_SIZE / 2;
    // Queue: walk to door, then interior walk to zone
    action.zoneX = zoneWorldX;
    action.zoneY = zoneWorldY;
    action.targetZone = zone.id;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/interiorGrid.ts server/engine/systems/decisions.ts server/__tests__/zoneActions.test.ts
git commit -m "feat: zone requirement checks in decision system"
```

---

### Task 14: Tier 2 Zone Actions

**Files:**
- Create: `server/engine/systems/zoneActions.ts`
- Modify: `server/data/activityRegistry.ts`
- Modify: `server/lib/memory/descriptionTemplates.ts`

- [ ] **Step 1: Implement tier 2 action effects**

```ts
// server/engine/systems/zoneActions.ts
import { db } from '../../db';
import { agents, economy } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from '../../lib/activityLogger';
import { simEvents } from '../../lib/simEvents';

interface ZoneActionResult {
  needDeltas: Record<string, number>;
  itemProduced?: { item: string; qty: number };
}

const ZONE_ACTIONS: Record<string, (agentId: number) => ZoneActionResult> = {
  cook: () => ({ needDeltas: { hunger: -20 } }),           // better than raw eating (-10)
  rest: () => ({ needDeltas: { energy: -5 } }),             // 50% of sleep rate
  contemplate: () => ({ needDeltas: { mood: 5, comfort: 3 } }),
  fish: () => ({ needDeltas: { fun: 4 }, itemProduced: { item: 'food_raw', qty: 1 } }),
  garden: () => ({ needDeltas: { comfort: 4, mood: 3 } }),
  forage: () => ({ needDeltas: {}, itemProduced: { item: 'food_raw', qty: 1 } }),
  perform: () => ({ needDeltas: { fun: 6, social: 3 } }),
  watch: () => ({ needDeltas: { fun: 3, social: 2 } }),
  browse: () => ({ needDeltas: { fun: 2 } }),
  jog: () => ({ needDeltas: { fun: 3, mood: 2, energy: 4 } }), // energy increases (costs energy)
};

export function executeZoneAction(actionType: string, agentId: number): boolean {
  const handler = ZONE_ACTIONS[actionType];
  if (!handler) return false;
  const result = handler(agentId);

  // Apply need deltas
  if (Object.keys(result.needDeltas).length > 0) {
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (agent) {
      const needs = { ...agent.needs };
      for (const [key, delta] of Object.entries(result.needDeltas)) {
        if (key in needs) {
          (needs as any)[key] = Math.max(0, Math.min(100, (needs as any)[key] + delta));
        }
      }
      db.update(agents).set({ needs }).where(eq(agents.id, agentId)).run();
    }
  }

  // Apply item production via existing economy system
  if (result.itemProduced) {
    const existing = db.select().from(economy).where(eq(economy.owner_id, agentId)).get();
    // Use existing economy update pattern from the codebase
    simEvents.emit('item:produced', {
      agentId,
      item: result.itemProduced.item,
      qty: result.itemProduced.qty,
    });
  }

  logActivity({
    type: actionType as any,
    initiator: agentId,
    templateData: { agent: agentId.toString() },
  });

  return true;
}
```

- [ ] **Step 2: Add activity log entries**

```ts
// server/data/activityRegistry.ts — add:
cook: { category: 'state', base_importance: 0.1, retention: 'short', template: '{agent} cooked a meal' },
fish: { category: 'state', base_importance: 0.2, retention: 'short', template: '{agent} went fishing at the riverside' },
perform: { category: 'social', base_importance: 0.4, retention: 'medium', template: '{agent} performed at {location}' },
// ... etc for each tier 2 action
```

- [ ] **Step 3: Add memory description templates**

```ts
// server/lib/memory/descriptionTemplates.ts — add templates for new actions
```

- [ ] **Step 4: Wire into tick loop**

In the needs tick or a new zone actions phase, check if agent's current action matches a zone action and call `executeZoneAction`.

- [ ] **Step 5: Run tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/engine/systems/zoneActions.ts server/data/activityRegistry.ts server/lib/memory/descriptionTemplates.ts
git commit -m "feat: tier 2 zone-specific actions (cook, fish, perform, etc.)"
```

---

### Task 15: Tier 3 Drama Actions

**Files:**
- Modify: `server/data/interactionRegistry.ts`
- Modify: `server/engine/systems/zoneActions.ts`

- [ ] **Step 1: Add tier 3 InteractionDefs**

Add 9 new entries to `INTERACTION_REGISTRY`: scheme, secret_meeting, confide, speech, protest, announce, escape_attempt, smuggle, lock_out. Each follows the existing `InteractionDef` pattern with prerequisites, effects, outcome factors, narration.

Example — `speech`:
```ts
speech: {
  category: 'authority',
  visibility: 1.3,
  duration: 20,
  requiredZone: { town_square: ['podium'] },
  prerequisites: [
    { type: 'role', with_role: 'mayor' },
    { type: 'location', scope: 'town_square' },
  ],
  effects_success: [
    { system: 'fact', type: 'speech', sensitivity: 0, subject: 'initiator' },
  ],
  effects_failure: [],
  outcomeFactors: [{ stat: 'vanity', weight: 0.3 }],
  narration: {
    strategy: 'always',
    token_budget: 60,
    prompt_tone: 'authoritative',
    templates: ['{initiator} gave a speech in the town square.'],
  },
  cooldown: { ticks: 1440, scope: 'initiator' },
},
```

Budget: ~50-80 lines per action, no new DB tables, no new LLM calls.

- [ ] **Step 2: Add activity log + memory templates for each**

- [ ] **Step 3: Test each action fires correctly**

Manual test: trigger conditions for each tier 3 action and verify it resolves.

- [ ] **Step 4: Run full test suite**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/data/interactionRegistry.ts server/engine/systems/zoneActions.ts server/data/activityRegistry.ts server/lib/memory/descriptionTemplates.ts
git commit -m "feat: tier 3 drama actions (scheme, speech, protest, escape, etc.)"
```

---

### Task 15b: Zone Requirements in states.ts and goalRegistry.ts

**Files:**
- Modify: `server/engine/systems/states.ts`
- Modify: `server/data/goalRegistry.ts`

The spec lists both files as affected. `states.ts` handles gambling and treatment state transitions which now need zone enforcement. `goalRegistry.ts` needs zone constraints on goal interactions.

- [ ] **Step 1: Add zone checks to states.ts**

In `states.ts`, wherever gambling (tavern:tables) and treatment (clinic:exam_room) actions are processed, add a zone validation check:

```ts
import { zoneOccupancy } from '../../lib/interiorGrid';

// Before executing gambling state transition:
const agentZone = zoneOccupancy.findAgentZone(agent.id);
if (!agentZone || agentZone.zone !== 'tables') {
  // Agent not at required zone — skip this tick
  continue;
}
```

Apply similar pattern for treatment at `clinic:exam_room`.

- [ ] **Step 2: Add zone constraints to goalRegistry.ts**

For goals that involve zone-bound interactions (e.g., "steal from shop" requires shop:storage), add `requiredZone` metadata to the relevant goal definitions so the PlanDecomposer can route agents correctly.

- [ ] **Step 3: Run tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/engine/systems/states.ts server/data/goalRegistry.ts
git commit -m "feat: zone requirement checks in states and goal registry"
```

---

### Task 15c: PlanDecomposer Action Type Registration

**Files:**
- Modify: `server/lib/planning/PlanDecomposer.ts`

The spec (Integration Risk #4) warns that the PlanDecomposer maps free-form LLM plan text to action types. Without registering the new tier 2/3 action types, agents will never plan to use them.

- [ ] **Step 1: Add new action types to PlanDecomposer inference**

In `PlanDecomposer.ts`, find the action type mapping/inference logic and add entries for all new actions:

```ts
// Tier 2 actions
'cook', 'rest', 'contemplate', 'fish', 'garden', 'forage', 'perform', 'watch', 'browse', 'jog',
// Tier 3 actions
'scheme', 'secret_meeting', 'confide', 'speech', 'protest', 'announce', 'escape_attempt', 'smuggle', 'lock_out',
```

Also add natural language synonyms that the LLM might produce (e.g., "go fishing" -> "fish", "give a speech" -> "speech", "sneak out" -> "escape_attempt").

- [ ] **Step 2: Run tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/lib/planning/PlanDecomposer.ts
git commit -m "feat: register new zone action types in PlanDecomposer"
```

---

### Task 15d: Cascade Engine Ripple Rules for New Actions

**Files:**
- Modify: `server/lib/cascade/rippleRules.ts`

The spec (Integration Risk #3) warns that new actions like scheme, protest, and escape_attempt will trigger the cascade engine's RippleEngine. Without rules, these events are silently dropped.

- [ ] **Step 1: Add ripple rules for tier 3 drama actions**

```ts
// server/lib/cascade/rippleRules.ts — add rules:
{
  trigger: 'speech',
  condition: 'location === "town_square"',
  effects: [
    // All agents in town_square get mood/opinion shift
    { type: 'broadcast_opinion', radius: 'location', delta: 'outcome-dependent' },
  ],
},
{
  trigger: 'protest',
  condition: 'always',
  effects: [
    { type: 'relationship_damage', target: 'authority', delta: -5 },
    { type: 'create_fact', factType: 'political' },
  ],
},
{
  trigger: 'escape_attempt',
  condition: 'always',
  effects: [
    { type: 'relationship_damage', target: 'constable', delta: -10, on: 'failure' },
    { type: 'create_fact', factType: 'crime' },
  ],
},
{
  trigger: 'scheme',
  condition: 'always',
  effects: [
    { type: 'create_shared_knowledge', visibility: 0.2 },
  ],
},
// announce, smuggle, lock_out — similar patterns
```

- [ ] **Step 2: Verify existing ripple rule tests still pass**

Run: `cd D:/proyects/little-life && npx vitest run server/__tests__/rippleRules.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/lib/cascade/rippleRules.ts
git commit -m "feat: cascade ripple rules for tier 3 drama actions"
```

---

### Task 15e: Open Area Floor Textures in TilemapRenderer

**Files:**
- Modify: `src/components/canvas/TilemapRenderer.ts`

The spec lists `TilemapRenderer.ts` under Sub-project 2 for "open area floor textures". This was missing from the plan.

- [ ] **Step 1: Add terrain-differentiated rendering for open area tiles**

In `TilemapRenderer.ts`, when rendering tiles that fall within open area bounds, use zone-specific colors instead of the default grass. Farm crop zones get a tilled earth color, park paths get a gravel color, etc.

```ts
// Check if tile overlaps an open area zone and apply zone color
// Use INTERIOR_ZONES[areaType] to look up zone tiles and their colors
```

- [ ] **Step 2: Test visually**

Run dev, verify farm crop zones, park paths, and town square areas have distinct floor rendering.

- [ ] **Step 3: Commit**

```bash
git add src/components/canvas/TilemapRenderer.ts
git commit -m "feat: open area floor texture differentiation in tilemap renderer"
```

---

### Task 15f: ZoneOccupancy Reconstruction on Server Start

**Files:**
- Modify: `server/lib/interiorGrid.ts`
- Modify: `server/index.ts` (or wherever server initialization happens)

The `ZoneOccupancy` singleton is in-memory and lost on restart. Add a reconstruction step that reads all active agents' positions and re-populates zone tracking.

- [ ] **Step 1: Add reconstruction function**

```ts
// server/lib/interiorGrid.ts — add:
export function reconstructZoneOccupancy(
  activeAgents: Array<{ id: number; current_location: number | null; position: { x: number; y: number } }>,
  allLocations: Array<{ id: number; type: string; position: { x: number; y: number; width: number; height: number } }>,
): void {
  zoneOccupancy.clear();
  for (const agent of activeAgents) {
    if (agent.current_location == null) continue;
    const loc = allLocations.find(l => l.id === agent.current_location);
    if (!loc) continue;
    const zones = INTERIOR_ZONES[loc.type] as ZoneDef[] | undefined;
    if (!zones) continue;
    // Find which zone the agent is closest to
    let bestZone: ZoneDef | null = null;
    let bestDist = Infinity;
    for (const zone of zones) {
      const [cx, cy] = zone.center;
      const worldCx = loc.position.x + cx * 32 + 16;
      const worldCy = loc.position.y + cy * 32 + 16;
      const dx = agent.position.x - worldCx;
      const dy = agent.position.y - worldCy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) { bestDist = dist; bestZone = zone; }
    }
    if (bestZone && bestDist < 48) { // within 1.5 tiles
      zoneOccupancy.enter(agent.id, loc.type, bestZone.id);
    }
  }
}
```

- [ ] **Step 2: Call on server startup**

In the server initialization code, after loading agents and locations from DB, call `reconstructZoneOccupancy(agents, locations)`.

- [ ] **Step 3: Commit**

```bash
git add server/lib/interiorGrid.ts server/index.ts
git commit -m "feat: reconstruct zone occupancy from DB on server restart"
```

---

### Task 16: Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All tests pass including new ones

- [ ] **Step 2: Type check**

Run: `cd D:/proyects/little-life && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Manual smoke test**

Run simulation for 2+ game days. Verify:
- Agents pathfind inside buildings (not teleporting)
- Homes still use lerp (no A* on 3×3)
- Zone capacity works (agents queue or redirect)
- Tier 2 actions fire (cook, fish, perform visible in activity log)
- Open area zones work (agents walk to farm crop zones, park benches)
- No tick performance degradation

- [ ] **Step 4: Final commit**

```bash
git add -u
git commit -m "feat: interior pathfinding, zone-bound actions, visual polish — complete"
```

> **Note:** Use `git add -u` (tracked files only) instead of `git add -A` to avoid accidentally staging untracked files.
