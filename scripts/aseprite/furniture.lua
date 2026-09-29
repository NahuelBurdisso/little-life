-- furniture.lua — the 18 interior furniture sprites, drawn in a 3/4 top-down view.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/furniture --script scripts/aseprite/furniture.lua
--   (add --script-param only=bed to rebuild one piece)
--
-- Supersedes scripts/gen-furniture.mjs (flat front-on rectangles). Same file names, same 32x32
-- cell, same 24-swatch master palette (docs/scratch/proposal-visual.md §1), but every piece now
-- has a lit top face, a shaded front face, a generated 1px outline and a soft drop shadow, so it
-- reads as an object standing on the floor rather than a sticker on it.
--
-- Writes <key>.aseprite (layers: shadow, outline, body — retouch body and re-run nothing) and
-- <key>.png for each piece.

local S = 32
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

local function px(x, y, c) if x >= 0 and y >= 0 and x < S and y < S then img:drawPixel(x, y, hex(c)) end end
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
  if x < 0 or y < 0 or x >= S or y >= S then return false end
  return pc.rgbaA(i:getPixel(x, y)) == 255
end

local function finish(body)
  local outline = Image(S, S, ColorMode.RGB); outline:clear(0)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      if not opaque(body, x, y) and (opaque(body, x - 1, y) or opaque(body, x + 1, y)
          or opaque(body, x, y - 1) or opaque(body, x, y + 1)) then
        outline:drawPixel(x, y, hex(P.OUTLINE))
      end
    end
  end
  -- Shadow: the silhouette (body + outline) pushed 2px right and 2px down.
  local shadow = Image(S, S, ColorMode.RGB); shadow:clear(0)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      if (opaque(body, x - 2, y - 2) or opaque(outline, x - 2, y - 2))
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

local dir = app.params.dir or "public/sprites/furniture"
local only = app.params.only
local keys = {}
for k in pairs(D) do if not only or only == k then table.insert(keys, k) end end
table.sort(keys)

for _, key in ipairs(keys) do
  img = Image(S, S, ColorMode.RGB); img:clear(0)
  D[key]()
  local body = img
  local shadow, outline = finish(body)

  local spr = Sprite(S, S, ColorMode.RGB)
  spr.filename = key
  local lShadow = spr.layers[1]; lShadow.name = "shadow"
  local lOutline = spr:newLayer(); lOutline.name = "outline"
  local lBody = spr:newLayer(); lBody.name = "body"
  spr:newCel(lShadow, spr.frames[1], shadow, Point(0, 0))
  spr:newCel(lOutline, spr.frames[1], outline, Point(0, 0))
  spr:newCel(lBody, spr.frames[1], body, Point(0, 0))
  spr:saveAs(app.fs.joinPath(dir, key .. ".aseprite"))
  spr:close()

  local flat = Image(S, S, ColorMode.RGB); flat:clear(0)
  flat:drawImage(shadow, Point(0, 0)); flat:drawImage(outline, Point(0, 0)); flat:drawImage(body, Point(0, 0))
  flat:saveAs(app.fs.joinPath(dir, key .. ".png"))
end
print(#keys .. " furniture sprites")
