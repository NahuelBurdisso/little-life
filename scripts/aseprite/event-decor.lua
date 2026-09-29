-- event-decor.lua — town event decorations: bunting, lantern posts, stalls, flower arch, wreath,
-- candles, harvest goods, flags, benches, flames and smoke, notice boards, sparkles...
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/fx --script scripts/aseprite/event-decor.lua
--
-- Writes decor.aseprite (layers: shadow, outline, body; one frame per cell, tagged by sprite)
-- and decor.png, a strip of 32x32 cells. Cell order — keep in sync with DECOR_FRAMES in
-- src/components/canvas/systems/townEvents/eventDecor.ts:
--
--   0-1 bunting (festival)   2-3 bunting (white)     4-5 bunting (dark)
--   6-7 lantern post         8 plain post
--   9 stall (red awning)     10 stall (blue awning)  11 crate
--   12 flower arch           13 petals               14 wreath on stand
--   15-17 candles            18 pumpkins             19 hay bale      20 basket
--   21-22 flag pole          23 podium               24 bench         25 lectern
--   26-29 fire               30-32 smoke             33 notice board
--   34-36 sparkle            37 herb rack            38 closed sign
--
-- Every object stands with its base on row 29 (the renderer anchors a cell at x=16, y=30, so a
-- placement's coordinates are where the object touches the ground). Same top-down 3/4 view as
-- the furniture sprites: lit top face, shaded front face, 1px #1a1510 outline. Tall thin things
-- (posts, arch, flags) get a ground ellipse for a shadow instead of the pushed silhouette, which
-- would read as a second pole. Flames, smoke, sparkles and the bunting strings are FX: no
-- outline, no shadow.

local S = 32
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end

-- Master palette, as furniture.lua.
local P = {
  OUTLINE = 0x1a1510, SHADOW = 0x2e2418, DARK_WOOD = 0x4a3020, MID_WOOD = 0x7a5030,
  LIGHT_WOOD = 0xb07840, TAN = 0xd4a870, LINEN = 0xe8d5a3, STONE_DK = 0x3a3830,
  STONE_MD = 0x5a5850, STONE_LT = 0x8a8878, MORTAR = 0x6a6858, IRON_DK = 0x2a2828,
  IRON_MD = 0x484442, IRON_LT = 0x706a60, EMBER_DK = 0x6a1800, EMBER_MD = 0xc04010,
  EMBER_LT = 0xf07020, FORGE_GLW = 0xffb040, GREEN_DK = 0x2a4020, GREEN_MD = 0x4a6830,
  CREAM = 0xe0d8c0, WHITE_LT = 0xf0ece0, BLUE_DARK = 0x1a2840, BLUE_MID = 0x2a4870,
  GOLD = 0xc09020,
}
P.RED_MD, P.RED_DK = 0x8a2a2a, 0x5a1a1a
-- Festival dyes and flower colours the furniture palette lacks.
P.FEST_RED, P.FEST_YEL, P.FEST_BLU, P.FEST_GRN = 0xc04040, 0xe0b830, 0x3a6ab0, 0x4a8a52
P.PINK, P.PINK_DK, P.LEAF_LT = 0xe89ab8, 0xc0688a, 0x6a9848

-- ── Drawing primitives ─────────────────────────────────────────────────────────────────────

local img -- current body image

local function px(x, y, c, a)
  x, y = math.floor(x), math.floor(y)
  if x >= 0 and y >= 0 and x < S and y < S then img:drawPixel(x, y, hex(c, a)) end
end
local function rect(x, y, w, h, c, a) for yy = y, y + h - 1 do for xx = x, x + w - 1 do px(xx, yy, c, a) end end end
local function hline(x, y, w, c, a) rect(x, y, w, 1, c, a) end
local function vline(x, y, h, c, a) rect(x, y, 1, h, c, a) end
local function disc(cx, cy, r, c, a)
  for yy = math.floor(cy - r), math.ceil(cy + r) do
    for xx = math.floor(cx - r), math.ceil(cx + r) do
      local dx, dy = xx + 0.5 - cx, yy + 0.5 - cy
      if dx * dx + dy * dy <= r * r then px(xx, yy, c, a) end
    end
  end
end

-- A soft glow: alpha falls off quadratically from the centre, so it has no visible rim.
local function halo(cx, cy, r, c, a)
  for yy = math.floor(cy - r), math.ceil(cy + r) do
    for xx = math.floor(cx - r), math.ceil(cx + r) do
      local d = math.sqrt((xx + 0.5 - cx) ^ 2 + (yy + 0.5 - cy) ^ 2)
      if d < r then
        local al = math.floor(a * (1 - d / r) ^ 2)
        if al >= 5 then px(xx, yy, c, al) end
      end
    end
  end
end

-- A box seen from above and slightly south: top face over a front face (see furniture.lua).
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

-- A shaded ellipse (light from the upper left), 4-tone ramp {dark, mid, light, highlight}.
local function lobe(cx, cy, rx, ry, ramp)
  for yy = math.floor(cy - ry) - 1, math.ceil(cy + ry) + 1 do
    for xx = math.floor(cx - rx) - 1, math.ceil(cx + rx) + 1 do
      local dx, dy = (xx + 0.5 - cx) / rx, (yy + 0.5 - cy) / ry
      if dx * dx + dy * dy <= 1 then
        local lit = -(dx * 0.6 + dy * 0.8)
        local t = lit > 0.45 and 4 or lit > 0.05 and 3 or lit > -0.45 and 2 or 1
        px(xx, yy, ramp[t])
      end
    end
  end
end

local seed = 11
local function rand()
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
end

-- ── Finishing: outline + shadow layers ─────────────────────────────────────────────────────

local function opaque(i, x, y)
  if x < 0 or y < 0 or x >= S or y >= S then return false end
  return pc.rgbaA(i:getPixel(x, y)) == 255
end

-- mode: "push" = silhouette pushed 2px down-right (low objects), "ground" = ellipse {cx,cy,rx,ry}
-- at the base (tall thin ones), "none" = FX. `outline` = false skips the 1px outline.
local function finish(body, opt)
  local outline = Image(S, S, ColorMode.RGB); outline:clear(0)
  local shadow = Image(S, S, ColorMode.RGB); shadow:clear(0)
  if opt.outline ~= false and opt.mode ~= "none" then
    for y = 0, S - 1 do
      for x = 0, S - 1 do
        if not opaque(body, x, y) and (opaque(body, x - 1, y) or opaque(body, x + 1, y)
            or opaque(body, x, y - 1) or opaque(body, x, y + 1)) then
          outline:drawPixel(x, y, hex(P.OUTLINE))
        end
      end
    end
  end
  if opt.mode == "push" then
    for y = 0, S - 1 do
      for x = 0, S - 1 do
        if (opaque(body, x - 2, y - 2) or opaque(outline, x - 2, y - 2))
           and not opaque(body, x, y) and not opaque(outline, x, y) then
          shadow:drawPixel(x, y, hex(0x1a1208, 90))
        end
      end
    end
  elseif opt.mode == "ground" then
    local g = opt.ground
    for y = 0, S - 1 do
      for x = 0, S - 1 do
        local dx, dy = (x + 0.5 - g[1]) / g[3], (y + 0.5 - g[2]) / g[4]
        if dx * dx + dy * dy <= 1 and not opaque(body, x, y) and not opaque(outline, x, y) then
          shadow:drawPixel(x, y, hex(0x1a1208, 80))
        end
      end
    end
  end
  return shadow, outline
end

-- ── Bunting ────────────────────────────────────────────────────────────────────────────────
-- A string from (0,4) to (31,4) sagging in the middle, five pennants hanging from it. The two
-- frames differ in the sag and in how far the pennant tips swing. Posts stand every 3 cells, so
-- the string reads as scallops between poles (the pole tops sit at y=4 on the neighbouring cell).

local FEST = { { P.FEST_RED, 0x8a2a2a }, { P.FEST_YEL, 0xa07818 }, { P.FEST_BLU, 0x24487a }, { P.FEST_GRN, 0x2f5a36 } }
local WHITE = { { 0xf4f0e6, 0xc8c0ae }, { 0xe8d5a3, 0xb8a878 }, { 0xf4f0e6, 0xc8c0ae }, { 0xdcd8e8, 0xaaa6be } }
local DARK = { { 0x4a4658, 0x2e2a3a }, { 0x36323f, 0x22202b }, { 0x4a4658, 0x2e2a3a }, { 0x2c2a36, 0x1a1822 } }
local PENNANT_ROWS = { 5, 5, 3, 3, 1 }

local function bunting(f, set, cord)
  local sag = f == 1 and 5 or 4.2
  local ys = {}
  for x = 0, 31 do
    ys[x] = 4 + math.floor(sag * math.sin(math.pi * x / 31) + 0.5)
    px(x, ys[x], cord)
  end
  for k = 0, 4 do
    local cx = 2 + k * 6
    local col = set[(k % #set) + 1]
    for r = 1, #PENNANT_ROWS do
      local w = PENNANT_ROWS[r]
      local sway = (f == 2 and r >= 3) and 1 or ((f == 1 and r >= 4) and -1 or 0)
      local c = (r >= 4) and col[2] or col[1]
      rect(cx - (w - 1) // 2 + sway, ys[cx] + r, w, 1, c)
    end
  end
end

-- ── Posts ──────────────────────────────────────────────────────────────────────────────────

local function pole(top)
  rect(15, top, 2, 29 - top, P.MID_WOOD)
  vline(15, top, 29 - top, P.LIGHT_WOOD)
  vline(16, top, 29 - top, P.DARK_WOOD)
  -- stone footing
  rect(12, 27, 8, 3, P.STONE_MD)
  hline(12, 27, 8, P.STONE_LT)
  hline(12, 29, 8, P.STONE_DK)
  -- brass cap
  rect(15, top - 2, 2, 2, P.GOLD)
  px(15, top - 2, 0xe8c050)
end

local function lanternPost(f)
  -- halo first so the frame draws over it
  halo(21.5, 10.5, f == 1 and 9 or 8, P.FORGE_GLW, f == 1 and 110 or 85)
  pole(5)
  hline(17, 6, 5, P.IRON_DK)                                    -- arm
  hline(19, 7, 5, P.IRON_MD)                                    -- cap
  rect(19, 8, 5, 5, f == 1 and 0xffd070 or P.FORGE_GLW)         -- glass
  rect(20, 9, 3, 3, f == 1 and 0xfff0b0 or 0xffe090)
  vline(19, 8, 5, P.IRON_DK); vline(23, 8, 5, P.IRON_DK)
  hline(19, 13, 5, P.IRON_MD)
end

local function plainPost()
  pole(5)
end

-- ── Stalls, crate ──────────────────────────────────────────────────────────────────────────

local function stall(c1, c2)
  local cream, creamDk = 0xe8ddc0, 0xbfb28e
  rect(5, 13, 22, 6, 0x3a2818)                                  -- dim inside of the stall
  vline(4, 13, 16, P.DARK_WOOD); vline(27, 13, 16, P.DARK_WOOD) -- awning posts
  vline(3, 13, 16, P.MID_WOOD); vline(28, 13, 16, P.MID_WOOD)
  box(5, 19, 22, 3, 7, P.LIGHT_WOOD, P.MID_WOOD,
      { rim = P.TAN, base = P.DARK_WOOD, planks = 5, plankC = P.DARK_WOOD })
  -- goods on the counter
  local goods = { 0xc0402a, 0x6a9a3a, 0xd0b040, 0xc0402a, 0xd8702a }
  for i, c in ipairs(goods) do
    disc(6.5 + (i - 1) * 4.2, 18.6, 1.7, c)
    px(6 + (i - 1) * 4.2, 17.6, 0xf0e0c0)
  end
  -- awning: top surface (light stripes), front valance (shaded), scalloped hem
  for x = 2, 29 do
    local stripe = ((x - 2) // 4) % 2 == 0
    for y = 3, 8 do px(x, y, stripe and c1 or cream) end
    for y = 9, 12 do px(x, y, stripe and c2 or creamDk) end
    if not ((x - 2) % 4 == 0 or (x - 2) % 4 == 3) then px(x, 13, stripe and c2 or creamDk) end
  end
  hline(2, 3, 28, 0xffffff, 60)
end

local function crate()
  box(7, 14, 18, 5, 10, P.TAN, P.LIGHT_WOOD, { rim = P.LINEN, base = P.DARK_WOOD })
  hline(8, 16, 16, P.LIGHT_WOOD)
  vline(7, 19, 10, P.MID_WOOD); vline(24, 19, 10, P.MID_WOOD)
  hline(8, 22, 16, P.MID_WOOD); hline(8, 25, 16, P.MID_WOOD)
  -- diagonal brace
  for i = 0, 5 do px(10 + i * 2, 23 + (i % 2), P.DARK_WOOD); px(11 + i * 2, 24 - (i % 2) * 0, P.DARK_WOOD) end
  vline(15, 14, 5, P.MID_WOOD)
end

-- ── Wedding ────────────────────────────────────────────────────────────────────────────────

local function flowerArch()
  -- posts
  for _, x in ipairs({ 4, 26 }) do
    rect(x, 12, 3, 17, P.CREAM)
    vline(x, 12, 17, P.WHITE_LT); vline(x + 2, 12, 17, 0xb0a890)
    rect(x - 1, 27, 5, 3, P.STONE_LT)
  end
  -- arch: a ring of vine on an ellipse centred (16,13), radii 12 x 10, upper half only
  for y = 0, 14 do
    for x = 0, 31 do
      local dx, dy = (x + 0.5 - 16) / 12, (y + 0.5 - 13) / 10
      local d = dx * dx + dy * dy
      if d <= 1 and d >= 0.5 then
        local lit = -(dx * 0.6 + dy * 0.8)
        px(x, y, lit > 0.3 and P.LEAF_LT or lit > -0.3 and P.GREEN_MD or P.GREEN_DK)
      end
    end
  end
  -- vine wound round the posts
  for y = 14, 27, 3 do
    px(4, y, P.GREEN_MD); px(5, y + 1, P.LEAF_LT); px(6, y, P.GREEN_DK)
    px(26, y + 1, P.GREEN_MD); px(27, y, P.LEAF_LT); px(28, y + 1, P.GREEN_DK)
  end
  -- blossoms along the arch and at the foot of each post
  local blooms = {
    { 5, 11, P.PINK }, { 8, 6, 0xf4f0e6 }, { 12, 3, P.PINK }, { 16, 2, 0xf4f0e6 }, { 20, 3, P.PINK },
    { 24, 6, 0xf4f0e6 }, { 27, 11, P.PINK }, { 10, 4, 0xe0b830 }, { 22, 4, 0xe0b830 },
    { 5, 20, 0xf4f0e6 }, { 27, 19, P.PINK }, { 4, 25, P.PINK }, { 28, 25, 0xf4f0e6 },
  }
  for _, b in ipairs(blooms) do
    px(b[1], b[2], b[3]); px(b[1] + 1, b[2], b[3]); px(b[1], b[2] + 1, b[3])
    px(b[1] + 1, b[2] + 1, b[3] == P.PINK and P.PINK_DK or 0xd8d0c0)
  end
end

local function petals()
  seed = 91
  local cols = { 0xf4b8cc, 0xf8f0f0, P.PINK, 0xf4d8e0 }
  for _ = 1, 19 do
    local x, y = 3 + math.floor(rand() * 26), 15 + math.floor(rand() * 13)
    local c = cols[1 + math.floor(rand() * #cols)]
    px(x, y, c)
    if rand() < 0.5 then px(x + 1, y, c) end
    if rand() < 0.2 then px(x, y + 1, P.PINK_DK, 200) end
  end
end

-- ── Funeral ────────────────────────────────────────────────────────────────────────────────

local function wreath()
  -- easel legs
  rect(15, 18, 2, 11, P.MID_WOOD); vline(15, 18, 11, P.LIGHT_WOOD)
  for i = 0, 6 do px(14 - i // 2, 22 + i, P.MID_WOOD); px(17 + i // 2, 22 + i, P.DARK_WOOD) end
  -- the ring of leaves
  for y = 0, 24 do
    for x = 0, 31 do
      local dx, dy = x + 0.5 - 16, y + 0.5 - 11
      local d = math.sqrt(dx * dx + dy * dy)
      if d <= 8.5 and d >= 4.5 then
        local lit = -(dx * 0.6 + dy * 0.8) / math.max(d, 1)
        local c = lit > 0.35 and P.GREEN_MD or lit > -0.2 and P.GREEN_DK or 0x1c2c16
        if (x * 7 + y * 3) % 5 == 0 then c = P.LEAF_LT end
        px(x, y, c)
      end
    end
  end
  -- white lilies and a dark ribbon
  local lil = { { 10, 8 }, { 22, 9 }, { 16, 3 }, { 12, 16 }, { 21, 15 } }
  for _, l in ipairs(lil) do
    px(l[1], l[2], 0xf4f0e6); px(l[1] + 1, l[2], 0xf4f0e6); px(l[1], l[2] + 1, 0xf4f0e6); px(l[1] + 1, l[2] + 1, 0xe0b830)
  end
  rect(14, 17, 5, 2, 0x3a2a4a)
  rect(12, 19, 2, 3, 0x3a2a4a); rect(19, 19, 2, 3, 0x3a2a4a)
  px(16, 17, 0x5a4a6a)
end

local function candles(f)
  -- brass dish
  rect(8, 25, 16, 3, P.GOLD)
  hline(8, 25, 16, 0xe8c050); hline(8, 27, 16, 0x7a5a18)
  -- two candles: tall + short, wax lit from the left
  local function candle(x, top)
    rect(x, top, 3, 25 - top, P.LINEN)
    vline(x, top, 25 - top, P.WHITE_LT); vline(x + 2, top, 25 - top, 0xb8a878)
    px(x + 1, top - 1, 0x3a2a18)                                 -- wick
  end
  candle(10, 15); candle(19, 19)
  -- third, tiny votive between them
  rect(15, 22, 3, 3, 0xc8c0d8)
  -- flames: height and lean vary per frame
  local hs = { { 3, 2, 2 }, { 4, 3, 2 }, { 3, 2, 3 } }
  local lean = { { 0, 0, 0 }, { 1, 0, 0 }, { -1, 0, 1 } }
  local spots = { { 11, 14 }, { 20, 18 }, { 16, 21 } }
  for i, s in ipairs(spots) do
    local h = hs[f][i]
    halo(s[1] + 0.5, s[2] - 1.5, 5, P.FORGE_GLW, 90)
    for k = 0, h - 1 do
      local w = (k == h - 1) and 1 or 2
      local x = s[1] + lean[f][i] * (k >= 2 and 1 or 0)
      rect(x, s[2] - k, w, 1, k == 0 and 0xfff0b0 or (k == h - 1 and P.EMBER_LT or P.FORGE_GLW))
    end
  end
end

-- ── Harvest ────────────────────────────────────────────────────────────────────────────────

local function pumpkins()
  local ramp = { 0x8a3a0c, 0xc25a1c, 0xe07a2c, 0xf4a048 }
  local rib = 0x8a3a0c
  -- big one, left
  lobe(12, 21, 9, 7, ramp)
  lobe(9, 21, 4.5, 6.5, ramp); lobe(15, 21, 4.5, 6.5, ramp)
  vline(12, 15, 12, rib, 160)
  for _, x in ipairs({ 8, 16 }) do vline(x, 17, 8, rib, 130) end
  rect(11, 12, 3, 3, 0x3a5a20); px(11, 12, 0x5a8a30); px(13, 11, 0x3a5a20)
  -- small one, right
  lobe(23, 24, 6, 4.5, ramp)
  vline(23, 20, 9, rib, 160)
  rect(22, 19, 2, 2, 0x3a5a20)
  -- a curl of vine and a leaf
  px(15, 12, 0x3a5a20); px(16, 11, 0x3a5a20); px(17, 11, 0x5a8a30)
  rect(19, 17, 3, 2, P.GREEN_MD); px(18, 18, P.GREEN_DK); px(21, 17, P.LEAF_LT)
end

local function hayBale()
  local straw, strawLt, strawDk, twine = 0xc09830, 0xe0c060, 0x8a6a20, 0x5a3a18
  box(5, 13, 22, 7, 9, strawLt, straw, { rim = 0xf0d880, base = strawDk })
  vline(5, 20, 9, strawDk); vline(26, 20, 9, strawDk)
  -- straw texture
  seed = 5
  for _ = 1, 26 do
    local x, y = 6 + math.floor(rand() * 19), 14 + math.floor(rand() * 14)
    local top = y < 20
    hline(x, y, 2 + math.floor(rand() * 3), top and 0xf0d880 or strawDk)
  end
  -- twine bands
  for _, x in ipairs({ 11, 20 }) do vline(x, 13, 16, twine); vline(x + 1, 13, 16, 0x7a5a28) end
  -- stray stalks sticking out
  px(4, 22, strawLt); px(3, 23, straw); px(27, 18, strawLt); px(28, 17, straw)
end

local function basket()
  local wick, wickDk = 0xb08048, 0x7a5030
  -- produce heaped over the rim
  disc(11, 13, 2.6, 0xc0402a); px(10, 12, 0xf08070)
  disc(17, 12, 2.8, 0xd8402a); px(16, 11, 0xf08070)
  disc(23, 13, 2.6, 0xc0402a); px(22, 12, 0xf08070)
  disc(14, 15, 2.6, 0x8ab040); px(13, 14, 0xc0d870)
  disc(20, 15, 2.6, 0xd0b040); px(19, 14, 0xf0e090)
  -- wicker body: trapezoid, checker weave
  for y = 17, 28 do
    local half = 10 - (28 - y) // 6 + (y > 26 and -1 or 0)
    half = math.max(8, half)
    for x = 16 - half, 15 + half do
      local weave = ((x + y) % 2 == 0) and wick or wickDk
      if y == 17 then weave = 0xd8a868 end
      px(x, y, weave)
    end
  end
  hline(6, 17, 20, 0xd8a868)
  hline(6, 18, 20, wickDk)
  -- shaded right side
  for y = 19, 28 do vline(24 - (28 - y) // 6, y, 1, 0x5a3a20) end
end

-- ── Competition ────────────────────────────────────────────────────────────────────────────

local function flag(f)
  rect(8, 5, 2, 24, P.MID_WOOD)
  vline(8, 5, 24, P.LIGHT_WOOD); vline(9, 5, 24, P.DARK_WOOD)
  rect(5, 27, 8, 3, P.STONE_MD); hline(5, 27, 8, P.STONE_LT); hline(5, 29, 8, P.STONE_DK)
  rect(7, 2, 4, 3, P.GOLD); px(7, 2, 0xe8c050)
  -- the flag: 16 columns wide, waving
  for j = 0, 15 do
    local dy = math.floor(math.sin(j * 0.6 + f * 2.2) * 1.4 + 0.5)
    local x = 10 + j
    for r = 0, 8 do
      local y = 5 + dy + r
      local c
      if r <= 2 then c = P.BLUE_MID
      elseif r <= 4 then c = P.GOLD
      else c = 0x1f3654 end
      if r == 0 then c = 0x3a6ab0 end
      if r == 3 then c = 0xe8c050 end
      if j >= 13 and (r == 4) then c = nil end          -- swallow-tail notch
      if j >= 14 and (r == 3 or r == 5) then c = nil end
      if c then px(x, y, c) end
    end
  end
end

local GLYPHS = {
  ["1"] = { "010", "110", "010", "010", "111" },
  ["2"] = { "111", "001", "111", "100", "111" },
  ["3"] = { "111", "001", "111", "001", "111" },
}
local function glyph(ch, x, y, c)
  for r, row in ipairs(GLYPHS[ch]) do
    for k = 1, 3 do if row:sub(k, k) == "1" then px(x + k - 1, y + r - 1, c) end end
  end
end

local function podium()
  box(12, 12, 9, 2, 16, P.GOLD, P.MID_WOOD, { rim = 0xe8c050, base = P.DARK_WOOD })
  box(3, 18, 9, 2, 10, P.LIGHT_WOOD, P.MID_WOOD, { rim = P.TAN, base = P.DARK_WOOD })
  box(21, 21, 9, 2, 7, P.LIGHT_WOOD, P.MID_WOOD, { rim = P.TAN, base = P.DARK_WOOD })
  glyph("1", 15, 17, P.CREAM)
  glyph("2", 6, 22, P.CREAM)
  glyph("3", 24, 24, P.CREAM)
end

-- ── Town meeting ───────────────────────────────────────────────────────────────────────────

local function bench()
  -- backrest slats behind the seat
  vline(4, 11, 13, P.DARK_WOOD); vline(27, 11, 13, P.DARK_WOOD)
  rect(5, 11, 22, 2, P.MID_WOOD); hline(5, 11, 22, P.LIGHT_WOOD)
  rect(5, 14, 22, 2, P.MID_WOOD); hline(5, 14, 22, P.LIGHT_WOOD)
  -- seat
  box(3, 18, 26, 3, 3, P.LIGHT_WOOD, P.MID_WOOD, { rim = P.TAN, base = P.DARK_WOOD })
  hline(3, 19, 26, 0xa06c38)
  -- legs
  rect(5, 24, 2, 5, P.DARK_WOOD); rect(25, 24, 2, 5, P.DARK_WOOD)
  vline(5, 24, 5, P.MID_WOOD)
end

local function lectern()
  rect(9, 27, 14, 2, P.DARK_WOOD)
  box(12, 19, 8, 1, 9, P.MID_WOOD, P.DARK_WOOD, { rim = P.LIGHT_WOOD, base = P.OUTLINE })
  vline(15, 21, 6, P.SHADOW)
  -- sloped desk with an open book
  box(6, 11, 20, 6, 3, P.LIGHT_WOOD, P.MID_WOOD, { rim = P.TAN, base = P.DARK_WOOD })
  rect(9, 12, 14, 4, P.WHITE_LT)
  vline(15, 12, 4, 0xb8b0a0); vline(16, 12, 4, P.CREAM)
  for _, y in ipairs({ 13, 15 }) do hline(10, y, 4, 0x9a9484); hline(18, y, 4, 0x9a9484) end
  px(22, 15, P.EMBER_MD); px(22, 16, P.EMBER_MD)                 -- ribbon
  rect(13, 8, 6, 3, P.IRON_MD); hline(13, 8, 6, P.IRON_LT)       -- little gavel block
  disc(16, 7, 1.6, P.GOLD)
end

-- ── Fire, smoke ────────────────────────────────────────────────────────────────────────────

local FIRE_TONGUES = {
  { { 16, 22, 6.0, 1 }, { 10, 15, 4.0, -2 }, { 22, 17, 4.5, 2 } },
  { { 16, 24, 6.0, -1 }, { 10, 17, 4.0, -1 }, { 22, 14, 4.5, 1 } },
  { { 16, 20, 6.5, 2 }, { 10, 14, 4.0, -2 }, { 22, 18, 4.5, -1 } },
  { { 16, 23, 6.0, -2 }, { 10, 16, 4.0, 1 }, { 22, 15, 4.5, 2 } },
}
local FIRE_SPARKS = {
  { { 12, 3 }, { 21, 6 } }, { { 19, 2 }, { 9, 7 } }, { { 14, 4 }, { 24, 8 } }, { { 20, 3 }, { 11, 5 } },
}

local function fire(f)
  -- warm glow on the roof under the flames
  halo(16, 21, 15, P.EMBER_LT, 120)
  -- ember bed
  seed = 40 + f
  for y = 25, 29 do
    for x = 4, 27 do
      local dx, dy = (x + 0.5 - 16) / 12, (y + 0.5 - 27.5) / 2.6
      if dx * dx + dy * dy <= 1 then
        px(x, y, rand() < 0.35 and P.EMBER_LT or (rand() < 0.5 and P.EMBER_MD or P.EMBER_DK))
      end
    end
  end
  local base = 27
  -- big tongue last so it sits in front
  local order = { 2, 3, 1 }
  for _, ti in ipairs(order) do
    local t = FIRE_TONGUES[f][ti]
    local cx, h, w, lean = t[1], t[2], t[3], t[4]
    for y = base, base - h + 1, -1 do
      local k = (base - y) / h                                   -- 0 bottom .. 1 tip
      local half = math.max(0.6, w * (1 - k ^ 1.35))
      local c = cx + lean * k ^ 1.6
      for x = math.floor(c - half), math.ceil(c + half) do
        local d = math.abs(x + 0.5 - c) / half
        local col
        if d < 0.34 and k < 0.5 then col = 0xfff0a0
        elseif d < 0.62 and k < 0.75 then col = 0xffc850
        elseif d < 0.88 and k < 0.92 then col = P.EMBER_LT
        else col = P.EMBER_MD end
        if d <= 1.0 then px(x, y, col) end
      end
    end
  end
  for _, s in ipairs(FIRE_SPARKS[f]) do px(s[1], s[2], 0xffd060); px(s[1], s[2] + 1, P.EMBER_LT, 160) end
end

local SMOKE_PUFFS = {
  { { 16, 24, 4.5 } },
  { { 16, 24, 3.5 }, { 17, 16, 6.5 } },
  { { 17, 15, 7 }, { 14, 8, 6 } },
}
local SMOKE_ALPHA = { 170, 150, 100 }

local function smoke(f)
  for _, p in ipairs(SMOKE_PUFFS[f]) do
    local cx, cy, r = p[1], p[2], p[3]
    for y = math.floor(cy - r), math.ceil(cy + r) do
      for x = math.floor(cx - r), math.ceil(cx + r) do
        local dx, dy = x + 0.5 - cx, y + 0.5 - cy
        local d = dx * dx + dy * dy
        if d <= r * r then
          local lit = -(dx * 0.6 + dy * 0.8) / r
          local c = lit > 0.35 and 0xa8a49a or lit > -0.25 and 0x807c74 or 0x5a5650
          local edge = d > (r * 0.78) ^ 2
          -- soft edge: dither the rim, more on the fainter frames
          if not (edge and (x + y) % 2 == (f == 3 and 0 or 1)) then
            px(x, y, c, edge and math.floor(SMOKE_ALPHA[f] * 0.7) or SMOKE_ALPHA[f])
          end
        end
      end
    end
  end
end

-- ── Scandal, blessing, sickness ────────────────────────────────────────────────────────────

local function noticeBoard()
  -- posts
  rect(8, 19, 2, 10, P.DARK_WOOD); rect(22, 19, 2, 10, P.DARK_WOOD)
  vline(8, 19, 10, P.MID_WOOD); vline(22, 19, 10, P.MID_WOOD)
  -- little roof
  hline(5, 5, 22, P.DARK_WOOD); hline(6, 4, 20, P.MID_WOOD); hline(7, 3, 18, P.LIGHT_WOOD)
  -- board: wood frame, cork face
  rect(6, 6, 20, 15, P.MID_WOOD)
  rect(7, 7, 18, 13, 0xa07a48)
  hline(6, 6, 20, P.LIGHT_WOOD); hline(6, 20, 20, P.DARK_WOOD)
  -- pinned notices, each a little off-square
  local notes = {
    { 8, 8, 5, 6, P.WHITE_LT }, { 14, 9, 4, 5, 0xf0e0a0 }, { 19, 8, 5, 7, P.WHITE_LT },
    { 9, 15, 4, 4, 0xf0e0a0 }, { 15, 15, 5, 4, P.WHITE_LT }, { 21, 16, 3, 4, 0xe8b8b8 },
  }
  for _, n in ipairs(notes) do
    rect(n[1], n[2], n[3], n[4], n[5])
    hline(n[1] + 1, n[2] + 2, n[3] - 2, 0x8a8474)
    if n[4] > 4 then hline(n[1] + 1, n[2] + 4, n[3] - 2, 0x8a8474) end
    px(n[1] + n[3] // 2, n[2], P.EMBER_MD)
  end
end

local SPARKLE_ARMS = { 2, 5, 3 }
local function sparkle(f)
  local a = SPARKLE_ARMS[f]
  local cx, cy = 16, 14
  halo(cx + 0.5, cy + 0.5, a + 4, 0xfff0b0, f == 2 and 150 or 90)
  for i = 1, a do
    local c = i <= 1 and 0xffffff or (i <= 3 and 0xfff0b0 or 0xffe070)
    local al = math.max(120, 255 - (i - 1) * 45)
    px(cx + i, cy, c, al); px(cx - i, cy, c, al); px(cx, cy + i, c, al); px(cx, cy - i, c, al)
  end
  px(cx, cy, 0xffffff)
  if f == 2 then                                     -- the fullest frame gets diagonals
    for _, d in ipairs({ { 1, 1 }, { -1, 1 }, { 1, -1 }, { -1, -1 } }) do px(cx + d[1], cy + d[2], 0xfff0b0, 200) end
    px(cx + 2, cy + 2, 0xffe070, 140); px(cx - 2, cy - 2, 0xffe070, 140)
  end
end

local function herbRack()
  -- two posts and a crossbar, bundles hanging from it
  rect(5, 8, 2, 21, P.DARK_WOOD); rect(25, 8, 2, 21, P.DARK_WOOD)
  vline(5, 8, 21, P.MID_WOOD); vline(25, 8, 21, P.MID_WOOD)
  rect(4, 8, 24, 2, P.MID_WOOD); hline(4, 8, 24, P.LIGHT_WOOD)
  rect(3, 27, 5, 2, P.STONE_MD); rect(24, 27, 5, 2, P.STONE_MD)
  local bundles = { { 10, 0x8a6ab0, 0x6a4a90 }, { 16, P.LEAF_LT, P.GREEN_MD }, { 22, 0xb0c060, 0x7a9a3a } }
  for _, b in ipairs(bundles) do
    local x = b[1]
    vline(x, 10, 2, 0x3a2a18)                                   -- cord
    rect(x - 1, 12, 3, 1, P.EMBER_MD)                           -- red tie
    for r = 0, 9 do                                             -- leaves fanning out downward
      local half = 1 + r // 3
      for dx = -half, half do
        local c = ((dx + r) % 2 == 0) and b[2] or b[3]
        px(x + dx, 13 + r, c)
      end
    end
    px(x, 23, b[3]); px(x - 1, 22, b[3])
  end
end

local function closedSign()
  -- legs of an A-frame sandwich board
  vline(9, 22, 7, P.DARK_WOOD); vline(22, 22, 7, P.DARK_WOOD)
  vline(10, 24, 5, P.MID_WOOD); vline(21, 24, 5, P.MID_WOOD)
  -- board
  rect(8, 9, 16, 14, P.MID_WOOD)
  rect(9, 10, 14, 12, P.LINEN)
  hline(8, 9, 16, P.LIGHT_WOOD); hline(8, 22, 16, P.DARK_WOOD)
  -- red border and a cross: "closed"
  for x = 10, 21 do px(x, 11, P.EMBER_MD); px(x, 20, P.EMBER_MD) end
  for y = 11, 20 do px(10, y, P.EMBER_MD); px(21, y, P.EMBER_MD) end
  for i = 0, 6 do px(12 + i, 12 + i, P.RED_MD); px(19 - i, 12 + i, P.RED_MD); px(13 + i, 12 + i, P.RED_MD); px(18 - i, 12 + i, P.RED_MD) end
end

-- ── Cell table ─────────────────────────────────────────────────────────────────────────────

local function ground(cx, rx) return { cx, 29, rx, 2 } end

local CELLS = {}
local function add(tag, fn, opt) table.insert(CELLS, { tag = tag, fn = fn, opt = opt }) end
local function addN(tag, n, fn, opt) for f = 1, n do add(tag, function() fn(f) end, opt) end end

local FX = { mode = "none" }
local STRING = { mode = "none", outline = false }

addN("bunting", 2, function(f) bunting(f, FEST, 0x3a2a18) end, STRING)
addN("bunting_white", 2, function(f) bunting(f, WHITE, 0x6a6050) end, STRING)
addN("bunting_dark", 2, function(f) bunting(f, DARK, 0x14121a) end, STRING)
addN("lantern_post", 2, lanternPost, { mode = "ground", ground = ground(17, 7) })
add("post", plainPost, { mode = "ground", ground = ground(17, 7) })
add("stall_red", function() stall(P.FEST_RED, 0x8a2a2a) end, { mode = "push" })
add("stall_blue", function() stall(P.FEST_BLU, 0x24487a) end, { mode = "push" })
add("crate", crate, { mode = "push" })
add("arch", flowerArch, { mode = "ground", ground = ground(16, 12) })
add("petals", petals, FX)
add("wreath", wreath, { mode = "ground", ground = ground(16, 7) })
addN("candles", 3, candles, { mode = "push" })
add("pumpkins", pumpkins, { mode = "push" })
add("hay", hayBale, { mode = "push" })
add("basket", basket, { mode = "push" })
addN("flag", 2, flag, { mode = "ground", ground = ground(11, 8) })
add("podium", podium, { mode = "push" })
add("bench", bench, { mode = "push" })
add("lectern", lectern, { mode = "push" })
addN("fire", 4, fire, FX)
addN("smoke", 3, smoke, FX)
add("notice_board", noticeBoard, { mode = "push" })
addN("sparkle", 3, sparkle, FX)
add("herb_rack", herbRack, { mode = "push" })
add("closed_sign", closedSign, { mode = "push" })

-- ── Build ──────────────────────────────────────────────────────────────────────────────────

local dir = app.params.dir or "public/sprites/fx"
app.fs.makeAllDirectories(dir)

local spr = Sprite(S, S, ColorMode.RGB)
spr.filename = "decor"
local lShadow = spr.layers[1]; lShadow.name = "shadow"
local lOutline = spr:newLayer(); lOutline.name = "outline"
local lBody = spr:newLayer(); lBody.name = "body"
for i = 2, #CELLS do spr:newEmptyFrame() end

local strip = Image(S * #CELLS, S, ColorMode.RGB)
strip:clear(0)

for i, c in ipairs(CELLS) do
  img = Image(S, S, ColorMode.RGB); img:clear(0)
  c.fn()
  local body = img
  local shadow, outline = finish(body, c.opt)
  spr:newCel(lShadow, spr.frames[i], shadow, Point(0, 0))
  spr:newCel(lOutline, spr.frames[i], outline, Point(0, 0))
  spr:newCel(lBody, spr.frames[i], body, Point(0, 0))
  local flat = Image(S, S, ColorMode.RGB); flat:clear(0)
  flat:drawImage(shadow, Point(0, 0)); flat:drawImage(outline, Point(0, 0)); flat:drawImage(body, Point(0, 0))
  strip:drawImage(flat, Point((i - 1) * S, 0))
end

local from = 1
for i = 1, #CELLS do
  if i == #CELLS or CELLS[i + 1].tag ~= CELLS[i].tag then
    local tag = spr:newTag(from, i); tag.name = CELLS[i].tag
    from = i + 1
  end
end
spr:saveAs(app.fs.joinPath(dir, "decor.aseprite"))
spr:close()
strip:saveAs(app.fs.joinPath(dir, "decor.png"))
print(#CELLS .. " decor cells")
