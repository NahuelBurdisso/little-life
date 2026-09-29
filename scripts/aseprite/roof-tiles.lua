-- roof-tiles.lua — tileable 32x32 roof surfaces for BuildingRenderer.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/tiles --script scripts/aseprite/roof-tiles.lua
--
-- Writes roof_<material>.aseprite + roof_<material>.png for clay, shingle, slate and tin.
-- Like the floor textures they are authored in neutral greys and tinted per building type
-- in the renderer (ROOF_STYLE in BuildingRenderer.ts), so one texture serves every type that
-- shares a material. Rows run horizontally: the renderer lays the ridge along the building's
-- long axis and tiles these across both slopes. Every shape wraps at the tile edge, so the
-- pattern has no seams when repeated.
--
-- Deterministic: the pseudo-random variation is seeded, so re-running reproduces the files.

local S = 32
local seed = 1
local function rand()
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
end

local function grey(v)
  v = math.max(0, math.min(255, math.floor(v + 0.5)))
  return app.pixelColor.rgba(v, v, v, 255)
end

local function new() local i = Image(S, S, ColorMode.RGB); i:clear(grey(0)); return i end
local function put(img, x, y, v) img:drawPixel(x % S, y % S, grey(v)) end

-- Clay: barrel tiles, 8px wide x 8px tall, alternate rows offset half a tile. Each barrel has
-- a lit crown, shaded flanks and a curved lower lip that overlaps the row below.
local function clay()
  local img = new()
  for row = 0, 3 do
    local y0, off = row * 8, (row % 2) * 4
    for col = 0, 3 do
      local x0 = col * 8 + off
      for dy = 0, 7 do
        for dx = 0, 7 do
          local v = ({ 120, 165, 200, 222, 214, 192, 160, 112 })[dx + 1]
          v = v - dy * 3                                  -- darker toward the lip
          put(img, x0 + dx, y0 + dy, v)
        end
      end
      -- Rounded lip: the bottom corners fall into the shadow of the next row.
      put(img, x0, y0 + 7, 70); put(img, x0 + 7, y0 + 7, 70)
      put(img, x0, y0 + 6, 96); put(img, x0 + 7, y0 + 6, 96)
      for dx = 1, 6 do put(img, x0 + dx, y0 + 7, 118) end
    end
  end
  return img
end

-- Shingle: split wooden shakes of uneven width, staggered, each with a grain line and a
-- dark overlap line on top where the row above covers it.
local function shingle()
  local img = new()
  for row = 0, 3 do
    local y0 = row * 8
    local x = math.floor(rand() * 6)
    local startX = x
    while x < startX + S do
      local w = 5 + math.floor(rand() * 4)
      if x + w > startX + S then w = startX + S - x end
      local base = 170 + rand() * 40
      for dx = 0, w - 1 do
        for dy = 0, 7 do
          local v = base - dy * 4
          if dy == 0 then v = 88 end                     -- overlap shadow
          if dx == 0 then v = 96 end                     -- gap between shakes
          put(img, x + dx, y0 + dy, v)
        end
      end
      if w > 3 then
        local gx = x + 2 + math.floor(rand() * (w - 3))
        for dy = 2, 6 do put(img, gx, y0 + dy, base - 34) end  -- grain
      end
      put(img, x + w - 1, y0 + 7, base - 50)               -- lower corner wear
      x = x + w
    end
  end
  return img
end

-- Slate: flat rectangular slates, 8 wide x 8 tall, staggered by half, each with its own shade
-- so the roof reads as stone rather than a printed grid.
local function slate()
  local img = new()
  for row = 0, 3 do
    local y0, off = row * 8, (row % 2) * 4
    for col = 0, 3 do
      local x0 = col * 8 + off
      local base = 150 + rand() * 50
      for dy = 0, 7 do
        for dx = 0, 7 do
          local v = base + (dy < 2 and 12 or 0) - dy * 2
          if dx == 7 then v = 72 end                     -- vertical joint
          if dy == 7 then v = 60 end                     -- lower edge shadow
          put(img, x0 + dx, y0 + dy, v)
        end
      end
      put(img, x0 + 1, y0 + 1, math.min(255, base + 40)) -- chipped highlight
    end
  end
  return img
end

-- Tin: corrugated sheet — a 4px ridge/valley cycle across, one lapped seam with rivets
-- every tile height, and a few rust-dark flecks.
local function tin()
  local img = new()
  local cycle = { 215, 180, 120, 160 }
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      put(img, x, y, cycle[(x % 4) + 1] - (y % 16 == 15 and 60 or 0))
    end
  end
  for x = 1, S - 1, 8 do put(img, x, 14, 235); put(img, x, 13, 90) end
  for _ = 1, 6 do put(img, math.floor(rand() * S), math.floor(rand() * S), 100) end
  return img
end

local dir = app.params.dir or "public/sprites/tiles"
for _, m in ipairs({ { "clay", clay }, { "shingle", shingle }, { "slate", slate }, { "tin", tin } }) do
  local name, make = m[1], m[2]
  local img = make()
  local spr = Sprite(S, S, ColorMode.RGB)
  spr.layers[1].name = name
  spr:newCel(spr.layers[1], spr.frames[1], img, Point(0, 0))
  spr:saveAs(app.fs.joinPath(dir, "roof_" .. name .. ".aseprite"))
  spr:close()
  img:saveAs(app.fs.joinPath(dir, "roof_" .. name .. ".png"))
  print("roof_" .. name)
end
