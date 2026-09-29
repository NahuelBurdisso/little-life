-- furniture.lua — the interior furniture and outdoor zone props, drawn in a 3/4 top-down view.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/furniture --script scripts/aseprite/furniture.lua
--   (add --script-param only=bed to rebuild one piece)
--
-- Replaced the old pngjs generator (gen-furniture.mjs, flat front-on rectangles). Same file names, same 32x32
-- cell, same 24-swatch master palette (docs/scratch/proposal-visual.md §1), but every piece now
-- has a lit top face, a shaded front face, a generated 1px outline and a soft drop shadow, so it
-- reads as an object standing on the floor rather than a sticker on it.
--
-- Writes <key>.aseprite (layers: shadow, outline, body — retouch body and re-run nothing) and
-- <key>.png for each piece.

-- Most pieces fill one 32x32 tile. A few outdoor/wide ones (podium, coop, barn) span several tiles;
-- they are listed in SIZES and every primitive below reads the current piece's W x H.
local S = 32
local W, H = S, S
local SIZES = { podium = { 64, 32 }, chicken_coop = { 64, 32 }, barn = { 64, 64 } }
-- Flat things lying on the floor (rugs, mats, flower beds) cast no drop shadow.
local FLAT = { rug = true, hall_mat = true, flower_bed_pink = true, flower_bed_yellow = true }
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end

local P = {
  OUTLINE = 0x1a1510, SHADOW = 0x2e2418, DARK_WOOD = 0x4a3020, MID_WOOD = 0x7a5030,
  LIGHT_WOOD = 0xb07840, TAN = 0xd4a870, LINEN = 0xe8d5a3, STONE_DK = 0x3a3830,
  STONE_MD = 0x5a5850, STONE_LT = 0x8a8878, MORTAR = 0x6a6858, IRON_DK = 0x2a2828,
  IRON_MD = 0x484442, IRON_LT = 0x706a60, EMBER_DK = 0x6a1800, EMBER_MD = 0xc04010,
  EMBER_LT = 0xf07020, FORGE_GLW = 0xffb040, GREEN_DK = 0x2a4020, GREEN_MD = 0x4a6830,
  CREAM = 0xe0d8c0, WHITE_LT = 0xf0ece0, BLUE_DARK = 0x1a2840, BLUE_MID = 0x2a4870,
  GOLD = 0xc09020,
}
-- Two extra tones the old palette lacked for fabric: a leather red and its shade.
P.RED_MD, P.RED_DK = 0x8a2a2a, 0x5a1a1a

-- ── Drawing primitives ─────────────────────────────────────────────────────────────────────

local img -- current body image

local function px(x, y, c) if x >= 0 and y >= 0 and x < W and y < H then img:drawPixel(x, y, hex(c)) end end
local function rect(x, y, w, h, c) for yy = y, y + h - 1 do for xx = x, x + w - 1 do px(xx, yy, c) end end end
local function hline(x, y, w, c) rect(x, y, w, 1, c) end
local function vline(x, y, h, c) rect(x, y, 1, h, c) end
local function disc(cx, cy, r, c)
  for yy = math.floor(cy - r), math.ceil(cy + r) do
    for xx = math.floor(cx - r), math.ceil(cx + r) do
      local dx, dy = xx + 0.5 - cx, yy + 0.5 - cy
      if dx * dx + dy * dy <= r * r then px(xx, yy, c) end
    end
  end
end

-- A box seen from above and slightly south: top face (w x topH) over a front face (w x frontH).
-- The top gets a 1px lit rim along its back edge; the front darkens toward the floor.
local function box(x, y, w, topH, frontH, top, front, opt)
  opt = opt or {}
  rect(x, y, w, topH, top)
  hline(x, y, w, opt.rim or top)
  rect(x, y + topH, w, frontH, front)
  if frontH > 1 then hline(x, y + topH + frontH - 1, w, opt.base or front) end
  if opt.planks then
    for xx = x + opt.planks, x + w - 2, opt.planks do vline(xx, y + topH, frontH - 1, opt.plankC) end
  end
  if opt.grain then
    for yy = y + 2, y + topH - 1, opt.grain do hline(x + 1, yy, w - 2, opt.grainC) end
  end
end

-- ── Finishing: outline + shadow layers ─────────────────────────────────────────────────────

local function opaque(i, x, y)
  if x < 0 or y < 0 or x >= W or y >= H then return false end
  return pc.rgbaA(i:getPixel(x, y)) == 255
end

local function finish(body, flat)
  local outline = Image(W, H, ColorMode.RGB); outline:clear(0)
  for y = 0, H - 1 do
    for x = 0, W - 1 do
      if not opaque(body, x, y) and (opaque(body, x - 1, y) or opaque(body, x + 1, y)
          or opaque(body, x, y - 1) or opaque(body, x, y + 1)) then
        outline:drawPixel(x, y, hex(P.OUTLINE))
      end
    end
  end
  -- Shadow: the silhouette (body + outline) pushed 2px right and 2px down.
  local shadow = Image(W, H, ColorMode.RGB); shadow:clear(0)
  for y = 0, H - 1 do
    for x = 0, W - 1 do
      if not flat and (opaque(body, x - 2, y - 2) or opaque(outline, x - 2, y - 2))
         and not opaque(body, x, y) and not opaque(outline, x, y) then
        shadow:drawPixel(x, y, hex(0x1a1208, 90))
      end
    end
  end
  return shadow, outline
end

-- ── The pieces ─────────────────────────────────────────────────────────────────────────────

local D = {}

D.bed = function()
  box(6, 2, 20, 4, 3, P.DARK_WOOD, P.SHADOW, { rim = P.MID_WOOD })          -- headboard
  box(6, 8, 20, 18, 4, P.MID_WOOD, P.DARK_WOOD, { rim = P.LIGHT_WOOD })     -- frame
  rect(7, 8, 18, 18, P.LINEN)                                               -- mattress
  box(9, 9, 14, 4, 1, P.WHITE_LT, P.CREAM)                                  -- pillow
  rect(7, 15, 18, 11, P.BLUE_MID)                                           -- blanket
  hline(7, 15, 18, P.CREAM)                                                 -- folded sheet
  hline(7, 16, 18, 0x3a5a88)
  for y = 18, 24, 3 do hline(8, y, 16, P.BLUE_DARK) end                    -- quilt seams
  vline(24, 16, 10, P.BLUE_DARK)
end

D.stove = function()
  box(4, 8, 24, 12, 9, P.IRON_MD, P.IRON_DK, { rim = P.IRON_LT })
  for _, c in ipairs({ { 10, 14 }, { 19, 14 } }) do
    disc(c[1], c[2], 3.5, P.IRON_DK); disc(c[1], c[2], 2.5, P.STONE_DK); disc(c[1], c[2], 1.2, P.EMBER_MD)
  end
  rect(8, 22, 16, 4, P.STONE_DK)                                            -- oven door
  hline(9, 23, 14, P.EMBER_DK); hline(10, 24, 12, P.EMBER_MD)
  box(23, 1, 4, 2, 7, P.IRON_LT, P.IRON_MD)                                 -- flue
end

D.counter = function()
  box(1, 9, 30, 9, 10, P.LIGHT_WOOD, P.MID_WOOD,
      { rim = P.TAN, planks = 6, plankC = P.DARK_WOOD, base = P.DARK_WOOD, grain = 3, grainC = 0xa06c38 })
  box(5, 6, 4, 2, 3, P.CREAM, P.STONE_LT)                                   -- cup
  box(20, 5, 7, 3, 3, P.TAN, P.MID_WOOD)                                    -- crate
end

D.shelves = function()
  box(3, 3, 26, 3, 24, P.MID_WOOD, P.DARK_WOOD, { rim = P.LIGHT_WOOD })
  for _, y in ipairs({ 11, 18, 25 }) do hline(5, y, 22, P.TAN); hline(5, y + 1, 22, P.MID_WOOD) end
  rect(5, 7, 22, 4, P.SHADOW); rect(5, 13, 22, 5, P.SHADOW); rect(5, 20, 22, 5, P.SHADOW)
  -- Stock: jars, boxes, bottles.
  rect(6, 7, 3, 4, P.CREAM); rect(10, 8, 4, 3, P.GREEN_MD); rect(16, 7, 3, 4, P.BLUE_MID)
  rect(21, 8, 5, 3, P.TAN); rect(6, 14, 5, 4, P.LIGHT_WOOD); rect(13, 15, 3, 3, P.EMBER_MD)
  rect(18, 14, 3, 4, P.CREAM); rect(23, 14, 3, 4, P.GOLD); rect(7, 21, 4, 4, P.STONE_LT)
  rect(13, 21, 6, 4, P.MID_WOOD); rect(21, 22, 4, 3, P.GREEN_DK)
end

D.bar_counter = function()
  box(1, 12, 30, 7, 11, P.LIGHT_WOOD, P.DARK_WOOD,
      { rim = P.TAN, planks = 5, plankC = P.SHADOW, base = P.SHADOW })
  hline(1, 22, 30, P.GOLD)                                                  -- brass foot rail
  for i, x in ipairs({ 4, 9, 14 }) do                                       -- bottles
    local c = ({ P.BLUE_DARK, P.GREEN_DK, P.EMBER_DK })[i]
    rect(x, 5, 3, 8, c); rect(x + 1, 2, 1, 3, c); px(x, 6, P.CREAM)
  end
  box(20, 9, 4, 2, 4, P.CREAM, P.TAN)                                       -- mugs
  box(25, 9, 4, 2, 4, P.CREAM, P.TAN)
  px(21, 10, P.GOLD); px(26, 10, P.GOLD)
end

D.stage = function()
  box(1, 6, 30, 16, 6, P.MID_WOOD, P.DARK_WOOD,
      { rim = P.GOLD, grain = 4, grainC = P.DARK_WOOD, base = P.SHADOW })
  hline(1, 22, 30, P.GOLD)
  vline(13, 13, 5, P.DARK_WOOD); vline(18, 13, 5, P.DARK_WOOD)              -- stool legs
  disc(15.5, 12, 3.5, P.RED_DK); disc(15.5, 11.5, 3, P.RED_MD); px(14, 10, 0xa84040)
  vline(24, 7, 12, P.IRON_LT); disc(24.5, 7.5, 1.6, P.IRON_MD)              -- mic stand
  rect(5, 12, 3, 1, P.GOLD); vline(7, 9, 4, P.GOLD); px(5, 11, P.GOLD)      -- note on the boards
end

D.booth_seat = function()
  box(2, 3, 28, 5, 3, P.RED_MD, P.RED_DK, { rim = 0xa84040 })               -- back rest
  box(2, 11, 8, 10, 4, P.RED_MD, P.RED_DK, { rim = 0xa84040 })              -- left seat
  box(22, 11, 8, 10, 4, P.RED_MD, P.RED_DK, { rim = 0xa84040 })             -- right seat
  box(11, 12, 10, 9, 5, P.STONE_LT, P.STONE_MD, { rim = P.CREAM })          -- table
  disc(14, 15, 1.5, P.CREAM); disc(18, 17, 1.5, P.GOLD)                     -- glass, coaster
end

D.reception_desk = function()
  box(3, 10, 26, 8, 10, P.MID_WOOD, P.DARK_WOOD, { rim = P.LIGHT_WOOD, base = P.SHADOW })
  rect(11, 14, 10, 6, P.WHITE_LT)                                           -- red cross panel
  rect(15, 15, 2, 4, P.EMBER_MD); rect(14, 16, 4, 2, P.EMBER_MD)
  box(5, 8, 7, 4, 1, P.WHITE_LT, P.CREAM)                                   -- papers
  hline(6, 9, 5, P.STONE_LT); hline(6, 10, 4, P.STONE_LT)
  disc(24, 10, 2, P.GOLD); px(24, 8, P.TAN)                                 -- bell
end

D.patient_bed = function()
  box(6, 2, 20, 3, 2, P.IRON_LT, P.IRON_MD)                                 -- head rail
  box(6, 6, 20, 20, 4, P.IRON_MD, P.IRON_DK, { rim = P.IRON_LT })
  rect(8, 7, 16, 19, P.WHITE_LT)
  box(10, 8, 12, 4, 1, P.CREAM, P.STONE_LT)                                 -- pillow
  rect(8, 15, 16, 11, 0xc8d8d4)                                             -- pale sheet
  hline(8, 15, 16, P.WHITE_LT)
  vline(6, 9, 15, P.IRON_LT); vline(25, 9, 15, P.IRON_LT)                   -- side rails
  vline(29, 3, 22, P.IRON_LT); rect(28, 2, 3, 5, 0xa8c8d8)                  -- IV stand + bag
end

D.mayors_desk = function()
  box(2, 8, 28, 11, 10, P.DARK_WOOD, P.SHADOW, { rim = P.MID_WOOD, base = P.OUTLINE })
  hline(2, 19, 28, P.GOLD)                                                  -- gilt trim
  rect(14, 21, 4, 4, P.GOLD); px(15, 22, P.OUTLINE); px(16, 22, P.OUTLINE)  -- seal
  box(5, 10, 9, 5, 1, P.WHITE_LT, P.CREAM)                                  -- papers
  hline(6, 11, 7, P.STONE_LT); hline(6, 13, 5, P.STONE_LT)
  rect(17, 11, 3, 3, P.BLUE_DARK); vline(21, 8, 5, P.CREAM)                 -- inkwell, quill
  box(24, 7, 4, 2, 5, P.GREEN_MD, P.GREEN_DK)                               -- banker's lamp
  hline(24, 7, 4, 0x6a9848)
end

D.meeting_table = function()
  for _, c in ipairs({ { 7, 2 }, { 19, 2 } }) do box(c[1], c[2], 6, 3, 3, P.MID_WOOD, P.DARK_WOOD) end
  box(3, 7, 26, 14, 5, P.MID_WOOD, P.DARK_WOOD,
      { rim = P.LIGHT_WOOD, grain = 4, grainC = 0x6a4428, base = P.SHADOW })
  for _, c in ipairs({ { 7, 26 }, { 19, 26 } }) do box(c[1], c[2], 6, 3, 3, P.MID_WOOD, P.DARK_WOOD) end
  box(8, 11, 6, 4, 1, P.WHITE_LT, P.CREAM); box(18, 12, 5, 3, 1, P.WHITE_LT, P.CREAM)
  disc(16, 15, 1.5, P.BLUE_MID)
end

D.filing_cabinet = function()
  box(7, 3, 18, 4, 25, P.STONE_LT, P.STONE_MD, { rim = P.CREAM, base = P.STONE_DK })
  for _, y in ipairs({ 7, 15, 23 }) do
    hline(8, y + 7, 16, P.STONE_DK)                                         -- drawer gap
    rect(13, y + 3, 6, 2, P.IRON_LT); hline(13, y + 4, 6, P.IRON_DK)        -- handle
    rect(14, y + 1, 4, 1, P.CREAM)                                          -- label slot
  end
end

D.oven = function()
  box(2, 4, 28, 12, 13, P.STONE_LT, P.STONE_MD, { rim = P.CREAM, base = P.STONE_DK })
  for y = 17, 28, 3 do hline(2, y, 28, P.MORTAR) end                        -- brick courses
  for y = 17, 26, 6 do for x = 5, 28, 7 do vline(x, y + 1, 2, P.MORTAR) end end
  disc(16, 23, 6, P.OUTLINE); disc(16, 23, 5, P.EMBER_DK)                   -- mouth
  rect(10, 23, 13, 6, P.OUTLINE); rect(11, 23, 11, 6, P.EMBER_DK)
  disc(16, 25, 3, P.EMBER_MD); disc(16, 26, 1.8, P.EMBER_LT)
  box(22, 0, 5, 2, 4, P.STONE_MD, P.STONE_DK)                               -- flue
end

D.prep_table = function()
  box(2, 7, 28, 13, 7, P.TAN, P.MID_WOOD,
      { rim = P.LINEN, grain = 4, grainC = 0xc09860, base = P.DARK_WOOD })
  for _, c in ipairs({ { 7, 11 }, { 12, 15 }, { 20, 10 }, { 24, 16 } }) do px(c[1], c[2], P.WHITE_LT) end
  rect(8, 11, 14, 2, P.LIGHT_WOOD); rect(6, 11, 2, 2, P.MID_WOOD); rect(22, 11, 2, 2, P.MID_WOOD)
  disc(13, 16, 2.4, P.LINEN); disc(19, 16, 2.4, P.LINEN)                    -- dough
  px(12, 15, P.WHITE_LT); px(18, 15, P.WHITE_LT)
end

D.workbench = function()
  box(1, 8, 30, 11, 9, P.LIGHT_WOOD, P.MID_WOOD,
      { rim = P.TAN, planks = 7, plankC = P.DARK_WOOD, base = P.DARK_WOOD })
  box(3, 5, 6, 4, 5, P.IRON_MD, P.IRON_DK, { rim = P.IRON_LT })             -- vise
  rect(12, 11, 8, 2, P.IRON_LT); rect(19, 10, 3, 4, P.MID_WOOD)             -- hammer
  for x = 22, 28 do px(x, 15 + (x % 2), P.IRON_LT) end                      -- saw teeth
  rect(22, 14, 7, 1, P.STONE_LT); rect(28, 13, 2, 3, P.MID_WOOD)
  disc(12, 16, 1, P.GOLD); disc(15, 17, 1, P.GOLD)                          -- nails
end

D.tool_rack = function()
  box(2, 4, 28, 2, 20, P.MID_WOOD, P.DARK_WOOD, { rim = P.LIGHT_WOOD, base = P.SHADOW })
  hline(3, 8, 26, P.LIGHT_WOOD)                                             -- peg rail
  -- Hanging tools: shovel, axe, rake, saw, hammer.
  vline(5, 8, 13, P.TAN); rect(4, 20, 3, 4, P.IRON_LT)
  vline(10, 8, 12, P.TAN); rect(10, 9, 3, 4, P.IRON_LT)
  vline(15, 8, 12, P.TAN); hline(13, 20, 5, P.IRON_LT); px(13, 21, P.IRON_LT); px(15, 21, P.IRON_LT); px(17, 21, P.IRON_LT)
  rect(19, 9, 5, 9, P.IRON_LT); rect(19, 8, 5, 1, P.MID_WOOD)
  vline(26, 8, 10, P.MID_WOOD); rect(25, 9, 3, 2, P.IRON_MD)
end

D.forge = function()
  box(1, 6, 20, 12, 10, P.STONE_MD, P.STONE_DK, { rim = P.STONE_LT, base = P.OUTLINE })
  for y = 19, 25, 3 do hline(1, y, 20, P.MORTAR) end
  rect(4, 8, 14, 8, P.OUTLINE)                                              -- coal bed
  for y = 9, 14 do for x = 5, 16 do
    local t = ((x * 7 + y * 13) % 5)
    px(x, y, t < 2 and P.EMBER_MD or t < 4 and P.EMBER_LT or P.FORGE_GLW)
  end end
  disc(11, 11.5, 2, P.FORGE_GLW)
  -- Anvil beside the hearth.
  box(22, 17, 9, 3, 2, P.IRON_LT, P.IRON_MD); px(21, 17, P.IRON_LT)
  box(24, 22, 5, 1, 4, P.IRON_MD, P.IRON_DK)
  box(22, 26, 9, 1, 2, P.IRON_MD, P.IRON_DK)
end

D.guard_desk = function()
  box(2, 10, 28, 9, 10, P.STONE_MD, P.STONE_DK, { rim = P.STONE_LT, base = P.OUTLINE })
  hline(2, 22, 28, P.IRON_MD)
  box(5, 12, 8, 5, 1, P.CREAM, P.TAN); vline(9, 12, 5, P.MID_WOOD)          -- log book
  disc(19, 14, 2.2, P.GOLD); disc(19, 14, 1, P.STONE_MD); rect(21, 14, 3, 1, P.GOLD) -- key ring
  box(24, 6, 4, 2, 6, P.IRON_MD, P.IRON_DK); disc(26, 5, 2, P.FORGE_GLW)    -- lamp
end

-- ── Build ──────────────────────────────────────────────────────────────────────────────────

-- ══ Zone props (feedback pass, workstream D) ═══════════════════════════════════════════════
-- Every zone that used to be a text label or a tinted rect gets a piece below. Pieces that
-- agents stand ON (rug, mats, flower beds) are flat; the rest keep their mass to the back of
-- the tile so the resident drawn above them is not swallowed.

-- Tones the master palette lacked: straw, glass and a few fabrics.
P.HAY_LT, P.HAY_MD, P.HAY_DK = 0xdcc060, 0xc09020, 0x8a6a1c
P.GLASS, P.GLASS_DK = 0xa8c8d8, 0x6a8a98
P.SOFA, P.SOFA_DK, P.SOFA_LT = 0x4a6a58, 0x2e4a3c, 0x62866e
P.BURLAP, P.BURLAP_DK = 0xc8a878, 0x9a7c50

-- ── Homes ────────────────────────────────────────────────────────────────────────────────

D.sofa = function()
  box(2, 5, 28, 6, 3, P.SOFA, P.SOFA_DK, { rim = P.SOFA_LT })                -- tall back rest
  vline(10, 6, 5, P.SOFA_DK); vline(21, 6, 5, P.SOFA_DK)                     -- back cushion seams
  box(2, 10, 6, 15, 4, P.SOFA_LT, P.SOFA_DK, { rim = 0x7aa088 })             -- left arm
  box(24, 10, 6, 15, 4, P.SOFA_LT, P.SOFA_DK, { rim = 0x7aa088 })            -- right arm
  rect(8, 13, 16, 9, 0x6e9478)                                               -- seat cushions
  hline(8, 13, 16, P.SOFA_LT); vline(16, 13, 9, P.SOFA)
  rect(8, 22, 16, 3, P.SOFA_DK); hline(8, 22, 16, P.SOFA)                    -- seat front
  px(4, 26, P.DARK_WOOD); px(27, 26, P.DARK_WOOD)                            -- feet
  rect(10, 9, 5, 4, P.GOLD); hline(10, 9, 5, P.TAN)                          -- throw cushion
end

D.armchair = function()
  box(6, 5, 20, 6, 3, P.RED_MD, P.RED_DK, { rim = 0xa84040 })
  box(6, 10, 5, 14, 4, P.RED_MD, P.RED_DK, { rim = 0xa84040 })
  box(21, 10, 5, 14, 4, P.RED_MD, P.RED_DK, { rim = 0xa84040 })
  rect(11, 12, 10, 10, 0xa04040)
  hline(11, 12, 10, P.RED_DK)
  rect(11, 21, 10, 3, P.RED_DK)
  px(7, 27, P.DARK_WOOD); px(24, 27, P.DARK_WOOD)
end

D.rug = function()
  rect(3, 5, 26, 22, P.RED_DK)                                               -- border
  rect(5, 7, 22, 18, P.TAN)
  rect(7, 9, 18, 14, P.RED_MD)
  -- diamond motif
  for i = 0, 5 do
    hline(16 - i, 16 - 5 + i, 1 + i * 2, P.LINEN)
    hline(16 - i, 16 + 5 - i, 1 + i * 2, P.LINEN)
  end
  rect(14, 14, 4, 4, P.BLUE_MID)
  for x = 4, 27, 2 do px(x, 5, P.LINEN); px(x, 26, P.LINEN) end               -- fringe
end

-- ── Shop / pawnshop ──────────────────────────────────────────────────────────────────────

local function crate(x, y, w, h)
  rect(x, y, w, h, P.MID_WOOD)
  hline(x, y, w, P.TAN)                                                      -- lit top edge
  hline(x, y + h - 1, w, P.DARK_WOOD)
  rect(x, y + 3, w, 1, P.DARK_WOOD)                                          -- slat
  vline(x, y, h, P.LIGHT_WOOD); vline(x + w - 1, y, h, P.DARK_WOOD)
  for i = 0, math.min(w, h) - 5 do px(x + 2 + i, y + 4 + i, P.DARK_WOOD) end  -- brace
end

D.crates = function()
  crate(3, 14, 13, 12); crate(17, 16, 12, 10)
  crate(8, 5, 12, 10)
  rect(10, 3, 3, 2, P.GREEN_MD); px(11, 2, P.GREEN_MD)                       -- greens peeking out
  rect(22, 14, 3, 2, P.EMBER_MD)
end

D.display_table = function()
  box(2, 12, 28, 6, 9, P.LIGHT_WOOD, P.MID_WOOD,
      { rim = P.TAN, base = P.DARK_WOOD, planks = 7, plankC = P.DARK_WOOD })
  rect(3, 13, 26, 5, P.CREAM)                                                -- cloth runner
  hline(3, 13, 26, P.WHITE_LT)
  -- Goods on show: apples, a cheese wheel, a jar, a folded cloth.
  disc(7, 11, 2.4, P.EMBER_MD); px(6, 10, 0xe06040); px(7, 8, P.GREEN_DK)
  disc(12, 12, 2.4, P.EMBER_MD); px(11, 11, 0xe06040)
  disc(19, 11, 3, P.GOLD); rect(17, 11, 5, 2, 0xa07818)
  rect(24, 7, 4, 6, P.BLUE_MID); rect(24, 6, 4, 1, P.CREAM)
  rect(2, 21, 28, 1, P.SHADOW)
end

D.pawn_case = function()
  box(3, 8, 26, 9, 12, P.GLASS, P.MID_WOOD, { rim = P.WHITE_LT, base = P.DARK_WOOD })
  vline(3, 8, 9, P.IRON_LT); vline(28, 8, 9, P.IRON_LT)
  hline(4, 16, 24, P.GLASS_DK)                                               -- glass lip
  -- Treasures under the glass: watch, ring, pendant, small violin, keys.
  disc(8, 12, 2, P.GOLD); px(8, 12, P.CREAM); px(8, 9, P.GOLD)
  disc(14, 13, 1.4, P.GOLD); px(14, 11, P.EMBER_MD)
  disc(19, 11, 1.6, P.TAN); vline(19, 9, 2, P.GOLD)
  rect(21, 12, 6, 2, P.MID_WOOD); rect(22, 11, 4, 1, P.LIGHT_WOOD)           -- violin body
  rect(5, 14, 6, 1, P.IRON_LT); px(10, 13, P.IRON_LT)                        -- keys
  rect(12, 21, 8, 3, P.GOLD); px(13, 22, P.OUTLINE); hline(12, 21, 8, 0xe0b040)  -- brass plate
  for x = 6, 26, 5 do vline(x, 18, 8, P.DARK_WOOD) end                        -- panelled front
end

-- ── Tavern / divebar ─────────────────────────────────────────────────────────────────────

D.table_chairs = function()
  box(12, 3, 8, 3, 3, P.MID_WOOD, P.DARK_WOOD, { rim = P.LIGHT_WOOD })       -- chair, back
  box(6, 9, 20, 11, 5, P.LIGHT_WOOD, P.MID_WOOD, { rim = P.TAN, grain = 4, grainC = 0xa06c38, base = P.DARK_WOOD })
  box(0, 11, 4, 7, 3, P.MID_WOOD, P.DARK_WOOD)                               -- chair, left
  vline(0, 9, 3, P.DARK_WOOD)
  box(28, 11, 4, 7, 3, P.MID_WOOD, P.DARK_WOOD)                              -- chair, right
  vline(31, 9, 3, P.DARK_WOOD)
  box(11, 25, 10, 3, 2, P.MID_WOOD, P.DARK_WOOD)                             -- chair, front
  box(9, 10, 4, 3, 2, P.CREAM, P.TAN); px(10, 11, P.GOLD)                    -- mug
  box(18, 12, 4, 3, 2, P.CREAM, P.TAN)
  disc(15.5, 14.5, 1.8, P.LINEN)                                             -- bread
end

D.table_stools = function()
  disc(16, 19, 9, P.DARK_WOOD)                                               -- table body
  disc(16, 16, 9, P.MID_WOOD); disc(16, 15.5, 8, P.LIGHT_WOOD)
  for a = 0, 3 do hline(10, 12 + a * 2, 12, 0xa06c38) end
  for _, c in ipairs({ { 4, 20 }, { 28, 20 }, { 16, 4 }, { 16, 28 } }) do    -- stools
    disc(c[1], c[2] + 1, 3, P.SHADOW); disc(c[1], c[2], 3, P.MID_WOOD); px(c[1] - 1, c[2] - 1, P.TAN)
  end
  rect(12, 12, 2, 5, P.GREEN_DK); px(12, 11, P.GREEN_DK); px(13, 10, P.CREAM)  -- bottle
  rect(17, 13, 4, 3, P.CREAM); px(18, 14, P.EMBER_MD); px(19, 13, P.OUTLINE)   -- cards
end

-- ── Clinic ───────────────────────────────────────────────────────────────────────────────

D.exam_table = function()
  box(5, 5, 22, 5, 2, P.WHITE_LT, P.CREAM, { rim = P.WHITE_LT })             -- raised head end
  box(5, 9, 22, 13, 7, P.BLUE_MID, P.IRON_MD, { rim = 0x3a5a88, base = P.IRON_DK })
  rect(7, 11, 18, 9, P.WHITE_LT)                                             -- paper sheet
  hline(7, 11, 18, P.CREAM)
  for x = 8, 23, 3 do px(x, 16, P.CREAM) end                                 -- tear-off perforation
  vline(7, 29, 1, P.IRON_DK)
  rect(7, 29, 4, 1, P.IRON_MD); rect(21, 29, 4, 1, P.IRON_MD)                -- feet
  box(28, 11, 3, 12, 3, P.STONE_LT, P.STONE_MD)                              -- instrument tray
  px(29, 13, P.IRON_LT); px(29, 16, P.EMBER_MD); px(29, 19, P.IRON_LT)
end

D.medicine_cabinet = function()
  box(6, 3, 20, 4, 25, P.WHITE_LT, P.CREAM, { rim = P.WHITE_LT, base = P.STONE_LT })
  rect(8, 8, 16, 18, P.GLASS_DK)                                             -- glass door
  for _, y in ipairs({ 13, 19, 25 }) do hline(8, y, 16, P.WHITE_LT) end      -- shelves
  -- bottles and boxes
  rect(9, 9, 2, 4, P.GREEN_MD); rect(12, 10, 3, 3, P.EMBER_MD); rect(16, 9, 2, 4, P.BLUE_MID); rect(19, 10, 4, 3, P.CREAM)
  rect(9, 15, 3, 4, P.GOLD); rect(13, 16, 2, 3, P.GREEN_MD); rect(16, 15, 3, 4, P.CREAM); rect(20, 16, 3, 3, P.EMBER_MD)
  rect(9, 21, 4, 4, P.CREAM); rect(14, 21, 3, 4, P.BLUE_MID); rect(18, 22, 5, 3, P.GREEN_DK)
  rect(14, 4, 4, 2, P.EMBER_MD); rect(15, 3, 2, 4, P.EMBER_MD)               -- red cross on the lintel
  vline(24, 12, 4, P.IRON_LT)
end

-- ── Town hall / parks ────────────────────────────────────────────────────────────────────

D.bench = function()
  box(2, 8, 28, 3, 4, P.MID_WOOD, P.DARK_WOOD, { rim = P.LIGHT_WOOD })       -- back rest
  for x = 6, 26, 6 do vline(x, 11, 3, P.SHADOW) end                          -- slat gaps
  box(2, 15, 28, 5, 3, P.LIGHT_WOOD, P.MID_WOOD, { rim = P.TAN, base = P.DARK_WOOD })
  hline(3, 17, 26, 0xa06c38)
  rect(4, 23, 2, 4, P.DARK_WOOD); rect(26, 23, 2, 4, P.DARK_WOOD)            -- legs
end

-- ── Bakery / workshop ────────────────────────────────────────────────────────────────────

local function loaf(cx, cy, r) disc(cx, cy, r, 0xa06428); disc(cx - 0.5, cy - 0.5, r - 1, 0xc08840); px(cx - 1, cy - 1, 0xe0b060) end

D.bread_display = function()
  box(2, 5, 28, 3, 22, P.MID_WOOD, P.DARK_WOOD, { rim = P.LIGHT_WOOD })      -- cabinet frame
  rect(4, 8, 24, 11, P.SHADOW)                                                -- inside, top shelf
  rect(4, 19, 24, 7, P.SHADOW)                                                -- inside, lower
  hline(4, 19, 24, P.TAN)
  loaf(8, 15, 3); loaf(15, 15, 3); loaf(22, 15, 3)
  for i = 0, 2 do hline(6 + i * 7, 11, 3, 0xd8a860) end                        -- baguettes leaning
  rect(6, 22, 4, 3, 0xd8a860); rect(12, 21, 5, 4, 0xa06428); rect(19, 22, 6, 3, 0xd8a860)
  hline(4, 8, 24, P.GLASS_DK)                                                  -- glass glint
  rect(2, 26, 28, 2, P.DARK_WOOD)
  rect(13, 2, 6, 3, P.CREAM); px(15, 3, P.MID_WOOD)                            -- price sign
end

D.flour_sacks = function()
  local function sack(x, y, w, h)
    rect(x, y + 3, w, h - 3, P.BURLAP)
    rect(x + 1, y + 1, w - 2, 3, P.BURLAP)
    hline(x + 2, y, w - 4, P.BURLAP_DK)                                        -- tied neck
    px(x + w // 2, y, P.RED_MD)
    vline(x, y + 4, h - 5, P.BURLAP_DK); vline(x + w - 1, y + 4, h - 5, P.BURLAP_DK)
    hline(x, y + h - 1, w, P.BURLAP_DK)
    rect(x + 1, y + 8, w - 2, 2, P.BLUE_MID)                                    -- miller's band
  end
  sack(2, 14, 12, 13); sack(15, 15, 12, 12); sack(8, 3, 12, 13)
  px(4, 27, P.WHITE_LT); px(6, 28, P.WHITE_LT); px(14, 28, P.WHITE_LT)         -- spilled flour
end

D.plank_pile = function()
  local tones = { P.LIGHT_WOOD, P.TAN, P.MID_WOOD, 0xc08850 }
  for i = 0, 5 do                                                              -- stack, front ends
    local y = 24 - i * 3
    local c = tones[(i % 4) + 1]
    rect(3 + (i % 2), y, 26 - (i % 2) * 2, 3, c)
    hline(3 + (i % 2), y + 2, 26 - (i % 2) * 2, P.DARK_WOOD)
    hline(3 + (i % 2), y, 26 - (i % 2) * 2, 0xd8b078)
    for x = 6 + i, 27, 7 do px(x, y + 1, 0xa06c38) end                           -- grain flecks
  end
  rect(4, 5, 5, 3, P.TAN); disc(6.5, 6.5, 1, P.MID_WOOD)                       -- log end on top
  rect(3, 25, 2, 3, P.DARK_WOOD); rect(26, 25, 2, 3, P.DARK_WOOD)              -- bearers
end

-- ── Prison ───────────────────────────────────────────────────────────────────────────────

D.prison_cell = function()
  box(4, 3, 24, 3, 2, P.IRON_MD, P.IRON_DK)                                    -- cot head
  box(4, 6, 24, 12, 3, P.IRON_MD, P.IRON_DK, { rim = P.IRON_LT })
  rect(6, 7, 20, 10, 0x6a6858)                                                 -- thin mattress
  rect(7, 8, 7, 3, P.CREAM)                                                    -- pillow
  rect(6, 12, 20, 5, 0x54627a); hline(6, 12, 20, 0x7a8aa0)                   -- grey-blue blanket
  -- Bars across the front of the cell.
  rect(0, 20, 32, 2, P.IRON_LT); hline(0, 20, 32, P.STONE_LT)
  rect(0, 29, 32, 2, P.IRON_MD)
  for x = 1, 30, 5 do rect(x, 22, 2, 7, P.IRON_LT); vline(x + 1, 22, 7, P.IRON_DK) end
  rect(14, 22, 3, 3, P.GOLD); px(15, 23, P.OUTLINE)                            -- padlock
end

D.hall_mat = function()
  rect(1, 9, 30, 14, 0x484442)
  rect(2, 10, 28, 12, 0x5a5850)
  for x = 3, 28, 3 do vline(x, 11, 10, 0x6a6858) end                            -- rush weave
  hline(2, 15, 28, 0x484442); hline(2, 17, 28, 0x484442)
  rect(13, 12, 6, 3, P.IRON_MD); px(14, 13, P.IRON_DK); px(17, 13, P.IRON_DK)  -- drain grate
end

-- ── Market stalls (outdoor) ──────────────────────────────────────────────────────────────

local function stall(awning, goods)
  -- Counter first so the awning overlaps it.
  box(2, 15, 28, 4, 8, P.LIGHT_WOOD, P.MID_WOOD, { rim = P.TAN, base = P.DARK_WOOD })
  vline(2, 8, 18, P.DARK_WOOD); vline(29, 8, 18, P.DARK_WOOD)                 -- posts
  goods()
  for s = 0, 3 do rect(1 + s * 7, 2, 7, 8, (s % 2 == 0) and awning or P.CREAM) end
  hline(1, 2, 28, P.WHITE_LT)
  for s = 0, 3 do                                                              -- scalloped hem
    local c = (s % 2 == 0) and awning or P.CREAM
    rect(1 + s * 7 + 1, 10, 5, 1, c); rect(1 + s * 7 + 2, 11, 3, 1, c)
  end
  hline(1, 9, 28, P.SHADOW)
end

D.stall_produce = function()
  stall(P.RED_MD, function()
    disc(7, 14, 2.4, P.EMBER_MD); disc(12, 14, 2.4, P.GREEN_MD); disc(17, 14, 2.4, P.EMBER_LT)
    disc(23, 14, 2.6, P.GOLD); px(23, 12, P.GREEN_DK); px(6, 13, 0xe06040)
  end)
end

D.stall_cloth = function()
  stall(P.BLUE_MID, function()
    rect(5, 12, 5, 4, P.RED_MD); rect(11, 11, 5, 5, P.CREAM); rect(17, 12, 5, 4, P.GREEN_MD); rect(23, 11, 4, 5, P.GOLD)
    hline(5, 12, 5, 0xa84040); hline(11, 11, 5, P.WHITE_LT)
  end)
end

D.stall_bread = function()
  stall(P.GOLD, function()
    loaf(8, 14, 2.6); loaf(14, 14, 2.6); loaf(20, 14, 2.6)
    rect(23, 12, 5, 2, 0xd8a860); rect(23, 14, 5, 2, 0xa06428)
  end)
end

D.stall_fish = function()
  stall(P.GREEN_MD, function()
    rect(4, 13, 24, 4, 0x8ab0c0)                                              -- ice
    for i = 0, 2 do
      local x = 6 + i * 8
      rect(x, 12, 6, 3, P.BLUE_MID); rect(x + 6, 12, 2, 1, P.BLUE_MID); px(x + 1, 12, P.CREAM); px(x + 1, 13, P.OUTLINE)
    end
  end)
end

-- ── Town square ──────────────────────────────────────────────────────────────────────────

D.podium = function()
  box(1, 6, 62, 20, 5, P.MID_WOOD, P.DARK_WOOD, { rim = P.GOLD, grain = 4, grainC = P.DARK_WOOD, base = P.SHADOW })
  hline(1, 26, 62, P.GOLD)
  box(6, 27, 10, 2, 1, P.MID_WOOD, P.DARK_WOOD)                                -- steps
  -- Lectern with a gilt edge, beside the spot the speaker stands on.
  box(50, 8, 11, 3, 10, P.LIGHT_WOOD, P.MID_WOOD, { rim = P.TAN, base = P.DARK_WOOD })
  rect(53, 4, 5, 4, P.WHITE_LT); hline(53, 4, 5, P.CREAM)                       -- speech notes
  rect(52, 15, 7, 2, P.GOLD)
  -- Banner behind the boards.
  vline(6, 1, 12, P.IRON_LT); rect(7, 1, 9, 6, P.RED_MD); rect(7, 6, 9, 1, P.RED_DK); rect(10, 3, 3, 2, P.GOLD)
end

D.lamp_post = function()
  rect(13, 26, 6, 3, P.STONE_MD); hline(13, 26, 6, P.STONE_LT)                  -- base
  rect(15, 9, 2, 17, P.IRON_MD); vline(15, 9, 17, P.IRON_LT)
  rect(11, 3, 10, 7, P.IRON_DK)                                                 -- lantern cage
  rect(12, 4, 8, 5, P.FORGE_GLW); rect(14, 5, 4, 3, 0xffe098)
  hline(10, 2, 12, P.IRON_MD); hline(13, 1, 6, P.IRON_MD)
end

D.planter = function()
  box(4, 16, 24, 5, 8, P.STONE_LT, P.STONE_MD, { rim = P.CREAM, base = P.STONE_DK })
  disc(10, 12, 5, P.GREEN_DK); disc(16, 10, 6, P.GREEN_MD); disc(23, 12, 5, P.GREEN_DK)
  disc(15, 8, 3, 0x6a9848)
  px(9, 11, 0xe07890); px(14, 8, 0xe8d5a3); px(20, 9, 0xe07890); px(24, 12, 0xe8d5a3); px(17, 12, 0xd8a030)
end

-- ── Park / garden ────────────────────────────────────────────────────────────────────────

local function flower_bed(a, b)
  rect(2, 6, 28, 22, P.DARK_WOOD)                                               -- timber edging
  rect(3, 7, 26, 20, 0x4a3822)                                                  -- dark soil
  hline(3, 7, 26, P.MID_WOOD)
  local n = 0
  for y = 10, 25, 4 do
    for x = 6, 27, 5 do
      n = n + 1
      local ox, oy = (n * 3) % 3 - 1, (n * 5) % 2
      local cx, cy = x + ox, y + oy
      px(cx, cy + 1, P.GREEN_MD); px(cx, cy + 2, P.GREEN_DK)
      px(cx - 1, cy, (n % 2 == 0) and a or b); px(cx + 1, cy, (n % 2 == 0) and a or b)
      px(cx, cy - 1, (n % 2 == 0) and a or b); px(cx, cy, P.CREAM)
    end
  end
end
D.flower_bed_pink = function() flower_bed(0xe07890, 0xf0b0c0) end
D.flower_bed_yellow = function() flower_bed(0xe8c038, 0xf0e090) end

D.reeds = function()
  local function reed(x, top, head)
    vline(x, top, 27 - top, P.GREEN_MD); vline(x + 1, top + 2, 25 - top, P.GREEN_DK)
    if head then rect(x, top - 1, 2, 4, P.MID_WOOD); px(x, top - 2, P.DARK_WOOD) end
  end
  reed(6, 12, true); reed(10, 8, true); reed(14, 15, false); reed(18, 10, true); reed(22, 14, false); reed(26, 9, true)
  hline(4, 27, 24, 0x5a8898); hline(6, 28, 20, 0x3a6070)                        -- waterline
  for i = 0, 3 do px(3 + i * 8, 20 - (i % 2) * 3, P.GREEN_MD) end
end

D.shore_rocks = function()
  disc(11, 20, 6, P.STONE_MD); disc(11, 19, 5.5, P.STONE_LT); disc(9, 17, 2.5, 0xa8a698); disc(13, 23, 3, P.MORTAR)
  disc(22, 22, 4.5, P.STONE_MD); disc(22, 21, 4, P.STONE_LT); px(20, 19, 0xa8a698); px(21, 19, 0xa8a698)
  disc(18, 12, 3, P.STONE_LT); px(17, 11, 0xa8a698)
  hline(3, 27, 26, 0x6aa0b0); hline(8, 29, 16, 0x5a8898)                        -- ripples
end

D.fallen_log = function()
  rect(5, 14, 22, 9, P.DARK_WOOD)
  rect(5, 14, 22, 3, P.MID_WOOD); hline(5, 14, 22, P.LIGHT_WOOD)                 -- lit bark
  for x = 8, 24, 5 do vline(x, 16, 6, P.SHADOW) end                              -- bark ridges
  disc(5, 18.5, 4.5, P.TAN); disc(5, 18.5, 3, P.LIGHT_WOOD); disc(5, 18.5, 1.4, P.TAN)  -- cut end
  rect(20, 11, 3, 3, P.GREEN_MD); rect(24, 12, 2, 2, P.GREEN_DK); px(22, 10, P.GREEN_MD)  -- moss + fern
  rect(12, 23, 5, 2, P.GREEN_DK); rect(14, 22, 2, 2, P.GREEN_MD)
end

D.mushrooms = function()
  local function cap(cx, cy, r)
    rect(cx - 1, cy, 2, 5, P.CREAM)
    disc(cx, cy, r, P.RED_MD); disc(cx - 0.5, cy - 0.5, r - 1, 0xa84040)
    px(cx - 1, cy - 1, P.WHITE_LT); px(cx + 1, cy, P.WHITE_LT)
  end
  cap(9, 20, 4); cap(19, 16, 5); cap(24, 24, 3)
  rect(5, 24, 3, 2, P.GREEN_MD); rect(13, 24, 4, 2, P.GREEN_DK)
end

-- ── Farm ─────────────────────────────────────────────────────────────────────────────────

D.chicken_coop = function()
  -- Hut, left half: pitched roof over a plank front with a pop-hole and ramp.
  box(2, 3, 26, 10, 3, P.MID_WOOD, P.DARK_WOOD, { rim = P.LIGHT_WOOD, grain = 3, grainC = P.DARK_WOOD })
  hline(2, 7, 26, P.DARK_WOOD)
  box(3, 13, 24, 11, 3, 0xa87850, P.MID_WOOD, { planks = 4, plankC = P.DARK_WOOD, base = P.DARK_WOOD })
  rect(11, 15, 7, 8, P.OUTLINE); rect(12, 16, 5, 7, P.SHADOW)                   -- pop-hole
  rect(9, 24, 11, 4, P.LIGHT_WOOD); for x = 10, 19, 3 do vline(x, 24, 4, P.DARK_WOOD) end  -- ramp
  -- Run, right half: fence, hens, feed.
  for x = 33, 61, 7 do rect(x, 12, 2, 16, P.MID_WOOD) end
  hline(33, 15, 29, P.LIGHT_WOOD); hline(33, 22, 29, P.LIGHT_WOOD)
  local function hen(x, y, c)
    disc(x, y, 3, c); px(x + 3, y - 2, c); px(x + 4, y - 2, c); px(x + 5, y - 2, P.GOLD)
    px(x + 3, y - 4, P.EMBER_MD); px(x + 4, y - 3, P.EMBER_MD); px(x - 3, y - 1, c); px(x, y + 3, P.GOLD)
  end
  hen(43, 20, P.CREAM); hen(53, 24, 0xb07840)
  px(38, 26, P.HAY_MD); px(48, 27, P.HAY_MD); px(57, 20, P.HAY_MD)
end

D.barn = function()
  -- Open-fronted barn: the roof only shades the back; the floor is left clear for the hands.
  box(0, 1, 64, 12, 4, P.DARK_WOOD, P.SHADOW, { rim = P.MID_WOOD, grain = 3, grainC = P.SHADOW })
  for x = 3, 61, 8 do vline(x, 3, 10, P.SHADOW) end
  rect(0, 17, 64, 20, 0x8a2a2a); hline(0, 17, 64, 0xa84040)                     -- back wall
  for x = 4, 62, 5 do vline(x, 18, 19, P.RED_DK) end                            -- boards
  rect(22, 19, 20, 17, P.RED_DK); rect(23, 20, 18, 15, P.SHADOW)                -- hayloft door
  for i = 0, 14 do px(23 + i, 20 + i, P.CREAM); px(40 - i, 20 + i, P.CREAM) end
  hline(22, 19, 20, P.CREAM); hline(22, 35, 20, P.CREAM); vline(22, 19, 17, P.CREAM); vline(41, 19, 17, P.CREAM)
  rect(0, 37, 64, 2, P.DARK_WOOD)                                               -- sill
  rect(2, 39, 60, 23, 0x5a4630)                                                 -- trodden floor
  for x = 5, 58, 6 do px(x, 44 + (x % 5), 0x6b5a3a); px(x + 2, 52 - (x % 4), 0x4a3822) end
  -- Timber frame posts and a low rail on each side.
  rect(0, 17, 3, 45, P.DARK_WOOD); rect(61, 17, 3, 45, P.DARK_WOOD)
  hline(0, 51, 3, P.MID_WOOD); hline(61, 51, 3, P.MID_WOOD)
  -- Hay heap + pitchfork.
  disc(11, 53, 7, P.HAY_DK); disc(11, 51.5, 6, P.HAY_MD); disc(9, 49, 3.5, P.HAY_LT)
  disc(52, 56, 5, P.HAY_DK); disc(52, 55, 4, P.HAY_MD)
  vline(46, 40, 16, P.TAN); hline(44, 40, 5, P.IRON_LT); px(44, 41, P.IRON_LT); px(48, 41, P.IRON_LT)
  rect(56, 42, 4, 5, P.MID_WOOD); hline(56, 42, 4, P.TAN)                       -- bucket
end

D.hay_bale = function()
  box(4, 9, 24, 7, 11, P.HAY_LT, P.HAY_MD, { rim = 0xecd880, base = P.HAY_DK })
  vline(11, 9, 18, P.MID_WOOD); vline(20, 9, 18, P.MID_WOOD)                    -- twine
  for x = 6, 26, 3 do px(x, 11 + (x % 4), P.HAY_MD); px(x + 1, 21 + (x % 3), P.HAY_DK) end
  px(3, 8, P.HAY_LT); px(29, 10, P.HAY_LT); px(28, 8, P.HAY_MD)                  -- loose straw
end

D.stump = function()
  box(7, 12, 18, 8, 8, P.MID_WOOD, P.DARK_WOOD, { base = P.SHADOW })
  disc(16, 15, 9, P.DARK_WOOD); disc(16, 14, 8, P.LIGHT_WOOD)
  disc(16, 14, 6, P.TAN); disc(16, 14, 4, P.LIGHT_WOOD); disc(16, 14, 2, P.TAN)  -- growth rings
  rect(6, 21, 4, 3, P.DARK_WOOD); rect(22, 21, 4, 3, P.DARK_WOOD)                 -- roots
  vline(26, 6, 10, P.MID_WOOD); rect(24, 5, 5, 3, P.IRON_LT)                     -- axe stuck in it
end

D.trough = function()
  box(3, 9, 26, 12, 6, P.MID_WOOD, P.DARK_WOOD, { rim = P.LIGHT_WOOD, base = P.SHADOW })
  rect(5, 11, 22, 8, 0x4a6a72); hline(5, 11, 22, 0x2a4a56)                      -- water
  hline(8, 14, 6, 0x8ab8c8); hline(18, 16, 5, 0x8ab8c8)
  rect(5, 22, 2, 4, P.DARK_WOOD); rect(25, 22, 2, 4, P.DARK_WOOD)                -- legs
end

local dir = app.params.dir or "public/sprites/furniture"
-- only=a,b,c rebuilds just those pieces (comma separated).
local wanted
if app.params.only then
  wanted = {}
  for k in string.gmatch(app.params.only, "[^,]+") do wanted[k] = true end
end
local keys = {}
for k in pairs(D) do if not wanted or wanted[k] then table.insert(keys, k) end end
table.sort(keys)

for _, key in ipairs(keys) do
  W, H = table.unpack(SIZES[key] or { S, S })
  img = Image(W, H, ColorMode.RGB); img:clear(0)
  D[key]()
  local body = img
  local shadow, outline = finish(body, FLAT[key])

  local spr = Sprite(W, H, ColorMode.RGB)
  spr.filename = key
  local lShadow = spr.layers[1]; lShadow.name = "shadow"
  local lOutline = spr:newLayer(); lOutline.name = "outline"
  local lBody = spr:newLayer(); lBody.name = "body"
  spr:newCel(lShadow, spr.frames[1], shadow, Point(0, 0))
  spr:newCel(lOutline, spr.frames[1], outline, Point(0, 0))
  spr:newCel(lBody, spr.frames[1], body, Point(0, 0))
  spr:saveAs(app.fs.joinPath(dir, key .. ".aseprite"))
  spr:close()

  local flat = Image(W, H, ColorMode.RGB); flat:clear(0)
  flat:drawImage(shadow, Point(0, 0)); flat:drawImage(outline, Point(0, 0)); flat:drawImage(body, Point(0, 0))
  flat:saveAs(app.fs.joinPath(dir, key .. ".png"))
end
print(#keys .. " furniture sprites")
