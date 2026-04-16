# Interior Pathfinding & Zone-Bound Actions Design

**Date:** 2026-04-15
**Status:** Draft
**Scope:** Interior grid system, zone-bound actions, visual polish, open area structure, interaction audit

## Overview

Rework the movement and action systems so agents pathfind within buildings, actions require specific zones, and open areas have walkable structure. Currently agents teleport-lerp to interior positions with no collision, actions work anywhere, and open areas are featureless blobs.

## Sub-projects

This is decomposed into 4 sequential sub-projects. Each builds on the previous.

### Sub-project 1: Interior Grid & Pathfinding

**Goal:** Per-building interior collision grids with A* pathfinding inside buildings.

**Grid format:** 2D array per building type, stored in `server/data/interiors.ts` (extends existing `INTERIOR_ZONES`).

Cell types:
- `0` = walkable floor
- `1` = wall/blocked
- `2` = furniture (blocked, visually distinct)
- `3` = door (walkable, entry/exit point)

Grid sizes (derived from actual building pixel dimensions in `server/data/maps.ts`, 32px per tile):
- Home: 3×3 (96×96px) — 1-tile wall border, minimal 1×1 walkable core
- Shop: 5×4 (160×128px)
- Tavern: 6×4 (192×128px)
- Clinic: 5×4 (160×128px)
- Bakery: 5×4 (160×128px)
- Workshop: 5×4 (160×128px)
- Town Hall: 6×5 (192×160px)
- Prison: 5×4 (160×128px)

**Home grid caveat:** At 3×3 tiles, homes are too small for meaningful A* pathfinding (a 1-tile wall border leaves only a 1×1 interior). For homes, use direct zone-lerp movement (the existing `_transitioning` approach in `movement.ts`) instead of A*. A* is only used for buildings 5×4 and larger, where there are enough interior tiles for pathing to matter.

**Pathfinding:** Reuse existing A* from `server/lib/pathfinding.ts` with per-building grid. The current `computeAStarPath` takes a flat `collisionGrid` string and `mapWidth`/`mapHeight` — for interior grids, convert the 2D array to a flat string and pass building tile dimensions. Movement system (`server/engine/systems/movement.ts`) switches between world grid and interior grid based on agent location.

**A* adaptation notes:** The existing A* uses a flat string where `'1'` = blocked. Interior grids use numbers (0/1/2/3), so a conversion helper is needed: map cell types 1 and 2 to `'1'` (blocked), and 0 and 3 to `'0'` (walkable). This avoids forking the pathfinding code.

**Entry/exit flow:**
1. Agent walks to `entry_point` (door) on world grid
2. Movement system detects arrival at door — switches to interior grid (or zone-lerp for homes)
3. Agent pathfinds to target zone center within interior grid
4. On leaving: pathfind to door tile (type `3`) — switch back to world grid
5. **Edge case:** If agent is already inside and receives a new destination in the same building, pathfind within the interior grid directly (no exit/re-enter)
6. **Edge case:** If door tile is blocked by another agent (maxOccupants=1 on door zone), queue at nearest walkable tile until door clears

**Zone definition (extended):**

```ts
interface ZoneDef {
  id: string;                  // e.g. "bed", "kitchen", "bar"
  label: string;
  tiles: [number, number][];   // grid coords belonging to this zone
  center: [number, number];    // pathfinding target (grid coords)
  maxOccupants: number;
  color: number;               // hex number (matches existing BuildingZone.color format)
  allowedActions: string[];    // actions permitted at this zone
  visibility: number;          // 0-1, affects witness detection (feeds into witnessResolver)
}
```

**Relationship to existing `BuildingZone`:** The new `ZoneDef` replaces the current `BuildingZone` interface in `interiors.ts`. The existing `relativePosition` (pixel-based rectangles) is superseded by `tiles` (grid-based). A migration path: keep `relativePosition` as a computed property derived from `tiles` and `TILE_SIZE` so `BuildingRenderer.ts` does not break during incremental adoption.

**Zone capacity:** Each zone has `maxOccupants`. When full:
- Agent waits at nearest walkable tile (queue behavior, no special state needed — reuse idle action with short duration)
- Or picks alternate zone (tables full -> bar) — decision system should have a fallback zone map per action
- Or leaves building (all busy -> go elsewhere)
- **Timeout:** If waiting exceeds 20 ticks, force alternate zone or leave to prevent deadlocks

### Sub-project 2: Visual Polish (Always-Visible Interiors)

**Goal:** Improve interior rendering without adding roof toggle. Interiors stay always visible.

**Floor differentiation:**
- Zone-specific floor colors (darker = private, lighter = public)
- Building floor differs from grass: wood (homes/tavern/bakery), stone (clinic/town_hall/prison), dirt (workshop/farm)
- Walls = thicker border lines with shadow

**Furniture sprites:**
- 1-2 small sprites per zone at blocked tiles (type `2`)
- 32px sprites using Kenney assets or simple emoji-style icons
- Bed, oven, desk, barrel, workbench, etc.
- **Asset loading:** Furniture textures should be loaded via PixiJS 8 `Assets.load()` with a manifest, not inline base64. Keep a fallback to colored rectangles if assets fail to load.

**Agent-inside indicators:**
- Subtle inner glow (additive blend circle) when agent is inside a building — reuse additive blending from Phase 6 particle rework (`sprite.blendMode = 'add'`)
- Zone label text fades when occupied
- Action icon above agent head (bed, cooking, dice, etc. — use text sprites, not emoji, for cross-platform consistency in PixiJS)

**Rendering changes** in `BuildingRenderer.ts`:
- Textured fills replacing flat colored rectangles
- Furniture sprite layer per zone
- Agent glow reuses particle system blending
- **Note:** `BuildingRenderer` currently imports `INTERIOR_ZONES` directly from server code. The `ZoneDef` migration (sub-project 1) must keep this import compatible or extract shared types to a `shared/` module.

### Sub-project 3: Open Area Structure

**Goal:** Farm, Park, Town Square get walkable sub-zones with terrain costs.

**Key difference from buildings:** No entry/exit transition. Open areas are part of the world grid. Agents walk in/out freely.

**Terrain cost modifiers** (on world A* grid):
- River tiles: blocked
- Crop tiles: 1.5x cost (agents prefer paths around them)
- Tree tiles: blocked
- All other tiles: normal cost

**A* cost modifier integration:** The current `computeAStarPath` treats all non-blocked tiles as cost 1.0 (or 1.414 diagonal). To support terrain costs, the `isBlocked` check must be replaced with a `getCost(x, y)` function that returns the tile's movement cost (or `Infinity` for blocked). The `tentativeG` calculation changes from `current.g + cost` to `current.g + baseCost * terrainCost`. This is a surgical change to pathfinding.ts (~10 lines) but affects all world movement, so it needs testing.

**Open area grids register directly on world collision grid** — no grid-switching.

**Farm zones (10×7):**
| Zone | Actions | Notes |
|------|---------|-------|
| Crop Fields (2 zones) | work, plant, harvest | Seasonal: crop tiles only spring-autumn |
| Chicken Coop | collect eggs, feed animals | — |
| Barn/Storage | work (store), hide, hookup | Low visibility |
| Well | fetch water, socialize | Social gathering point |
| Rest Spot | eat, idle, break | Partial energy restore |

**Park zones (8×6):**
| Zone | Actions | Notes |
|------|---------|-------|
| Riverside | fish, contemplate | Mood recovery, food production |
| Grove (2 zones) | stroll, flirt, secret meeting, forage | Low visibility for secrets |
| Benches | socialize, idle, comfort, people-watch | — |
| Garden | garden, pick flowers | Mood + comfort |
| Path | walking, jog | Normal movement |

**Town Square zones (9×8):**
| Zone | Actions | Notes |
|------|---------|-------|
| Market Stalls (2 zones) | browse market, shopping, pickpocket | — |
| Fountain | socialize, busking | Musician work zone |
| Open Plaza | socialize, idle, fight | High visibility (1.3x) |
| Podium | speech, protest, announce | Drama events |
| Seating | idle, eat, watch event | — |

**Farm seasonality:**
- Spring/Summer: crop tiles walkable (planted), 1.5x movement cost
- Autumn: crop tiles + harvest action, 1.5x movement cost
- Winter: crop tiles normal cost (fallow)
- **Implementation:** Terrain cost map must be recalculated on season change. The world already tracks `season` in the tick loop time object. Register a listener or check at the start of each day.

### Sub-project 4: Zone-Bound Actions & Interaction Expansion

**Goal:** Actions require specific zones. Add new zone-specific actions.

**Action resolution flow:**
1. Decision system picks action
2. Lookup `requiredZone` for action + building type
3. If agent not at required zone -> queue walk to zone
4. If zone at capacity -> alternate zone or wait (20-tick timeout, then fallback)
5. Execute action only when at correct zone

**Where to add `requiredZone`:** The `InteractionDef` interface in `interactionConstants.ts` gets an optional `requiredZone?: string[]` field. For non-interaction actions (sleep, eat, work), add zone requirements to a separate `ACTION_ZONE_REQUIREMENTS` map in `interiors.ts`. The decision system (`decisions.ts`) already imports `INTERIOR_ZONES` — extend that import to include zone requirements.

**Tier 1 -- Zone binding only (no new code beyond the zone check, 10 bindings):**

| Action | Required Zone |
|--------|--------------|
| sleep | home:bed |
| eat | home:kitchen, tavern:tables, bakery:display |
| working | per-job work zone (oven, counter, workbench, etc.) |
| gamble | tavern:tables |
| flirt/date | tavern:booth, park:grove |
| blackmail | tavern:booth, shop:storage |
| pickpocket | shop:shelves, square:market_stalls |
| burglary | shop:storage |

**Note:** "flirt/date" maps to existing interaction types `flirt` and `date` in the interaction registry. "gamble" is handled in `states.ts`. Each binding needs to map to the actual action/interaction type name used in the codebase.

**Tier 2 — Simple new actions (10 actions):**

| Action | Zone | Effect | Need Satisfied |
|--------|------|--------|---------------|
| cook | home:kitchen | food_raw → meal | hunger (better than raw eating) |
| rest | home:bed | partial energy | energy (50% of sleep rate) |
| contemplate | park:riverside | mood recovery | mood +5, comfort +3 |
| fish | park:riverside | produce food_raw + fun | fun +4, hunger if eaten |
| garden | park:garden | comfort + mood | comfort +4, mood +3 |
| forage | park:grove | produce herbs/berries | adds to inventory |
| perform | tavern:stage, square:fountain | musician work, fun for watchers | fun +6 for audience |
| watch | tavern:stage (nearby) | fun + social passive | fun +3, social +2 |
| browse | shop:shelves, square:market_stalls | fun, no purchase | fun +2 |
| jog | park:path | energy drain, fun + mood | fun +3, mood +2, energy -4 |

**Tier 3 -- Drama actions (9 actions):**

These are the most complex additions. Each requires a new `InteractionDef` entry in `interactionRegistry.ts` with prerequisites, effects, outcome factors, and narration config. Scope control: implement tier 3 only after tiers 1 and 2 are stable. Each action below is self-contained and can be added incrementally.

| Action | Zone | Effect | Consequences |
|--------|------|--------|-------------|
| scheme | tavern:booth | plan crime with accomplice | Creates shared_knowledge fact, enables coordinated goals |
| secret_meeting | park:grove | low-vis socializing | Visibility 0.2, share secrets safely |
| confide | clinic:exam_room | share secrets with doctor | Trust +5, creates therapy fact |
| speech | square:podium | mayor world event | All agents in square hear, mood/opinion shift |
| protest | square:podium | conflict with authority | Trust damage with mayor, creates political fact |
| announce | square:podium | gossip blast | All present agents learn the fact |
| escape_attempt | prison:cell | crime, chance-based | Success: flee. Fail: extended sentence, trust -10 with constable |
| smuggle | prison:hallway | pass item to prisoner | Creates contraband fact if witnessed |
| lock_out | home:door | prevent roommate entry | Target forced to find alternate shelter, relationship damage |

**Scope boundary for tier 3:** Each action needs: InteractionDef, zone binding, decision scoring logic, effect application, activity log template, and memory description template. Budget ~50-80 lines per action. Do NOT add new item types (smuggle uses existing economy items), new DB tables, or new LLM calls. "scheme" creates a shared_knowledge entry via existing `createFact()`. "speech/announce" broadcast to `current_occupants` of the location (already tracked). "escape_attempt" uses existing crime/arrest flow.

**Zone visibility for witness detection:**

| Zone Type | Visibility | Examples |
|-----------|-----------|---------|
| Public open | 1.0-1.3 | Plaza, podium, fountain |
| Indoor public | 0.7-0.9 | Bar, counter, tables |
| Semi-private | 0.4-0.6 | Booths, storage, hallway |
| Private | 0.2-0.3 | Cells, grove, barn |
| Home interior | 0.3-0.5 | Living, kitchen, bed |

## Files Affected

### Sub-project 1 (Interior Grid)
- `server/data/interiors.ts` -- extend with grid arrays, ZoneDef (replaces BuildingZone), keep backward-compatible relativePosition
- `server/lib/pathfinding.ts` -- add helper to convert 2D grid to flat collision string; no changes to core A* needed
- `server/engine/systems/movement.ts` -- interior/exterior grid switching, zone arrival detection, remove `_transitioning` hack for large buildings (keep for homes)
- `server/data/maps.ts` -- no changes needed (building dimensions stay the same)

### Sub-project 2 (Visual Polish)
- `src/components/canvas/BuildingRenderer.ts` -- floor textures, furniture sprites, wall shadows (imports ZoneDef from interiors.ts)
- `src/components/canvas/SpritePool.ts` -- agent glow when inside building
- `src/components/canvas/TilemapRenderer.ts` -- open area floor textures

### Sub-project 3 (Open Areas)
- `server/data/interiors.ts` -- add open area zone definitions (farm, park, town_square already have empty arrays)
- `server/lib/pathfinding.ts` -- add terrain cost support: `getCost(x, y)` function, modify tentativeG calculation
- `server/db/seed.ts` -- register open area zones in location data
- `server/engine/tick.ts` (or wherever season change is detected) -- trigger terrain cost recalculation on season change

### Sub-project 4 (Zone-Bound Actions)
- `server/lib/interactionConstants.ts` -- add optional `requiredZone?: string[]` to `InteractionDef`
- `server/data/interiors.ts` -- `ACTION_ZONE_REQUIREMENTS` map for non-interaction actions + `allowedActions` per zone
- `server/engine/systems/decisions.ts` -- zone requirement check in action selection (already imports INTERIOR_ZONES)
- `server/engine/systems/states.ts` -- zone requirements for gambling, theft, treatment
- `server/data/goalRegistry.ts` -- zone constraints on goal interactions
- `server/data/interactionRegistry.ts` -- add `requiredZone` to existing interaction defs, add tier 3 interaction defs
- New file: `server/engine/systems/zoneActions.ts` -- tier 2 action effect implementations
- `server/lib/memory/descriptionTemplates.ts` -- add memory templates for new actions
- `server/lib/activityLogger.ts` -- add activity log templates for new actions

### Testing
- `server/__tests__/interiorGrid.test.ts` -- grid conversion, zone lookup, home fallback
- `server/__tests__/pathfindingCost.test.ts` -- terrain cost modifiers, seasonal changes
- `server/__tests__/zoneActions.test.ts` -- zone binding validation, capacity overflow, tier 2 effects

## Integration Risks

1. **Movement system complexity:** `movement.ts` is already 414 lines with stuck detection, zone transitions, path recalculation, and interior lerp. Adding grid-switching increases state machine complexity. Consider extracting interior movement to a separate helper module.
2. **Tick performance:** The 10-phase tick loop runs synchronously. Adding zone occupancy checks and interior pathfinding per-agent per-tick could add latency. Interior A* on 5x4 grids is trivial (<1ms), but the grid lookup and conversion should be cached, not recomputed each tick.
3. **Cascade engine interaction:** New actions (scheme, protest, escape_attempt) will trigger ripple rules in the cascade engine. Verify that new action types are handled by `RippleEngine` rules or add catch-all handling to prevent silent drops.
4. **Planning system:** The `PlanDecomposer` maps free-form LLM plan text to action types. New tier 2/3 actions need to be added to the action type inference logic, or agents will never plan to use them.
5. **Client-server shared types:** `BuildingRenderer.ts` imports `INTERIOR_ZONES` directly from server code. The ZoneDef migration must not break this import path. If the type grows too complex for the client, extract a shared types module.

## What This Does NOT Include

- Roof toggle / cutaway rendering (decided: always visible)
- Expanded interiors (decided: same 32px tile size; homes remain 3x3)
- Tier 4 actions (haggle, teach recipe, decree, falsify records, public shaming, etc.)
- New item types beyond what existing economy supports
- Interior tileset art (uses colored rectangles + simple sprite furniture)
- Multiplayer / player avatar movement
- Multi-agent pathfinding / agent-agent collision inside buildings (agents can overlap on tiles)
