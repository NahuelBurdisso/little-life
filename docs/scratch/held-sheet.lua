-- held-sheet.lua — review contact sheets for public/sprites/fx/held.png (throwaway probe).
--
--   Aseprite.exe -b --script-param out=docs/scratch/shots --script docs/scratch/held-sheet.lua
--
-- Writes held-sheet.png (every cell upscaled 8x on grass and on dark) and held-mock.png
-- (agent frame 0 with each item drawn at the hand offset the game uses, x+7 / y-10 from the feet
-- at 16,29 of the 32px cell, pivoting on the grip — a rest pose, plus a 2x "real size" row).
-- The grips below mirror HELD_ITEMS in src/components/canvas/systems/held/heldFrames.ts.

local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end

local out = app.params.out or "docs/scratch/shots"
app.fs.makeAllDirectories(out)

local atlas = Image{ fromFile = "public/sprites/fx/held.png" }
local agentSheet = Image{ fromFile = "public/sprites/agents/" .. (app.params.agent or "carlos_mendez") .. "_sheet.png" }

local names = { "hammer", "hammer_up", "rolling_pin", "clipboard", "ledger", "mug", "quill", "keys",
  "hoe", "plate", "basket", "rod", "watering_can", "lute", "book" }
local grips = { { 10, 12 }, { 10, 12 }, { 2, 8 }, { 8, 12 }, { 8, 12 }, { 8, 10 }, { 6, 11 }, { 8, 3 },
  { 8, 12 }, { 8, 10 }, { 8, 3 }, { 4, 13 }, { 2, 8 }, { 10, 6 }, { 8, 12 } }

local function cell(i)
  local c = Image(16, 16, ColorMode.RGB); c:clear(0)
  c:drawImage(atlas, Point(-(i - 1) * 16, 0))
  return c
end

local function fill(w, h, color)
  local im = Image(w, h, ColorMode.RGB); im:clear(hex(color)); return im
end

local function up(src, k)
  local dst = Image(src.width * k, src.height * k, ColorMode.RGB); dst:clear(0)
  for y = 0, src.height - 1 do
    for x = 0, src.width - 1 do
      local p = src:getPixel(x, y)
      if pc.rgbaA(p) > 0 then
        for yy = 0, k - 1 do for xx = 0, k - 1 do dst:drawPixel(x * k + xx, y * k + yy, p) end end
      end
    end
  end
  return dst
end

-- ── Sheet 1: the atlas ────────────────────────────────────────────────────────────────────
do
  local K, pad, per = 8, 8, 8
  local cw = 16 * K + pad
  local rows = math.ceil(#names / per)
  local sheet = fill(per * cw + pad, rows * 2 * cw + pad, 0x2a2622)
  for i = 1, #names do
    local col, row = (i - 1) % per, (i - 1) // per
    local x, y = pad + col * cw, pad + row * 2 * cw
    sheet:drawImage(fill(16 * K, 16 * K, 0x4f6f3c), Point(x, y))
    sheet:drawImage(up(cell(i), K), Point(x, y))
    sheet:drawImage(fill(16 * K, 16 * K, 0x6b5a42), Point(x, y + cw))
    sheet:drawImage(up(cell(i), K), Point(x, y + cw))
    -- Grip marker: a magenta pixel-square on the lower panel.
    local g = grips[i]
    sheet:drawImage(fill(K, K, 0xff00ff), Point(x + g[1] * K, y + cw + g[2] * K))
    sheet:drawImage(up(cell(i), K), Point(x, y + cw))
  end
  sheet:saveAs(app.fs.joinPath(out, "held-sheet.png"))
end

-- ── Sheet 2: mock composites on an agent ──────────────────────────────────────────────────
do
  local body = Image(32, 32, ColorMode.RGB); body:clear(0)
  body:drawImage(agentSheet, Point(0, 0))
  local K, pad, per = 4, 8, 8
  local cw = 48 * K + pad
  local rows = math.ceil(#names / per)
  local sheet = fill(per * cw + pad, rows * cw + 100 + pad, 0x2a2622)
  local strip = {}
  for i = 1, #names do
    local col, row = (i - 1) % per, (i - 1) // per
    local comp = fill(48, 40, 0x5a7a44)
    comp:drawImage(body, Point(8, 4))
    local g = grips[i]
    comp:drawImage(cell(i), Point(8 + 16 + 7 - g[1], 4 + 29 - 10 - g[2]))
    sheet:drawImage(up(comp, K), Point(pad + col * cw, pad + row * cw))
    strip[i] = comp
  end
  -- Real size (2x, about what a normal camera zoom shows): every composite in one row.
  local y0 = rows * cw + pad + 8
  local row2 = fill(#names * 96 + pad, 88, 0x5a7a44)
  for i = 1, #names do row2:drawImage(up(strip[i], 2), Point((i - 1) * 96, 4)) end
  sheet:drawImage(row2, Point(0, y0))
  sheet:saveAs(app.fs.joinPath(out, "held-mock.png"))
end
print("sheets written to " .. out)
