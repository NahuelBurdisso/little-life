# Visual Coherence Proposal — Perfect Believable Town

Art Director pass. Stack: PixiJS 8, PIXI.Graphics + PNG sprites 32×32 nearest, earthy master palette.

---

## 0. Ship Priority (max believability / effort)

1. Floor materials for pawnshop + divebar (5-min code fix, B1)
2. Per-building wall stroke colors (replaces universal 0x4a3f2e)
3. All 18 furniture sprites via node script (single batch)
4. Exterior signs / roof trim via Graphics overlays (no new sprites needed)
5. Chimney sprites for bakery, workshop, forge

---

## 1. Master Palette — Shared Constraints

All 18 furniture sprites and all building assets draw from these 24 swatches only.
This ensures every sprite reads as the same hand.

```
OUTLINE   #1a1510   (universal hard outline, 1px border)
SHADOW    #2e2418
DARK_WOOD #4a3020
MID_WOOD  #7a5030
LIGHT_WOOD #b07840
TAN       #d4a870
LINEN     #e8d5a3   (bed.png reference)
STONE_DK  #3a3830
STONE_MD  #5a5850
STONE_LT  #8a8878
MORTAR    #6a6858
IRON_DK   #2a2828
IRON_MD   #484442
IRON_LT   #706a60
EMBER_DK  #6a1800
EMBER_MD  #c04010
EMBER_LT  #f07020
FORGE_GLW #ffb040   (additive, forge only)
GREEN_DK  #2a4020
GREEN_MD  #4a6830
CREAM     #e0d8c0
WHITE_LT  #f0ece0
BLUE_DARK #1a2840
BLUE_MID  #2a4870
GOLD      #c09020
```

Palette rule: no sprite uses more than 8 of these swatches. Outline always #1a1510.

---

## 2. All 18 Furniture Sprites — 32×32 Specs

### Home

**Bed** (existing, earthy reference — KEEP)
- Already ships. Linen #e8d5a3 pillow, MID_WOOD #7a5030 frame, DARK_WOOD headboard. No change.

**Stove** — home kitchen, cast iron
- Body: 20×18px IRON_MD centered, IRON_DK top surface
- 2 burner circles 6px diameter IRON_LT with EMBER_MD glow dot center
- Pipe stem 4×8px IRON_DK rising top-right
- Key: chunky iron mass, no decorative tiles, reads as domestic

**Counter** — shop / home, wooden work surface
- 28×12px MID_WOOD plank across bottom-center of tile
- 3 vertical plank lines in DARK_WOOD
- Lip overhang: 2px SHADOW strip along top edge
- Key: horizontal plank read, shop variant identical (differentiated by floor color around it)

**Shelves** — shop / home
- 3 horizontal shelves TAN #d4a870, each 28×4px, evenly spaced
- 2 vertical supports DARK_WOOD
- Small colored rect "items" on middle shelf (3×3px, mix CREAM + STONE_LT)
- Key: ladder-like silhouette, immediately reads as storage

### Tavern

**Bar Counter** — tavern, social hub
- Wide 28×14px DARK_WOOD base, LIGHT_WOOD top surface strip 28×4px
- 3 small bottle shapes (4×8px) on top surface: BLUE_DARK body, CREAM highlight
- Front face: vertical plank texture lines in MID_WOOD
- Key: bottles distinguish it from generic Counter — they must be visible at 32px

**Stage** — tavern, performance corner
- Raised platform: 28×20px MID_WOOD planks, 3px DARK_WOOD edge shadow
- Center: simple music note glyph (3 pixels) in GOLD #c09020
- Stage lip: 2px LIGHT_WOOD highlight strip
- Key: raised-platform read via edge shadow + slightly lighter surface

**Booth Seat** — divebar (fix: move to correct tile per A1/A9)
- Two seat pads 10×8px each, DARK_WOOD #4a3020, flanking a center gap
- Back cushion 26×6px across top, same tone
- Table surface 12×8px STONE_MD between seats
- Key: U-shape / booth silhouette, denser/darker than tavern benches

### Shop / Commerce

_(Counter and Shelves above cover shop — no additional unique labels)_

### Clinic

**Reception Desk** — clinic entry
- 24×16px MID_WOOD base
- White clipboard rect 8×10px on surface (WHITE_LT + OUTLINE border)
- Small red cross 5×5px in EMBER_MD top-left corner of surface
- Key: red cross is the single most important pixel — make it land

**Patient Bed** — clinic, must NOT read as home Bed
- Frame: IRON_MD #484442 (metal, vs wood home bed)
- Mattress: WHITE_LT #f0ece0 (vs linen tan of home bed)
- Pillow: CREAM #e0d8c0 with OUTLINE border
- Side rails: 2px IRON_LT strips along long edges
- Key: metal frame + white palette = clinical, home Bed = warm wood + tan

### Town Hall

**Mayor's Desk** — authority, civic
- 28×16px DARK_WOOD base, ornate — 4px carved-panel indentations on front face
- GOLD #c09020 nameplate rect 12×4px on surface center
- Stack of papers 8×6px CREAM top-right corner
- Key: the gold nameplate is the lone accent; reads as important

**Meeting Table** — large, central (fix tile per A4: ensure furniture cell [1,1] matches zone)
- 28×20px MID_WOOD oval approximated by rect with 4px corner notches
- 6 small chair indicators (4×4px DARK_WOOD) around perimeter
- Center: LIGHT_WOOD surface highlight strip
- Key: chairs-around-table silhouette = unmistakable meeting room

**Filing Cabinet** — records zone (fix tile per A5: move to reachable cell)
- 12×28px IRON_MD tall rectangle (portrait orientation)
- 3 drawer lines IRON_DK at 8px intervals
- Drawer pull: 2px IRON_LT centered per drawer
- Key: tall + portrait + drawers — instantly reads as filing

### Bakery

**Oven** — bakery, large + hot
- 24×22px STONE_MD body (masonry)
- Arched opening 10×8px IRON_DK with EMBER_LT glow inside (3×4px)
- Top surface: STONE_LT slab
- Chimney pipe hint: 4×6px IRON_DK top-right
- Key: arch opening + ember glow = unambiguous oven; differs from Stove (no arch, iron body)

**Prep Table** — bakery worktop with flour mess
- 28×14px LIGHT_WOOD surface
- Irregular white scatter pixels (5-7px, WHITE_LT) = flour
- Rolling pin diagonal: 3×12px CREAM with OUTLINE ends
- Key: rolling pin is unique prop, flour scatter adds texture

### Workshop

**Workbench** — workshop, heavy
- 28×16px DARK_WOOD base, very thick
- Clamp on left edge: 6×6px IRON_MD with 2px screw circle
- Surface: scattered 3px tool shapes (IRON_LT)
- Key: clamp silhouette + thick legs reads as workshop, not kitchen

**Tool Rack** — vertical wall-mount
- 28×24px DARK_WOOD backing panel
- 4 peg rows: 3px IRON_MD pegs each, horizontal
- Hanging tool outlines: 2 hammers (6px), 1 saw (8px) in IRON_LT
- Key: wall-panel orientation + peg silhouettes. Only furniture with vertical dominant axis

**Forge** — workshop, signature piece — GLOWS
- 20×20px STONE_DK stone base, irregular top edge (2px notched)
- Coal bed: 16×6px IRON_DK with EMBER_DK + EMBER_MD scatter pixels
- Flame core: 8×6px EMBER_LT, tip pixel FORGE_GLW #ffb040
- Note for technical-artist: add PointLight or additive tinted overlay at forge center (FORGE_GLW, radius 48px, alpha 0.6) matching LightingSystem pattern
- Key: FORGE_GLW is used ONLY here. It is the visual anchor of the workshop district

### Prison

**Guard Desk** — prison, authority / surveillance
- 24×14px DARK_WOOD base
- Iron badge shape 8×8px IRON_LT on surface (star silhouette: center square + 4 cardinal pixels)
- Key ring: 3px circle IRON_MD bottom-right corner
- Key: badge + key ring = law enforcement, not civic (no gold nameplate)

### Divebar

_(Booth Seat specified above)_

---

## 3. Per-Building Interior Palettes

Floor hex is what FLOOR_MATERIALS should return. Wall stroke replaces the universal `0x4a3f2e`.

| Type      | Floor hex  | Floor read     | Wall stroke | Wall character            |
|-----------|-----------|----------------|-------------|---------------------------|
| home      | `#6b5b45` | worn plank     | `#3d2e1e`   | warm dark timber          |
| shop      | `#5a5040` | flagstone gray | `#38302a`   | stone-and-mortar          |
| tavern    | `#7a4f35` | dark oak       | `#4a2e18`   | rough-hewn wood, amber    |
| clinic    | `#d8e8e0` | pale mint tile | `#7a9090`   | clean plaster, cool tone  |
| town_hall | `#7a6a4a` | polished slate | `#4a3c28`   | dressed stone, civic      |
| bakery    | `#c8a870` | warm terracotta| `#6a4a28`   | whitewashed brick tint    |
| workshop  | `#4a4a42` | concrete slab  | `#2a2820`   | soot-dark stone           |
| prison    | `#6a6a6a` | cold stone     | `#3a3838`   | iron-grey fortress stone  |
| pawnshop  | `#5c5044` | worn stone     | `#3a302a`   | same family as shop       |
| divebar   | `#3a3028` | grime wood     | `#28201a`   | darkest interior, moody   |

Wall rendering upgrade (compatible with current Graphics approach):
- Stroke width stays 3px but color becomes type-specific (table above)
- Add a second inner rect stroke at 1px, color = floor hex at alpha 0.3, to imply wainscoting
- No sprite swap required — pure color data change in FLOOR_MATERIALS + new WALL_COLORS map

---

## 4. Exterior Differentiation

All via PIXI.Graphics overlays on the existing floor-rect approach. No new exterior sprites except chimney.

### Roof Trim Strip
- Draw a 4px horizontal rect across the TOP edge of each building rect
- Color = BUILDING_COLORS[type] darkened by ~30% (multiply by 0.7 in hex math)
- This creates an eave shadow line that breaks up the flat rect immediately

### Door Styles (replace current 12×8 generic gold rect)
| Type       | Door color      | Door size | Detail                          |
|------------|----------------|-----------|---------------------------------|
| home       | `#7a5030` MID_WOOD | 10×10 | Single leaf, no window          |
| shop       | `#8b6914` GOLD   | 12×10 | Gold trim = open for business   |
| tavern     | `#4a2e18` dark   | 14×12 | Wide double-door, arched top 2px|
| clinic     | `#e0e8e4` WHITE  | 10×10 | White = clean, medical          |
| town_hall  | `#c09020` GOLD   | 16×12 | Grand double-door, widest       |
| bakery     | `#a06820` warm   | 10×10 | Standard, warm tone             |
| workshop   | `#3a3028` iron   | 12×10 | Heavy dark door                 |
| prison     | `#2a2828` iron   | 10×12 | Tall narrow, iron-dark          |
| pawnshop   | `#5a4030` mid    | 10×10 | Standard                        |
| divebar    | `#1e1810` black  | 12×10 | Near-black, uninviting          |

### Signs / Awnings (Graphics only, no sprites)
- Shop: 20×6px rect, color GOLD, centered above door, y = building.top - 8
- Tavern: 28×8px rect, color `#5a2010` (burgundy), full width awning, y = building.top - 8
- Bakery: 18×6px rect, color `#c07828` (warm orange-tan), y = building.top - 8
- Clinic: white cross 6×6px drawn as two rects, centered above door
- Town Hall: 8×8px GOLD circle (seal) top-center of building face
- Pawnshop: three-ball pawnbroker: 3× 4px circles GOLD, stacked triangle, y = building.top - 10
- Divebar: no sign (intentional — increases mystery)

### Chimneys (Graphics rect, 3 types)
- bakery: 6×10px STONE_MD rect at building top-right corner, 2px STONE_LT highlight
- workshop: 4×8px IRON_MD rect, same position
- forge: 6×12px STONE_DK rect + EMBER_LT 4×4px glow circle above rim (blended additive)
- Render: draw BEFORE the wall rect so walls overlap the base naturally

---

## 5. Data Fixes Required for Visuals

These only matter because visual placement follows `furniture.tile`:

- **A1 + A9 divebar.booth**: change `furniture.tile` to `[3,2]`, change zone `center` to `[2,2]`. Without this the Booth Seat sprite will land on a furniture cell that the renderer skips (tile=floor).
- **A4 town_hall.meeting_table**: change `furniture.tile` to `[1,1]` to match the actual furniture cell in the grid.
- **A5 town_hall.records**: change `furniture.tile` to `[2,3]` (closest reachable cell to center [1,3]). Filing Cabinet sprite lands visible to agent.
- **A6 workshop.forge**: grid has no furniture cell at [3,2]. Add a `2` at grid position [3,2] or move `furniture.tile` to an existing `2` cell. Forge glow effect tied to this tile position.
- **B1 pawnshop + divebar**: add to FLOOR_MATERIALS (values in table above). Eliminates the fallback brown.

No other data changes needed for the visual layer.

---

## 6. Sprite Production Method

Single Node.js script: `scripts/gen-furniture.mjs`

```
Input:  JSON spec per sprite (palette subset, shape commands as [x,y,w,h,color] rects)
Output: 32×32 RGBA PNG via `pngjs`, written to public/sprites/furniture/<key>.png
Scaling: nearest (no sub-pixel, no AA) — enforced by integer coords only
Outline: first pass draws all rects; second pass traces 1px border pixels against transparent neighbors, sets them to #1a1510
```

Spec JSON structure per sprite:
```json
{
  "key": "forge",
  "rects": [
    { "x": 6, "y": 8, "w": 20, "h": 20, "color": "#3a3830" },
    { "x": 8, "y": 18, "w": 16, "h": 6, "color": "#2a2828" }
  ],
  "pixels": [
    { "x": 12, "y": 20, "color": "#f07020" }
  ]
}
```

FURNITURE_URLS in textures.ts: add all 17 new keys alongside `'bed'`.
FURNITURE_SPRITE in BuildingRenderer.ts: add all 17 label-to-key mappings.

Sprite keys:
`bed, stove, counter, shelves, bar_counter, stage, booth_seat, reception_desk,
patient_bed, mayors_desk, meeting_table, filing_cabinet, oven, prep_table,
workbench, tool_rack, forge, guard_desk`

---

## 7. Rendering Note for Forge Glow

Forge is the one furniture piece that must interact with LightingSystem.
The technical-artist should add a `forge` entry to BUILDING_LIGHTS in LightingSystem.ts:
radius 64px, color FORGE_GLW #ffb040, alpha 0.7, always-on (not operating-hours gated),
positioned at the forge furniture tile center. This is the only interior light source in the game
and makes the workshop district read as distinctly industrial at night.
