-- nature-props.lua — trees, bushes, rocks and flowers for TilemapRenderer's prop pass.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/props --script scripts/aseprite/nature-props.lua
--
-- Writes props.aseprite (one frame per prop, tagged by kind) and props.png, a strip of 32x32
-- cells. Cell order — keep in sync with PROP_FRAMES in src/components/canvas/propFrames.ts:
--
--   0-3 tree (oak, round, fruit, pine)   4-6 bush (plain, berry, flowering)
--   7-8 rock (boulder, stones)           9-11 flowers (pink, yellow, white)
--
-- Shapes are unions of ellipses shaded per pixel: light comes from the upper left (matching
-- the drop shadows cast down-right everywhere else), so each pixel's tone follows how far it
-- sits toward the lit side of its own lobe. Outlines are a dark green/brown rather than the
-- agents' near-black #1a1510 — the art bible keeps terrain as background, and props with hard
-- black outlines competed with the residents for attention.
--
-- Roots/contact points sit at y≈28 so the renderer can place a cell at its tile's top-left.

local S = 32
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end

local seed = 7
local function rand()
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
end

-- ── Shape helpers ───────────────────────────────────────────────────────────────────────────

-- A mask is a table of lobes {cx, cy, rx, ry}; a pixel is inside if it is inside any lobe.
local function lobeAt(lobes, x, y)
  local best, bestD = nil, 99
  for _, l in ipairs(lobes) do
    local dx, dy = (x + 0.5 - l[1]) / l[3], (y + 0.5 - l[2]) / l[4]
    local d = dx * dx + dy * dy
    if d <= 1 and d < bestD then best, bestD = l, d end
  end
  return best
end

-- Shade a union of lobes with a 4-tone ramp {dark, mid, light, highlight} plus outline.
-- `texture` adds leafy speckle: that fraction of pixels is nudged one tone down.
local function paintLobes(img, lobes, ramp, outline, texture)
  local inside = {}
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local l = lobeAt(lobes, x, y)
      if l then
        inside[y * S + x] = true
        -- Position within the lobe, light from the upper left.
        local nx, ny = (x + 0.5 - l[1]) / l[3], (y + 0.5 - l[2]) / l[4]
        local lit = -(nx * 0.6 + ny * 0.8)             -- 1 = facing the light
        local t = lit > 0.45 and 4 or lit > 0.05 and 3 or lit > -0.45 and 2 or 1
        if texture and rand() < texture and t > 1 then t = t - 1 end
        img:drawPixel(x, y, ramp[t])
      end
    end
  end
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      if inside[y * S + x] then
        local edge = not inside[(y - 1) * S + x] or not inside[(y + 1) * S + x]
                  or not inside[y * S + x - 1] or not inside[y * S + x + 1]
        if edge then img:drawPixel(x, y, outline) end
      end
    end
  end
end

local function shadow(img, cx, cy, rx, ry)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local dx, dy = (x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry
      if dx * dx + dy * dy <= 1 and pc.rgbaA(img:getPixel(x, y)) == 0 then
        img:drawPixel(x, y, hex(0x1a2412, 80))
      end
    end
  end
end

local function trunk(img, cx, top, bottom, w)
  for y = top, bottom do
    for x = cx - w // 2, cx - w // 2 + w - 1 do
      local c = 0x4a3520
      if x == cx - w // 2 then c = 0x2e2012
      elseif x == cx - w // 2 + w - 1 then c = 0x3a2818
      elseif x == cx - w // 2 + 1 then c = 0x6a4a2a end
      img:drawPixel(x, y, hex(c))
    end
  end
  -- Root flare.
  img:drawPixel(cx - w // 2 - 1, bottom, hex(0x2e2012))
  img:drawPixel(cx - w // 2 + w, bottom, hex(0x2e2012))
end

local function dots(img, lobes, n, colors)
  local placed = 0
  for _ = 1, 400 do
    if placed >= n then break end
    local x, y = math.floor(rand() * S), math.floor(rand() * S)
    local l = lobeAt(lobes, x, y)
    -- Inside, and at least a pixel away from the outline.
    if l and lobeAt(lobes, x - 1, y) and lobeAt(lobes, x + 1, y)
       and lobeAt(lobes, x, y - 1) and lobeAt(lobes, x, y + 1) then
      local c = colors[1 + placed % #colors]
      img:drawPixel(x, y, hex(c))
      placed = placed + 1
    end
  end
end

-- ── Palettes ────────────────────────────────────────────────────────────────────────────────

local LEAF = { hex(0x24391a), hex(0x2f4a22), hex(0x3f6330), hex(0x5a8240) }
local LEAF_OUT = hex(0x16220f)
local PINE = { hex(0x16301f), hex(0x1f3e29), hex(0x2d5436), hex(0x437149) }
local PINE_OUT = hex(0x0f1e14)
local ROCK = { hex(0x4a463e), hex(0x6b6459), hex(0x8b8377), hex(0xaaa294) }
local ROCK_OUT = hex(0x2e2b26)

-- ── Props ───────────────────────────────────────────────────────────────────────────────────

local function blank() local i = Image(S, S, ColorMode.RGB); i:clear(0); return i end

local function oak()
  local img = blank()
  shadow(img, 18, 28, 10, 3)
  trunk(img, 16, 17, 28, 4)
  local lobes = { { 10, 13, 7, 6 }, { 22, 13, 7, 6 }, { 16, 9, 8, 7 }, { 16, 16, 8, 5 } }
  paintLobes(img, lobes, LEAF, LEAF_OUT, 0.18)
  return img
end

local function round()
  local img = blank()
  shadow(img, 17, 28, 8, 3)
  trunk(img, 16, 19, 28, 3)
  local lobes = { { 16, 12, 9, 9 }, { 11, 17, 4, 3 }, { 21, 17, 4, 3 } }
  paintLobes(img, lobes, LEAF, LEAF_OUT, 0.14)
  return img
end

local function fruit()
  local img = blank()
  shadow(img, 18, 28, 10, 3)
  trunk(img, 16, 18, 28, 4)
  local lobes = { { 11, 14, 6, 5 }, { 21, 14, 6, 5 }, { 16, 10, 8, 6 } }
  paintLobes(img, lobes, LEAF, LEAF_OUT, 0.16)
  dots(img, lobes, 7, { 0xc0402a, 0xd86a2a })
  return img
end

local function pine()
  local img = blank()
  shadow(img, 17, 28, 7, 2)
  trunk(img, 16, 23, 28, 3)
  -- Tiers are narrow ellipses stacked upward; each tier's bottom edge is its darkest part.
  local lobes = { { 16, 21, 9, 3.5 }, { 16, 15, 7.5, 3.5 }, { 16, 9, 5.5, 3.2 }, { 16, 4, 3, 2.6 } }
  paintLobes(img, lobes, PINE, PINE_OUT, 0.1)
  return img
end

local function bush(decor)
  local img = blank()
  shadow(img, 17, 25, 10, 3)
  local lobes = { { 11, 20, 6, 5 }, { 21, 20, 6, 5 }, { 16, 16, 7, 6 } }
  paintLobes(img, lobes, LEAF, LEAF_OUT, 0.2)
  if decor then dots(img, lobes, decor.n, decor.colors) end
  return img
end

local function boulder()
  local img = blank()
  shadow(img, 18, 24, 9, 3)
  paintLobes(img, { { 16, 19, 8, 6 }, { 12, 21, 5, 4 } }, ROCK, ROCK_OUT, 0.08)
  return img
end

local function stones()
  local img = blank()
  shadow(img, 13, 23, 6, 2); shadow(img, 22, 25, 5, 2)
  paintLobes(img, { { 12, 20, 5, 4 } }, ROCK, ROCK_OUT, 0.05)
  paintLobes(img, { { 22, 23, 4, 3 } }, ROCK, ROCK_OUT, 0.05)
  return img
end

-- A clump of flowers: short stems in two greens, heads as a plus of petals round a centre.
local function flowers(petal, centre)
  local img = blank()
  local spots = { { 8, 16 }, { 15, 12 }, { 22, 17 }, { 12, 23 }, { 20, 24 }, { 26, 22 } }
  for _, p in ipairs(spots) do
    local x, y = p[1], p[2]
    for dy = 1, 3 do img:drawPixel(x, y + dy, hex(dy == 3 and 0x2f4a22 or 0x3f6330)) end
    for _, d in ipairs({ { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }) do
      img:drawPixel(x + d[1], y + d[2], hex(petal))
    end
    img:drawPixel(x, y, hex(centre))
  end
  return img
end

local cells = {
  { "tree", oak() }, { "tree", round() }, { "tree", fruit() }, { "tree", pine() },
  { "bush", bush(nil) },
  { "bush", bush({ n = 6, colors = { 0x8a2a3a, 0xb03a48 } }) },
  { "bush", bush({ n = 8, colors = { 0xd8a0c0, 0xf0e0e8 } }) },
  { "rock", boulder() }, { "rock", stones() },
  { "flowers", flowers(0xc75a8a, 0xf0d060) },
  { "flowers", flowers(0xe0b830, 0x8a4a1a) },
  { "flowers", flowers(0xe8e4dc, 0xe0b830) },
}

local dir = app.params.dir or "public/sprites/props"
app.fs.makeAllDirectories(dir)

local spr = Sprite(S, S, ColorMode.RGB)
spr.filename = "props"
for i = 2, #cells do spr:newEmptyFrame() end
for i, c in ipairs(cells) do spr:newCel(spr.layers[1], spr.frames[i], c[2], Point(0, 0)) end
local from = 1
for i = 1, #cells do
  if i == #cells or cells[i + 1][1] ~= cells[i][1] then
    local tag = spr:newTag(from, i); tag.name = cells[i][1]
    from = i + 1
  end
end
spr:saveAs(app.fs.joinPath(dir, "props.aseprite"))
spr:close()

local strip = Image(S * #cells, S, ColorMode.RGB)
strip:clear(0)
for i, c in ipairs(cells) do strip:drawImage(c[2], Point((i - 1) * S, 0)) end
strip:saveAs(app.fs.joinPath(dir, "props.png"))
print(#cells .. " props")
