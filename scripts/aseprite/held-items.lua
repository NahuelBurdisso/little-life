-- held-items.lua — the tools and props agents carry (HeldItemSystem).
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/fx --script scripts/aseprite/held-items.lua
--
-- Writes held.aseprite (one frame per cell, tagged by item, layers: outline + body) and held.png,
-- a strip of 16x16 cells. Cell order and grips — keep in sync with HELD_ITEMS in
-- src/components/canvas/systems/held/heldFrames.ts:
--
--   0 hammer (grip 10,12)      1 hammer raised (10,12)    2 rolling pin (2,8)   3 clipboard (8,12)
--   4 ledger (8,12)            5 mug (8,10)               6 quill (6,11)        7 keys (8,3)
--   8 hoe (8,12)               9 plate (8,10)            10 basket (8,3)       11 fishing rod (4,13)
--  12 watering can (2,8)      13 lute (10,6)             14 book (8,12)
--
-- Every item is a chunky silhouette meant to read at ~10 px on screen: flat 2-3 tone fills lit from
-- the upper left, a 1px #1a1510 outline generated from the fill (like the furniture), no drop
-- shadow (the agent's own shadow already grounds it). The grip is the pixel that sits in the hand;
-- the renderer pivots the sprite around it so swings rotate about the fist.
--
-- Palette: the 24 swatches of scripts/aseprite/furniture.lua plus a few tints for glass and steel.

local S = 16
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end

local P = {
  OUTLINE = 0x1a1510, SHADOW = 0x2e2418, DARK_WOOD = 0x4a3020, MID_WOOD = 0x7a5030,
  LIGHT_WOOD = 0xb07840, TAN = 0xd4a870, LINEN = 0xe8d5a3, STONE_DK = 0x3a3830,
  STONE_MD = 0x5a5850, STONE_LT = 0x8a8878, IRON_MD = 0x484442, IRON_LT = 0x706a60,
  EMBER_MD = 0xc04010, EMBER_LT = 0xf07020, FORGE_GLW = 0xffb040, GREEN_DK = 0x2a4020,
  GREEN_MD = 0x4a6830, CREAM = 0xe0d8c0, WHITE_LT = 0xf0ece0, BLUE_DARK = 0x1a2840,
  BLUE_MID = 0x2a4870, GOLD = 0xc09020, RED_MD = 0x8a2a2a, RED_DK = 0x5a1a1a,
}
-- Tints the master palette lacks: steel highlight, bright gold, apple red, water blues.
P.STEEL = 0xb4b09e
P.GOLD_LT = 0xe8c040
P.APPLE = 0xb03a34
P.BLUE_LT = 0x4a80b0
P.WATER = 0x8ec4e8
P.PAPER_INK = 0x8a8070

-- ── Drawing primitives ─────────────────────────────────────────────────────────────────────

local img -- current fill image

local function px(x, y, c) if x >= 0 and y >= 0 and x < S and y < S then img:drawPixel(x, y, hex(c)) end end
local function rect(x, y, w, h, c) for yy = y, y + h - 1 do for xx = x, x + w - 1 do px(xx, yy, c) end end end
local function hline(x, y, w, c) rect(x, y, w, 1, c) end
local function vline(x, y, h, c) rect(x, y, 1, h, c) end
-- Filled ellipse centred on (cx, cy) with radii rx, ry; `shade(dx, dy)` may pick the colour.
local function ellipse(cx, cy, rx, ry, colorAt)
  for yy = math.floor(cy - ry), math.ceil(cy + ry) do
    for xx = math.floor(cx - rx), math.ceil(cx + rx) do
      local dx, dy = (xx + 0.5 - cx) / rx, (yy + 0.5 - cy) / ry
      if dx * dx + dy * dy <= 1 then px(xx, yy, colorAt(dx, dy)) end
    end
  end
end
-- Bresenham line, `c` may be a colour or function(i) -> colour (i counts from 0 at the start).
local function line(x0, y0, x1, y1, c)
  local dx, dy = math.abs(x1 - x0), -math.abs(y1 - y0)
  local sx, sy = x0 < x1 and 1 or -1, y0 < y1 and 1 or -1
  local err, i = dx + dy, 0
  while true do
    px(x0, y0, type(c) == "function" and c(i) or c)
    if x0 == x1 and y0 == y1 then break end
    local e2 = 2 * err
    if e2 >= dy then err = err + dy; x0 = x0 + sx end
    if e2 <= dx then err = err + dx; y0 = y0 + sy end
    i = i + 1
  end
end

local function opaque(i, x, y)
  if x < 0 or y < 0 or x >= S or y >= S then return false end
  return pc.rgbaA(i:getPixel(x, y)) == 255
end

local function outlineOf(body)
  local out = Image(S, S, ColorMode.RGB); out:clear(0)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      if not opaque(body, x, y) and (opaque(body, x - 1, y) or opaque(body, x + 1, y)
          or opaque(body, x, y - 1) or opaque(body, x, y + 1)) then
        out:drawPixel(x, y, hex(P.OUTLINE))
      end
    end
  end
  return out
end

-- Rotate an image about (gx, gy) by `rad` (clockwise on screen) with nearest sampling.
local function rotated(src, rad, gx, gy)
  local dst = Image(S, S, ColorMode.RGB); dst:clear(0)
  local c, s = math.cos(-rad), math.sin(-rad)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local rx, ry = x + 0.5 - gx, y + 0.5 - gy
      local sx = math.floor(rx * c - ry * s + gx)
      local sy = math.floor(rx * s + ry * c + gy)
      if sx >= 0 and sy >= 0 and sx < S and sy < S then dst:drawPixel(x, y, src:getPixel(sx, sy)) end
    end
  end
  return dst
end

-- ── The items ──────────────────────────────────────────────────────────────────────────────

local D = {}

-- Claw-less smith's hammer, head up. Raised variant = same drawing cocked back 30 degrees.
D.hammer = function()
  vline(9, 6, 9, P.LIGHT_WOOD); vline(10, 6, 9, P.MID_WOOD)     -- handle
  vline(9, 14, 1, P.MID_WOOD); vline(10, 14, 1, P.DARK_WOOD)
  hline(6, 2, 8, P.STEEL)                                        -- head: lit top, dark underside
  rect(6, 3, 8, 3, P.IRON_LT)
  hline(6, 6, 8, P.IRON_MD)
  rect(6, 3, 2, 3, P.STONE_LT)                                   -- the striking face
  px(13, 2, P.IRON_LT)
end

D.rolling_pin = function()
  rect(4, 6, 9, 5, P.TAN)                                        -- barrel, pointing forward
  hline(4, 6, 9, P.LINEN)
  hline(4, 9, 9, P.LIGHT_WOOD)
  hline(4, 10, 9, P.MID_WOOD)
  vline(4, 7, 3, P.LIGHT_WOOD); vline(12, 7, 3, P.LIGHT_WOOD)   -- end caps
  rect(1, 7, 3, 3, P.LIGHT_WOOD); hline(1, 9, 3, P.MID_WOOD)     -- handles
  rect(13, 7, 2, 3, P.LIGHT_WOOD); hline(13, 9, 2, P.MID_WOOD)
  px(7, 7, P.WHITE_LT); px(10, 8, P.WHITE_LT); px(6, 8, P.WHITE_LT) -- flour
end

D.clipboard = function()
  rect(4, 2, 8, 12, P.MID_WOOD)                                  -- board
  vline(4, 2, 12, P.LIGHT_WOOD)
  rect(5, 4, 6, 9, P.WHITE_LT)                                   -- paper
  hline(5, 12, 6, P.CREAM)
  for i, w in ipairs({ 4, 3, 4, 2 }) do hline(6, 5 + (i - 1) * 2, w, P.PAPER_INK) end
  hline(5, 2, 6, P.GOLD)                                         -- clip
  rect(6, 1, 4, 2, P.GOLD_LT); hline(6, 2, 4, P.GOLD)
  px(7, 2, P.IRON_LT); px(8, 2, P.IRON_LT)
end

D.ledger = function()
  rect(3, 3, 9, 10, P.RED_MD)                                    -- cover
  vline(3, 3, 10, P.RED_DK); vline(4, 3, 10, P.RED_DK)          -- spine
  hline(5, 3, 7, 0xa03a3a)
  vline(12, 4, 10, P.CREAM); hline(4, 13, 9, P.CREAM)            -- page block, seen from the corner
  hline(4, 13, 9, P.STONE_LT); px(12, 13, P.STONE_LT)
  rect(6, 5, 4, 3, P.GOLD_LT); hline(6, 7, 4, P.GOLD)            -- title plate
  hline(6, 10, 5, P.GOLD)                                        -- strap
end

D.mug = function()
  rect(4, 6, 7, 8, P.FORGE_GLW)                                  -- tankard of ale
  vline(5, 6, 7, 0xf8d878)                                       -- highlight
  vline(10, 6, 8, P.EMBER_LT)
  hline(4, 13, 7, P.GOLD); px(10, 13, P.EMBER_MD)
  hline(4, 4, 7, P.WHITE_LT); hline(5, 3, 2, P.WHITE_LT); hline(8, 3, 2, P.WHITE_LT) -- foam
  hline(4, 5, 7, P.CREAM); px(7, 5, P.WHITE_LT)
  vline(11, 7, 4, P.TAN); vline(12, 8, 2, P.TAN)                 -- handle
  px(11, 10, P.LIGHT_WOOD); px(12, 9, P.LIGHT_WOOD)
end

D.quill = function()
  local shaft = function(i) return i < 2 and P.IRON_MD or P.TAN end
  line(4, 13, 12, 5, shaft)
  for k = 3, 8 do                                                -- vane on both sides of the shaft
    local x, y = 4 + k, 13 - k
    px(x + 1, y, P.LINEN); px(x, y - 1, P.WHITE_LT)
    if k >= 5 then px(x + 2, y, P.LINEN); px(x, y - 2, P.WHITE_LT) end
  end
  px(13, 4, P.WHITE_LT); px(12, 3, P.WHITE_LT); px(13, 5, P.CREAM); px(11, 4, P.CREAM)
  px(4, 13, P.OUTLINE)                                           -- ink on the nib
  px(4, 14, P.BLUE_MID)
end

D.keys = function()
  for yy = 0, 8 do                                               -- ring
    for xx = 3, 12 do
      local d = math.sqrt((xx + 0.5 - 8) ^ 2 + (yy + 0.5 - 4.5) ^ 2)
      if d >= 1.7 and d <= 3.2 then px(xx, yy, d < 2.3 and P.STEEL or P.IRON_LT) end
    end
  end
  for _, k in ipairs({ { 6, 9 }, { 11, 9 } }) do                 -- two keys hanging off it
    local x, y = k[1], k[2]
    rect(x - 1, y - 1, 3, 3, P.GOLD_LT); px(x, y, P.GOLD)
    vline(x, y + 2, 5, P.GOLD_LT)
    px(x + 1, y + 5, P.GOLD); px(x + 1, y + 6, P.GOLD)
    px(x - 1, y + 3, P.GOLD)
  end
end

D.hoe = function()
  vline(7, 3, 12, P.LIGHT_WOOD); vline(8, 3, 12, P.MID_WOOD)     -- long handle
  hline(7, 1, 7, P.STEEL); hline(7, 2, 7, P.IRON_LT)             -- blade, bent over at the top
  rect(12, 3, 2, 2, P.IRON_LT); hline(12, 4, 2, P.IRON_MD)
  px(7, 1, P.IRON_LT); px(7, 2, P.IRON_MD)
end

D.plate = function()
  ellipse(7.5, 8.5, 6, 3, function(dx, dy)
    if dx * dx + dy * dy > 0.62 then return dy > 0.35 and P.STONE_LT or P.WHITE_LT end   -- rim
    return P.CREAM
  end)
  ellipse(5.5, 7.5, 2, 1.4, function(dx, dy) return dy < -0.2 and P.TAN or P.LIGHT_WOOD end) -- roll
  px(5, 7, P.LINEN)
  hline(8, 8, 3, P.GREEN_MD); px(9, 7, P.GREEN_MD); px(10, 9, P.GREEN_DK)                     -- greens
  px(9, 9, P.APPLE); px(8, 9, P.APPLE)
end

D.basket = function()
  local arch = { { 4, 6 }, { 4, 5 }, { 4, 4 }, { 5, 3 }, { 6, 2 }, { 7, 2 }, { 8, 2 }, { 9, 2 },
                 { 10, 3 }, { 11, 4 }, { 11, 5 }, { 11, 6 } }
  for _, p in ipairs(arch) do px(p[1], p[2], p[2] == 2 and P.LIGHT_WOOD or P.MID_WOOD) end
  rect(5, 5, 2, 2, P.APPLE); px(5, 5, 0xd05048)                                              -- apples
  rect(8, 5, 2, 2, P.APPLE); px(8, 5, 0xd05048)
  hline(7, 6, 1, P.GREEN_MD); px(9, 4, P.GREEN_MD); px(10, 5, P.GREEN_MD)
  local rows = { { 7, 2, 13 }, { 8, 3, 12 }, { 9, 3, 12 }, { 10, 3, 12 }, { 11, 3, 12 },
                 { 12, 4, 11 }, { 13, 4, 11 } }
  for _, r in ipairs(rows) do
    for x = r[2], r[3] do
      -- Weave: alternating light/dark checker, a lit rim on top and a shaded base.
      local c = ((x + r[1]) % 2 == 0) and P.TAN or P.LIGHT_WOOD
      if r[1] == 7 then c = P.LINEN elseif r[1] == 13 then c = P.MID_WOOD end
      if x == r[3] and r[1] > 7 then c = P.MID_WOOD end
      px(x, r[1], c)
    end
  end
end

D.rod = function()
  line(3, 14, 13, 3, function(i) return i < 3 and P.TAN or (i > 9 and P.DARK_WOOD or P.LIGHT_WOOD) end)
  px(5, 11, P.STONE_LT); px(4, 11, P.IRON_MD)                    -- reel
  vline(14, 3, 6, P.WHITE_LT)                                    -- line
  rect(13, 9, 2, 2, P.WHITE_LT); hline(13, 9, 2, P.EMBER_MD)     -- bobber
  px(14, 9, P.APPLE)
end

D.watering_can = function()
  rect(3, 6, 7, 7, P.BLUE_MID)                                   -- body
  vline(3, 6, 7, P.BLUE_LT); vline(8, 6, 7, P.BLUE_DARK); vline(9, 6, 7, P.BLUE_DARK)
  hline(3, 6, 7, P.BLUE_LT); hline(3, 12, 7, P.BLUE_DARK)
  hline(3, 8, 7, P.BLUE_DARK); hline(3, 8, 5, 0x35608a)          -- rivet band
  local spout = { { 10, 11 }, { 10, 10 }, { 11, 10 }, { 11, 9 }, { 12, 9 }, { 12, 8 }, { 13, 8 }, { 13, 7 } }
  for _, p in ipairs(spout) do px(p[1], p[2], (p[1] + p[2]) % 2 == 0 and P.BLUE_MID or P.BLUE_LT) end
  rect(13, 4, 2, 3, P.STEEL); px(14, 4, P.IRON_LT); px(14, 6, P.IRON_LT)                     -- rose
  local handle = { { 3, 5 }, { 2, 5 }, { 1, 6 }, { 1, 7 }, { 1, 8 }, { 1, 9 }, { 2, 10 }, { 3, 10 } }
  for _, p in ipairs(handle) do px(p[1], p[2], P.BLUE_DARK) end
  px(14, 9, P.WATER); px(13, 11, P.WATER); px(15, 11, P.WATER)   -- drops
end

D.lute = function()
  ellipse(6, 10.5, 4.6, 4.2, function(dx, dy)                    -- pear-shaped body
    local lit = -(dx * 0.6 + dy * 0.8)
    return lit > 0.4 and P.TAN or (lit > -0.2 and P.LIGHT_WOOD or P.MID_WOOD)
  end)
  ellipse(6, 10.5, 1.3, 1.3, function() return P.SHADOW end)     -- sound hole
  hline(4, 13, 5, P.DARK_WOOD)                                   -- bridge
  line(9, 8, 13, 4, P.DARK_WOOD); line(10, 8, 14, 4, P.MID_WOOD) -- neck
  rect(13, 1, 3, 3, P.DARK_WOOD); px(15, 1, P.GOLD_LT); px(13, 1, P.GOLD_LT); px(15, 3, P.GOLD_LT)
end

D.book = function()
  hline(1, 12, 14, P.BLUE_MID); hline(1, 13, 14, P.BLUE_DARK)    -- cover
  vline(1, 12, 2, P.BLUE_LT)
  rect(2, 4, 6, 8, P.WHITE_LT); rect(8, 4, 6, 8, P.CREAM)        -- open pages
  hline(2, 4, 12, P.WHITE_LT); vline(7, 4, 8, P.STONE_LT); vline(8, 4, 8, P.STONE_LT)
  for _, y in ipairs({ 6, 8, 10 }) do
    hline(3, y, 3, P.PAPER_INK); hline(9, y, 4, P.PAPER_INK)
  end
  px(3, 6, P.PAPER_INK); px(11, 10, P.CREAM)
  vline(11, 12, 3, P.RED_MD)                                     -- ribbon
end

-- ── Frames ─────────────────────────────────────────────────────────────────────────────────

-- Order is the atlas layout; `raised` marks the hammer's second frame.
local ORDER = {
  { "hammer" }, { "hammer", raised = true }, { "rolling_pin" }, { "clipboard" }, { "ledger" },
  { "mug" }, { "quill" }, { "keys" }, { "hoe" }, { "plate" }, { "basket" }, { "rod" },
  { "watering_can" }, { "lute" }, { "book" },
}

local cells = {}
for i, e in ipairs(ORDER) do
  img = Image(S, S, ColorMode.RGB); img:clear(0)
  D[e[1]]()
  local body = img
  if e.raised then body = rotated(body, math.rad(-22), 10.5, 12.5) end
  cells[i] = { name = e[1], body = body, outline = outlineOf(body) }
end

local dir = app.params.dir or "public/sprites/fx"
app.fs.makeAllDirectories(dir)

local spr = Sprite(S, S, ColorMode.RGB)
spr.filename = "held"
local lOutline = spr.layers[1]; lOutline.name = "outline"
local lBody = spr:newLayer(); lBody.name = "body"
for i = 2, #cells do spr:newEmptyFrame() end
for i, c in ipairs(cells) do
  spr:newCel(lOutline, spr.frames[i], c.outline, Point(0, 0))
  spr:newCel(lBody, spr.frames[i], c.body, Point(0, 0))
end
local from = 1
for i = 1, #cells do
  if i == #cells or cells[i + 1].name ~= cells[i].name then
    local tag = spr:newTag(from, i); tag.name = cells[i].name
    from = i + 1
  end
end
spr:saveAs(app.fs.joinPath(dir, "held.aseprite"))
spr:close()

local strip = Image(S * #cells, S, ColorMode.RGB)
strip:clear(0)
for i, c in ipairs(cells) do
  strip:drawImage(c.outline, Point((i - 1) * S, 0))
  strip:drawImage(c.body, Point((i - 1) * S, 0))
end
strip:saveAs(app.fs.joinPath(dir, "held.png"))
print(#cells .. " held-item frames")
