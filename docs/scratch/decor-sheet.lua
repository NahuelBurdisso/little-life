-- decor-sheet.lua — upscaled contact sheet of public/sprites/fx/decor.png for art review.
--   Aseprite.exe -b --script-param out=docs/scratch/shots/decor-sheet.png --script docs/scratch/decor-sheet.lua
-- Cells sit on grass (#4a6830) with a faint grid; a dark half shows how they read at night.
local S, N = 32, 39
local SCALE = tonumber(app.params.scale or "5")
local COLS = tonumber(app.params.cols or "10")
local src = Image { fromFile = app.params.src or "public/sprites/fx/decor.png" }
local rows = math.ceil(N / COLS)
local W, H = COLS * S * SCALE, rows * S * SCALE
local sheet = Image(W, H, ColorMode.RGB)
local pc = app.pixelColor
local function hex(h) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, 255) end
local function blend(bg, fg)
  local a = pc.rgbaA(fg) / 255
  local function ch(f, b) return math.floor(f * a + b * (1 - a) + 0.5) end
  return pc.rgba(ch(pc.rgbaR(fg), pc.rgbaR(bg)), ch(pc.rgbaG(fg), pc.rgbaG(bg)), ch(pc.rgbaB(fg), pc.rgbaB(bg)), 255)
end
for i = 0, N - 1 do
  local cx, cy = (i % COLS) * S * SCALE, (i // COLS) * S * SCALE
  for y = 0, S * SCALE - 1 do
    for x = 0, S * SCALE - 1 do
      local grid = (x % (S * SCALE) == 0) or (y % (S * SCALE) == 0)
      local bg = grid and hex(0x3a5228) or hex(0x4a6830)
      local sx, sy = x // SCALE, y // SCALE
      local fg = src:getPixel(i * S + sx, sy)
      local c = pc.rgbaA(fg) == 0 and bg or blend(bg, fg)
      -- foot marker: a dim tick where the sprite anchors (x=16, y=30)
      sheet:drawPixel(cx + x, cy + y, c)
    end
  end
end
sheet:saveAs(app.params.out or "docs/scratch/shots/decor-sheet.png")
print("sheet " .. W .. "x" .. H)
