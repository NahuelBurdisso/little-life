-- Contact sheet for public/sprites/fx/beats.png: every effect on its own row, upscaled, over
-- grass (left half) and dark stone (right half of each cell) so translucent parts are judged
-- against both. Not part of the build — a review aid (output goes to docs/scratch/shots/).
--
--   Aseprite.exe -b --script-param png=public/sprites/fx/beats.png \
--     --script-param out=docs/scratch/shots/beats-a.png --script-param first=1 --script-param last=5 \
--     --script docs/scratch/beat-fx-sheet.lua
local ROWS = { { 0, 6 }, { 6, 5 }, { 11, 5 }, { 16, 5 }, { 21, 4 }, { 25, 4 }, { 29, 5 }, { 34, 4 }, { 38, 5 }, { 43, 5 } }
local Z = tonumber(app.params.zoom or "5")
local first, last = tonumber(app.params.first or "1"), tonumber(app.params.last or "10")
local S = 32
local strip = Sprite{ fromFile = app.params.png }
local src = Image(strip.cels[1].image)
local COLS = 6
local pc = app.pixelColor
local sheet = Image(COLS * S * Z, (last - first + 1) * S * Z, ColorMode.RGB)
sheet:clear(pc.rgba(0, 0, 0, 255))
local GRASS, STONE = pc.rgba(0x5a, 0x7a, 0x3a, 255), pc.rgba(0x30, 0x30, 0x38, 255)
for ri = first, last do
  local start, count = ROWS[ri][1], ROWS[ri][2]
  for c = 0, count - 1 do
    local ox, oy = c * S * Z, (ri - first) * S * Z
    for y = 0, S * Z - 1 do
      for x = 0, S * Z - 1 do
        local bg = (x < S * Z / 2) and GRASS or STONE
        local px = src:getPixel((start + c) * S + x // Z, y // Z)
        local a = pc.rgbaA(px)
        if a > 0 then
          local f = a / 255
          local r = math.floor(pc.rgbaR(px) * f + pc.rgbaR(bg) * (1 - f))
          local g = math.floor(pc.rgbaG(px) * f + pc.rgbaG(bg) * (1 - f))
          local b = math.floor(pc.rgbaB(px) * f + pc.rgbaB(bg) * (1 - f))
          sheet:drawPixel(ox + x, oy + y, pc.rgba(r, g, b, 255))
        else
          sheet:drawPixel(ox + x, oy + y, bg)
        end
      end
    end
  end
end
app.fs.makeAllDirectories(app.fs.filePath(app.params.out))
sheet:saveAs(app.params.out)
print("sheet " .. app.params.out)
