# Perfect Town — Phase 3 Synthesized Plan (ranked)

Inputs: proposal-visual.md, proposal-simulation.md, proposal-readability.md + 3 judge reports.
Judge verdicts: simulation grid fixes VALID (visual proposal's A4/A5 grid edits REJECTED — collision at [1,1], invariant break). Order constraint: data fixes land BEFORE sprite wiring (sprite draw positions depend on corrected furniture.tile).

## Ranked implementation order

### Tier 1 — Data foundation (Stream B, ships first)
Source: proposal-simulation.md (all edits judge-validated).
1. Invariant test suite `server/__tests__/interiorDataIntegrity.test.ts` (FAILING FIRST):
   - every zone.center is walkable floor (grid 0 or 3-adjacent standing rule)
   - every zone.furniture.tile points to grid cell == 2 (or sentinel [-1,-1] for homes)
   - Chebyshev(center, furniture.tile) <= 1
   - no orphan furniture cells (every 2-cell claimed by exactly one zone)
   - ACTION_ZONE_REQUIREMENTS refs valid zones
   - home synthetic grid has door at [1,2]
2. Grid/zone fixes (interiors.ts):
   - divebar booth: center -> [2,2], furniture.tile -> [3,2] (zone-only fix)
   - town_hall row1 -> [1,2,0,2,0,1]; meeting_table furniture [3,1], center [2,1]; records center -> [3,2]
   - workshop row2 -> [1,0,0,2,1]; forge furniture [3,2], center [2,2]
   - prison orphan [3,1] -> demote to floor 0
   - divebar orphan [3,2]: claimed by booth fix above
   - home bed/kitchen furniture.tile -> sentinel [-1,-1] handling OR give home real synthetic grid (below)
3. Home synthetic grid `[[0,0,0],[0,0,0],[0,3,0]]` in INTERIOR_GRIDS — fixes lerp wall-clip (C3), gives door cell. Update interiorGrid.test.ts (home-has-no-grid test).
4. Comfort outlet (C7/needs gap): ACTION_ZONE_REQUIREMENTS comfort -> park benches; needs.ts comfort ACTION_MODIFIER row; decisions.ts threshold. Existing zones only — no new furniture (mission rule: new furniture only w/ full pipeline).

### Tier 2 — Asset production (Stream D, after Tier 1 merges)
Source: proposal-visual.md.
5. `scripts/gen-furniture.mjs` (pngjs): 24-swatch master palette (OUTLINE #1a1510, LINEN #e8d5a3, FORGE_GLW #ffb040), JSON rect specs, auto outline pass. 18 sprites, 32x32: bed(regen), stove, counter, shelves, bar_counter, stage, booth_seat, reception_desk, patient_bed(distinct), mayors_desk, meeting_table, filing_cabinet, oven, prep_table, workbench, tool_rack, forge, guard_desk.
6. Register all in FURNITURE_URLS (textures.ts) + FURNITURE_SPRITE map (BuildingRenderer.ts) — all 18 labels.
7. Invariant test: label in interiors.ts + FURNITURE_SPRITE + FURNITURE_URLS — all three or none (target-state coherence test).

### Tier 3 — Renderer no-asset pass (Stream C, parallel w/ Tier 2)
Source: proposal-readability.md quick wins + B1.
8. FLOOR_MATERIALS: add pawnshop, divebar + per-type interior palettes (floor+wall hex from visual proposal table).
9. Per-type exterior differentiation via Graphics: wall stroke color per type, door style, sign plate, chimney rects (no sprites needed).
10. Zone-rect suppression: hide alpha-0.4 zone rects by default, show on hover/selection.
11. Bubble anchor fix: bubbleY = agent.y - 32 - 4 - bubbleHeight.
12. Occupancy dots: activity-colored (not mood-only).
13. Daytime glow bug: gate shop/clinic light profiles to operating hours properly (audit showed day blobs).

### Tier 4 — Lighting/atmosphere (Stream C phase 2)
14. Window glow rects keyed occupancy+night (Graphics, warm color).
15. Forge/oven emissive light profiles; add pawnshop light profile.

### Deferred to Phase 6 polish rounds
Roof silhouettes (multi-tile, underspecified), floor texture tiles, road edge transitions, chimney smoke particles, door open states, agent facing/rotation, zoom bands, HOME_ZONE_VARIANTS A/B/C, scatter sprite variants.

## Verification (Phase 5)
- npx vitest run (baseline 415 + new tests, all green)
- Regen seeded world (server/seed-world.ts), screenshot gallery day+night via Playwright CLI.
