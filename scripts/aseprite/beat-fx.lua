-- beat-fx.lua — one-shot story-beat effects drawn over the map (fights, gifts, kisses...).
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/fx --script scripts/aseprite/beat-fx.lua
--
-- Writes beats.aseprite (one frame per cell, tagged per effect) and beats.png, a strip of 32x32
-- cells. Cell order — keep in sync with FX_ANIMS in src/components/canvas/systems/beats/beatFrames.ts:
--
--    0- 5 brawl     dust-cloud scuffle with fists, boots and stars
--    6-10 gift      0 = closed box (the flying sprite), 1-4 = lid pops, confetti
--   11-15 heart     heart grows, mini hearts burst out
--   16-20 broken    heart cracks and the halves fall apart
--   21-24 cuffs     handcuffs swing shut, clink
--   25-28 whisper   lavender curls rising
--   29-33 levelup   gold star burst
--   34-37 cake      birthday cake, candle flame flickering (loops)
--   38-42 ghost     a small, peaceful wisp (death) — the system floats it upward
--   43-47 ping      gold ring with sparkles (player intervention)
--
-- Everything is centred on the cell centre (16,16) so the renderer can anchor at 0.5/0.5 on the
-- midpoint between the agents. Effects are brighter than the world on purpose — they are the
-- foreground for one second — but keep the 1px near-black outline (#1a1510, or a tinted dark for
-- soft things like dust and the wisp) the agents and emotes use. Drawing is procedural and
-- deterministic (seeded rand): rerunning the script reproduces the PNG byte for byte.

local S = 32
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end

local seed = 11
local function rand()
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
end

local OUT = 0x1a1510

-- ── Canvas primitives ───────────────────────────────────────────────────────────────────────
-- A canvas is a sparse table y*S+x+1 -> pixelColor int, so shapes can be outlined, split,
-- shifted and faded as data before being written to an Image.

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
-- Even-odd polygon fill on pixel centres.
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
local function star(cv, cx, cy, R, r, col, rot)
  local pts = {}
  for i = 0, 9 do
    local a = (rot or -math.pi / 2) + i * math.pi / 5
    local rad = (i % 2 == 0) and R or r
    pts[#pts + 1] = { cx + math.cos(a) * rad, cy + math.sin(a) * rad }
  end
  poly(cv, pts, col)
end
-- Rows of a tiny bitmap; `map` maps a character to a colour ('.' is empty).
local function pattern(cv, x, y, rows, map)
  for j, row in ipairs(rows) do
    for i = 1, #row do
      local ch = row:sub(i, i)
      if map[ch] then put(cv, x + i - 1, y + j - 1, map[ch]) end
    end
  end
end

-- 1px outline drawn on EMPTY pixels 4-adjacent to painted ones, so the fill keeps its size.
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

local function copy(cv, dx, dy, pred)
  local out = canvas()
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local c = get(cv, x, y)
      if c and (not pred or pred(x, y)) then put(out, x + (dx or 0), y + (dy or 0), c) end
    end
  end
  return out
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

-- A 4-point sparkle: bright centre, arms of length n.
local function sparkle(cv, cx, cy, n, arm, core)
  for i = 1, n do
    put(cv, cx - i, cy, arm); put(cv, cx + i, cy, arm)
    put(cv, cx, cy - i, arm); put(cv, cx, cy + i, arm)
  end
  put(cv, cx, cy, core)
end

-- Union-of-discs shaded per pixel, light from the upper left (as nature-props.lua does).
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

-- ── Shapes shared by several effects ─────────────────────────────────────────────────────────

-- Implicit heart curve; `r` is roughly the half-width in pixels.
local HEART = { hex(0xa02040), hex(0xe04058), hex(0xf06878), hex(0xffb0b8) }
local function heartMask(cx, cy, r)
  local m = {}
  for y = 0, S - 1 do
    for x = 0, S - 1 do
      local u = (x + 0.5 - cx) / r * 1.15
      local v = -(y + 0.5 - cy) / r * 1.15 + 0.25
      local a = u * u + v * v - 1
      if a * a * a - u * u * v * v * v <= 0 then m[#m + 1] = { x, y } end
    end
  end
  return m
end
local function heart(cv, cx, cy, r, ramp)
  ramp = ramp or HEART
  for _, p in ipairs(heartMask(cx, cy, r)) do
    local x, y = p[1], p[2]
    local dx, dy = (x + 0.5 - cx) / r, (y + 0.5 - cy) / r
    local c = ramp[2]
    if dx + dy > 0.95 then c = ramp[1]
    elseif dx + dy > 0.5 then c = ramp[2]
    elseif dx + dy < -0.55 then c = ramp[3] end
    put(cv, x, y, c)
  end
  -- Shine on the upper-left lobe.
  local sx, sy = math.floor(cx - r * 0.55), math.floor(cy - r * 0.5)
  if r >= 5 then put(cv, sx, sy, ramp[4]); put(cv, sx + 1, sy, ramp[4]); put(cv, sx, sy + 1, ramp[4]) end
end
local function miniHeart(cv, x, y, col, dark)
  pattern(cv, x, y, { ".X.X.", "XXXXX", ".XXX.", "..X.." }, { X = col })
  outline(cv, dark or hex(OUT))
end

-- ── Effects ──────────────────────────────────────────────────────────────────────────────────

local DUST = { hex(0x6a5c48), hex(0x9a8a70), hex(0xc0b294), hex(0xe4d8bc) }
local DUST_OUT = hex(0x3a2e22)
local SKIN, SKIN_DK, BOOT = hex(0xe0b088), hex(0xb07a50), hex(0x4a3020)
local GOLD, GOLD_LT, GOLD_DK = hex(0xf5c518), hex(0xfff3a0), hex(0xc09020)

local function brawl(t)
  local R = ({ 6, 9, 11, 12, 11, 8 })[t + 1]
  local cv = canvas()
  local lobes = { { 16, 16, R * 0.45 + 1 } }
  local spread = t == 5 and 0.9 or 0.68
  local puffR = t == 5 and R * 0.3 or R * 0.36
  for k = 0, 6 do
    local a = t * 0.9 + k * 2 * math.pi / 7
    -- Alternate near/far puffs so the silhouette is lumpy, not a disc.
    local d = spread * (k % 2 == 0 and 1 or 0.78)
    lobes[#lobes + 1] = { 16 + math.cos(a) * R * d, 16 + math.sin(a) * R * d * 0.85, puffR * (k % 2 == 0 and 1 or 1.15) }
  end
  shadedLobes(cv, lobes, DUST)
  -- A dark swirl inside the cloud, turning frame to frame: the scuffle rolling around.
  for i = 0, 16 do
    local a = t * 0.9 + i * 0.4
    local rr = 1.5 + i * R * 0.55 / 16
    local sx, sy = math.floor(16 + math.cos(a) * rr), math.floor(16 + math.sin(a) * rr * 0.85)
    if get(cv, sx, sy) then put(cv, sx, sy, DUST[1]) end
  end
  outline(cv, DUST_OUT)
  if t == 5 then fade(cv, 0.7) end

  -- Fists, a boot and stars poking out of the scuffle.
  if t >= 1 and t <= 4 then
    local limbs = canvas()
    local function limb(angle, len, boot)
      local ex, ey = 16 + math.cos(angle) * (R + len), 16 + math.sin(angle) * (R + len) * 0.85
      local sx, sy = 16 + math.cos(angle) * (R - 2), 16 + math.sin(angle) * (R - 2) * 0.85
      line(limbs, sx, sy, ex, ey, boot and BOOT or SKIN)
      line(limbs, sx, sy + 1, ex, ey + 1, boot and BOOT or SKIN_DK)
      line(limbs, sx + 1, sy, ex + 1, ey, boot and BOOT or SKIN)
      disc(limbs, ex, ey, 2, boot and BOOT or SKIN)
    end
    limb(-2.3 + t * 0.35, 3, false)
    limb(0.5 - t * 0.3, 3, false)
    limb(2.4 + t * 0.2, 2, true)
    limb(-0.7 + t * 0.25, 2, true)
    outline(limbs, hex(OUT))
    stamp(cv, limbs)
  end
  if t >= 2 and t <= 4 then
    local a0 = t * 1.1
    for k = 0, 2 do
      local a = a0 + k * 2.1
      local sx, sy = 16 + math.cos(a) * (R + 3), 16 + math.sin(a) * (R + 2) * 0.8
      local sp = canvas()
      sparkle(sp, math.floor(sx), math.floor(sy), 2, GOLD, GOLD_LT)
      outline(sp, hex(OUT))
      stamp(cv, sp)
    end
  end
  return cv
end

-- Gift box, drawn with its lid `lift` px above the rim (nil = no lid).
local BOX, BOX_DK, BOX_LT = hex(0xd83a3a), hex(0x8a2a2a), hex(0xf06a5a)
local RIB, RIB_DK = hex(0xf0c040), hex(0xc09020)
local function giftBox(cv, lift, tilt)
  local box = canvas()
  rect(box, 10, 18, 12, 8, BOX)
  rect(box, 10, 18, 2, 8, BOX_LT)
  rect(box, 19, 18, 3, 8, BOX_DK)
  rect(box, 10, 24, 12, 2, BOX_DK)
  rect(box, 15, 18, 2, 8, RIB)
  rect(box, 16, 18, 1, 8, RIB_DK)
  if lift then
    -- The rim seen from a little above: dark inside once the lid is off.
    rect(box, 11, 18, 10, 2, hex(0x4a1414))
    rect(box, 12, 18, 8, 1, hex(0x2a0a0a))
  end
  outline(box, hex(OUT))
  stamp(cv, box)
  if lift then
    local lid = canvas()
    local dx = tilt or 0
    rect(lid, 9 + dx, 14 - lift, 14, 4, BOX)
    rect(lid, 9 + dx, 14 - lift, 14, 1, BOX_LT)
    rect(lid, 9 + dx, 17 - lift, 14, 1, BOX_DK)
    rect(lid, 15 + dx, 14 - lift, 2, 4, RIB)
    -- Bow.
    pattern(lid, 12 + dx, 11 - lift, { "XX..XX", "XXX.XXX", ".XXXXX." }, { X = RIB })
    put(lid, 15 + dx, 12 - lift, RIB_DK); put(lid, 16 + dx, 12 - lift, RIB_DK)
    outline(lid, hex(OUT))
    stamp(cv, lid)
  end
end
local CONFETTI = { hex(0x4ac8e0), hex(0xf07090), hex(0xf5c518), hex(0x8ae05a) }
local function confetti(cv, n, rMin, rMax, seedShift)
  for k = 1, n do
    local a = (k / n) * math.pi * 2 + seedShift
    local rr = rMin + (rMax - rMin) * (0.5 + 0.5 * math.sin(k * 2.3 + seedShift))
    local x, y = 16 + math.cos(a) * rr, 15 + math.sin(a) * rr * 0.9
    local c = CONFETTI[1 + k % #CONFETTI]
    put(cv, x, y, c); put(cv, x + 1, y, c); put(cv, x, y + 1, c); put(cv, x + 1, y + 1, c)
  end
end
local function gift(t)
  local cv = canvas()
  if t == 0 then
    giftBox(cv, 0)
    return cv
  end
  local lifts = { 3, 8, 12, nil }
  giftBox(cv, lifts[t])
  if t == 1 then
    sparkle(cv, 12, 12, 1, GOLD, GOLD_LT); sparkle(cv, 21, 11, 1, GOLD, GOLD_LT)
  elseif t == 2 then
    star(cv, 16, 13, 4, 1.8, GOLD, nil); confetti(cv, 8, 7, 11, 0.4)
    sparkle(cv, 8, 15, 2, GOLD, GOLD_LT); sparkle(cv, 25, 14, 2, GOLD, GOLD_LT)
  elseif t == 3 then
    confetti(cv, 10, 9, 14, 1.3)
    sparkle(cv, 9, 8, 2, GOLD, GOLD_LT); sparkle(cv, 24, 9, 1, GOLD, GOLD_LT); sparkle(cv, 16, 4, 1, GOLD, GOLD_LT)
  else
    confetti(cv, 7, 10, 14, 2.6)
    fade(cv, 0.85)
    sparkle(cv, 14, 12, 1, GOLD, GOLD_LT)
  end
  return cv
end

local function heartBurst(t)
  local cv = canvas()
  local r = ({ 5, 7, 9, 8, 5 })[t + 1]
  local big = canvas()
  heart(big, 16, 16, r)
  outline(big, hex(OUT))
  if t == 4 then fade(big, 0.55) end
  stamp(cv, big)
  local minis = {
    { { 2, 4 }, { 25, 3 } },
    { { 1, 6 }, { 26, 2 }, { 2, 22 }, { 26, 21 } },
    { { 1, 2 }, { 26, 0 }, { 0, 15 }, { 27, 13 }, { 13, 0 } },
  }
  local list = t == 2 and minis[1] or t == 3 and minis[2] or t == 4 and minis[3] or {}
  for _, p in ipairs(list) do
    local m = canvas()
    miniHeart(m, p[1], p[2], HEART[3], hex(OUT))
    if t == 4 then fade(m, 0.55) end
    stamp(cv, m)
  end
  if t >= 1 and t <= 3 then sparkle(cv, 27, 26, 1, GOLD, GOLD_LT) end
  return cv
end

local function brokenHeart(t)
  local BR = { hex(0x701830), hex(0xb03048), hex(0xd05868), hex(0xf0a0a8) }
  local cv = canvas()
  local full = canvas()
  heart(full, 16, 14, 9, BR)
  -- Lightning-bolt crack: one pixel sideways every two rows, so the edge reads as a fracture.
  local function crackX(y) return 16 + ({ 0, 1, 2, 1, 0, -1, -2, -1 })[(y // 2) % 8 + 1] end
  if t == 0 then
    -- Whole heart, crack running down the middle (the gap becomes outline).
    for y = 3, 26 do full[y * S + crackX(y) + 1] = nil end
    outline(full, hex(OUT))
    return full
  end
  local left = copy(full, 0, 0, function(x, y) return x < crackX(y) end)
  local right = copy(full, 0, 0, function(x, y) return x >= crackX(y) end)
  local off = ({ 0, 1, 3, 5, 6 })[t + 1]
  local drop = ({ 0, 0, 1, 3, 6 })[t + 1]
  local l = copy(left, -off, drop + 1)
  local r = copy(right, off, drop)
  outline(l, hex(OUT)); outline(r, hex(OUT))
  if t == 4 then fade(l, 0.7); fade(r, 0.7) end
  stamp(cv, l); stamp(cv, r)
  if t >= 2 then
    -- A few falling shards.
    for _, s in ipairs({ { 15, 23 }, { 17, 20 }, { 14, 27 } }) do
      local y = s[2] + (t - 2) * 2
      put(cv, s[1], y, BR[2]); put(cv, s[1] + 1, y, BR[1])
    end
  end
  return cv
end

local STEEL, STEEL_DK, STEEL_LT = hex(0x8a929c), hex(0x4a5058), hex(0xd0d8e0)
local function cuffRing(cv, cx, cy, gapDeg)
  for yy = cy - 7, cy + 7 do
    for xx = cx - 7, cx + 7 do
      local dx, dy = xx + 0.5 - cx, yy + 0.5 - cy
      local d = math.sqrt(dx * dx + dy * dy)
      if d <= 5.2 and d >= 2.6 then
        local ang = math.deg(math.atan(dy, dx))           -- -180..180, up is -90
        local gap = gapDeg and math.abs(ang + 90) < gapDeg
        if not gap then
          local c = STEEL
          if dx + dy < -2.5 then c = STEEL_LT elseif dx + dy > 3 then c = STEEL_DK end
          put(cv, xx, yy, c)
        end
      end
    end
  end
end
local function cuffs(t)
  local cv = canvas()
  local spread = ({ 11, 10, 9, 9 })[t + 1]
  local gap = ({ 55, 25, nil, nil })[t + 1]
  local sag = ({ 2, 1, 0, 0 })[t + 1]
  local lx, rx, cy = 16 - spread, 16 + spread, 16
  cuffRing(cv, lx, cy, gap); cuffRing(cv, rx, cy, gap)
  -- Chain: links sagging between the rings.
  local n = 5
  for i = 0, n - 1 do
    local f = (i + 0.5) / n
    local x = lx + 5 + (rx - lx - 10) * f - 1
    local y = cy + math.sin(f * math.pi) * sag
    rect(cv, math.floor(x), math.floor(y), i % 2 == 0 and 3 or 2, 2, i % 2 == 0 and STEEL_LT or STEEL)
  end
  outline(cv, hex(OUT))
  if t == 2 then sparkle(cv, lx - 2, cy - 6, 2, hex(0xffffff), hex(0xffffff)) end
  if t == 3 then
    -- Clink: little strike lines off both rings.
    local c = hex(0xf5c518)
    line(cv, lx - 8, cy - 8, lx - 6, cy - 6, c); line(cv, lx - 10, cy - 1, lx - 8, cy - 1, c)
    line(cv, rx + 8, cy - 8, rx + 6, cy - 6, c); line(cv, rx + 10, cy - 1, rx + 8, cy - 1, c)
    sparkle(cv, rx + 1, cy - 8, 2, hex(0xffffff), hex(0xffffff))
  end
  return cv
end

local WH_LT, WH_MD, WH_OUT = hex(0xf0eaff), hex(0xb4a4ec), hex(0x5a4a90)
-- Three wavy murmur lines that scroll one wavelength per four frames and end in a small curl:
-- hushed talk drifting between two heads.
local function whisper(t)
  local cv = canvas()
  local phase = t * math.pi / 2
  local lines = { { y = 9, x0 = 6, x1 = 24, amp = 1.7 }, { y = 16, x0 = 4, x1 = 27, amp = 2.2 }, { y = 23, x0 = 7, x1 = 22, amp = 1.7 } }
  for k, l in ipairs(lines) do
    local n = (l.x1 - l.x0) * 2
    for i = 0, n do
      local f = i / n
      local x = l.x0 + f * (l.x1 - l.x0)
      local y = l.y + math.sin(f * math.pi * 2.6 - phase + k) * l.amp
      local a = math.floor(255 * (1 - f * 0.55))
      put(cv, x, y, pc.rgba(0xf0, 0xea, 0xff, a))
      put(cv, x, y + 1, pc.rgba(0xb4, 0xa4, 0xec, a))
    end
    -- Curl at the end of the line.
    local ex = l.x1
    local ey = l.y + math.sin(math.pi * 2.6 - phase + k) * l.amp
    for i = 0, 12 do
      local a = i * 0.6 + k
      local rr = 0.8 + i * 0.16
      put(cv, ex + 2 + math.cos(a) * rr, ey + math.sin(a) * rr, pc.rgba(0xf0, 0xea, 0xff, 150))
    end
  end
  outline(cv, hex(WH_OUT, 220))
  return cv
end

local function levelup(t)
  local cv = canvas()
  local R = ({ 5, 8, 10, 8, 5 })[t + 1]
  local st = canvas()
  star(st, 16, 16, R, R * 0.45, GOLD, nil)
  star(st, 15.5, 15.5, R * 0.55, R * 0.25, GOLD_LT, nil)
  -- Shade the lower right edge.
  for y = 0, S - 1 do for x = 0, S - 1 do
    if get(st, x, y) == GOLD and (x - 16) + (y - 16) > R * 0.5 then put(st, x, y, GOLD_DK) end
  end end
  outline(st, hex(OUT))
  if t == 4 then fade(st, 0.5) end
  stamp(cv, st)
  if t >= 1 and t <= 3 then
    local rays = canvas()
    local len = t == 2 and 4 or 3
    for k = 0, 7 do
      local a = k * math.pi / 4 + math.pi / 8
      local r0, r1 = R + 3, R + 3 + len - (k % 2)
      line(rays, 16 + math.cos(a) * r0, 16 + math.sin(a) * r0, 16 + math.cos(a) * r1, 16 + math.sin(a) * r1, GOLD_LT)
    end
    stamp(cv, rays)
  end
  local sp = ({ {}, { { 5, 5 }, { 27, 26 } }, { { 4, 6 }, { 27, 8 }, { 6, 26 }, { 26, 26 } },
                { { 3, 3 }, { 28, 5 }, { 4, 27 }, { 28, 24 } }, { { 4, 4 }, { 27, 27 } } })[t + 1]
  for _, p in ipairs(sp) do
    local s = canvas()
    sparkle(s, p[1], p[2], t == 4 and 1 or 2, GOLD, hex(0xffffff))
    if t == 4 then fade(s, 0.5) end
    stamp(cv, s)
  end
  return cv
end

local CAKE, CAKE_DK = hex(0xf0e0b8), hex(0xc8a878)
local PINK, PINK_DK, PINK_LT = hex(0xf07090), hex(0xb04868), hex(0xffb0c8)
local function cake(t)
  local cv = canvas()
  local body = canvas()
  -- Plate.
  for x = 6, 25 do put(body, x, 26, hex(0xe8ecf0)); put(body, x, 27, hex(0x9098a8)) end
  -- Bottom tier.
  rect(body, 8, 19, 16, 7, CAKE)
  rect(body, 21, 19, 3, 7, CAKE_DK)
  rect(body, 8, 24, 16, 2, CAKE_DK)
  rect(body, 8, 18, 16, 2, PINK)
  for _, x in ipairs({ 10, 14, 19, 22 }) do put(body, x, 20, PINK); put(body, x, 21, PINK_DK) end
  -- Top tier.
  rect(body, 11, 13, 10, 5, PINK_LT)
  rect(body, 18, 13, 3, 5, PINK)
  rect(body, 11, 12, 10, 2, hex(0xfff8e8))
  -- Sprinkles.
  for _, p in ipairs({ { 9, 22 }, { 13, 23 }, { 17, 21 }, { 20, 23 }, { 13, 15 }, { 16, 16 } }) do
    put(body, p[1], p[2], CONFETTI[1 + (p[1] + p[2]) % #CONFETTI])
  end
  -- Candle.
  rect(body, 15, 7, 2, 5, hex(0x8ad0f0))
  put(body, 15, 8, hex(0xffffff)); put(body, 16, 10, hex(0xffffff))
  outline(body, hex(OUT))
  stamp(cv, body)
  -- Flame, flickering: tall, lean left, short, lean right.
  local fl = canvas()
  local lean = ({ 0, -1, 0, 1 })[t + 1]
  local hgt = ({ 4, 3, 2, 3 })[t + 1]
  for i = 0, hgt - 1 do
    local w = (i == 0 or i == hgt - 1) and 1 or 2
    local x = 15 + (i < hgt - 1 and 0 or lean)
    rect(fl, x, 6 - i, w, 1, i <= 1 and hex(0xf5c518) or hex(0xf08020))
  end
  put(fl, 15, 6, hex(0xfff3a0)); put(fl, 16, 6, hex(0xfff3a0))
  outline(fl, hex(0x8a3a10))
  stamp(cv, fl)
  local sp = ({ { 5, 10 }, { 26, 8 }, { 4, 6 }, { 27, 12 } })[t + 1]
  sparkle(cv, sp[1], sp[2], 1, GOLD, hex(0xffffff))
  return cv
end

local GH, GH_SH, GH_OUT = hex(0xf4f8ff), hex(0xc8d4ec), 0x8898b8
local function ghost(t)
  local alpha = ({ 0.4, 0.85, 0.95, 0.8, 0.4 })[t + 1]
  local body = canvas()
  disc(body, 16, 13, 6, GH)
  rect(body, 10, 13, 12, 9, GH)
  -- Wavy hem, gently shifting frame to frame.
  local hem = { 0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1 }
  for i = 0, 11 do
    local x = 10 + i
    local h = hem[(i + t) % 12 + 1]
    for y = 22, 22 + h do put(body, x, y, GH) end
  end
  -- Soft shade on the right and along the hem.
  for y = 0, S - 1 do for x = 0, S - 1 do
    if get(body, x, y) and (x >= 19 or y >= 22) then put(body, x, y, GH_SH) end
  end end
  -- Peaceful closed eyes and a small smile.
  local eye = hex(0x5a6a90)
  put(body, 13, 14, eye); put(body, 14, 15, eye); put(body, 15, 14, eye)
  put(body, 17, 14, eye); put(body, 18, 15, eye); put(body, 19, 14, eye)
  put(body, 16, 17, eye)
  outline(body, hex(GH_OUT))
  fade(body, alpha)
  local cv = canvas()
  stamp(cv, body)
  local sp = canvas()
  local dots = ({ { 7, 22 }, { 24, 20 }, { 6, 14 }, { 25, 12 }, { 8, 8 } })[t + 1]
  sparkle(sp, dots[1], dots[2], 1, hex(0xdfe8ff), hex(0xffffff))
  fade(sp, alpha)
  stamp(cv, sp)
  return cv
end

local function ping(t)
  local r = ({ 3, 6, 9, 12, 14 })[t + 1]
  local a = ({ 1, 1, 0.9, 0.65, 0.35 })[t + 1]
  local cv = canvas()
  ring(cv, 16, 16, r - 1.6, r, GOLD)
  ring(cv, 16, 16, r - 0.9, r - 0.3, GOLD_LT)
  outline(cv, hex(0x8a5a10))
  fade(cv, a)
  if t >= 1 then
    local sp = canvas()
    for k = 0, 3 do
      local ang = k * math.pi / 2 + math.pi / 4
      local sx, sy = 16 + math.cos(ang) * (r - 0.8), 16 + math.sin(ang) * (r - 0.8)
      sparkle(sp, math.floor(sx), math.floor(sy), t >= 3 and 1 or 2, GOLD_LT, hex(0xffffff))
    end
    fade(sp, a)
    stamp(cv, sp)
  end
  return cv
end

-- ── Assembly ─────────────────────────────────────────────────────────────────────────────────

local anims = {
  { "brawl", 6, brawl }, { "gift", 5, gift }, { "heart", 5, heartBurst }, { "broken", 5, brokenHeart },
  { "cuffs", 4, cuffs }, { "whisper", 4, whisper }, { "levelup", 5, levelup }, { "cake", 4, cake },
  { "ghost", 5, ghost }, { "ping", 5, ping },
}

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

local dir = app.params.dir or "public/sprites/fx"
app.fs.makeAllDirectories(dir)

local spr = Sprite(S, S, ColorMode.RGB)
spr.filename = "beats"
for i = 2, #cells do spr:newEmptyFrame() end
for i, img in ipairs(cells) do spr:newCel(spr.layers[1], spr.frames[i], img, Point(0, 0)) end
for _, tg in ipairs(tags) do
  local tag = spr:newTag(tg[2], tg[3]); tag.name = tg[1]
end
spr:saveAs(app.fs.joinPath(dir, "beats.aseprite"))
spr:close()

local strip = Image(S * #cells, S, ColorMode.RGB)
strip:clear(0)
for i, img in ipairs(cells) do strip:drawImage(img, Point((i - 1) * S, 0)) end
strip:saveAs(app.fs.joinPath(dir, "beats.png"))
print(#cells .. " beat fx frames")
