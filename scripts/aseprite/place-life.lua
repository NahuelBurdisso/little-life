-- place-life.lua — art for places that react to what happens in them: forge sparks, chatter
-- puffs and music notes, OPEN/CLOSED signs, the town hall flag and bell, prison window hands,
-- chickens, field dust, laundry, soft glows, and the four seasons of the farm's crop rows.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/fx --script-param tiles=public/sprites/tiles \
--     --script scripts/aseprite/place-life.lua
--
-- Writes three strips:
--   place.png       16x16 cells, order below   (dir)     — keep in sync with PLACE_FRAMES in
--                   src/components/canvas/systems/placeLife/placeFrames.ts
--   place-glow.png  32x32 white glows, tinted and blended additively at runtime (dir)
--   crops.png       32x32 crop-row tiles, 3 growth stages per season (tiles) — keep in sync
--                   with CROP_STAGE_COUNT in src/components/canvas/crops.ts
-- plus the matching .aseprite sources (one frame per cell).
--
--   place.png:  0-2 spark (hot, mid, ember)   3-4 note (single, beamed)   5-6 chatter puff
--   7-8 OPEN sign (swing A, B)   9-10 CLOSED sign   11 flag hanging   12-14 flag waving
--   15-16 flag in a gust   17-19 bell (rest, swung left, swung right)   20-21 hands on window
--   bars   22 chicken standing   23 pecking   24-25 walking   26-28 dust puff   29-30 laundry
--
-- Everything faces right (the renderer mirrors). Palette is the art bible's, as in
-- event-decor.lua: 1px #1a1510 outline on solid objects; FX (sparks, dust, glows) carry none.
-- Solid frames are character grids; the palette key sits in PAL below. Deterministic: the
-- little randomness in the crop rows is seeded, so re-running reproduces the files.

local S = 16
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end
local OUTLINE = hex(0x1a1510)

local PAL = {
  k = OUTLINE,
  -- linen / white
  w = hex(0xe8d5a3), W = hex(0xf0ece0), L = hex(0xcfc8b0),
  -- wood
  t = hex(0xd4a870), T = hex(0xb07840), m = hex(0x7a5030), d = hex(0x4a3020),
  -- reds, greens, gold
  r = hex(0x8a2a2a), R = hex(0xc04040), q = hex(0x5a1a1a),
  g = hex(0x4a8a52), G = hex(0x2a4020), l = hex(0x6a9848), j = hex(0x3a6a38),
  y = hex(0xe0b830), a = hex(0xc09020), A = hex(0x8a6418),
  -- fire
  o = hex(0xf07020), O = hex(0xc04010), e = hex(0x6a1800), f = hex(0xffb040), h = hex(0xfff0b0),
  -- stone / iron
  s = hex(0x8a8878), S = hex(0x5a5850), i = hex(0x484442), I = hex(0x706a60), z = hex(0x2a2828),
  -- blues
  b = hex(0x3a6ab0), B = hex(0x1a2840), n = hex(0x2a4870),
  -- skin
  p = hex(0xe0b090), P = hex(0xb88060),
  -- dust (semi transparent)
  u = hex(0xb8a888, 190), U = hex(0xd8cbb0, 200),
  -- chicken legs
  c = hex(0xd8842c),
}

-- Draws a character grid at an offset. Rows may be shorter than S (padded with '.') and there
-- may be fewer than S rows (the rest is empty), so small sprites are written at their own size.
local function grid(img, rows, ox, oy)
  for ry = 1, #rows do
    local row = rows[ry]
    for rx = 1, #row do
      local ch = row:sub(rx, rx)
      if ch ~= "." then
        assert(PAL[ch], "unknown palette key '" .. ch .. "'")
        local x, y = ox + rx - 1, oy + ry - 1
        if x >= 0 and y >= 0 and x < img.width and y < img.height then img:drawPixel(x, y, PAL[ch]) end
      end
    end
  end
end

local function newImg(size)
  local img = Image(size or S, size or S, ColorMode.RGB)
  img:clear(0)
  return img
end

local function put(img, x, y, c, a)
  if x >= 0 and y >= 0 and x < img.width and y < img.height then img:drawPixel(x, y, hex(c, a)) end
end

-- 1px outline around every opaque pixel, on empty neighbours only.
local function outline(img)
  local w, h = img.width, img.height
  local mark = {}
  local function opaque(x, y)
    if x < 0 or y < 0 or x >= w or y >= h then return false end
    return pc.rgbaA(img:getPixel(x, y)) > 128
  end
  for y = 0, h - 1 do
    for x = 0, w - 1 do
      if not opaque(x, y) and (opaque(x - 1, y) or opaque(x + 1, y) or opaque(x, y - 1) or opaque(x, y + 1)) then
        mark[#mark + 1] = { x, y }
      end
    end
  end
  for _, m in ipairs(mark) do img:drawPixel(m[1], m[2], OUTLINE) end
end

local cells = {}
local function add(tag, img) cells[#cells + 1] = { tag, img } end

-- ── Sparks (FX: no outline) ─────────────────────────────────────────────────────────────

do
  local hot = newImg()
  for _, p in ipairs({ { 7, 7 }, { 8, 7 }, { 7, 8 }, { 8, 8 } }) do put(hot, p[1], p[2], 0xfff0b0) end
  for _, p in ipairs({ { 6, 7 }, { 6, 8 }, { 9, 7 }, { 9, 8 }, { 7, 6 }, { 8, 6 }, { 7, 9 }, { 8, 9 } }) do
    put(hot, p[1], p[2], 0xffb040)
  end
  add("spark", hot)
  local mid = newImg()
  put(mid, 7, 7, 0xf07020); put(mid, 8, 7, 0xf07020); put(mid, 7, 8, 0xf07020); put(mid, 8, 8, 0xc04010)
  add("spark", mid)
  local ember = newImg()
  put(ember, 7, 7, 0xc04010); put(ember, 8, 7, 0x6a1800); put(ember, 7, 8, 0x6a1800)
  add("spark", ember)
end

-- ── Music notes ─────────────────────────────────────────────────────────────────────────

do
  local n1 = newImg()
  grid(n1, {
    "...ww...",
    "...w.ww.",
    "...w..ww",
    "...w...w",
    "...w....",
    "...w....",
    "...w....",
    ".www....",
    "wwww....",
    "wwww....",
    ".ww.....",
  }, 4, 2)
  outline(n1)
  add("note", n1)

  local n2 = newImg()
  grid(n2, {
    "..wwwwwww",
    "..wwwwwww",
    "..w.....w",
    "..w.....w",
    "..w.....w",
    "..w.....w",
    "..w.....w",
    ".ww....ww",
    "www...www",
    "www...www",
    ".w.....w.",
  }, 3, 2)
  outline(n2)
  add("note", n2)
end

-- ── Chatter puff: a little speech cloud with three dots that hop ─────────────────────────

do
  local function puff(big)
    local img = newImg()
    grid(img, {
      "..wwwwwwww..",
      ".wwwwwwwwww.",
      "wwwwwwwwwwww",
      "wwwwwwwwwwww",
      "wwwwwwwwwwww",
      ".wwwwwwwwww.",
      "..wwwwwwww..",
      "...ww.......",
    }, 2, 4)
    -- dots at x = 4, 7, 10 (2x2); the raised one hops a row up
    for i = 0, 2 do
      local x = 4 + i * 3
      local y = (i == big) and 6 or 7
      for dyy = 0, 1 do for dxx = 0, 1 do put(img, x + dxx, y + dyy, 0x7a5030) end end
    end
    outline(img)
    return img
  end
  add("puff", puff(0))
  add("puff", puff(2))
end

-- ── OPEN / CLOSED hanging sign ──────────────────────────────────────────────────────────
-- Bracket arm on top, two chains, a board. `shear` swings the lower part a pixel either way,
-- which is all the animation a 12px sign needs.

local function sign(open, shear)
  local img = newImg()
  -- bracket arm with its wall plate
  grid(img, { "mddddddddddddm" }, 2, 3)
  -- chains
  put(img, 4, 5, 0x706a60); put(img, 13, 5, 0x706a60)
  put(img, 4 + shear, 6, 0x706a60); put(img, 13 + shear, 6, 0x706a60)
  local board
  if open then
    board = {
      "wwwwwwwwww",
      "wgggggggWw",
      "wggWgggWgw",
      "wgggWgWggw",
      "wggggWgggw",
      "wwwwwwwwww",
    }
  else
    board = {
      "wwwwwwwwww",
      "wRRRRRRRRw",
      "wRwwwwwwRw",
      "wRwwwwwwRw",
      "wRRRRRRRRw",
      "wwwwwwwwww",
    }
  end
  grid(img, board, 4 + shear, 7)
  outline(img)
  return img
end

add("sign_open", sign(true, -1))
add("sign_open", sign(true, 1))
add("sign_closed", sign(false, -1))
add("sign_closed", sign(false, 1))

-- ── Flag on a pole (town hall roof) ─────────────────────────────────────────────────────

local function flag(cloth)
  local img = newImg()
  grid(img, { "a", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d" }, 3, 1)
  grid(img, { "SSS", "SSSSS" }, 2, 13)
  grid(img, cloth, 4, 2)
  outline(img)
  return img
end

add("flag", flag({ "bbb", "bbb", "yyy", "bbb", "nnn" }))                         -- hanging
add("flag", flag({ "bbbbbbb", "bbbbbbbb", "yyyyyyy", "bbbbbbb", "nnnnn" }))      -- wave A
add("flag", flag({ "bbbbbb", "bbbbbbb", "yyyyyyyy", "bbbbbbbb", "nnnnnn" }))     -- wave B
add("flag", flag({ "bbbbbbbb", "bbbbbbb", "yyyyyy", "bbbbbbb", "nnnnnnn" }))     -- wave C
add("flag", flag({ "bbbbbbbbbbb", "yyyyyyyyyyy", "bbbbbbbbbb", "nnnnnnnnn" }))   -- gust A
add("flag", flag({ "bbbbbbbbbb", "yyyyyyyyyy", "bbbbbbbbbbb", "nnnnnnnnnn" }))   -- gust B

-- ── Bell on a little gallows ────────────────────────────────────────────────────────────

local function bell(dx, ting)
  local img = newImg()
  -- gallows: post, arm, brace
  grid(img, { "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d" }, 1, 1)
  grid(img, { "ddddddddddd" }, 1, 1)
  grid(img, { "SSS", "SSSSS" }, 0, 13)
  -- bell hangs from the arm; `dx` swings it
  grid(img, {
    "..aa..",
    ".aaaa.",
    ".aaAa.",
    "aaaaaa",
    "aaaaaa",
    "AAAAAA",
    "..yy..",
  }, 5 + dx, 2)
  outline(img)
  if ting then
    -- little strike marks on the side the bell swung towards
    local side = (dx > 0) and 1 or -1
    local bx = (dx > 0) and 14 or 1
    put(img, bx, 5, 0xf0ece0); put(img, bx + side, 4, 0xf0ece0); put(img, bx + side, 7, 0xf0ece0)
  end
  return img
end

add("bell", bell(0, false))
add("bell", bell(-2, true))
add("bell", bell(2, true))

-- ── Hands on window bars (prison) — drawn over a 10x8 window centred in the cell ────────

local function bars(hy)
  local img = newImg()
  -- the window rect the renderer drew is cols 3..12, rows 4..11; light inside 4..11 x 5..10
  for _, bx in ipairs({ 5, 8, 11 }) do
    for y = 5, 10 do put(img, bx, y, 0x2a2828) end
  end
  -- fingers wrapped round the outer bars, thumbs behind
  for _, bx in ipairs({ 5, 11 }) do
    for dxx = -1, 1 do put(img, bx + dxx, hy, 0xe0b090) end
    put(img, bx - 1, hy + 1, 0xb88060); put(img, bx, hy + 1, 0xe0b090); put(img, bx + 1, hy + 1, 0xb88060)
  end
  return img
end

add("hands", bars(7))
add("hands", bars(6))

-- ── Chicken ─────────────────────────────────────────────────────────────────────────────

local chick = {}
chick.stand = {
  ".......r....",
  "......rWW...",
  "......WkWy..",
  "......WWW...",
  "..W..WWWW...",
  "..WW.WWWWW..",
  ".WWWWWWWWW..",
  ".WWLWWWWLW..",
  "..WWWWWWL...",
  "...LWWWL....",
  ".....c.c....",
  ".....c.c....",
}
chick.peck = {
  "............",
  "............",
  "..W.........",
  "..WW.WWW....",
  ".WWWWWWWW...",
  ".WWLWWWWLW..",
  "..WWWWWWWWr.",
  "...LWWWLWkWy",
  ".....c.c.WW.",
  ".....c.c....",
  "............",
  "............",
}
chick.walkA = {
  ".......r....",
  "......rWW...",
  "......WkWy..",
  "......WWW...",
  "..W..WWWW...",
  "..WW.WWWWW..",
  ".WWWWWWWWW..",
  ".WWLWWWWLW..",
  "..WWWWWWL...",
  "...LWWWL....",
  "....c...c...",
  "...c.....c..",
}
chick.walkB = {
  ".......r....",
  "......rWW...",
  "......WkWy..",
  "......WWW...",
  "..W..WWWW...",
  "..WW.WWWWW..",
  ".WWWWWWWWW..",
  ".WWLWWWWLW..",
  "..WWWWWWL...",
  "...LWWWL....",
  ".....cc.....",
  ".....cc.....",
}
for _, key in ipairs({ "stand", "peck", "walkA", "walkB" }) do
  local img = newImg()
  grid(img, chick[key], 2, 3)
  outline(img)
  add("chicken", img)
end

-- ── Dust puff (FX) ──────────────────────────────────────────────────────────────────────

do
  local a = newImg()
  grid(a, { ".UU.", "UuuU", "UuuU", ".UU." }, 6, 10)
  add("dust", a)
  local b = newImg()
  grid(b, { "..UUUU..", ".UuuuuU.", "UuuUUuuU", "UuuUUuuU", ".UuuuuU.", "..UUUU.." }, 4, 8)
  add("dust", b)
  local c = newImg()
  grid(c, { "..U..UU..", ".U.....U.", "U.......U", "U.......U", ".U.....U.", "..UU.UU.." }, 3, 7)
  add("dust", c)
end

-- ── Laundry line ────────────────────────────────────────────────────────────────────────

local function laundry(sway)
  local img = newImg()
  -- two short posts
  grid(img, { "d", "m", "m", "m", "m", "m", "m", "m", "m", "d" }, 1, 5)
  grid(img, { "d", "m", "m", "m", "m", "m", "m", "m", "m", "d" }, 14, 5)
  -- garments: a shirt and a towel, swaying a pixel in the breeze
  grid(img, { "bbbbb", "bbbbb", ".bbb.", ".bbb.", ".nnn." }, 3, 6)
  grid(img, { "www", "www", "www", "www", "LLL" }, 9 + sway, 6)
  outline(img)
  -- the line itself goes on after the outline, or it would be three pixels thick
  for x = 2, 13 do put(img, x, (x > 4 and x < 11) and 6 or 5, 0x9a9484) end
  return img
end

add("laundry", laundry(0))
add("laundry", laundry(1))

-- ── Write place.png ─────────────────────────────────────────────────────────────────────

local dir = app.params.dir or "public/sprites/fx"
local tilesDir = app.params.tiles or "public/sprites/tiles"
app.fs.makeAllDirectories(dir)
app.fs.makeAllDirectories(tilesDir)

local function writeStrip(name, size, list, folder)
  local spr = Sprite(size, size, ColorMode.RGB)
  spr.filename = name
  for i = 2, #list do spr:newEmptyFrame() end
  for i, c in ipairs(list) do spr:newCel(spr.layers[1], spr.frames[i], c[2], Point(0, 0)) end
  local from = 1
  for i = 1, #list do
    if i == #list or list[i + 1][1] ~= list[i][1] then
      local tag = spr:newTag(from, i); tag.name = list[i][1]
      from = i + 1
    end
  end
  spr:saveAs(app.fs.joinPath(folder, name .. ".aseprite"))
  spr:close()
  local strip = Image(size * #list, size, ColorMode.RGB)
  strip:clear(0)
  for i, c in ipairs(list) do strip:drawImage(c[2], Point((i - 1) * size, 0)) end
  strip:saveAs(app.fs.joinPath(folder, name .. ".png"))
end

writeStrip("place", S, cells, dir)
print(#cells .. " place frames")

-- ── Glows: white, dithered, tinted and added at runtime ─────────────────────────────────

local G = 32
local BAYER = { { 0, 8, 2, 10 }, { 12, 4, 14, 6 }, { 3, 11, 1, 9 }, { 15, 7, 13, 5 } }

local function glow(shape)
  local img = newImg(G)
  local steps = 5
  for y = 0, G - 1 do
    for x = 0, G - 1 do
      local dx, dy = x + 0.5 - G / 2, y + 0.5 - G / 2
      local f
      if shape == "round" then
        f = 1 - math.sqrt(dx * dx + dy * dy) / (G / 2)
        f = f > 0 and f ^ 1.5 or 0
      elseif shape == "wide" then
        f = 1 - math.sqrt((dx / 15.5) ^ 2 + (dy / 8.5) ^ 2)
        f = f > 0 and f ^ 1.3 or 0
      else -- cross
        local a = math.exp(-((dx * dx) / (2 * 1.8 * 1.8) + (dy * dy) / (2 * 11 * 11)))
        local b = math.exp(-((dy * dy) / (2 * 1.8 * 1.8) + (dx * dx) / (2 * 11 * 11)))
        local halo = 1 - math.sqrt(dx * dx + dy * dy) / 13
        f = math.max(a, b) * 0.9 + (halo > 0 and halo ^ 2 * 0.35 or 0)
      end
      f = math.min(f, 1)
      local t = (BAYER[(y % 4) + 1][(x % 4) + 1] + 0.5) / 16
      local level = math.floor(f * steps + t)
      if level > steps then level = steps end
      if level > 0 then img:drawPixel(x, y, pc.rgba(255, 255, 255, math.floor(level / steps * 235))) end
    end
  end
  return img
end

writeStrip("place-glow", G, { { "glow", glow("round") }, { "glow", glow("cross") }, { "glow", glow("wide") } }, dir)
print("3 glows")

-- ── Crop rows: 3 growth stages for each season ──────────────────────────────────────────
-- Same rhythm as the summer tile they replace: four furrow bands of 8px, a plant every 8px on
-- the ridge. Opaque soil, muted so the farmers keep the contrast (art bible: terrain recedes).

local seed = 7
local function rand()
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
end

local SOIL_DK, SOIL_MD, SOIL_LT = 0x46352a, 0x5e4630, 0x74593a
local T32 = 32

local function soil(img, snowPatches)
  for band = 0, 3 do
    local y0 = band * 8
    for y = 0, 7 do
      local c
      if y == 0 or y == 7 then c = SOIL_DK
      elseif y == 1 then c = SOIL_MD
      elseif y == 2 then c = SOIL_LT
      else c = SOIL_MD end
      for x = 0, T32 - 1 do put(img, x, y0 + y, c) end
    end
  end
  -- clods and pebbles, so the rows are not printed
  for _ = 1, 26 do
    local x, y = math.floor(rand() * T32), math.floor(rand() * T32)
    put(img, x, y, rand() < 0.5 and 0x3a2c22 or 0x86694a)
  end
end

local PLANT_XS = { 3, 11, 19, 27 }

-- `draw(img, cx, ridgeY, i)` paints one plant; ridgeY is the middle of a band's ridge
local function field(draw)
  local img = newImg(T32)
  soil(img)
  for band = 0, 3 do
    for i, cx in ipairs(PLANT_XS) do draw(img, cx, band * 8 + 4, band * 4 + i) end
  end
  return img
end

local function sprout(img, x, y, big)
  put(img, x, y, 0x4a6830)
  put(img, x, y - 1, 0x6a9848)
  put(img, x - 1, y - 2, 0x6a9848); put(img, x + 1, y - 2, 0x6a9848)
  if big then put(img, x - 1, y - 3, 0x8ab860); put(img, x + 1, y - 3, 0x8ab860) end
end

local function leafy(img, x, y, r, dark, mid, light)
  for dy = -r, 0 do
    local half = r + (dy == -r and -1 or 0)
    for dxx = -half, half do
      put(img, x + dxx, y + dy - 1, (dxx + dy) % 3 == 0 and mid or dark)
    end
  end
  put(img, x - 1, y - r - 1, light); put(img, x, y - r, light); put(img, x + 1, y - r - 1, mid)
  put(img, x - r + 1, y - 2, light)
end

local stages = {}

-- spring: bare tilled rows with a few early sprouts, then sprouts, then seedlings
stages[1] = field(function(img, x, y, i) if i % 3 == 0 then put(img, x, y - 1, 0x6a9848); put(img, x, y, 0x4a6830) end end)
stages[2] = field(function(img, x, y) sprout(img, x, y, false) end)
stages[3] = field(function(img, x, y, i) sprout(img, x, y, true); put(img, x - 2, y - 1, 0x4a6830); put(img, x + 2, y - 1, 0x4a6830) end)
-- summer: growing, lush, in flower
stages[4] = field(function(img, x, y) leafy(img, x, y, 2, 0x2f5a30, 0x4a8a3a, 0x7ab85a) end)
stages[5] = field(function(img, x, y) leafy(img, x, y, 3, 0x2a5030, 0x4a8a3a, 0x86c464) end)
stages[6] = field(function(img, x, y, i)
  leafy(img, x, y, 3, 0x2a5030, 0x4a8a3a, 0x86c464)
  put(img, x - 1, y - 3, (i % 2 == 0) and 0xe0b830 or 0xe89ab8)
  put(img, x + 2, y - 2, 0xf0ece0)
end)
-- autumn: turning, ripe gold, then stubble
stages[7] = field(function(img, x, y) leafy(img, x, y, 3, 0x6a7a28, 0xa8a838, 0xd8c460) end)
stages[8] = field(function(img, x, y, i)
  leafy(img, x, y, 3, 0x9a6a20, 0xd4a03a, 0xf0d06a)
  for k = -2, 2, 2 do put(img, x + k, y - 5, 0xf0d06a); put(img, x + k, y - 4, 0xd4a03a) end
end)
stages[9] = field(function(img, x, y, i)
  -- stubble: short straw stalks, an odd pumpkin left behind
  put(img, x - 1, y - 1, 0xb89a4a); put(img, x + 1, y, 0xb89a4a); put(img, x, y - 2, 0x8a6f30)
  if i == 6 or i == 13 then
    put(img, x, y - 1, 0xd8842c); put(img, x + 1, y - 1, 0xd8842c); put(img, x, y, 0xc04010); put(img, x + 1, y, 0xc04010)
    put(img, x, y - 2, 0x4a6830)
  end
end)
-- winter: frosted bare rows, patchy snow, snowed under
stages[10] = field(function(img, x, y, i)
  if i % 2 == 0 then put(img, x, y - 1, 0xdfe8ee); put(img, x + 1, y, 0xb8c8d8) end
  put(img, x - 1, y - 2, 0xb8c8d8)
end)
stages[11] = field(function(img, x, y, i)
  for k = -3, 3 do
    if (k + i) % 4 ~= 0 then put(img, x + k, y - 1, 0xe0eaf0); put(img, x + k, y - 2, 0xf0f6fa) end
  end
  put(img, x, y, 0xb8c8d8)
end)
stages[12] = field(function(img, x, y)
  for k = -4, 4 do
    put(img, x + k, y - 2, 0xf0f6fa); put(img, x + k, y - 1, 0xe0eaf0)
    if math.abs(k) < 4 then put(img, x + k, y, 0xc8d8e4) end
  end
  put(img, x - 1, y - 3, 0xf0f6fa); put(img, x, y - 3, 0xf0f6fa); put(img, x + 1, y - 3, 0xf0f6fa)
end)

local cropCells = {}
for i, im in ipairs(stages) do cropCells[i] = { "crops", im } end
writeStrip("crops", T32, cropCells, tilesDir)
print(#cropCells .. " crop tiles")
