-- emotes.lua — the pixel-art emote atlas that replaced the OS-emoji `PIXI.Text` bubbles.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/fx --script scripts/aseprite/emotes.lua
--
-- Writes emotes.aseprite (one frame per cell, one tag per emote) and emotes.png, a horizontal strip
-- of 16x16 cells. Cells are packed back to back in the order below — keep in sync with SPEC in
-- src/components/canvas/emoteFrames.ts (a vitest test parses this line):
--
-- ORDER: heart:3 anger:3 laugh:2 wave:2 question:2 exclaim:2 zzz:4 cry:3 sparkle:3 fish:2 flower:2 music:3 sweat:3 money:2 skull:2 fire:3 star:3 drink:2 sick:2 think:3 work:3 gift:2 handcuffs:2 whisper:3 levelup:4 candle:3 cake:2 broken_heart:3 dizzy:3
--
-- Emotes are the foreground: brighter and more saturated than terrain, but they share the agents'
-- universal 1px #1a1510 outline. Only the fills are authored (ASCII grids below, one char per
-- pixel, see PAL); `Canvas:finish` traces the outline around whatever was drawn, so an artwork
-- must leave a one-pixel margin inside its 16x16 cell.
--
-- Animation reads at 3-7 fps over the ~1.5 s an emote lives, so each emote only needs 2-4 frames:
-- a pulse, a bob, a flicker. Emotes float upward and fade in code, so frames stay planted.

local S = 16
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end

-- ── Palette ─────────────────────────────────────────────────────────────────────────────────
-- Capital = base, lowercase = shade/highlight of the same hue. '.' is transparent.
local PAL = {
  R = 0xe5322d, r = 0x9c1f2e, p = 0xff8fa3,             -- red, dark red, pink highlight
  O = 0xf57c1f, Y = 0xffd83a, y = 0xd99a17,             -- orange, yellow, dark yellow
  W = 0xfbf6ea, w = 0xc9c5bd, g = 0x8f909a, G = 0x555764, -- white, light grey, grey, dark grey
  B = 0x2f7be0, b = 0x7cc4ff, d = 0x1f4aa0, C = 0x52e6e6, -- blue, light blue, dark blue, cyan
  N = 0x34b34a, n = 0x1d7a30, l = 0xa6e858,             -- green, dark green, lime
  P = 0xb05be0, u = 0x6e2f9c,                           -- purple, dark purple
  T = 0xe6c58c, t = 0xa8703c, m = 0x6a4322,             -- tan, brown, dark brown
  S = 0xf5c79a, s = 0xd69466,                           -- skin, skin shade
  K = 0x1a1510,                                         -- outline colour, also used as ink
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

function Canvas:erase(x, y)
  if x < 0 or y < 0 or x >= S or y >= S then return end
  self.img:drawPixel(x, y, 0)
  self.filled[y * S + x] = nil
end

-- Split an ASCII block into trimmed non-empty rows.
local function A(block)
  local rows = {}
  for line in block:gmatch("[^\r\n]+") do
    line = line:match("^%s*(.-)%s*$")
    if #line > 0 then rows[#rows + 1] = line end
  end
  return rows
end

-- Draw an ASCII sprite centred on the cell, nudged by dx/dy. `lean` shears the top of the shape
-- sideways by that many pixels (0 at the base); `map` swaps colour chars ({R='O'}).
function Canvas:spr(rows, dx, dy, lean, map)
  local h, w = #rows, 0
  for _, r in ipairs(rows) do if #r > w then w = #r end end
  local x0 = (S - w) // 2 + (dx or 0)
  local y0 = (S - h) // 2 + (dy or 0)
  for j, r in ipairs(rows) do
    local shear = lean and lean ~= 0 and math.floor(lean * (h - j) / math.max(1, h - 1) + 0.5) or 0
    for i = 1, #r do
      local ch = r:sub(i, i)
      if ch ~= "." then
        if map and map[ch] then ch = map[ch] end
        self:px(x0 + i - 1 + shear, y0 + j - 1, ch)
      end
    end
  end
end

function Canvas:disc(cx, cy, r, ch, shade)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local dx, dy = x + 0.5 - cx, y + 0.5 - cy
      if dx * dx + dy * dy <= r * r then
        local c = ch
        if shade and dx * 0.7 + dy * 0.9 > r * 0.55 then c = shade end
        self:px(x, y, c)
      end
    end
  end
end

function Canvas:ring(cx, cy, ro, ri, ch, shade)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local dx, dy = x + 0.5 - cx, y + 0.5 - cy
      local d = dx * dx + dy * dy
      if d <= ro * ro and d >= ri * ri then
        local c = ch
        if shade and dx * 0.7 + dy * 0.9 > ro * 0.3 then c = shade end
        self:px(x, y, c)
      end
    end
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

-- Trace a 1px outline (4-neighbourhood) round everything drawn so far.
function Canvas:finish()
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
  for _, e in ipairs(edge) do self.img:drawPixel(e[1], e[2], OUTLINE) end
  return self.img
end

-- ── Shared shapes ───────────────────────────────────────────────────────────────────────────

local HEART_BIG = A [[
  .RRR...RRR.
  RppRR.RRRRR
  RpRRRRRRRRR
  RRRRRRRRRRr
  RRRRRRRRRRr
  .RRRRRRRRr.
  ..RRRRRRr..
  ...RRRRr...
  ....RRr....
  .....R.....
]]
local HEART_SMALL = A [[
  .RR...RR.
  RpRR.RRRR
  RRRRRRRRr
  RRRRRRRRr
  .RRRRRRr.
  ..RRRRr..
  ...RRr...
  ....R....
]]

-- A round emoji face on the yellow ramp, centred lower/higher via cy.
local function face(c, cy, base, shade)
  c:disc(8, cy, 6.5, base or "Y", shade or "y")
end

local STAR_BIG = A [[
  ....Y....
  ...YYY...
  ...YWY...
  .YYYWYYY.
  YYYWWWYYY
  .YYYWYYY.
  ...YWY...
  ...YYY...
  ....Y....
]]
local STAR_SMALL = A [[
  ..Y..
  .YWY.
  YWWWY
  .YWY.
  ..Y..
]]
local STAR_TINY = A [[
  .Y.
  YWY
  .Y.
]]

-- ── Emotes ──────────────────────────────────────────────────────────────────────────────────
-- Each entry: { name, { frame function, ... } }. A frame function draws onto a fresh Canvas.

local E = {}
local function emote(name, frames) E[#E + 1] = { name, frames } end

-- heart: pulses big / small / big with a glint.
emote("heart", {
  function(c) c:spr(HEART_BIG, 0, 0) end,
  function(c) c:spr(HEART_SMALL, 0, 0) end,
  function(c) c:spr(HEART_BIG, 0, -1); c:px(3, 3, "W"); c:px(4, 3, "W") end,
})

-- anger: the manga vein cross throbs apart and together, flashing hot.
local function angerFace(c, dx, dy, hot)
  c:disc(8 + dx, 8.5 + dy, 6.3, hot and "O" or "R", hot and "R" or "r")
  -- Slanted brows dive toward the nose, eyes glare underneath.
  for _, p in ipairs({ { 3, 4 }, { 4, 4 }, { 4, 5 }, { 5, 5 }, { 5, 6 }, { 6, 6 },
                       { 12, 4 }, { 11, 4 }, { 11, 5 }, { 10, 5 }, { 10, 6 }, { 9, 6 } }) do
    c:px(p[1] + dx, p[2] + dy, "K")
  end
  c:rect(5 + dx, 7 + dy, 2, 2, "W"); c:rect(9 + dx, 7 + dy, 2, 2, "W")
  c:px(6 + dx, 8 + dy, "K"); c:px(9 + dx, 8 + dy, "K")
  -- Bared teeth in a snarl.
  for i = 5, 10 do c:px(i + dx, 11 + dy, "W") end
  for i = 5, 10 do c:px(i + dx, 12 + dy, i % 2 == 0 and "K" or "W") end
  c:px(4 + dx, 11 + dy, "K"); c:px(11 + dx, 11 + dy, "K")
  c:px(4 + dx, 12 + dy, "K"); c:px(11 + dx, 12 + dy, "K")
  for i = 5, 10 do c:px(i + dx, 13 + dy, "K") end
end
emote("anger", {
  function(c) angerFace(c, 0, 0, false) end,
  function(c) angerFace(c, 1, 0, false) end,
  function(c) angerFace(c, -1, 0, true) end,
})

-- laugh: crying-with-laughter face; bounces, tears fly off.
local function laughFace(c, dy, tears)
  face(c, 8 + dy)
  for _, p in ipairs({ { 4, 6 }, { 5, 5 }, { 6, 6 }, { 9, 6 }, { 10, 5 }, { 11, 6 } }) do c:px(p[1], p[2] + dy, "K") end
  for i = 4, 11 do c:px(i, 9 + dy, i == 4 or i == 11 and "K" or "W") end
  c:px(4, 9 + dy, "K"); c:px(11, 9 + dy, "K")
  c:px(5, 10 + dy, "K"); c:px(10, 10 + dy, "K")
  for i = 6, 9 do c:px(i, 10 + dy, "R"); c:px(i, 11 + dy, "K") end
  for _, p in ipairs(tears) do c:px(p[1], p[2], "C") end
end
emote("laugh", {
  function(c) laughFace(c, 0, { { 1, 7 }, { 1, 8 }, { 14, 7 }, { 14, 8 } }) end,
  function(c) laughFace(c, -1, { { 1, 8 }, { 1, 9 }, { 1, 5 }, { 14, 8 }, { 14, 9 }, { 14, 5 } }) end,
})

-- wave: an open hand rocking left and right with motion arcs.
local HAND = A [[
  ..S.S.S.S..
  ..S.S.S.S..
  ..SSSSSSSs.
  SSSSSSSSSs.
  .SSSSSSSSs.
  ..SSSSSSSs.
  ..SSSSSSSs.
  ...SSSSSs..
  ....SSSs...
]]
emote("wave", {
  function(c)
    c:spr(HAND, 0, 1, -2)
    for _, p in ipairs({ { 13, 3 }, { 14, 4 }, { 14, 5 }, { 13, 6 }, { 13, 9 }, { 14, 10 } }) do c:px(p[1], p[2], "W") end
  end,
  function(c)
    c:spr(HAND, 0, 1, 2)
    for _, p in ipairs({ { 2, 3 }, { 1, 4 }, { 1, 5 }, { 2, 6 }, { 2, 9 }, { 1, 10 } }) do c:px(p[1], p[2], "W") end
  end,
})

-- question: a bold blue "?" hopping.
local QUESTION = A [[
  .bbBBBB.
  bbBBBBBB
  bB....BB
  ......BB
  .....BBB
  ....BBB.
  ...BBB..
  ...BB...
  ...BB...
  ........
  ...bB...
  ...BB...
]]
emote("question", {
  function(c) c:spr(QUESTION, 0, 0) end,
  function(c) c:spr(QUESTION, 0, -1, 1) end,
})

-- exclaim: a red "!" that jolts.
local EXCLAIM = A [[
  .RRR.
  RpRRr
  RpRRr
  RRRRr
  RRRRr
  .RRr.
  .RRr.
  ..R..
  .....
  .RRR.
  RRRRr
  .RRr.
]]
emote("exclaim", {
  function(c) c:spr(EXCLAIM, 0, 0) end,
  function(c) c:spr(EXCLAIM, 0, -1, 0, { R = "O", r = "R", p = "Y" }) end,
})

-- zzz: three Zs growing and drifting up.
local Z_SMALL = A [[
  WWWW
  ..bb
  .bb.
  bbbb
]]
local Z_MED = A [[
  WWWWW
  ...bb
  ..bb.
  .bb..
  bbbbb
]]
local Z_BIG = A [[
  WWWWWWW
  .....bb
  ....bb.
  ...bb..
  ..bb...
  .bb....
  bbbbbbb
]]
emote("zzz", {
  function(c) c:spr(Z_SMALL, -4, 4) end,
  function(c) c:spr(Z_SMALL, -5, 5); c:spr(Z_MED, 0, 0) end,
  function(c) c:spr(Z_SMALL, -5, 5); c:spr(Z_MED, -1, 1); c:spr(Z_BIG, 4, -4) end,
  function(c) c:spr(Z_MED, -3, 3); c:spr(Z_BIG, 3, -3) end,
})

-- cry: worried face, a tear sliding down each cheek and dripping off the chin.
local function cryFace(c, t)
  face(c, 8)
  c:px(4, 5, "K"); c:px(5, 4, "K"); c:px(10, 4, "K"); c:px(11, 5, "K")   -- sad brows
  c:rect(5, 6, 2, 2, "K"); c:rect(9, 6, 2, 2, "K")
  c:px(5, 6, "W"); c:px(9, 6, "W")
  for _, p in ipairs({ { 6, 11 }, { 7, 10 }, { 8, 10 }, { 9, 10 }, { 10, 11 } }) do c:px(p[1], p[2] + 0, "K") end
  for _, x in ipairs({ 4, 11 }) do
    local y = 8 + t
    c:px(x, y, "C"); c:px(x, y + 1, "b")
    if t >= 2 then c:px(x, 13 + (t - 2), "C") end
  end
end
emote("cry", {
  function(c) cryFace(c, 0) end,
  function(c) cryFace(c, 1) end,
  function(c) cryFace(c, 2) end,
})

-- sparkle: a big four-point star and two little ones twinkling in turn.
emote("sparkle", {
  function(c) c:spr(STAR_BIG, 0, 0); c:spr(STAR_TINY, 5, -5); c:spr(STAR_TINY, -5, 5) end,
  function(c) c:spr(STAR_SMALL, 0, 0); c:spr(STAR_SMALL, 5, -4); c:spr(STAR_TINY, -5, 5) end,
  function(c) c:spr(STAR_BIG, 0, 0); c:spr(STAR_TINY, 5, -5); c:spr(STAR_SMALL, -5, 4) end,
})

-- fish: a blue fish, tail swishing over a ripple.
local FISH_A = A [[
  ...dBBBBB.....
  B..BBBBBBBB...
  BB.BBBBBBBBBB.
  BBBBBBBBBBWKBB
  BB.BBbbbbbBBB.
  B..BBbWWWbBB..
  ...dBBBBBB....
]]
local FISH_B = A [[
  B..dBBBBB.....
  BB.BBBBBBBB...
  BBBBBBBBBBBBB.
  BB.BBBBBBBWKBB
  BB.BBbbbbbBBB.
  B..BBbWWWbBB..
  ...dBBBBBB....
]]
emote("fish", {
  function(c)
    c:spr(FISH_A, 0, -2)
    for _, x in ipairs({ 2, 6, 10 }) do c:px(x, 12, "b"); c:px(x + 1, 12, "b") end
    c:px(7, 14, "C"); c:px(12, 13, "C")
  end,
  function(c)
    c:spr(FISH_B, 0, -3)
    for _, x in ipairs({ 4, 8, 12 }) do c:px(x, 12, "b"); c:px(x + 1, 12, "b") end
    c:px(2, 10, "C"); c:px(14, 9, "C"); c:px(6, 14, "C")
  end,
})

-- flower: a pink blossom on a stem, swaying.
local function flowerFrame(c, sway, spin)
  c:line(8, 15, 8 + sway, 8, "N"); c:line(9, 15, 9 + sway, 9, "n")
  c:spr(A [[
    ..N
    .NNN
    .NN.
  ]], 2 + sway, 4)
  local cx, cy = 8 + sway, 6
  for i = 0, 4 do
    local a = (i / 5 + spin) * math.pi * 2 - math.pi / 2
    c:disc(cx + math.cos(a) * 3.1, cy + math.sin(a) * 3.1, 2.1, "p", "P")
  end
  c:disc(cx, cy, 1.9, "Y", "y")
end
emote("flower", {
  function(c) flowerFrame(c, 0, 0) end,
  function(c) flowerFrame(c, 1, 0.06) end,
})

-- music: beamed eighth notes bobbing.
local NOTES = A [[
  ...BBBBBBB
  ...BBBBBBB
  ...B.....B
  ...B.....B
  ...B.....B
  ...B.....B
  .bbB...bbB
  bbBBB.bbBBB
  .BBB...BBB.
]]
emote("music", {
  function(c) c:spr(NOTES, 0, 1) end,
  function(c) c:spr(NOTES, 0, 0, 1) end,
  function(c) c:spr(NOTES, 0, -1, -1) end,
})

-- sweat: a big drop sliding down with a small one flicking off.
local DROP = A [[
  ...b...
  ...B...
  ..BBB..
  ..BBB..
  .BBBBB.
  .BWBBB.
  BBWBBBB
  BBBBBBB
  BBBBBBd
  .BBBBd.
]]
local DROP_SM = A [[
  .b.
  BBB
  BBd
]]
emote("sweat", {
  function(c) c:spr(DROP, 2, -3); c:spr(DROP_SM, -5, 1) end,
  function(c) c:spr(DROP, 2, 0); c:spr(DROP_SM, -5, 4) end,
  function(c) c:spr(DROP, 2, 3); c:spr(DROP_SM, -5, 6) end,
})

-- money: a coin sack with a $ that glints.
local BAG = A [[
  ..TT..TT..
  ...TTTT...
  ...RRRR...
  ..TTTTTT..
  .TTTTTTTTt
  TTTT.NNTTt
  TTT.N...Tt
  TTTT.N..Tt
  TTTT..N.Tt
  TTT.NN..Tt
  TTTT.N.TTt
  .TTTTTTTt.
]]
emote("money", {
  function(c) c:spr(BAG, 0, 0); c:px(12, 3, "Y"); c:px(13, 2, "W"); c:px(13, 4, "W") end,
  function(c) c:spr(BAG, 0, -1); c:px(2, 3, "Y"); c:px(1, 2, "W"); c:px(1, 4, "W") end,
})

-- skull: a grinning skull whose eyes flare red on the second frame.
local SKULL = A [[
  ..WWWWWWWW..
  .WWWWWWWWWw.
  WWWWWWWWWWWw
  WKKKKWWKKKKw
  WKKKKWWKKKKw
  WWKKWWWWKKWw
  .WWWWKKWWWw.
  ..WWWWWWWw..
  ...WKWKWKw..
  ...WKWKWKw..
]]
emote("skull", {
  function(c) c:spr(SKULL, 0, 0) end,
  function(c) c:spr(SKULL, 0, 1); c:px(3, 7, "R"); c:px(4, 7, "R"); c:px(8, 7, "R"); c:px(9, 7, "R") end,
})

-- fire: a three-tongued flame licking left, up, right.
local FIRE_A = A [[
  .....R.....
  ....RR.....
  ....ROR.R..
  ...RROORRR.
  ...ROOOORR.
  ..RROOYOORR
  ..ROOYYYOOR
  .RROOYYYYOR
  .ROOYYWYYOR
  .ROOYYWWYOR
  .RROOYWWYOR
  ..RROOYYORR
  ...RROOORR.
]]
local FIRE_B = A [[
  ......R....
  ......RR...
  ..R...ROR..
  ..RR.RROOR.
  ..RROROOOR.
  .RROOOOYOR.
  .ROOOYYYOOR
  .ROOYYYYYOR
  .ROOYYWYYOR
  .ROOYYWWYOR
  .RROOYWWYOR
  ..RROOYYORR
  ...RROOORR.
]]
local FIRE_C = A [[
  ....R......
  ....RR.....
  ...ROR..R..
  ..RROR.RR..
  ..ROOR.ROR.
  ..ROOORROR.
  .RROOOOOOR.
  .ROOOYYOOOR
  .ROOYYYYYOR
  .ROOYYWYYOR
  .ROOYYWWYOR
  ..ROOYWWYOR
  ..RROOYYORR
  ...RROOORR.
]]
emote("fire", {
  function(c) c:spr(FIRE_A, 0, 1) end,
  function(c) c:spr(FIRE_B, 0, 1) end,
  function(c) c:spr(FIRE_C, 0, 1) end,
})

-- star: a gold star that glints.
local STAR5 = A [[
  ......Y......
  ......Y......
  .....YYY.....
  .....YYY.....
  YYYYYYYYYYYYY
  .YYYYYYYYYYYy
  ..YYYYYYYYYy.
  ...YYYYYYYy..
  ...YYYYYYYy..
  ..YYYYyYYYYy.
  ..YYYy..yYYy.
  .YYy......yY.
]]
emote("star", {
  function(c) c:spr(STAR5, 0, 0) end,
  function(c) c:spr(STAR5, 0, 0); c:px(5, 5, "W"); c:px(4, 5, "W"); c:px(5, 4, "W"); c:px(6, 5, "W"); c:px(5, 6, "W") end,
  function(c) c:spr(STAR5, 0, -1, 0, { Y = "Y" }); c:px(9, 6, "W"); c:px(9, 5, "W") end,
})

-- drink: a foaming beer mug, tipping and slopping.
local MUG = A [[
  ..WW.WW.W...
  .WWWWWWWWW..
  .WWWWWWWWW..
  .YYYYYYYYY..
  .YlYYYYYYYTT
  .YlYYYYYYYT.T
  .YYYYYYYYYT.T
  .YYYYYYYYYT.T
  .YYYYYYYYYTT.
  .yYYYYYYYy..
  ..yyyyyyy...
]]
emote("drink", {
  function(c) c:spr(MUG, 0, 0) end,
  function(c) c:spr(MUG, 0, 0, 1); c:px(1, 5, "W"); c:px(0, 6, "W") end,
})

-- sick: a green face, queasy wobble, cold sweat.
local function sickFace(c, dx, wave)
  face(c, 8, "l", "N")
  c:rect(4 + dx, 6, 3, 1, "K"); c:rect(9 + dx, 6, 3, 1, "K")
  c:rect(4 + dx, 7, 3, 1, "n"); c:rect(9 + dx, 7, 3, 1, "n")
  local m = wave and { 1, 0, 1, 0, 1, 0 } or { 0, 1, 0, 1, 0, 1 }
  for i = 1, 6 do c:px(4 + i + dx, 10 + m[i], "K") end
  c:px(13, 3, "C"); c:px(13, 4, "b")
end
emote("sick", {
  function(c) sickFace(c, 0, true) end,
  function(c) sickFace(c, 1, false) end,
})

-- think: a cloud with trailing bubbles; the dots fill in.
local function cloud(c, dots)
  c:spr(A [[
    ...WWW.WW....
    ..WWWWWWWWW..
    .WWWWWWWWWWW.
    WWWWWWWWWWWWw
    WWWWWWWWWWWWw
    .WWWWWWWWWWw.
    ..wwWWWWWwww.
  ]], 0, -2)
  c:rect(2, 10, 2, 2, "W"); c:px(1, 13, "W")
  for i = 1, dots do c:rect(2 + i * 3, 4, 2, 2, "G") end
end
emote("think", {
  function(c) cloud(c, 1) end,
  function(c) cloud(c, 2) end,
  function(c) cloud(c, 3) end,
})

-- work: a hammer winding up, striking, and shedding sparks.
local HAMMER = A [[
  .gggggg.....
  gWWggGGg....
  gWGGGGGg....
  .gggggg.....
  ...tt.......
  ....tt......
  .....tt.....
  ......tt....
  .......tt...
  ........tt..
]]
emote("work", {
  function(c) c:spr(HAMMER, 0, -2, 0) end,
  function(c) c:spr(HAMMER, 1, 1, 0) end,
  function(c) c:spr(HAMMER, 1, 2, 0); c:px(2, 11, "Y"); c:px(1, 9, "Y"); c:px(4, 13, "O"); c:px(1, 12, "W") end,
})

-- gift: a wrapped box; the lid pops on the second frame.
local BOX = A [[
  ..YYY..YYY..
  .YYYYYYYYYY.
  ..YYYYYYYY..
  RRRRRYYRRRRr
  RRRRRYYRRRRr
  RRRRRYYRRRRr
  RRRRRYYRRRRr
  RRRRRYYRRRRr
  rrrrrYYrrrrr
]]
local BOX_LID = A [[
  ..YYY..YYY..
  .YYYYYYYYYY.
  RRRRRYYRRRRr
  rrrrrYYrrrrr
]]
local BOX_BASE = A [[
  RRRRRYYRRRRr
  RRRRRYYRRRRr
  RRRRRYYRRRRr
  RRRRRYYRRRRr
  rrrrrYYrrrrr
]]
emote("gift", {
  function(c) c:spr(BOX, 0, 1) end,
  function(c)
    c:spr(BOX_BASE, 0, 4)
    c:spr(BOX_LID, 0, -4)
    c:px(7, 5, "W"); c:px(8, 4, "Y"); c:px(9, 5, "W"); c:px(8, 6, "Y")
  end,
})

-- handcuffs: two steel cuffs on a chain; they clink together.
local function cuffs(c, gap)
  -- Two cuffs on a diagonal so the whole 14px square is used: a wide open ring at the top left,
  -- one at the bottom right, and a chain of links between them. `gap` = 1 draws the chain slack.
  local a, b = 4.6 + gap * -0.6, 11.4 + gap * 0.6
  c:ring(a, a, 3.3, 1.5, "w", "g")
  c:ring(b, b, 3.3, 1.5, "w", "g")
  c:px(a - 1, a - 2, "W"); c:px(a - 2, a - 1, "W")
  c:px(b - 1, b - 2, "W"); c:px(b - 2, b - 1, "W")
  -- Ratchet teeth on the outer edge of each cuff.
  c:rect(a - 1, a - 4, 3, 1, "G"); c:rect(b - 1, b + 3, 3, 1, "G")
  local links = gap == 1
    and { { 7, 7 }, { 8, 7 }, { 8, 8 }, { 7, 8 }, { 9, 9 } }
    or  { { 6, 7 }, { 7, 7 }, { 8, 8 }, { 9, 8 }, { 8, 9 }, { 7, 6 } }
  for i, p in ipairs(links) do c:px(p[1], p[2], i % 2 == 0 and "W" or "w") end
end
emote("handcuffs", {
  function(c) cuffs(c, 1) end,
  function(c) cuffs(c, 0); c:px(1, 12, "Y"); c:px(14, 3, "Y"); c:px(13, 1, "W"); c:px(2, 14, "W") end,
})

-- whisper: a small speech bubble of curly lines, hushed.
local function whisperBubble(c, ph)
  c:spr(A [[
    .WWWWWWWWWW.
    WWWWWWWWWWWw
    WWWWWWWWWWWw
    WWWWWWWWWWWw
    WWWWWWWWWWWw
    .WWWWWWWWWw.
    ..WWWWwwww..
    ...WWw......
    ...Ww.......
  ]], 0, -1)
  local rows = { 4, 6, 8 }
  for k, y in ipairs(rows) do
    for i = 0, 6 do
      local yy = y + (((i + k + ph) % 4) < 2 and 0 or 1) - 1
      c:px(3 + i, yy + 1, "b")
    end
  end
end
emote("whisper", {
  function(c) whisperBubble(c, 0) end,
  function(c) whisperBubble(c, 1) end,
  function(c) whisperBubble(c, 2) end,
})

-- levelup: a green arrow shooting up in a shower of stars.
local ARROW = A [[
  ....N....
  ...lNN...
  ..lNNNN..
  .lNNNNNN.
  lNNNNNNNN
  ..lNNNn..
  ..lNNNn..
  ..lNNNn..
  ..lNNNn..
]]
emote("levelup", {
  function(c) c:spr(ARROW, 0, 3) end,
  function(c) c:spr(ARROW, 0, 1); c:px(2, 10, "Y"); c:px(13, 9, "Y") end,
  function(c) c:spr(ARROW, 0, -1); c:spr(STAR_TINY, -5, 4); c:spr(STAR_TINY, 5, 1) end,
  function(c) c:spr(ARROW, 0, -2); c:px(3, 4, "Y"); c:px(12, 6, "Y"); c:px(2, 9, "W"); c:px(13, 3, "W") end,
})

-- candle: a lit candle, the flame guttering.
local function candle(c, f)
  c:spr(A [[
    wWWWw
    WWWWw
    WWWWw
    WWWWw
    WWWWw
    WwWWw
    wwwww
  ]], 0, 4)
  c:px(8, 6, "K")
  local flames = {
    { { 8, 2, "O" }, { 8, 3, "Y" }, { 8, 4, "Y" }, { 7, 4, "O" }, { 9, 4, "O" }, { 8, 5, "W" } },
    { { 9, 2, "O" }, { 8, 3, "Y" }, { 8, 4, "Y" }, { 7, 4, "O" }, { 9, 4, "O" }, { 8, 5, "W" } },
    { { 7, 2, "O" }, { 8, 3, "Y" }, { 8, 4, "Y" }, { 7, 4, "O" }, { 9, 4, "O" }, { 8, 5, "W" } },
  }
  for _, p in ipairs(flames[f]) do c:px(p[1], p[2], p[3]) end
end
emote("candle", {
  function(c) candle(c, 1) end,
  function(c) candle(c, 2) end,
  function(c) candle(c, 3) end,
})

-- cake: a two-tier cake with a flickering candle.
local function cake(c, flick)
  c:spr(A [[
    .ppppppppp.
    pppppppppppp
    .pWpWpWpWpp.
    TTTTTTTTTTTt
    TtTtTtTtTtTt
    TTTTTTTTTTTt
    RRRRRRRRRRRr
    rrrrrrrrrrrr
  ]], 0, 3)
  c:rect(8, 2, 1, 4, "R")
  c:px(8, 1, flick and "Y" or "O"); c:px(8, 0 + 1, flick and "Y" or "O")
  if flick then c:px(8, 0, "O") end
end
emote("cake", {
  function(c) cake(c, true) end,
  function(c) cake(c, false) end,
})

-- broken_heart: the big heart splitting along a zigzag and drifting apart.
local function brokenHeart(c, gap, drop)
  local crack = { 5, 6, 5, 6, 5, 6, 5, 6, 5, 5 }
  local x0, y0 = (S - 11) // 2, (S - 10) // 2
  for j, r in ipairs(HEART_BIG) do
    local cx = crack[j]
    for i = 1, #r do
      local ch = r:sub(i, i)
      if ch ~= "." then
        local px = x0 + i - 1
        if i - 1 < cx then
          c:px(px - gap, y0 + j - 1, ch)
        elseif i - 1 > cx then
          c:px(px + gap, y0 + j - 1 + drop, ch)
        end
      end
    end
  end
end
emote("broken_heart", {
  function(c) brokenHeart(c, 0, 0) end,
  function(c) brokenHeart(c, 1, 0) end,
  function(c) brokenHeart(c, 2, 1); c:px(8, 13, "r"); c:px(9, 14, "r") end,
})

-- dizzy: a cyan spiral turning, a few gold stars twinkling round it.
local function dizzy(c, ph)
  local turns, rmax = 1.9, 5.6
  local steps = 220
  for i = 0, steps do
    local t = i / steps
    local r = 0.7 + t * rmax
    local a = t * turns * math.pi * 2 + ph * math.pi * 2
    local x, y = 8 + math.cos(a) * r, 8 + math.sin(a) * r
    c:px(x, y, t > 0.55 and "C" or "b")
  end
  local twinkle = { { 2, 2 }, { 13, 3 }, { 13, 13 }, { 2, 13 } }
  for k, p in ipairs(twinkle) do
    if (k + math.floor(ph * 3 + 0.5)) % 2 == 0 then c:px(p[1], p[2], "Y") end
  end
end
emote("dizzy", {
  function(c) dizzy(c, 0.0) end,
  function(c) dizzy(c, 0.33) end,
  function(c) dizzy(c, 0.66) end,
})

-- ── Output ──────────────────────────────────────────────────────────────────────────────────

local dir = app.params.dir or "public/sprites/fx"
app.fs.makeAllDirectories(dir)

local cells, tags = {}, {}
for _, e in ipairs(E) do
  local first = #cells + 1
  for _, fn in ipairs(e[2]) do
    local c = newCanvas()
    fn(c)
    cells[#cells + 1] = c:finish()
  end
  tags[#tags + 1] = { e[1], first, #cells }
end

local spr = Sprite(S, S, ColorMode.RGB)
spr.filename = "emotes"
for _ = 2, #cells do spr:newEmptyFrame() end
for i, img in ipairs(cells) do spr:newCel(spr.layers[1], spr.frames[i], img, Point(0, 0)) end
for _, t in ipairs(tags) do
  local tag = spr:newTag(t[2], t[3]); tag.name = t[1]
end
spr:saveAs(app.fs.joinPath(dir, "emotes.aseprite"))
spr:close()

local strip = Image(S * #cells, S, ColorMode.RGB)
strip:clear(0)
for i, img in ipairs(cells) do strip:drawImage(img, Point((i - 1) * S, 0)) end
strip:saveAs(app.fs.joinPath(dir, "emotes.png"))
print(#E .. " emotes, " .. #cells .. " cells")
