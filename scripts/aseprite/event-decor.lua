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
--   39-40 hooded stranger with lantern (mysterious_stranger)
--   41 fish crate            42 net rack             43-48 fish jump (ripple, fin, rise, apex,
--                                                    fall, splash) — bountiful_catch, on water
--   49-50 hand cart          51 luggage stack        52-53 welcome banner (new_arrival)
--   54 parasol               55 water barrel         (heatwave)
--   56 petals falling        57 gold motes falling   58 leaves falling  59 confetti falling
--   60 paper scraps falling  (clusters the renderer drifts down: wedding, blessing, harvest,
--                             festival, scandal)
--   61 heat haze (rises, heatwave)
--   62-64 fireflies          65-68 owl on a post (look centre, left, right, blink)   (full_moon)
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

-- ── Mysterious stranger ────────────────────────────────────────────────────────────────────
-- A hooded traveller with a walking staff and a lantern held out at arm's length. The face is a
-- black hollow with two pale pinpricks: ominous, but only if you look closely.

local CLOAK = { 0x14121c, 0x24202f, 0x342f44, 0x48425c }

local function stranger(f)
  -- lantern light first so the figure draws over it
  halo(24.5, 21.5, f == 1 and 9 or 8, P.FORGE_GLW, f == 1 and 105 or 78)
  -- walking staff
  rect(7, 10, 1, 19, P.MID_WOOD); vline(7, 10, 19, P.LIGHT_WOOD)
  disc(7.5, 8.5, 1.7, P.DARK_WOOD); px(7, 8, P.MID_WOOD)
  -- cloak: a bell that widens to the hem, lit from the right by the lantern
  local cx = 15.5
  for y = 13, 28 do
    local half = 3.6 + (y - 13) * 0.38
    local sway = (f == 2 and y >= 25) and 1 or 0
    for x = math.floor(cx - half) + sway, math.ceil(cx + half - 1) + sway do
      local dx = (x + 0.5 - sway - cx) / half
      local c = CLOAK[2]
      if dx < -0.35 then c = CLOAK[1] elseif dx > 0.4 then c = CLOAK[3] end
      if dx > 0.78 then c = 0x5a4238 end                          -- warm rim from the lantern
      if (y + x) % 5 == 0 and dx > -0.3 and dx < 0.3 then c = CLOAK[1] end -- a fold
      px(x, y, c)
    end
  end
  vline(14, 18, 10, CLOAK[1]); vline(18, 19, 9, CLOAK[1])
  -- hood: an egg with a point on top
  lobe(15.5, 10.5, 4.6, 5.4, CLOAK)
  px(15, 4, CLOAK[2]); px(16, 4, CLOAK[3]); px(15, 5, CLOAK[2]); px(16, 5, CLOAK[2]); px(17, 5, CLOAK[3])
  -- the dark inside the hood
  for y = 8, 15 do
    for x = 11, 20 do
      local dx, dy = (x + 0.5 - 15.5) / 2.5, (y + 0.5 - 11.6) / 3.3
      if dx * dx + dy * dy <= 1 then px(x, y, 0x08060c) end
    end
  end
  px(14, 11, 0xb8c4e0); px(17, 11, 0xb8c4e0)
  -- the arm that holds the lantern
  rect(19, 15, 3, 3, CLOAK[3]); rect(21, 17, 2, 2, CLOAK[2]); px(22, 19, 0xc8a888)
  -- lantern
  hline(22, 19, 5, P.IRON_MD); px(24, 18, P.IRON_DK)
  rect(23, 20, 3, 4, f == 1 and 0xffd070 or P.FORGE_GLW)
  px(24, 21, 0xfff0b0); px(24, 22, f == 1 and 0xfff0b0 or 0xffe090)
  vline(22, 20, 4, P.IRON_DK); vline(26, 20, 4, P.IRON_DK)
  hline(22, 24, 5, P.IRON_MD)
  -- boots
  rect(12, 28, 3, 2, 0x1a1510); rect(17, 28, 3, 2, 0x1a1510)
end

-- ── Bountiful catch ────────────────────────────────────────────────────────────────────────

local FISH_RAMP = { back = 0x4a6a80, mid = 0x8aa4b8, lt = 0xc4d6e0, belly = 0xeef4f6, edge = 0x22384a }

-- Pixels of a fish centred (cx,cy) heading at `ang` (radians, +x = right, +y = down).
local function fishPixels(cx, cy, ang, len, thick)
  local ca, sa = math.cos(ang), math.sin(ang)
  local pts = {}
  local r = len * 1.6 + 2
  for yy = math.floor(cy - r), math.ceil(cy + r) do
    for xx = math.floor(cx - r), math.ceil(cx + r) do
      local dx, dy = xx + 0.5 - cx, yy + 0.5 - cy
      local u = dx * ca + dy * sa
      local v = -dx * sa + dy * ca
      local body = (u / len) ^ 2 + (v / thick) ^ 2 <= 1
      local tail = u < -len * 0.65 and u > -len * 1.55
        and math.abs(v) <= ((-u - len * 0.65) / (len * 0.9)) * thick * 1.5 + 0.4
      if body or tail then
        local c
        if tail then c = FISH_RAMP.back
        elseif v < -thick * 0.35 then c = FISH_RAMP.back
        elseif v > thick * 0.4 then c = FISH_RAMP.belly
        elseif u > len * 0.35 then c = FISH_RAMP.lt
        else c = FISH_RAMP.mid end
        if not tail and v < -thick * 0.1 and v > -thick * 0.5 and math.floor(u) % 3 == 0 then c = FISH_RAMP.mid end
        pts[#pts + 1] = { xx, yy, c }
      end
    end
  end
  return pts, cx + ca * len * 0.62 - sa * thick * -0.15, cy + sa * len * 0.62 + ca * thick * -0.15
end

local function drawFish(cx, cy, ang, len, thick)
  local pts, ex, ey = fishPixels(cx, cy, ang, len, thick)
  local set = {}
  for _, p in ipairs(pts) do set[p[1] * 100 + p[2]] = true end
  for _, p in ipairs(pts) do
    for _, d in ipairs({ { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) do
      local k = (p[1] + d[1]) * 100 + p[2] + d[2]
      if not set[k] then px(p[1] + d[1], p[2] + d[2], FISH_RAMP.edge) end
    end
  end
  for _, p in ipairs(pts) do px(p[1], p[2], p[3]) end
  px(ex, ey, 0x12202c)
end

local function ripple(cx, cy, rx, ry, a)
  for x = math.floor(cx - rx) - 1, math.ceil(cx + rx) + 1 do
    for y = math.floor(cy - ry) - 1, math.ceil(cy + ry) + 1 do
      local dx, dy = (x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry
      local d = dx * dx + dy * dy
      if d <= 1.15 and d >= 0.62 then
        px(x, y, (y + 0.5 < cy) and 0xe4f4fc or 0x7aa6c8, a)
      end
    end
  end
end

local function drop(x, y, a) px(x, y, 0xe4f4fc, a or 255); px(x, y + 1, 0x9cc4e0, (a or 255) // 2) end

local function fishJump(f)
  if f == 1 then
    ripple(10, 23, 4, 1.8, 170)
  elseif f == 2 then
    ripple(10, 23, 6, 2.5, 210); ripple(10, 23, 3, 1.3, 230)
    px(10, 21, 0x22384a); px(10, 22, 0x4a6a80); px(9, 22, 0x22384a); px(11, 22, 0x22384a)
  elseif f == 3 then
    ripple(10, 23, 7, 3, 150)
    drawFish(13, 16, -1.05, 5, 2.1)
    drop(9, 19); drop(11, 21); drop(16, 20)
  elseif f == 4 then
    drawFish(18, 9, 0.1, 5, 2.1)
    drop(12, 12, 230); drop(23, 12); drop(15, 15); drop(21, 16, 180)
  elseif f == 5 then
    drawFish(23, 15, 1.1, 5, 2.1)
    drop(19, 13, 220); drop(27, 18); drop(20, 19, 180)
  else
    ripple(24, 23, 9, 3.6, 140); ripple(24, 23, 5, 2.2, 220)
    -- splash crown
    for _, d in ipairs({ { -5, -3 }, { -3, -6 }, { 0, -7 }, { 3, -6 }, { 5, -3 }, { -1, -4 }, { 2, -4 } }) do
      drop(24 + d[1], 22 + d[2])
    end
    vline(24, 19, 3, 0xe4f4fc); vline(23, 20, 2, 0x9cc4e0, 220); vline(25, 20, 2, 0x9cc4e0, 220)
  end
end

local function fishCrate()
  box(5, 15, 22, 5, 10, P.TAN, P.LIGHT_WOOD, { rim = P.LINEN, base = P.DARK_WOOD })
  hline(6, 17, 20, P.LIGHT_WOOD)
  vline(5, 20, 10, P.MID_WOOD); vline(26, 20, 10, P.MID_WOOD)
  hline(6, 23, 20, P.MID_WOOD); hline(6, 26, 20, P.MID_WOOD)
  -- silver catch heaped over the rim, packed in ice
  rect(7, 12, 18, 4, 0xdcecf4); hline(7, 12, 18, 0xf4fafc)
  drawFish(11, 13, 0.3, 4.2, 1.8)
  drawFish(20, 12, -0.25, 4.2, 1.8)
  drawFish(15.5, 14.5, 3.3, 3.8, 1.7)
end

-- A net hung to dry between two stakes. The mesh is drawn at alpha 254 so the outline pass (which
-- only rings fully opaque pixels) leaves it as thin rope instead of a fuzzy black lattice.
local function netRack()
  local rope, ropeDk = 0xc8b078, 0x8a7448
  for _, x in ipairs({ 3, 27 }) do
    rect(x, 7, 2, 22, P.DARK_WOOD); vline(x, 7, 22, P.MID_WOOD)
    rect(x - 1, 27, 4, 3, P.STONE_MD); hline(x - 1, 27, 4, P.STONE_LT)
  end
  hline(4, 8, 24, ropeDk)
  for x = 5, 26 do
    local hem = 22 + math.floor(2.6 * math.sin(math.pi * (x - 5) / 21) + 0.5)
    for y = 9, hem do
      local a, b = (x + y) % 4, (x - y) % 4
      if a == 0 or b == 0 then px(x, y, ((x + y) % 8 == 0) and rope or ropeDk, 254) end
    end
    px(x, hem, ropeDk, 254)
  end
  -- floats along the top rope
  for _, x in ipairs({ 7, 12, 17, 22 }) do
    disc(x + 0.5, 8.5, 1.6, x % 2 == 0 and P.EMBER_MD or 0xe8e0d0)
  end
  -- a fish tangled in the net
  drawFish(16, 17, 0.2, 4.5, 1.8)
end

-- ── New arrival ────────────────────────────────────────────────────────────────────────────

local function spokes(cx, cy, f)
  if f == 1 then
    hline(cx - 3, cy, 7, 0xb07840); vline(cx, cy - 3, 7, 0xb07840)
  else
    for i = -2, 2 do px(cx + i, cy + i, 0xb07840); px(cx + i, cy - i, 0xb07840) end
  end
  px(cx, cy, P.GOLD)
end

local function wheel(cx, cy, f)
  for y = cy - 5, cy + 5 do
    for x = cx - 5, cx + 5 do
      local d = math.sqrt((x - cx) ^ 2 + (y - cy) ^ 2)
      if d <= 4.6 then
        if d >= 3.3 then px(x, y, (x < cx and y < cy) and P.LIGHT_WOOD or P.MID_WOOD)
        else px(x, y, 0x3a2818) end
      end
    end
  end
  spokes(cx, cy, f)
end

-- A hand cart heaped with the newcomer's belongings. Two frames: wheels a quarter turn apart and
-- the load a pixel higher, so a cart moving along the ground rattles.
local function cart(f)
  local bob = (f == 2) and 1 or 0
  -- shaft, pointing left (the direction it is pulled)
  hline(0, 21, 6, P.MID_WOOD); hline(0, 22, 6, P.DARK_WOOD)
  -- bed
  box(4, 18 + bob, 25, 2, 6, P.LIGHT_WOOD, P.MID_WOOD, { rim = P.TAN, base = P.DARK_WOOD, planks = 6, plankC = P.DARK_WOOD })
  -- load: a trunk with straps, a sack, a rolled blanket lashed on top
  local sackRamp = { 0x8a7448, 0xb89c60, 0xd8bc80, 0xe8d8a0 }
  box(6, 11 + bob, 10, 3, 6, 0x7a4a2a, 0x5a3418, { rim = 0x9a6438, base = 0x3a2010 })
  vline(9, 11 + bob, 9, P.GOLD); vline(13, 11 + bob, 9, P.GOLD); px(11, 15 + bob, 0xe8c050)
  lobe(23, 14 + bob, 5.6, 5, sackRamp)
  rect(21, 8 + bob, 4, 2, 0x6a5030); px(23, 7 + bob, 0x6a5030)
  rect(8, 8 + bob, 13, 3, P.FEST_RED); hline(8, 8 + bob, 13, 0xe06060)
  rect(7, 8 + bob, 1, 3, P.LINEN); rect(21, 8 + bob, 1, 3, P.LINEN)
  vline(12, 8 + bob, 3, P.RED_DK); vline(17, 8 + bob, 3, P.RED_DK)
  -- wheels
  wheel(10, 25, f); wheel(23, 25, f)
end

local function luggage()
  -- big trunk
  box(3, 19, 17, 3, 8, 0x7a4a2a, 0x5a3418, { rim = 0x9a6438, base = 0x3a2010 })
  vline(7, 19, 11, P.GOLD); vline(15, 19, 11, P.GOLD); rect(10, 23, 3, 2, 0xe8c050); px(11, 24, P.IRON_DK)
  -- small suitcase on top
  box(5, 11, 12, 3, 5, 0x3a7a78, 0x28565a, { rim = 0x5aa09c, base = 0x1a3a3a })
  rect(9, 9, 4, 2, P.IRON_MD); hline(9, 9, 4, P.IRON_LT)
  vline(7, 11, 8, 0xc8b078); vline(14, 11, 8, 0xc8b078)
  -- hat box, striped
  local cx = 25
  rect(cx - 5, 16, 11, 11, 0x3a4a78)
  rect(cx - 5, 20, 11, 3, P.CREAM)
  vline(cx + 5, 16, 11, 0x24304f)
  for x = cx - 6, cx + 6 do
    for y = 13, 19 do
      local dx, dy = (x + 0.5 - cx) / 6, (y + 0.5 - 15.5) / 2.6
      if dx * dx + dy * dy <= 1 then px(x, y, y < 15 and 0x5a70a8 or 0x3a4a78) end
    end
  end
  rect(cx - 5, 27, 11, 2, 0x24304f)
  hline(cx - 2, 12, 4, P.GOLD)
end

local function welcomeBanner(f)
  for _, x in ipairs({ 3, 28 }) do
    rect(x, 6, 2, 23, P.DARK_WOOD); vline(x, 6, 23, P.MID_WOOD)
    rect(x - 1, 27, 4, 3, P.STONE_MD); hline(x - 1, 27, 4, P.STONE_LT); hline(x - 1, 29, 4, P.STONE_DK)
    rect(x, 4, 2, 2, P.GOLD); px(x, 4, 0xe8c050)
  end
  for x = 5, 27 do
    local dy = math.floor(0.9 * math.sin(x * 0.5 + f * 2.6) + 0.5)
    local hem = 17 + dy
    for y = 7 + (dy > 0 and 1 or 0), hem do
      local c = P.LINEN
      if y <= 8 or y >= hem - 1 or x <= 6 or x >= 26 then c = (y >= hem - 1) and 0x24487a or 0x3a6ab0 end
      px(x, y, c)
    end
  end
  -- heart
  local heart = { ".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..." }
  for r, row in ipairs(heart) do
    for k = 1, 7 do
      if row:sub(k, k) == "X" then px(12 + k, 10 + r + (f == 2 and 0 or 0), (r == 1 and k <= 3) and 0xe06060 or P.FEST_RED) end
    end
  end
  -- ties at the posts
  px(5, 8, P.EMBER_MD); px(26, 8, P.EMBER_MD)
end

-- ── Heat: parasol, water barrel ────────────────────────────────────────────────────────────

local function parasol()
  rect(15, 11, 2, 18, P.MID_WOOD); vline(15, 11, 18, P.LIGHT_WOOD)
  rect(12, 27, 8, 3, P.STONE_MD); hline(12, 27, 8, P.STONE_LT); hline(12, 29, 8, P.STONE_DK)
  for x = 2, 29 do
    local dx = (x + 0.5 - 15.5) / 13.5
    if math.abs(dx) < 1 then
      local top = 10 - math.floor(7 * math.sqrt(1 - dx * dx))
      local seg = math.floor((dx + 1) * 3.5)
      local stripe = seg % 2 == 0
      for y = top, 10 do
        local c = stripe and P.FEST_RED or 0xf0e8d0
        if dx > 0.35 then c = stripe and 0x8a2a2a or 0xc8bea0 end
        px(x, y, c)
      end
      if (x % 4) < 2 then px(x, 11, stripe and 0x8a2a2a or 0xc8bea0) end
    end
  end
  hline(9, 4, 6, 0xffffff, 60)
  rect(15, 1, 2, 2, P.GOLD); px(15, 1, 0xe8c050)
end

local function waterBarrel()
  for y = 15, 28 do
    local t = (y - 15) / 13
    local half = 7 + 1.6 * math.sin(math.pi * t)
    for x = math.floor(15.5 - half), math.ceil(15.5 + half - 1) do
      local dx = (x + 0.5 - 15.5) / half
      local c = ((x - 6) % 4 == 0) and P.DARK_WOOD or P.MID_WOOD
      if dx < -0.5 then c = ((x - 6) % 4 == 0) and P.MID_WOOD or P.LIGHT_WOOD
      elseif dx > 0.55 then c = P.DARK_WOOD end
      px(x, y, c)
    end
  end
  for _, y in ipairs({ 18, 25 }) do
    local half = 7 + 1.6 * math.sin(math.pi * (y - 15) / 13)
    hline(math.floor(15.5 - half), y, math.ceil(half * 2), P.IRON_MD)
    hline(math.floor(15.5 - half), y, math.ceil(half * 2), P.IRON_LT, 90)
  end
  -- open top with the water showing
  for y = 10, 19 do
    for x = 5, 26 do
      local dx, dy = (x + 0.5 - 15.5) / 8.6, (y + 0.5 - 15) / 3.4
      local d = dx * dx + dy * dy
      if d <= 1 then
        if d > 0.66 then px(x, y, P.LIGHT_WOOD)
        else px(x, y, (x + y) % 7 == 0 and 0xa8d8f0 or 0x5a9cd0) end
      end
    end
  end
  px(13, 14, 0xe4f4fc); px(14, 14, 0xe4f4fc); px(18, 16, 0xa8d8f0)
  -- a tin cup on a hook
  rect(25, 19, 4, 4, 0xa8a8b0); hline(25, 19, 4, 0xd8d8e0); px(29, 20, 0xa8a8b0); px(29, 21, 0x706a60)
end

-- ── Falling particles: each cell is a small cluster that the renderer drifts down ──────────

local function petalFall()
  local cols = { 0xf4b8cc, 0xf8f0f0, P.PINK, 0xf4d8e0 }
  local spots = { { 6, 5 }, { 20, 3 }, { 12, 14 }, { 26, 12 }, { 8, 24 }, { 22, 23 } }
  for i, s in ipairs(spots) do
    local c = cols[(i % #cols) + 1]
    px(s[1], s[2], c); px(s[1] + 1, s[2], c); px(s[1] + 1, s[2] + 1, i % 2 == 0 and P.PINK_DK or c, 220)
  end
end

local function moteFall()
  local spots = { { 5, 6, 2 }, { 24, 4, 1 }, { 15, 13, 2 }, { 27, 17, 1 }, { 9, 22, 1 }, { 20, 27, 2 } }
  for _, s in ipairs(spots) do
    halo(s[1] + 0.5, s[2] + 0.5, s[3] + 3, 0xfff0b0, 90)
    px(s[1], s[2], 0xffffff)
    if s[3] == 2 then
      px(s[1] + 1, s[2], 0xfff0b0, 200); px(s[1] - 1, s[2], 0xfff0b0, 200)
      px(s[1], s[2] + 1, 0xfff0b0, 200); px(s[1], s[2] - 1, 0xfff0b0, 200)
    end
  end
end

local function leafFall()
  local cols = { 0xc25a1c, 0xe0a030, 0xa03a1c, 0xd8782c }
  local spots = { { 5, 6 }, { 21, 4 }, { 13, 15 }, { 26, 14 }, { 8, 25 }, { 19, 24 } }
  for i, s in ipairs(spots) do
    local c = cols[(i % #cols) + 1]
    px(s[1], s[2], c); px(s[1] + 1, s[2], c); px(s[1] + 2, s[2] + 1, c)
    px(s[1] + 1, s[2] + 1, 0x6a3a10); px(s[1] + 2, s[2], i % 2 == 0 and 0xf0c060 or c)
  end
end

local function confettiFall()
  local cols = { P.FEST_RED, P.FEST_YEL, P.FEST_BLU, P.FEST_GRN, 0xe89ab8 }
  seed = 33
  for i = 1, 11 do
    local x, y = 2 + math.floor(rand() * 27), 2 + math.floor(rand() * 27)
    local c = cols[(i % #cols) + 1]
    px(x, y, c); if rand() < 0.6 then px(x + 1, y, c) end
    if rand() < 0.25 then px(x, y + 1, c, 200) end
  end
end

local function paperFall()
  local spots = { { 4, 4, 5, 6 }, { 19, 8, 4, 5 }, { 9, 19, 5, 5 }, { 23, 22, 4, 4 } }
  for i, s in ipairs(spots) do
    local x, y, w, h = s[1], s[2], s[3], s[4]
    rect(x, y, w, h, i % 2 == 0 and 0xf0e0a0 or P.WHITE_LT)
    vline(x, y, h, 0xb8b0a0, 200)
    hline(x + 1, y + 1, w - 2, 0x8a8474); hline(x + 1, y + 3, w - 2, 0x8a8474)
    if i == 3 then px(x + 4, y + h - 1, 0xb8b0a0) end
    px(x + w - 1, y, 0xd8d0c0)
  end
end

local function heatHaze()
  -- wavy warm streaks, faint enough to read as air rather than an object
  seed = 77
  for k, y in ipairs({ 6, 12, 18, 24 }) do
    local x0 = 3 + math.floor(rand() * 6)
    local len = 16 + math.floor(rand() * 8)
    for x = x0, x0 + len do
      local yy = y + math.floor(1.4 * math.sin((x + k * 3) * 0.55) + 0.5)
      local edge = math.min(x - x0, x0 + len - x)
      px(x, yy, 0xfff0c0, math.min(84, 22 + edge * 16))
    end
  end
end

-- ── Full moon: fireflies and an owl ────────────────────────────────────────────────────────

local function fireflies(f)
  local spots = { { 6, 9 }, { 17, 5 }, { 25, 14 }, { 11, 21 }, { 22, 26 } }
  for i, s in ipairs(spots) do
    local lit = (i + f) % 3
    local x, y = s[1], s[2]
    if lit == 0 then
      halo(x + 0.5, y + 0.5, 6, 0xd8ff70, 150)
      px(x, y, 0xffffe0); px(x + 1, y, 0xe8ff90); px(x, y + 1, 0xe8ff90)
    elseif lit == 1 then
      halo(x + 0.5, y + 0.5, 3.5, 0xd8ff70, 80)
      px(x, y, 0xc8e860)
    else
      px(x, y, 0x6a8a30, 160)
    end
  end
end

local OWL = { 0x3a2c20, 0x5a4630, 0x7a6444, 0x9a8460 }
local function owlPost(f)
  -- a fence post, weathered
  rect(12, 16, 8, 13, P.DARK_WOOD)
  vline(12, 16, 13, P.MID_WOOD); vline(13, 16, 13, P.LIGHT_WOOD); vline(19, 16, 13, 0x2e1c10)
  hline(12, 16, 8, P.TAN); px(14, 22, 0x6a8a30); px(15, 22, 0x4a6a20); px(13, 23, 0x4a6a20)
  -- body
  lobe(16, 11.5, 5.4, 6.2, OWL)
  for _, p in ipairs({ { 14, 13 }, { 17, 13 }, { 15, 15 }, { 18, 15 }, { 13, 15 } }) do
    px(p[1], p[2], 0xc8b890); px(p[1] + 1, p[2] + 1, 0xa89870)
  end
  -- ear tufts
  px(11, 5, OWL[1]); px(12, 5, OWL[2]); px(12, 6, OWL[2]); px(20, 5, OWL[1]); px(19, 5, OWL[2]); px(19, 6, OWL[2])
  -- face disc and eyes
  if f == 4 then
    hline(12, 9, 3, OWL[1]); hline(17, 9, 3, OWL[1])
  else
    local look = (f == 2) and -1 or ((f == 3) and 1 or 0)
    for _, ex in ipairs({ 13.5, 18.5 }) do
      disc(ex, 9.5, 2.5, 0xe8dcc0)
      disc(ex + look * 0.4, 9.5, 1.7, 0xe0b830)
      px(ex - 0.5 + look, 9, 0x10080a); px(ex - 0.5 + look, 10, 0x10080a)
      px(ex + 0.5 + look, 9, 0x10080a); px(ex + 0.5 + look, 10, 0x10080a)
      px(ex - 1 + look, 8, 0xffffff)
    end
  end
  px(15, 11, 0xd8802a); px(16, 11, 0xd8802a); px(15, 12, 0xa85a18)
  -- talons over the post edge
  px(13, 17, 0xd8a040); px(15, 17, 0xd8a040); px(17, 17, 0xd8a040); px(19, 17, 0xd8a040)
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
addN("stranger", 2, stranger, { mode = "ground", ground = ground(16, 8) })
add("fish_crate", fishCrate, { mode = "push" })
add("net_rack", netRack, { mode = "ground", ground = ground(15, 13) })
addN("fish_jump", 6, fishJump, FX)
addN("cart", 2, cart, { mode = "push" })
add("luggage", luggage, { mode = "push" })
addN("welcome", 2, welcomeBanner, { mode = "ground", ground = ground(16, 13) })
add("parasol", parasol, { mode = "ground", ground = ground(16, 12) })
add("water_barrel", waterBarrel, { mode = "push" })
add("petal_fall", petalFall, FX)
add("mote_fall", moteFall, FX)
add("leaf_fall", leafFall, FX)
add("confetti_fall", confettiFall, FX)
add("paper_fall", paperFall, FX)
add("heat_haze", heatHaze, FX)
addN("firefly", 3, fireflies, FX)
addN("owl", 4, owlPost, { mode = "ground", ground = ground(16, 7) })

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
