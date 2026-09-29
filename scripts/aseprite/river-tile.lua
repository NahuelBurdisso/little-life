-- river-tile.lua — tileable 32x32 water for the park's riverside zone.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/tiles --script scripts/aseprite/river-tile.lua
--
-- Writes terrain_river.aseprite + terrain_river.png. The older terrain_water.png is a mostly
-- transparent overlay of dark dashes, so a riverside drawn with it read as speckled grass and
-- the reeds/rocks props stood on nothing. This one is opaque water: a deep body with slow
-- horizontal bands, broken ripple dashes and a few glints, all wrapping at the tile edge so a
-- 2x2 zone shows no seams.
--
-- Deterministic: the pseudo-random variation is seeded, so re-running reproduces the file.

local S = 32
local seed = 7
local function rand()
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
end

local dir = app.params["dir"] or "public/sprites/tiles"
local function c(hex)
  return app.pixelColor.rgba(tonumber(hex:sub(1, 2), 16), tonumber(hex:sub(3, 4), 16), tonumber(hex:sub(5, 6), 16), 255)
end

-- Palette: deep, body, light band, ripple, glint (cool blues that sit next to the park greens).
local DEEP, BODY, BAND, RIPPLE, GLINT = c("2c5578"), c("356690"), c("3f75a0"), c("6a9fc6"), c("b8dcef")

local img = Image(S, S, ColorMode.RGB)
local function put(x, y, col) img:drawPixel(x % S, y % S, col) end

-- Body with two gentle bands of lighter water and a darker trough: reads as a slow current.
for y = 0, S - 1 do
  for x = 0, S - 1 do
    local band = math.sin((y + math.sin(x / 32 * math.pi * 2) * 1.5) / S * math.pi * 4)
    local col = BODY
    if band > 0.55 then col = BAND elseif band < -0.7 then col = DEEP end
    put(x, y, col)
  end
end

-- Ripple dashes: short horizontal strokes, some with a darker underline (the wave's shadow).
for _ = 1, 9 do
  local x, y, len = math.floor(rand() * S), math.floor(rand() * S), 2 + math.floor(rand() * 4)
  for i = 0, len - 1 do put(x + i, y, RIPPLE) end
  if rand() < 0.6 then for i = 1, len - 2 do put(x + i, y + 1, DEEP) end end
end

-- A few single-pixel glints.
for _ = 1, 4 do put(math.floor(rand() * S), math.floor(rand() * S), GLINT) end

local spr = Sprite(S, S, ColorMode.RGB)
spr.layers[1].name = "river"
spr:newCel(spr.layers[1], spr.frames[1], img, Point(0, 0))
spr:saveAs(app.fs.joinPath(dir, "terrain_river.aseprite"))
spr:close()
img:saveAs(app.fs.joinPath(dir, "terrain_river.png"))
print("terrain_river")
