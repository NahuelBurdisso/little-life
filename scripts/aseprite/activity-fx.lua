-- activity-fx.lua — small looping particles that sit on an agent while it does something
-- (ActivityFxSystem): sweat, steam, dust, notes, sparks, coins, ripples, splashes...
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/fx --script scripts/aseprite/activity-fx.lua
--
-- Writes activity-fx.aseprite (one frame per cell, one tag per effect) and activity-fx.png, a
-- horizontal strip of 16x16 cells packed back to back in the order below — keep in sync with SPEC in
-- src/components/canvas/systems/activityFx/activityFrames.ts (a vitest test parses this line):
--
-- ORDER: steam:3 sweat:2 dust:3 note:3 spark:3 coin:4 flour:3 ink:2 cross:2 ripple:4 splash:4 fish:2 bobber:2 drop:3 glint:4 wave:3 crumb:2 clap:3 heart:3
--
-- These are particles, not icons: each is a few pixels big and drawn in the middle of its cell (the
-- renderer anchors at 0.5/0.5), so the cell is mostly empty. Solid things (notes, coins, the fish, the
-- bobber, the cross) carry the agents' 1px #1a1510 outline; soft things (steam, dust, flour, ripples,
-- splashes, sparks) get a faint tinted edge or none at all, otherwise a puff of steam would read as a
-- dark blob. Animation frames stretch over the particle's life in code, so a 3-frame puff grows and
-- thins as it rises. Drawing is deterministic: rerunning reproduces the PNG byte for byte.

local S = 16
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end

-- ── Palette (same letters as emotes.lua) ─────────────────────────────────────────────────────
local PAL = {
  R = 0xe5322d, r = 0x9c1f2e, p = 0xff8fa3,
  O = 0xf57c1f, Y = 0xffd83a, y = 0xd99a17,
  W = 0xfbf6ea, w = 0xc9c5bd, g = 0x8f909a, G = 0x555764,
  B = 0x2f7be0, b = 0x7cc4ff, d = 0x1f4aa0, C = 0x52e6e6,
  N = 0x34b34a, n = 0x1d7a30, l = 0xa6e858,
  P = 0xb05be0, u = 0x6e2f9c,
  T = 0xe6c58c, t = 0xa8703c, m = 0x6a4322,
  S = 0xf5c79a, s = 0xd69466,
  K = 0x1a1510,
}
local OUTLINE = hex(PAL.K)

-- ── Canvas ──────────────────────────────────────────────────────────────────────────────────
local Canvas = {}
Canvas.__index = Canvas

local function newCanvas()
  local img = Image(S, S, ColorMode.RGB)
  img:clear(0)
  return setmetatable({ img = img, filled = {} }, Canvas)
end

function Canvas:px(x, y, ch)
  x, y = math.floor(x), math.floor(y)
  if x < 0 or y < 0 or x >= S or y >= S then return end
  local col = PAL[ch]
  if not col then return end
  self.img:drawPixel(x, y, hex(col))
  self.filled[y * S + x] = true
end

local function A(block)
  local rows = {}
  for line in block:gmatch("[^\r\n]+") do
    line = line:match("^%s*(.-)%s*$")
    if #line > 0 then rows[#rows + 1] = line end
  end
  return rows
end

-- Draw an ASCII sprite centred on the cell, nudged by dx/dy.
function Canvas:spr(rows, dx, dy)
  local h, w = #rows, 0
  for _, r in ipairs(rows) do if #r > w then w = #r end end
  local x0 = (S - w) // 2 + (dx or 0)
  local y0 = (S - h) // 2 + (dy or 0)
  for j, r in ipairs(rows) do
    for i = 1, #r do
      local ch = r:sub(i, i)
      if ch ~= "." then self:px(x0 + i - 1, y0 + j - 1, ch) end
    end
  end
end

function Canvas:disc(cx, cy, r, ch, shade)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local dx, dy = x + 0.5 - cx, y + 0.5 - cy
      if dx * dx + dy * dy <= r * r then
        local c = ch
        if shade and dx * 0.7 + dy * 0.9 > r * 0.45 then c = shade end
        self:px(x, y, c)
      end
    end
  end
end

function Canvas:ellipse(cx, cy, rx, ry, ch, shade)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local dx, dy = (x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry
      if dx * dx + dy * dy <= 1 then
        local c = ch
        if shade and dx * 0.5 + dy * 0.8 > 0.3 then c = shade end
        self:px(x, y, c)
      end
    end
  end
end

-- A ring of an ellipse; `skip` leaves every skip-th sample out so it reads as fading dots.
function Canvas:ellipseRing(cx, cy, rx, ry, ch, skip)
  local n = math.floor((rx + ry) * 6)
  for i = 0, n - 1 do
    if not skip or i % skip ~= 0 then
      local a = i / n * math.pi * 2
      self:px(cx + math.cos(a) * rx, cy + math.sin(a) * ry, ch)
    end
  end
end

-- A circular arc opening to the right, `from`..`to` radians round (cx, cy).
function Canvas:arc(cx, cy, r, from, to, ch)
  local n = math.floor(r * 8)
  for i = 0, n do
    local a = from + (to - from) * i / n
    self:px(cx + math.cos(a) * r, cy + math.sin(a) * r, ch)
  end
end

function Canvas:line(x0, y0, x1, y1, ch)
  local n = math.max(math.abs(x1 - x0), math.abs(y1 - y0))
  for i = 0, n do
    local t = n == 0 and 0 or i / n
    self:px(math.floor(x0 + (x1 - x0) * t + 0.5), math.floor(y0 + (y1 - y0) * t + 0.5), ch)
  end
end

function Canvas:rect(x, y, w, h, ch)
  for yy = y, y + h - 1 do for xx = x, x + w - 1 do self:px(xx, yy, ch) end end
end

-- Trace a 1px outline (4-neighbourhood). `col` overrides the default near-black; nil `col` and
-- `none` = true skips the outline (glowing things).
function Canvas:finish(col, none)
  if none then return self.img end
  local edge = {}
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      if not self.filled[y * S + x] then
        for _, d in ipairs({ { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) do
          if self.filled[(y + d[2]) * S + x + d[1]] then edge[#edge + 1] = { x, y }; break end
        end
      end
    end
  end
  for _, e in ipairs(edge) do self.img:drawPixel(e[1], e[2], col or OUTLINE) end
  return self.img
end

-- ── Effect registry ─────────────────────────────────────────────────────────────────────────
-- fx(name, outline, frames): outline = "hard" (near-black), a hex colour with alpha for a soft
-- edge (given as { hexcolor, alpha }), or "none".
local E = {}
local function fx(name, outline, frames) E[#E + 1] = { name, outline, frames } end

-- steam: a wisp that grows and thins as it rises (plates, pans, cups).
fx("steam", { 0x8f909a, 120 }, {
  function(c) c:disc(8, 9, 1.8, "W", "w") end,
  function(c) c:disc(8, 8, 2.7, "W", "w"); c:px(6, 10, "W") end,
  function(c)
    c:disc(7.5, 7.5, 3.4, "w", "g")
    c:px(7, 7, "W"); c:px(9, 6, "W")                    -- holes: it is thinning out
  end,
})

-- sweat: a drop thrown off the brow, then a bead that dries.
fx("sweat", "hard", {
  function(c) c:spr(A [[
    .b.
    bWB
    BBB
    .B.
  ]]) end,
  function(c) c:spr(A [[
    b.
    BB
  ]]) end,
})

-- dust: a scuff of dry earth kicked up by running feet.
fx("dust", { 0x6a4322, 110 }, {
  function(c) c:disc(8, 9, 1.7, "T", "t") end,
  function(c) c:disc(8, 8.5, 2.6, "T", "t"); c:px(5, 10, "T") end,
  function(c) c:disc(8, 8, 3.3, "T", "t"); c:px(7, 7, "W"); c:px(9, 9, "W"); c:px(6, 9, "W") end,
})

-- note: three flavours of music note (eighth, beamed pair, quarter) so a busker never repeats itself.
fx("note", "hard", {
  function(c) c:spr(A [[
    ..Y...
    ..YY..
    ..Y.Y.
    ..Y..Y
    ..Y...
    ..Y...
    YYY...
    YYy...
  ]]) end,
  function(c) c:spr(A [[
    ..WWWWWW
    ..WWWWWW
    ..W....W
    ..W....W
    ..W....W
    WWW..WWW
    WWw..WWw
  ]]) end,
  function(c) c:spr(A [[
    ..C
    ..C
    ..C
    ..C
    ..C
    CCC
    CCb
  ]]) end,
})

-- spark: struck off the anvil — a bright star, an ember cross, a dying ember.
fx("spark", "none", {
  function(c) c:spr(A [[
    ..Y..
    ..W..
    YWWWY
    ..W..
    ..Y..
  ]]) end,
  function(c) c:spr(A [[
    O.Y.O
    .OYO.
    YYWYY
    .OYO.
    O.Y.O
  ]]) end,
  function(c) c:spr(A [[
    O..
    .r.
    ..O
  ]], 1, 0) end,
})

-- coin: gold coin turning over (face, three-quarter, edge, three-quarter).
fx("coin", "hard", {
  function(c) c:ellipse(8, 8, 3.4, 3.4, "Y", "y"); c:px(8, 8, "y"); c:px(7, 7, "W") end,
  function(c) c:ellipse(8, 8, 2.4, 3.4, "Y", "y"); c:px(8, 8, "y") end,
  function(c) c:ellipse(8, 8, 0.9, 3.4, "y", "y"); c:px(8, 6, "Y") end,
  function(c) c:ellipse(8, 8, 2.4, 3.4, "y", "y"); c:px(8, 8, "Y"); c:px(9, 7, "W") end,
})

-- flour: a floury puff off the bench — dots, a cloud, drifting dust.
fx("flour", { 0xc9c5bd, 130 }, {
  function(c) c:px(7, 8, "W"); c:px(9, 9, "W"); c:px(8, 6, "W"); c:px(9, 7, "w") end,
  function(c) c:disc(8, 8, 2.6, "W", "w"); c:px(5, 6, "W"); c:px(11, 9, "W") end,
  function(c) c:px(5, 5, "W"); c:px(10, 6, "w"); c:px(7, 10, "W"); c:px(11, 10, "w"); c:px(8, 7, "W") end,
})

-- ink: quill scratches — a squiggle of ink that lengthens, then a blot.
fx("ink", "none", {
  function(c) c:spr(A [[
    dd.d.dd
    .d.d..K
  ]]) end,
  function(c) c:spr(A [[
    dd.d.dd.d
    .d.d..dd.
    ....KKd..
  ]]) end,
})

-- cross: a medical cross that pulses (clinic).
local function cross(c, hi)
  c:rect(7, 3, 3, 10, "N"); c:rect(3, 7, 10, 3, "N")
  c:rect(7, 3, 3, 1, hi); c:rect(3, 7, 1, 3, hi); c:rect(7, 3, 1, 4, hi); c:rect(3, 7, 4, 1, hi)
  c:rect(7, 12, 3, 1, "n"); c:rect(12, 7, 1, 3, "n"); c:rect(9, 9, 1, 4, "n"); c:rect(9, 9, 4, 1, "n")
end
fx("cross", "hard", {
  function(c) cross(c, "l") end,
  function(c) cross(c, "W"); c:px(13, 3, "W"); c:px(2, 13, "W") end,
})

-- ripple: rings spreading on the water round a bobber.
fx("ripple", "none", {
  function(c) c:ellipseRing(8, 8, 1.6, 0.9, "W") end,
  function(c) c:ellipseRing(8, 8, 3.4, 1.6, "W"); c:ellipseRing(8, 8, 1.5, 0.8, "b") end,
  function(c) c:ellipseRing(8, 8, 5.4, 2.4, "b"); c:ellipseRing(8, 8, 3.2, 1.5, "W", 3) end,
  function(c) c:ellipseRing(8, 8, 7.2, 3.2, "b", 2) end,
})

-- splash: a fish (or a big bite) breaking the surface.
fx("splash", "none", {
  function(c)
    c:px(8, 9, "W"); c:px(7, 8, "b"); c:px(9, 8, "b"); c:px(8, 8, "W"); c:px(8, 7, "b")
    c:ellipseRing(8, 11, 2.6, 1.1, "W")
  end,
  function(c)
    c:line(6, 10, 5, 6, "b"); c:line(10, 10, 11, 6, "b"); c:line(8, 10, 8, 5, "W")
    c:px(5, 5, "W"); c:px(11, 5, "W"); c:px(8, 4, "b")
    c:ellipseRing(8, 11, 3.6, 1.5, "b")
  end,
  function(c)
    c:px(4, 6, "b"); c:px(12, 6, "b"); c:px(6, 4, "W"); c:px(10, 4, "W"); c:px(8, 3, "b")
    c:px(5, 9, "b"); c:px(11, 9, "b")
    c:ellipseRing(8, 11, 5, 2, "b", 2)
  end,
  function(c)
    c:px(3, 9, "b"); c:px(13, 9, "b"); c:px(6, 7, "W"); c:px(10, 7, "W")
    c:ellipseRing(8, 11, 6.4, 2.6, "b", 2)
  end,
})

-- fish: a silver fish (drawn level; the renderer tilts it along its arc), tail flicking.
fx("fish", "hard", {
  function(c) c:spr(A [[
    ....gggg...
    g..gGGGGgg.
    ggwwWWWWWwK
    g..gwwWWww.
    ....ww.....
  ]]) end,
  function(c) c:spr(A [[
    g...gggg...
    gg.gGGGGgg.
    ggwwWWWWWwK
    gg.gwwWWww.
    g...ww.....
  ]]) end,
})

-- bobber: red-and-white float, sitting up (rest) and pulled under (bite).
fx("bobber", "hard", {
  function(c) c:spr(A [[
    .W.
    RRR
    RRr
    WWw
  ]]) end,
  function(c) c:spr(A [[
    .W.
    RRR
  ]], 0, 2) end,
})

-- drop: from the watering can — falling, stretching, splashing on the soil.
fx("drop", "none", {
  function(c) c:spr(A [[
    b
    B
  ]]) end,
  function(c) c:spr(A [[
    W
    b
    B
    B
  ]]) end,
  function(c) c:spr(A [[
    b.W.b
    .BBB.
  ]]) end,
})

-- glint: pick-up twinkle — a plus that swells and pops into diagonals.
fx("glint", "none", {
  function(c) c:spr(A [[
    .Y.
    YWY
    .Y.
  ]]) end,
  function(c) c:spr(A [[
    ..Y..
    ..W..
    YWWWY
    ..W..
    ..Y..
  ]]) end,
  function(c) c:spr(A [[
    Y..Y..Y
    .Y.W.Y.
    ..YWY..
    YWWWWWY
    ..YWY..
    .Y.W.Y.
    Y..Y..Y
  ]]) end,
  function(c) c:spr(A [[
    Y.....Y
    .......
    ...W...
    .......
    Y.....Y
  ]]) end,
})

-- wave: sound arcs spreading from a mouth (megaphone, speech). Opens to the right. Each arc is
-- a white line over a one-pixel dark-brown drop shadow instead of a full outline (which would
-- fatten a 1px arc into a bracket).
local function waves(c, list)
  for _, w in ipairs(list) do c:arc(w[1] + 1, 8, w[2], -w[3], w[3], "m") end
  for _, w in ipairs(list) do c:arc(w[1], 8, w[2], -w[3], w[3], "W") end
end
fx("wave", "none", {
  function(c) waves(c, { { 4, 3, 0.85 } }) end,
  function(c) waves(c, { { 2, 3, 0.85 }, { 2, 6, 0.75 } }) end,
  function(c) waves(c, { { 1, 6, 0.75 }, { 1, 9, 0.6 } }) end,
})

-- crumb: bread crumbs from the table.
fx("crumb", "none", {
  function(c) c:px(7, 8, "T"); c:px(8, 8, "t"); c:px(9, 9, "T") end,
  function(c) c:px(8, 8, "t"); c:px(7, 9, "m") end,
})

-- clap: the burst round two hands meeting.
fx("clap", "none", {
  function(c) c:spr(A [[
    Y.....Y
    .Y...Y.
    .......
    .......
    .Y...Y.
    Y.....Y
  ]]) end,
  function(c) c:spr(A [[
    Y.W.W.Y
    .......
    W.....W
    .......
    Y.W.W.Y
  ]]) end,
  function(c) c:spr(A [[
    W.....W
    ...Y...
    W.....W
  ]]) end,
})

-- heart: a small pink-red heart that drifts up from a house where two people are spending the
-- evening (ActivityFxSystem, the roofline of the tryst activity). Suggestive and sweet, nothing
-- more: it swells from a small heart to a full one, then pales as it fades. Hard outline, like
-- the emote hearts (emotes.lua), but smaller so a house shows a few now and then, not a shout.
fx("heart", "hard", {
  function(c) c:spr(A [[
    .R.R.
    RpRRR
    RRRRr
    .RRr.
    ..r..
  ]]) end,
  function(c) c:spr(A [[
    .RR.RR.
    RpRRRRR
    RRRRRRr
    .RRRRr.
    ..RRr..
    ...r...
  ]]) end,
  function(c) c:spr(A [[
    .pp.pp.
    ppppppp
    ppppppR
    .pppppR
    ..pppR.
    ...R...
  ]], 0, -1) end,
})

-- ── Output ──────────────────────────────────────────────────────────────────────────────────
local dir = app.params.dir or "public/sprites/fx"
app.fs.makeAllDirectories(dir)

local cells, tags = {}, {}
for _, e in ipairs(E) do
  local first = #cells + 1
  for _, fn in ipairs(e[3]) do
    local c = newCanvas()
    fn(c)
    local o = e[2]
    if o == "hard" then cells[#cells + 1] = c:finish()
    elseif o == "none" then cells[#cells + 1] = c:finish(nil, true)
    else cells[#cells + 1] = c:finish(hex(o[1], o[2])) end
  end
  tags[#tags + 1] = { e[1], first, #cells }
end

local spr = Sprite(S, S, ColorMode.RGB)
spr.filename = "activity-fx"
for _ = 2, #cells do spr:newEmptyFrame() end
for i, img in ipairs(cells) do spr:newCel(spr.layers[1], spr.frames[i], img, Point(0, 0)) end
for _, t in ipairs(tags) do
  local tag = spr:newTag(t[2], t[3]); tag.name = t[1]
end
spr:saveAs(app.fs.joinPath(dir, "activity-fx.aseprite"))
spr:close()

local strip = Image(S * #cells, S, ColorMode.RGB)
strip:clear(0)
for i, img in ipairs(cells) do strip:drawImage(img, Point((i - 1) * S, 0)) end
strip:saveAs(app.fs.joinPath(dir, "activity-fx.png"))
print(#E .. " effects, " .. #cells .. " cells")
