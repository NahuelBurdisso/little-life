# Perfect Town — World Model (Phase 1 scratchpad)

Mission scratchpad. Branch: feat/procedural-world-phase2. Baseline: 415 tests.

## Style source of truth
- NO art-bible.md exists anywhere. Canon = existing assets:
  - bed.png: 32×32 RGBA pixel art, ~6-8 color earthy palette (browns #9d7d47, tans #e8d5a3), hard dark outlines, no AA, nearest scaling.
  - Terrain tiles: 7× 32×32 (grass, dirt_path, water, farm_soil, crops_summer, grove, stone_plaza) + .aseprite sources.
  - Walls: door.png, wall_h.png, wall_v.png, wall_stone.png — ON DISK but NEVER LOADED (WALL_URLS empty; procedural Graphics used).
  - Agents: 32×32 single-frame, no directions, no animation.
- All new sprites: 32×32 PNG, nearest, hard outline, restricted earthy palette per building theme.

## Furniture labels (18 unique, from INTERIOR_ZONES)
Bed, Stove, Counter, Shelves, Bar Counter, Stage, Reception Desk, Patient Bed,
Mayor's Desk, Meeting Table, Filing Cabinet, Oven, Prep Table, Workbench,
Tool Rack, Forge, Guard Desk, Booth Seat.
- FURNITURE_URLS (textures.ts:23-25): ONLY 'bed'.
- FURNITURE_SPRITE (BuildingRenderer.ts:9-12): only 'Bed','Patient Bed' → 'bed'.
- => 16 labels render as text-label-only (5px gray text, no visual). Patient Bed identical to Bed.

## Building types
- Core: shop 5×4, tavern 6×4, clinic 5×4, town_hall 6×5, town_square 9×8(open), farm 10×7(open), park 8×6(open).
- Optional: bakery(6+) 5×4, workshop(8+) 5×4, prison(8+) 5×4, pawnshop(10+) 5×4, divebar(12+) 5×4.
- home 3×3, capacity 2, count = max(ceil(agents/2), maxReferenced).
- Derived outdoor: mainstreet, market_square, alley, farmyard (no grids, no colors).
- BUILDING_COLORS (buildingTemplates.ts:262+): all 12 types have hex.
- FLOOR_MATERIALS (BuildingRenderer.ts:14-23): only 8 (missing pawnshop, divebar + opens) → default 0x5A4A3A.
- Exteriors: pure Graphics — floor rect + 3px wall stroke (same 0x4a3f2e for ALL) + door rect. No roofs, signs, awnings, chimneys, windows. Identical look save floor color.

## Interior model
- INTERIOR_GRIDS (interiors.ts:57-130): 0=floor 1=wall 2=furniture 3=door(south edge, col=floor(w/2)).
- ZoneDef: id,name,label,tiles,center,maxOccupants,color,allowedActions,visibility?,furniture{label,tile},relativePosition.
- Agent stands at zone.center (adjacent floor tile), NOT on furniture. Pixel = locPos + center*32+16 (decisions.ts:1227).
- getInteriorGrid caches collision string + doorTile (interiorGrid.ts:39-67).
- Homes have NO door cell in 3×3 grid (no type-3) — special-cased.
- pawnshop grid identical layout to shop.
- Interior render: zone rects alpha 0.4 + text labels; furniture = sprite if mapped else text only.

## Interactions (35) & zone gating
- 14 interactions have requiredZone (pickpocket, burglary, flirt, date, blackmail, eavesdrop, buy_drinks, scheme, secret_meeting, speech, protest, announce, escape_attempt, smuggle, lock_out).
- ACTION_ZONE_REQUIREMENTS (interiors.ts:652-668): sleeping/eating/working/gambling.
- Needs: hunger, energy, social, comfort, fun (+mood, stress derived). ACTION_MODIFIERS needs.ts:21-30, ZONE_ACTIVITY_MODIFIERS needs.ts:37-46.
- Gaps flagged by reader: comfort need weak outlets; farm/park activities (fish, garden, forage, collect_eggs...) never demanded by any interaction/goal; divebar gambling zone=tables but tables zone has no furniture; nothing drives agents to forage/fish zones.

## Pathfinding
- Exterior A*: row-major '0'/'1' string, 8-dir, diagonal needs both orthogonals free, costMap Float32Array (farm crops 1.5 summer, park river Infinity, grove 1.3). pathfinding.ts:48-207.
- Interior: door→zone.center two-phase (movement.ts:169-293); exit = interior path to door + world path (487-507).
- collisionGrid.ts: enclosed footprints blocked, door + N/S neighbors unblocked (assumes south doors).
- FACING NOT TRACKED anywhere (no direction state; sprites single-frame).
- Test patterns: pathfindingCost.test.ts (string grids + expect path.length>0), interiorGrid.test.ts (door uniqueness/position, zone occupancy).

## Rendering
- textures.ts: TERRAIN_URLS(7), WALL_URLS(empty), FURNITURE_URLS(bed). getXTexture → null if unmapped. preloadAllWorldTextures.
- TilemapRenderer: containers terrain<roads<openArea<labels<occupancy. Roads: color 0x6b5a3e fallback + tries texture key 'road' (NO road.png on disk → always fallback). Terrain scatter = colored overlays, no textures. Open-area ZONE_TEXTURE maps 7 zone ids.
- LightingSystem: 9 building light profiles, additive lightmap 1/8 res, multiply composite. home occupancy-gated; shop/clinic/bakery operating-hours; tavern/divebar night-only. Street lights every ~6 road tiles. Agent lanterns at night. NO pawnshop/town_square/farm/park profiles.
- DayNightCycle: static tint overlay per phase.
- AgentSprite: layers glow/selection/mood ring/sprite/state ring/label. No facing/animation.
- BubbleSystem/InteractionLayer: not yet audited in detail.

## Live audit tooling
- No Browser MCP this session. Use Playwright/Puppeteer script via Bash (check devDeps).
- npm run dev = server:3001 + vite:5173. Needs Ollama; sim may degrade without.

## VISUAL COVERAGE MATRIX (initial, static)
Furniture label × (sprite disk / URLS entry / renderer maps / distinct):
- Bed: YES/YES/YES/no (shared w Patient Bed)
- Patient Bed: reuses bed.png — not distinct
- Other 16 labels: NO/NO/NO/NO
Building type × (exterior look / wall set / floor set / signage):
- ALL types: exterior = colored rect only; walls generic stroke; floor color 8/13; signage none.
- Roofs/windows/chimneys/awnings: none anywhere.

---
# Phase 2 — Audit Findings (verified)

## Grid/data integrity (programmatic validation; 226 checks passed, 9 findings)
- A1 HIGH divebar.booth: center [3,2] = furniture cell (grid [1,0,0,2,1] row2); furniture.tile [3,1] = floor. Swap: furniture at [3,2], center [2,2]... but [2,2] belongs to tables zone — resolve by making booth tiles/center consistent. VERIFIED by direct read.
- A2/A3 MED home bed/kitchen: furniture.tile points to floor — home grid is synthetic all-floor 3×3, no furniture cells (no INTERIOR_GRIDS[home]). Renderer still draws Bed sprite from zone data, but grid/data invariant broken.
- A4 MED town_hall.meeting_table: furniture.tile [3,1]=0; actual furniture cell [1,1] claimed by mayors_desk? (grid row1 [1,2,0,0,0,1]).
- A5 MED town_hall.records: furniture.tile [4,2] Chebyshev 3 from center [1,3] — agent nowhere near filing cabinet.
- A6 MED workshop.forge: furniture.tile [3,2]=0 — forge has no furniture cell in grid.
- A7 MED divebar.booth.furniture.tile [3,1]=0 (see A1).
- A8 LOW prison orphan furniture cell [3,1] — no zone.furniture claims it.
- A9 LOW divebar orphan furniture cell [3,2].
- Clean: all zone centers reachable from doors; ACTION_ZONE_REQUIREMENTS + requiredZone refs all valid; zone tiles in bounds.

## Template/renderer consistency
- B1 MED FLOOR_MATERIALS missing pawnshop + divebar (BuildingRenderer.ts:14-23) → fallback color.
- B2 LOW LightingSystem OPEN_AREA_TYPES lists 'mainstreet','alley' — types DO exist as derived outdoor locations (auditor wrong that they don't exist — worldgen layout.ts derives them). Treat as OK but verify rendering of derived outdoor locs (no INTERIOR_ZONES → no zone render; likely invisible areas).
- B3 LOW maps.ts getDefaultServices/getOperatingHours missing pawnshop/divebar cases (redundant with templates; verify which is actually consumed at runtime before touching).
- Clean: grid dims match templates; door alignment verified all types; open-area zone tiles within footprints; BUILDING_LIGHTS 10/10.

## Believability top breaks (static)
- C1 HIGH homes 100% identical 3×3 clones; descriptions promise variety.
- C2 HIGH no sleep/sit/use poses; sleeping agent = standing sprite at bed top-left corner (zone.center [0,0]).
- C3 MED-HIGH home/non-A* interiors: door→zone straight lerp clips through walls (movement.ts:236-256).
- C4 MED prison/clinic/bakery/workshop interiors indistinguishable without text; brown-gray soup.
- C5 MED bubbles/emotes: fixed offsets tuned for AGENT_RADIUS=8; overlap in dense scenes; emote stacking.
- C6 MED lights = radial blobs at door; no window visuals; home lights pop on arrival.
- C7 LOW-MED occupancy dots mood-only.
- Day/night traffic: OK (sleep 22-07 w/ personality shift, high priority) — plausible.

## Live audit (screenshots: docs/scratch/shots/)
- town-initial.png: buildings = flat rects + pale zone patches + illegible 5-6px text; terrain scatter = flat dark squares (reads as artifacts, not flowers/grass); roads = flat brown, no edges/transitions; daytime white glow blobs visible (shop/clinic lights render in day); town square = translucent color patches; agents = circle fallbacks (test world). No roofs/walls/signs/windows anywhere.
- Current DB world = "Test Agent" seed, few buildings. Full-type audit needs seeded 12+ agent world.

## Tooling notes
- Playwright CLI works: npx playwright screenshot --viewport-size=1600,1000 --wait-for-timeout=10000 http://localhost:5173 out.png
- Dev server bg task byb9dstnq. Ollama offline — LLM errors spam but sim+render fine.
