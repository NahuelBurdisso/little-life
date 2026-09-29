-- decor-mock.lua — composites eventDecor placements over a mock town square (grass, square
-- tint, well + benches as BuildingRenderer draws them) to check composition.
--   npx tsx docs/scratch/decor-plan.ts docs/scratch/shots/decor-plan.json
--   Aseprite.exe -b --script-param event=festival --script-param out=docs/scratch/shots/mock-festival.png \
--     --script-param scale=2 --script docs/scratch/decor-mock.lua
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end
local f = io.open(app.params.plan or "docs/scratch/shots/decor-plan.json", "r")
local plan = json.decode(f:read("a")); f:close()
local atlas = Image { fromFile = "public/sprites/fx/decor.png" }
local W, H = 416, 440
local night = app.params.night == "1"
local img = Image(W, H, ColorMode.RGB)
img:clear(hex(0x4a6830))

local function blendPx(x, y, c, a)
  if x < 0 or y < 0 or x >= W or y >= H then return end
  local bg = img:getPixel(x, y)
  local al = (a or 255) / 255
  local function ch(fg, b) return math.floor(fg * al + b * (1 - al) + 0.5) end
  img:drawPixel(x, y, pc.rgba(ch((c >> 16) & 255, pc.rgbaR(bg)), ch((c >> 8) & 255, pc.rgbaG(bg)), ch(c & 255, pc.rgbaB(bg)), 255))
end
local function rect(x, y, w, h, c, a) for yy = y, y + h - 1 do for xx = x, x + w - 1 do blendPx(xx, yy, c, a) end end end
local function disc(cx, cy, r, c, a)
  for yy = math.floor(cy - r), math.ceil(cy + r) do for xx = math.floor(cx - r), math.ceil(cx + r) do
    local dx, dy = xx + 0.5 - cx, yy + 0.5 - cy
    if dx * dx + dy * dy <= r * r then blendPx(xx, yy, c, a) end
  end end
end
local function ring(cx, cy, r, w, c, a)
  for yy = math.floor(cy - r - w), math.ceil(cy + r + w) do for xx = math.floor(cx - r - w), math.ceil(cx + r + w) do
    local d = math.sqrt((xx + 0.5 - cx) ^ 2 + (yy + 0.5 - cy) ^ 2)
    if d <= r + w / 2 and d >= r - w / 2 then blendPx(xx, yy, c, a) end
  end end
end

-- the square
local sq = plan.square
rect(sq.x, sq.y, sq.width, sq.height, 0x8a7a5a, 128)
local cx = sq.x + (math.floor(sq.width / 2 / 32)) * 32
local cy = sq.y + (math.floor(sq.height / 2 / 32)) * 32
ring(cx + 16, cy + 16, 36, 7, 0x8a7a5e, 77)
for _, b in ipairs({ { cx + 10, cy - 40, 14, 5 }, { cx + 10, cy + 68, 14, 5 }, { cx - 40, cy + 10, 5, 14 }, { cx + 68, cy + 10, 5, 14 } }) do
  rect(b[1] + 1, b[2] + 2, b[3], b[4], 0x1a1208, 64); rect(b[1], b[2], b[3], b[4], 0x6a5236)
end
disc(cx + 19, cy + 20, 20, 0x1a1208, 77)
disc(cx + 16, cy + 16, 20, 0x1a1510); disc(cx + 16, cy + 16, 19, 0x9a9284)
disc(cx + 16, cy + 16, 13, 0x4a7a8c); rect(cx + 9, cy + 9, 4, 4, 0x8ab8c8)

-- buildings for the fire panel
local function building(b, roof)
  rect(b.x, b.y, b.width, b.height, 0x6a5a40)
  rect(b.x - 3, b.y - 3, b.width + 6, b.height - 11 + 3, roof)
  rect(b.x - 3, b.y - 3, b.width + 6, 2, 0xffffff, 40)
  rect(b.x, b.y + b.height - 11, b.width, 11, 0xc8b898)
  rect(b.x + b.width // 2 - 6, b.y + b.height - 8, 12, 8, 0x5a3a20)
end
building(plan.bakery, 0x8a4a3a)
building(plan.clinic, 0x6a7a8a)

local base = img:clone()
local function render(ev)
img = base:clone()
local function cell(frame, phase)
  local c = Image(32, 32, ColorMode.RGB); c:clear(0)
  c:drawImage(atlas, Point(-frame * 32, 0))
  return c
end
local tick = tonumber(app.params.tick or "0")
for _, p in ipairs(plan.events[ev]) do
  local fr = p.frame
  if p.frames > 1 then fr = fr + (math.floor(tick + p.phase * p.frames)) % p.frames end
  local c = cell(fr)
  if night and p.frame >= 6 and p.frame <= 7 then end
  img:drawImage(c, Point(p.x - 16, p.y - 30))
end

if night then
  -- crude night: darken everything except a glow near lights
  for y = 0, H - 1 do for x = 0, W - 1 do
    local c = img:getPixel(x, y)
    img:drawPixel(x, y, pc.rgba(pc.rgbaR(c) * 0.45 // 1, pc.rgbaG(c) * 0.5 // 1, pc.rgbaB(c) * 0.7 // 1, 255))
  end end
end

local scale = tonumber(app.params.scale or "2")
local out = Image(W * scale, H * scale, ColorMode.RGB)
for y = 0, H * scale - 1 do for x = 0, W * scale - 1 do out:drawPixel(x, y, img:getPixel(x // scale, y // scale)) end end
out:saveAs(app.params.out or ("docs/scratch/shots/mock-" .. ev .. ".png"))
print(ev .. " " .. #plan.events[ev] .. " placements")

end
for ev in string.gmatch(app.params.event or "festival", "[^,]+") do render(ev) end
