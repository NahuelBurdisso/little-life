-- player-fx.lua — the canvas's answers to what the PLAYER does: nudges, gifts of coins, secrets,
-- confrontations, newcomers, farewells and world events (systems/playerFx/).
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/fx --script scripts/aseprite/player-fx.lua
--
-- Writes two strips (each also as .aseprite, one frame per cell, tagged per effect):
--   playerfx.png        32x32 cells. Layout — keep in sync with PFX_ANIMS in
--                       src/components/canvas/systems/playerFx/playerFxFrames.ts (a vitest test parses this line):
--
-- LAYOUT: speech:4 coin:4 coinSparkle:3 swirl:4 clash:5 column:6 suitcase:1 confetti:4 poof:5 pin:2 groundRing:4 burst:5 dotPink:1 dotPinkBig:1 dotHeart:1 dotGold:1 dotGoldBig:1
--
--   speech      speech bubble, blue "..." typing 1-2-3-2 dots (suggest_talk)
--   coin        gold coin spinning: face, three-quarter, edge, three-quarter (give_money)
--   coinSparkle gold glint where a coin lands / a pin is reached
--   swirl       lavender spiral, one full turn over the 4 cells (tell_secret flies it across)
--   clash       two swords swing together, cross in a white flash with lightning, sparks die out
--   column      pillar of light with rising glints (introduce_agent)
--   suitcase    a tan suitcase with gold latches, base at the cell's lower edge
--   confetti    a burst that flies up and falls back, fading
--   poof        dust cloud that swallows the agent that leaves (remove_agent)
--   pin         red map pin, tip at the bottom; cell 1 glints (suggest_go_to)
--   groundRing  dashed gold ring that rotates a quarter of a dash per cell; squashed on the ground
--   burst       golden shock ring with rays (world event at a location); scaled up in code
--   dot*        arc/line dots: pink for the matchmaker arc, gold for the go-to trail
--
--   playerfxdigits.png  10x10 cells: "0".."9" then "+", the gold numbers that float up on a gift.
--
-- Same look as beat-fx.lua: effects are the foreground, brighter than the world, with the 1px
-- near-black outline (#1a1510) — soft things (light beam, dust) get a tinted outline or none.
-- Drawing is procedural and seeded, so rerunning the script reproduces the PNGs byte for byte.

local S = 32
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end

local seed = 23
local function rand()
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
end

-- ── Palette (24 swatches; everything below is drawn from these) ─────────────────────────────
local OUT      = hex(0x1a1510)
local GOLD, GOLD_LT, GOLD_DK, GOLD_OUT = hex(0xf5c518), hex(0xfff3a0), hex(0xc09020), hex(0x8a5a10)
local WHITE    = hex(0xffffff)
local PAPER, PAPER_DK = hex(0xfbf6ea), hex(0xc9c5bd)
local BLUE, BLUE_LT = hex(0x2f7be0), hex(0x7cc4ff)
local PINK, PINK_LT = hex(0xf07090), hex(0xffb0c8)
local RED, RED_DK, RED_LT = hex(0xd83a3a), hex(0x8a2a2a), hex(0xf06a5a)
local LAV, LAV_MD, LAV_DK = hex(0xf0eaff), hex(0xb4a4ec), hex(0x5a4a90)
local STEEL, STEEL_LT = hex(0x8a929c), hex(0xd0d8e0)
local HILT     = hex(0x6a4322)
local TAN, TAN_LT, TAN_DK = hex(0xc8884c), hex(0xe6c58c), hex(0x8a5a30)
local DUST = { hex(0x6a5c48), hex(0x9a8a70), hex(0xc0b294), hex(0xe4d8bc) }
local DUST_OUT = hex(0x3a2e22)
local CONFETTI = { hex(0x4ac8e0), PINK, GOLD, hex(0x8ae05a) }

-- ── Canvas primitives (same as beat-fx.lua; a canvas is a sparse table y*S+x+1 -> colour) ───
local function canvas() return {} end
local function put(cv, x, y, col)
  x, y = math.floor(x), math.floor(y)
  if x >= 0 and y >= 0 and x < S and y < S then cv[y * S + x + 1] = col end
end
local function get(cv, x, y)
  if x < 0 or y < 0 or x >= S or y >= S then return nil end
  return cv[y * S + x + 1]
end
local function rect(cv, x, y, w, h, col)
  for yy = y, y + h - 1 do for xx = x, x + w - 1 do put(cv, xx, yy, col) end end
end
local function disc(cv, cx, cy, r, col)
  for yy = math.floor(cy - r), math.ceil(cy + r) do
    for xx = math.floor(cx - r), math.ceil(cx + r) do
      local dx, dy = xx + 0.5 - cx, yy + 0.5 - cy
      if dx * dx + dy * dy <= r * r then put(cv, xx, yy, col) end
    end
  end
end
local function ellipse(cv, cx, cy, rx, ry, col)
  for yy = math.floor(cy - ry), math.ceil(cy + ry) do
    for xx = math.floor(cx - rx), math.ceil(cx + rx) do
      local dx, dy = (xx + 0.5 - cx) / rx, (yy + 0.5 - cy) / ry
      if dx * dx + dy * dy <= 1 then put(cv, xx, yy, col) end
    end
  end
end
local function ring(cv, cx, cy, r0, r1, col)
  for yy = math.floor(cy - r1), math.ceil(cy + r1) do
    for xx = math.floor(cx - r1), math.ceil(cx + r1) do
      local dx, dy = xx + 0.5 - cx, yy + 0.5 - cy
      local d = dx * dx + dy * dy
      if d <= r1 * r1 and d >= r0 * r0 then put(cv, xx, yy, col) end
    end
  end
end
local function line(cv, x0, y0, x1, y1, col)
  x0, y0, x1, y1 = math.floor(x0), math.floor(y0), math.floor(x1), math.floor(y1)
  local dx, dy = math.abs(x1 - x0), -math.abs(y1 - y0)
  local sx, sy = x0 < x1 and 1 or -1, y0 < y1 and 1 or -1
  local err = dx + dy
  while true do
    put(cv, x0, y0, col)
    if x0 == x1 and y0 == y1 then break end
    local e2 = 2 * err
    if e2 >= dy then err = err + dy; x0 = x0 + sx end
    if e2 <= dx then err = err + dx; y0 = y0 + sy end
  end
end
local function poly(cv, pts, col)
  local minY, maxY = S, 0
  for _, p in ipairs(pts) do minY = math.min(minY, p[2]); maxY = math.max(maxY, p[2]) end
  for yy = math.max(0, math.floor(minY)), math.min(S - 1, math.ceil(maxY)) do
    for xx = 0, S - 1 do
      local px, py = xx + 0.5, yy + 0.5
      local inside = false
      local j = #pts
      for i = 1, #pts do
        local xi, yi, xj, yj = pts[i][1], pts[i][2], pts[j][1], pts[j][2]
        if (yi > py) ~= (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi then inside = not inside end
        j = i
      end
      if inside then put(cv, xx, yy, col) end
    end
  end
end
local function star(cv, cx, cy, R, r, col)
  local pts = {}
  for i = 0, 9 do
    local a = -math.pi / 2 + i * math.pi / 5
    local rad = (i % 2 == 0) and R or r
    pts[#pts + 1] = { cx + math.cos(a) * rad, cy + math.sin(a) * rad }
  end
  poly(cv, pts, col)
end
local function pattern(cv, x, y, rows, map)
  for j, row in ipairs(rows) do
    for i = 1, #row do
      local ch = row:sub(i, i)
      if map[ch] then put(cv, x + i - 1, y + j - 1, map[ch]) end
    end
  end
end
-- 1px outline on EMPTY pixels 4-adjacent to painted ones, so the fill keeps its size.
local function outline(cv, col)
  local add = {}
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      if not get(cv, x, y) then
        if get(cv, x - 1, y) or get(cv, x + 1, y) or get(cv, x, y - 1) or get(cv, x, y + 1) then
          add[#add + 1] = { x, y }
        end
      end
    end
  end
  for _, p in ipairs(add) do put(cv, p[1], p[2], col) end
end
local function stamp(dst, src)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local c = get(src, x, y)
      if c then put(dst, x, y, c) end
    end
  end
end
local function fade(cv, f)
  for i, c in pairs(cv) do
    cv[i] = pc.rgba(pc.rgbaR(c), pc.rgbaG(c), pc.rgbaB(c), math.floor(pc.rgbaA(c) * f))
  end
end
local function sparkle(cv, cx, cy, n, arm, core)
  for i = 1, n do
    put(cv, cx - i, cy, arm); put(cv, cx + i, cy, arm)
    put(cv, cx, cy - i, arm); put(cv, cx, cy + i, arm)
  end
  put(cv, cx, cy, core)
end
-- An outlined sparkle stamped onto `cv`, optionally faded.
local function glint(cv, cx, cy, n, a)
  local sp = canvas()
  sparkle(sp, cx, cy, n, GOLD, WHITE)
  outline(sp, OUT)
  if a and a < 1 then fade(sp, a) end
  stamp(cv, sp)
end
local function lobeAt(lobes, x, y)
  local best, bestD = nil, 99
  for _, l in ipairs(lobes) do
    local dx, dy = (x + 0.5 - l[1]) / l[3], (y + 0.5 - l[2]) / l[3]
    local d = dx * dx + dy * dy
    if d <= 1 and d < bestD then best, bestD = l, d end
  end
  return best
end
local function shadedLobes(cv, lobes, ramp)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local l = lobeAt(lobes, x, y)
      if l then
        local nx, ny = (x + 0.5 - l[1]) / l[3], (y + 0.5 - l[2]) / l[3]
        local lit = -(nx * 0.6 + ny * 0.8)
        local t = lit > 0.45 and 4 or lit > 0.05 and 3 or lit > -0.45 and 2 or 1
        put(cv, x, y, ramp[t])
      end
    end
  end
end

-- ── Effects ──────────────────────────────────────────────────────────────────────────────────

-- Speech bubble with typing dots; the tail points down-left at the speaker's head.
local function speech(t)
  local cv, b = canvas(), canvas()
  rect(b, 6, 7, 20, 14, PAPER)
  rect(b, 5, 8, 22, 12, PAPER)
  rect(b, 10, 21, 4, 1, PAPER); rect(b, 10, 22, 3, 1, PAPER); rect(b, 10, 23, 2, 1, PAPER); put(b, 10, 24, PAPER)
  for x = 6, 25 do put(b, x, 20, PAPER_DK) end
  for y = 8, 19 do put(b, 26, y, PAPER_DK) end
  outline(b, OUT)
  stamp(cv, b)
  local n = ({ 1, 2, 3, 2 })[t + 1]
  for i = 0, n - 1 do
    local x = 10 + i * 5
    rect(cv, x, 12, 3, 3, BLUE)
    put(cv, x, 12, BLUE_LT)
  end
  return cv
end

-- Spinning coin: the ellipse narrows to an edge and widens again; the face has a "$"-ish slot.
local function coin(t)
  local rx = ({ 6, 4, 1.5, 4 })[t + 1]
  local mirror = t == 3 and -1 or 1
  local c = canvas()
  ellipse(c, 16, 16, rx, 6, GOLD)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      if get(c, x, y) then
        local dx, dy = mirror * (x + 0.5 - 16) / math.max(rx, 1), (y + 0.5 - 16) / 6
        if dx + dy > 0.9 then put(c, x, y, GOLD_DK) elseif dx + dy < -0.8 then put(c, x, y, GOLD_LT) end
      end
    end
  end
  if t == 0 then
    rect(c, 15, 13, 2, 6, GOLD_DK); rect(c, 14, 15, 4, 1, GOLD_DK)
  elseif t == 1 or t == 3 then
    rect(c, 16, 13, 1, 6, GOLD_DK)
  end
  outline(c, OUT)
  return c
end

local function coinSparkle(t)
  local cv = canvas()
  if t == 0 then
    glint(cv, 16, 16, 2)
  elseif t == 1 then
    glint(cv, 16, 16, 3)
    for _, d in ipairs({ { -5, -5 }, { 5, -5 }, { -5, 5 }, { 5, 5 } }) do put(cv, 16 + d[1], 16 + d[2], GOLD_LT) end
  else
    for _, p in ipairs({ { 9, 9 }, { 23, 9 }, { 9, 23 }, { 23, 23 } }) do glint(cv, p[1], p[2], 1, 0.7) end
  end
  return cv
end

-- A spiral that makes exactly one full turn over the four cells, so the loop is seamless.
local function swirl(t)
  local cv = canvas()
  local rot = t * math.pi / 2
  local steps = 44
  for i = 0, steps do
    local s = i / steps
    local a = s * math.pi * 5 + rot
    local r = 1.2 + s * 8.5
    local x, y = 16 + math.cos(a) * r, 16 + math.sin(a) * r
    local col = s < 0.45 and LAV_MD or LAV
    rect(cv, math.floor(x), math.floor(y), 2, 2, col)
  end
  disc(cv, 16, 16, 1.6, WHITE)
  outline(cv, LAV_DK)
  return cv
end

-- Crossed swords. `off` is the horizontal gap of each sword's midpoint from the centre while
-- they are still closing in; `ang` how far each blade leans from vertical.
local function sword(cv, side, off, ang)
  local a = side * ang
  local dx, dy = math.sin(a), -math.cos(a)
  local px, py = -dy, dx
  -- Midpoint of the blade sits at (16 + side*off, 17).
  local ox, oy = 16 + side * off - dx * 6, 17 - dy * 6
  local sw = canvas()
  for i = 2, 12 do
    local x, y = ox + dx * i, oy + dy * i
    put(sw, x, y, STEEL_LT)
    if math.abs(dx) > math.abs(dy) then put(sw, x, y + 1, STEEL) else put(sw, x + 1, y, STEEL) end
  end
  for i = -4, 1 do put(sw, ox + dx * i, oy + dy * i, HILT) end
  for k = -3, 3 do put(sw, ox + dx * 1.6 + px * k, oy + dy * 1.6 + py * k, GOLD) end
  disc(sw, ox - dx * 5, oy - dy * 5, 1.2, GOLD_DK)
  outline(sw, OUT)
  stamp(cv, sw)
end
local function bolt(cv, pts, col)
  for i = 1, #pts - 1 do line(cv, pts[i][1], pts[i][2], pts[i + 1][1], pts[i + 1][2], col) end
end
local function clash(t)
  local cv = canvas()
  local off = ({ 8, 4, 0, 0, 0 })[t + 1]
  local ang = ({ math.rad(20), math.rad(34), math.rad(42), math.rad(40), math.rad(38) })[t + 1]
  if t == 2 then
    -- The impact flash sits BEHIND the blades so the crossing stays readable.
    local f = canvas()
    star(f, 16, 17, 8, 3.5, WHITE)
    outline(f, GOLD)
    stamp(cv, f)
  end
  local swords = canvas()
  sword(swords, -1, off, ang); sword(swords, 1, off, ang)
  if t == 4 then fade(swords, 0.75) end
  stamp(cv, swords)
  if t == 2 or t == 3 then
    -- Lightning: short yellow zigzags leaving the crossing.
    local bl = canvas()
    bolt(bl, { { 13, 11 }, { 15, 9 }, { 12, 5 } }, GOLD_LT)
    bolt(bl, { { 19, 11 }, { 17, 9 }, { 20, 5 } }, GOLD_LT)
    bolt(bl, { { 6, 18 }, { 8, 16 }, { 4, 14 } }, GOLD_LT)
    bolt(bl, { { 26, 18 }, { 24, 16 }, { 28, 14 } }, GOLD_LT)
    outline(bl, GOLD_OUT)
    stamp(cv, bl)
  end
  if t >= 3 then
    local a = t == 4 and 0.55 or 1
    glint(cv, 5, 7, 1, a); glint(cv, 27, 7, 1, a); glint(cv, 4, 25, 1, a); glint(cv, 28, 25, 1, a)
    if t == 3 then glint(cv, 16, 4, 2, a) end
  end
  return cv
end

-- Pillar of light. Grows from the ground, holds, dims; glints rise inside it.
local function column(t)
  local cv = canvas()
  local top = ({ 22, 9, 3, 3, 3, 3 })[t + 1]
  local f = ({ 0.95, 1, 1, 0.85, 0.55, 0.25 })[t + 1]
  local baseY = 29
  local beam = canvas()
  for y = top, baseY do
    local k = (baseY - y) / math.max(1, baseY - top)
    local hw = 4 - k * 2
    local a = (1 - k * 0.5) * f
    for x = math.floor(16 - hw), math.ceil(15 + hw) do
      local inner = math.abs(x + 0.5 - 16) < hw * 0.5
      put(beam, x, y, inner and pc.rgba(0xff, 0xff, 0xff, math.floor(255 * a))
                             or pc.rgba(0xff, 0xe0, 0x60, math.floor(230 * a)))
    end
  end
  stamp(cv, beam)
  local glow = canvas()
  ellipse(glow, 16, baseY, 8, 2.5, hex(0xf5c518, 200))
  fade(glow, f)
  stamp(cv, glow)
  local spots = { { 9, 26 }, { 22, 22 }, { 12, 18 }, { 21, 13 } }
  for _, p in ipairs(spots) do
    local y = p[2] - t * 3.5
    if y > 3 and t < 5 then glint(cv, p[1], math.floor(y), 1, f) end
  end
  if t <= 1 then glint(cv, 16, math.max(4, top - 2), 2, 1) end
  return cv
end

local function suitcase(_)
  local cv, b = canvas(), canvas()
  rect(b, 9, 14, 14, 10, TAN)
  rect(b, 9, 14, 14, 2, TAN_LT)
  rect(b, 9, 22, 14, 2, TAN_DK)
  rect(b, 20, 16, 3, 6, TAN_DK)
  rect(b, 9, 18, 14, 1, TAN_DK)
  rect(b, 12, 17, 2, 3, GOLD); rect(b, 18, 17, 2, 3, GOLD)
  put(b, 12, 17, GOLD_LT); put(b, 18, 17, GOLD_LT)
  -- Handle: a hollow loop on the lid.
  rect(b, 13, 11, 6, 1, HILT)
  rect(b, 13, 12, 1, 2, HILT); rect(b, 18, 12, 1, 2, HILT)
  outline(b, OUT)
  stamp(cv, b)
  return cv
end

-- Confetti thrown up from the ground and pulled back down; seeded so it is the same every run.
local pieces
local function confetti(t)
  if not pieces then
    pieces = {}
    for k = 1, 16 do
      pieces[k] = { a = -math.pi * (0.12 + 0.76 * rand()), v = 3.2 + 3.4 * rand(), c = CONFETTI[1 + k % #CONFETTI] }
    end
  end
  local cv = canvas()
  for _, p in ipairs(pieces) do
    local x = 16 + math.cos(p.a) * p.v * t * 1.5
    local y = 24 + math.sin(p.a) * p.v * t * 1.5 + 1.6 * t * t
    if t == 0 then x, y = 16 + (p.v - 5) * 0.6, 24 end
    rect(cv, x, y, t == 3 and 1 or 2, 2, p.c)
  end
  if t == 3 then fade(cv, 0.65) end
  return cv
end

local function poof(t)
  local R = ({ 5, 8, 11, 13, 14 })[t + 1]
  local cv = canvas()
  local lobes = { { 16, 17, R * 0.5 + 1 } }
  local spread = t >= 3 and 0.85 or 0.66
  for k = 0, 6 do
    local a = t * 0.7 + k * 2 * math.pi / 7
    local d = spread * (k % 2 == 0 and 1 or 0.78)
    lobes[#lobes + 1] = { 16 + math.cos(a) * R * d, 17 + math.sin(a) * R * d * 0.8, R * (t >= 3 and 0.26 or 0.34) * (k % 2 == 0 and 1 or 1.15) }
  end
  shadedLobes(cv, lobes, DUST)
  outline(cv, DUST_OUT)
  if t == 3 then fade(cv, 0.75) elseif t == 4 then fade(cv, 0.42) end
  if t <= 2 then glint(cv, 16, 17 - R - 1, 1) end
  return cv
end

-- Map pin, tip at (16,28). Cell 1 adds a glint so the marker seems to shine.
local function pin(t)
  local cv, p = canvas(), canvas()
  disc(p, 16, 12, 6.5, RED)
  poly(p, { { 10.5, 15 }, { 21.5, 15 }, { 16, 28 } }, RED)
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      if get(p, x, y) then
        local lit = (x + 0.5 - 16) + (y + 0.5 - 12)
        if lit > 5 then put(p, x, y, RED_DK) elseif lit < -4 then put(p, x, y, RED_LT) end
      end
    end
  end
  disc(p, 16, 12, 2.4, PAPER)
  put(p, 12, 9, WHITE); put(p, 13, 8, WHITE)
  outline(p, OUT)
  stamp(cv, p)
  if t == 1 then glint(cv, 24, 6, 1) end
  return cv
end

-- Dashed ring: 8 dashes, so a quarter of a dash per cell loops after 4 cells.
local function groundRing(t)
  local cv = canvas()
  local rot = t * (2 * math.pi / 16) / 4 * 2
  disc(cv, 16, 16, 12, hex(0xf5c518, 46))
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local dx, dy = x + 0.5 - 16, y + 0.5 - 16
      local d = math.sqrt(dx * dx + dy * dy)
      if d >= 11 and d <= 14 then
        local a = math.atan(dy, dx) + math.pi + rot
        if math.floor(a / (2 * math.pi / 16)) % 2 == 0 then
          put(cv, x, y, d < 12.4 and GOLD_LT or GOLD)
        else
          cv[y * S + x + 1] = nil
        end
      end
    end
  end
  outline(cv, GOLD_OUT)
  return cv
end

-- Golden shock ring for a world event; the renderer scales it to the building.
local function burst(t)
  local cv = canvas()
  local r = ({ 4, 8.5, 12, 13.8, 14.6 })[t + 1]
  local a = ({ 1, 1, 0.95, 0.7, 0.4 })[t + 1]
  if t <= 1 then disc(cv, 16, 16, r - 1, hex(0xfff3a0, 130)) end
  ring(cv, 16, 16, r - 2, r, GOLD)
  ring(cv, 16, 16, r - 1.3, r - 0.5, GOLD_LT)
  outline(cv, GOLD_OUT)
  local len = ({ 2, 3, 2, 1, 0 })[t + 1]
  if len > 0 then
    for k = 0, 11 do
      local ang = k * math.pi / 6 + math.pi / 12
      local r0, r1 = r + 1.5, r + 1.5 + len
      if r1 < 15.5 then
        line(cv, 16 + math.cos(ang) * r0, 16 + math.sin(ang) * r0, 16 + math.cos(ang) * r1, 16 + math.sin(ang) * r1, GOLD_LT)
      end
    end
  end
  if a < 1 then fade(cv, a) end
  if t >= 1 and t <= 3 then
    for _, d in ipairs({ { -1, -1 }, { 1, -1 }, { -1, 1 }, { 1, 1 } }) do
      local rr = r * 0.7
      glint(cv, math.floor(16 + d[1] * rr), math.floor(16 + d[2] * rr), 1, a)
    end
  end
  return cv
end

local function dotAt(fillCol, lightCol, size)
  return function(_)
    local cv = canvas()
    local o = size == 3 and 14 or 15
    rect(cv, o, o, size, size, fillCol)
    if size == 3 then put(cv, o + 1, o + 1, lightCol) else put(cv, o, o, lightCol) end
    outline(cv, OUT)
    return cv
  end
end
local function dotHeart(_)
  local cv = canvas()
  pattern(cv, 13, 14, { ".X.X.", "XXXXX", ".XXX.", "..X.." }, { X = PINK })
  put(cv, 14, 15, PINK_LT)
  outline(cv, OUT)
  return cv
end

-- ── Digits: 5x7 glyphs, gold with a lit top and a darker foot ────────────────────────────────

local GLYPHS = {
  ["0"] = { ".XXX.", "X...X", "X..XX", "X.X.X", "XX..X", "X...X", ".XXX." },
  ["1"] = { "..X..", ".XX..", "..X..", "..X..", "..X..", "..X..", ".XXX." },
  ["2"] = { ".XXX.", "X...X", "....X", "...X.", "..X..", ".X...", "XXXXX" },
  ["3"] = { "XXXX.", "....X", "....X", ".XXX.", "....X", "....X", "XXXX." },
  ["4"] = { "...X.", "..XX.", ".X.X.", "X..X.", "XXXXX", "...X.", "...X." },
  ["5"] = { "XXXXX", "X....", "XXXX.", "....X", "....X", "X...X", ".XXX." },
  ["6"] = { ".XXX.", "X....", "X....", "XXXX.", "X...X", "X...X", ".XXX." },
  ["7"] = { "XXXXX", "....X", "...X.", "..X..", ".X...", ".X...", ".X..." },
  ["8"] = { ".XXX.", "X...X", "X...X", ".XXX.", "X...X", "X...X", ".XXX." },
  ["9"] = { ".XXX.", "X...X", "X...X", ".XXXX", "....X", "....X", ".XXX." },
  ["+"] = { ".....", "..X..", "..X..", "XXXXX", "..X..", "..X..", "....." },
}
local function glyph(ch)
  return function(_)
    local cv = canvas()
    local rows = GLYPHS[ch]
    for j, row in ipairs(rows) do
      local col = j <= 2 and GOLD_LT or (j <= 5 and GOLD or GOLD_DK)
      for i = 1, #row do
        if row:sub(i, i) == "X" then put(cv, 1 + i, j, col) end
      end
    end
    outline(cv, OUT)
    return cv
  end
end

-- ── Assembly ─────────────────────────────────────────────────────────────────────────────────

local dir = app.params.dir or "public/sprites/fx"
app.fs.makeAllDirectories(dir)

local function build(name, size, anims)
  S = size
  local cells, tags = {}, {}
  for _, a in ipairs(anims) do
    local from = #cells + 1
    for t = 0, a[2] - 1 do
      local cv = a[3](t)
      local img = Image(S, S, ColorMode.RGB)
      img:clear(0)
      for i, c in pairs(cv) do
        local idx = i - 1
        img:drawPixel(idx % S, idx // S, c)
      end
      cells[#cells + 1] = img
    end
    tags[#tags + 1] = { a[1], from, #cells }
  end

  local spr = Sprite(S, S, ColorMode.RGB)
  spr.filename = name
  for i = 2, #cells do spr:newEmptyFrame() end
  for i, img in ipairs(cells) do spr:newCel(spr.layers[1], spr.frames[i], img, Point(0, 0)) end
  for _, tg in ipairs(tags) do
    local tag = spr:newTag(tg[2], tg[3]); tag.name = tg[1]
  end
  spr:saveAs(app.fs.joinPath(dir, name .. ".aseprite"))
  spr:close()

  local strip = Image(S * #cells, S, ColorMode.RGB)
  strip:clear(0)
  for i, img in ipairs(cells) do strip:drawImage(img, Point((i - 1) * S, 0)) end
  strip:saveAs(app.fs.joinPath(dir, name .. ".png"))
  print(name .. ": " .. #cells .. " cells")
end

build("playerfx", 32, {
  { "speech", 4, speech }, { "coin", 4, coin }, { "coinSparkle", 3, coinSparkle }, { "swirl", 4, swirl },
  { "clash", 5, clash }, { "column", 6, column }, { "suitcase", 1, suitcase }, { "confetti", 4, confetti },
  { "poof", 5, poof }, { "pin", 2, pin }, { "groundRing", 4, groundRing }, { "burst", 5, burst },
  { "dotPink", 1, dotAt(PINK, PINK_LT, 2) }, { "dotPinkBig", 1, dotAt(PINK, PINK_LT, 3) },
  { "dotHeart", 1, dotHeart },
  { "dotGold", 1, dotAt(GOLD, GOLD_LT, 2) }, { "dotGoldBig", 1, dotAt(GOLD, GOLD_LT, 3) },
})

local digits = {}
for _, ch in ipairs({ "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+" }) do
  digits[#digits + 1] = { "g" .. (ch == "+" and "plus" or ch), 1, glyph(ch) }
end
build("playerfxdigits", 10, digits)
