# Proposal: Perfect Believable Town — Gameplay Readability

**Lens:** A first-time viewer must instantly parse every building, zone, and agent state at default 1x zoom.
**Constraint:** 32×32 pixel art, nearest scaling, earthy palette, hard outlines. No AA.
**Priority order:** viewer impact ÷ implementation effort.

---

## 1. Instant Building Identification

**Problem (screenshot confirmed):** All buildings are colored floor rects with a generic 3px stroke in `0x4a3f2e`. A shop and a clinic are visually identical at default zoom except for floor tint — and even then, the tints are close enough to merge.

### 1a. Roof silhouettes (highest impact, one new sprite per type)

Replace the flat floor rect with a building volume: draw a 32×32 "roof cap" tile anchored to the top row of each building's footprint. Roof shape encodes type at a glance:

| Building | Roof silhouette | Roof color |
|---|---|---|
| home | pitched triangle peak, centered | warm terracotta `#b85c38` |
| shop | flat roof + small awning stripe | existing floor `#5a5040` + awning `#c8a84b` |
| tavern | wide pitched + chimney stub left | deep brown `#7a4f35` + chimney `#6b4f2e` |
| clinic | flat + red cross 4×4 on fascia | pale `#d8e8e0` + cross `#cc3333` |
| town_hall | hipped roof + bell-tower stub | gold `#c8a84b` |
| bakery | pitched + chimney right | warm tan `#e8d5a3` |
| workshop | mono-pitch (lean-to) + chimney left | slate `#4a4a42` |
| prison | crenellated parapet edge | stone gray `#6A6A6A` |
| pawnshop | flat + hanging sign below eave | dark `#5a4a3a` |
| divebar | flat + neon-strip sprite at door | `#6a3a2a` |
| farm | no roof (open) — fence post corner sprites | N/A |
| park | no roof (open) — tree sprites at corners | N/A |
| town_square | no roof (open) — cobblestone border ring | N/A |

Roof tiles do not need to be physically accurate — they are silhouette cues. Keep them within the building footprint's top 1–2 tile rows.

### 1b. Exterior signage icons (32×16 px, mounted above door)

Each closed building gets one icon sprite centered above the door cell. These must read at 32×32 equivalence:

| Building | Icon |
|---|---|
| shop | shelf/box icon |
| tavern | mug silhouette |
| clinic | white cross on green |
| town_hall | column/pillar |
| bakery | loaf / swirl |
| workshop | hammer |
| prison | bars (3 vertical lines) |
| pawnshop | three-ball pawn symbol |
| divebar | bottle silhouette |

At far zoom, icons collapse — only roof silhouette + BUILDING_COLORS floor tint remain readable. That is acceptable.

### 1c. Wall differentiation (low cost, instant improvement)

Current wall stroke is `0x4a3f2e` for all types. Change the stroke color per building family:
- Residential (home): `#9d7d47` warm wood
- Commercial (shop, pawnshop, divebar): `#5a4a32` dark plank
- Civic (town_hall, clinic, prison): `#8a8a7a` stone
- Industry (bakery, workshop): `#7a6a52` rougher stone
- Increase stroke from 3px to 4px — adds mass at small sizes.

---

## 2. Interior Legibility

**Problem:** Zone rects at 0.4 alpha + 5–6px text create an unreadable color soup. 16 of 18 furniture labels render as gray text with no visual. The current view (screenshot: interior buildings at right edge) shows exactly this — tinted patches with unreadable labels.

### 2a. Floor texture per building type (replaces flat FLOOR_MATERIALS color)

The 7 terrain tiles already exist as `32×32` PNGs with tile-repeat support. Apply the same pattern fill approach to interior floors:

| Building | Floor pattern |
|---|---|
| home | wood plank (horizontal lines, `#9d7d47` / `#e8d5a3`) |
| shop | stone tile (2×2 grid lines, `#5a5040`) |
| tavern | dark wood (diagonal grain, `#7a4f35`) |
| clinic | white tile (grid, `#d8e8e0` / `#c0d4cc`) |
| town_hall | flagstone (irregular patches, `#7a6a4a`) |
| bakery | terracotta tile (warm, `#c8785a`) |
| workshop | dirt/concrete (rough, `#4a4a42`) |
| prison | stone block (large, `#6A6A6A` / `#5a5a5a`) |
| pawnshop | worn wood (`#5a4a3a`) |
| divebar | sawdust floor (speckled, `#6a3a2a`) |

One 32×32 repeating tile per type. Already have `.aseprite` workflow — 10 tiles.

### 2b. Furniture sprite priority list (18 labels, effort-ordered)

The 16 unmapped labels must become visually distinct sprites. Not all require a new asset — some can share base shapes with color/icon overlays.

**Tier 1 — Distinct reads, ~1 hour each:**

| Label | Sprite description | Shared base |
|---|---|---|
| Stove | black box, 2 burner circles on top, pipe up | unique |
| Oven | front-face rectangle, door hatch lines | unique |
| Workbench | long plank on two legs, side vise | unique |
| Forge | dark stone bowl, orange glow center | unique |
| Counter | long low rectangle, different color from floor | unique |
| Shelves | 3 horizontal shelf lines, items implied | unique |
| Bar Counter | long counter + beer tap stub on top | Counter + tap |
| Prep Table | Counter + cutting mark diagonal | Counter variant |

**Tier 2 — Civic/institutional (distinct enough at 32px):**

| Label | Sprite | Shared base |
|---|---|---|
| Reception Desk | L-shaped desk, front panel | Counter variant |
| Mayor's Desk | wider desk, paper stack | Counter + paper |
| Guard Desk | Counter + badge icon overlay | Counter + badge |
| Meeting Table | wide oval/rect, chairs implied by corner dots | unique |
| Filing Cabinet | tall narrow rectangle, 2 drawer lines | unique |
| Patient Bed | bed.png recolor (white/pale blue instead of tan) | bed.png |

**Tier 3 — Lower priority reads:**

| Label | Sprite | Shared base |
|---|---|---|
| Tool Rack | vertical post, horizontal pegs | unique |
| Booth Seat | two-sided bench, curved back | unique |
| Stage | raised platform edge + footlights dots | unique |

**Rule:** Patient Bed must be visually distinct from Bed — recolor (white linen vs. brown linen) is the minimum. This resolves audit finding in VISUAL COVERAGE MATRIX immediately.

### 2c. Zone rects — suppress by default, reveal on hover/zoom

- **Default (far/mid zoom):** Remove zone rect overlays entirely. Floor texture + furniture sprites carry all identity information.
- **Near zoom (> 2x) or hover:** Show zone rects at 0.15 alpha as a soft highlight — enough to show area bounds without covering the floor.
- **Zone labels:** Move from always-on text to tooltip on zone hover only. At near zoom, show the label in a small pill (8px, background `rgba(0,0,0,0.6)`) above the zone center.

This one change eliminates the color-soup problem with zero new assets.

---

## 3. Life Signals

**Problem (audit C6, C7):** Lights are radial blobs at door positions. Windows don't exist. Occupancy dots show mood only. No dynamic signals of activity.

### 3a. Window glow keyed to occupancy + time

Add 4×6 px window sprites (two per building side) to each closed building's exterior. Windows are always drawn — dark `#2a1f14` at night unoccupied, lit `#f5c842` (warm yellow) at night occupied, `#c8d4c0` (daylight reflection) during day regardless of occupancy. This gives instant day/night building population reads.

Implementation: window positions are fixed offsets from building rect, per building width. No new render system needed — draw in the existing building Graphics pass.

### 3b. Chimney smoke — bakery and workshop only

When a bakery or workshop agent is in the working zone (forge, oven, prep_table):
- Spawn 3–4 animated particles above the chimney stub sprite.
- Particles: 4×4 gray-white circles, rise 12px over 60 ticks, fade alpha 1.0 → 0. Loop.
- Render in the same container layer as agent glow so they composite correctly.
- No smoke when unoccupied or closed. This is the single most legible "something is happening here" signal.

### 3c. Door open states

When any agent is inside a building, the door sprite renders open (rotated 45° or swapped to an open-door variant). When empty, door is closed. This is a 1-bit read at any zoom and costs one sprite variant per door type.

### 3d. Occupancy dots — activity not mood

Current dots encode mood color. Repurpose as activity state:

| Color | Meaning |
|---|---|
| `#4a9e6b` green | active / working |
| `#e8c84a` yellow | idle / socializing |
| `#5a7ac8` blue | sleeping / resting |
| `#cc4444` red | stressed / in conflict |

Mood is already available in the AgentPanel — dots on the world canvas should answer "what is this agent doing right now" not "how do they feel." Keep the mood ring on the agent sprite itself (already exists per audit: mood ring layer).

---

## 4. Bubble and Emote Anchoring

**Problem (audit C5):** Offsets are tuned for `AGENT_RADIUS=8`. Agents are 32×64 px sprites (32 wide, 64 tall with bubble zone). The bubble anchor must sit above the sprite head, not above the center point.

### 4a. Corrected anchor offset

Agent center is at `(spriteX + 16, spriteY + 16)` for a 32×32 sprite. Bubble should anchor at `(spriteX + 16, spriteY - 4)` — 4px above the sprite top edge, not at the center Y.

Formula: `bubbleY = agent.y - TILE_SIZE/2 - 4 - bubbleHeight`

For a 32×64 sprite with agent feet at Y and head at Y-32: `bubbleY = agent.y - 32 - 4 - bubbleHeight`

### 4b. Simultaneous emote stacking

When multiple emotes are queued, stack them vertically above the agent in reverse-chronological order (newest closest to head). Maximum 3 visible simultaneously. Each bubble is 20px tall + 2px gap. Oldest bubble fades at alpha 0.4.

Horizontal rule: if two agents within 48px horizontal distance both have bubbles, offset each outward by 12px to prevent overlap. Check neighbor positions at bubble spawn time.

---

## 5. Terrain Readability

**Problem (screenshot confirmed):** Scatter tiles render as flat dark squares (`#2a2a1a` or similar) on the green grass base. They read as visual noise or dead pixels, not as organic terrain detail.

### 5a. Scatter sprite variants

Replace the solid color overlays with 3–4 sprite variants per scatter type:

| Scatter type | Sprites (32×32 each) |
|---|---|
| Grass scatter | 3 variants: short tuft, medium tuft, wildflower (small white/yellow dot) |
| Dirt patch | 2 variants: bare patch, small pebble cluster |
| Rock | 1 base + 1 moss variant |
| Flower | 2 variants: yellow daisy, pink clover |

The existing terrain tiles (`grass`, `farm_soil`, `grove`) are already 32×32 and repeating. Scatter sprites sit on top at ~40% alpha — but must use pixel-art shapes (hard outline, 2-3 colors), not the current solid rect.

A single "scatter_grass.png" with 4 frame strip (4×32 px wide) lets the renderer pick frame by tile coordinate hash, giving variety with one asset.

### 5b. Road edges and transitions

Current roads render as flat `#6b5a3e` with no edge. The grass-to-road transition is a hard pixel boundary.

Add a 1-tile-wide "road edge" sprite: a dithered transition strip (dark road on one side, grass on the other, 4px blending zone using hard-pixel checkerboard — consistent with the existing art style). Four variants: N, S, E, W edge. These tile along every road-grass boundary.

Road surface: add subtle track marks — two parallel lines `#5a4a2e` running the road axis direction. Costs 2 sprites (H and V road tile), removes the "flat brown void" read.

---

## 6. Zoom-Dependent Detail Levels

Three zoom bands. The PixiJS camera scale drives which layers are visible.

### Far zoom (scale < 0.6 — full town visible)

Visible: roof silhouette sprites, building floor color, road edges, chimney smoke, window glow dots, agent position dots (4×4 px), occupancy dot colors.
Hidden: zone rects, furniture, agent labels, bubble text (only emote icon), interior detail.

Goal: town legibility. You know which building is which by silhouette + color.

### Mid zoom (0.6 – 1.4 — default view, matches screenshot)

Visible: all far content + building name label (7px pill above roof), agent sprite (32×32), agent name label, emote bubbles, door state, window sprites.
Hidden: zone rects, furniture sprites (buildings appear as floor texture only), zone labels.

Goal: agent tracking. You follow who is where and what mood/state they carry.

### Near zoom (> 1.4 — single building focus)

Visible: all mid content + furniture sprites, zone rects (0.15 alpha), zone labels (hover only → always-on at this zoom), interior floor texture detail, agent action text above bubble.
Hidden: nothing additional hidden.

Goal: understand what is happening inside this specific building.

---

## Priority Stack (viewer impact per effort)

| Rank | Change | Impact | Effort |
|---|---|---|---|
| 1 | Suppress zone rects by default (2c) | Eliminates color soup instantly | Low — alpha flag |
| 2 | Patient Bed recolor to white (2b Tier 2) | Fixes audit finding, one sprite | Very Low |
| 3 | Window glow keyed to occupancy (3a) | Town reads alive vs. empty | Low — Graphics offset |
| 4 | Roof silhouettes (1a) | Building identity at any zoom | Med — 10 sprites |
| 5 | Scatter sprite variants (5a) | Removes artifact reads from terrain | Med — 1 strip asset |
| 6 | Occupancy dot to activity color (3d) | Adds instant agent-state signal | Very Low — color remap |
| 7 | Furniture sprites Tier 1 (2b) | Interiors become readable | High — 8 sprites |
| 8 | Floor textures per type (2a) | Interior identity without labels | Med — 10 tile sprites |
| 9 | Wall stroke color family (1c) | Reinforces building category | Very Low — hex change |
| 10 | Bubble anchor fix (4a) | Fixes misplaced bubbles | Very Low — offset constant |
| 11 | Door open state (3c) | Occupancy signal at glance | Low — 1 sprite variant |
| 12 | Chimney smoke (3b) | Strongest "alive" signal | Med — particle system |
| 13 | Road edge transitions (5b) | Removes flat-brown-void read | Med — 4 edge sprites |
| 14 | Signage icons above door (1b) | Secondary to roof silhouettes | Med — 9 sprites |
| 15 | Emote stacking (4b) | Dense-scene readability | Low — layout logic |
| 16 | Furniture sprites Tier 2–3 (2b) | Civic building identity | High — 8 more sprites |
| 17 | Zoom-band layer gating (6) | Full progressive disclosure | Med — render flags |

Items 1, 2, 3, 6, 9, 10 require no new sprite assets. They should ship as a single low-cost pass before any art work begins. Items 4, 5, 7, 8 are the core art sprint.
