-- portrait-moods.lua — derive expression variants from the 64x64 agent portraits.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/agents --script scripts/aseprite/portrait-moods.lua
--   (add --script-param only=carlos_mendez to rebuild one agent)
--
-- The hand-authored `<name>_portrait.png` stays the source of truth (it is the "neutral" face).
-- For each one this writes `<name>_portrait_<mood>.png` for mood in happy|sad|angry|shocked, plus
-- `<name>_portraits.aseprite` with one tagged frame per mood (neutral first). The client picks the
-- file from the resident's mood/states (src/components/ui/portraitMood.ts) and falls back to the
-- neutral portrait when a variant is missing — so a portrait whose anatomy can't be detected is
-- simply skipped here (reported on stdout) rather than drawn badly.
--
-- Anatomy. All 13 portraits share one face template, only hair/hats/beards differ:
--   * a pupil is the exact colour #0a0604, one per eye, at (23,32) and (40,32); each eye is a 5x3
--     box centred on its pupil, framed by a dark lid line one row above and a lower-lid line one
--     row below, with the fringe/hat shadow over the lid line;
--   * the mouth sits 8..11 rows under the pupils, spanning the 12 columns between the eyes' outer
--     inner corners (x 26..37): upper lip line, body, lower lip, chin shade.
-- Rather than hard-coding coordinates the script FINDS the pupils and derives everything from
-- them, and refuses a portrait whose pupils/lid lines/lips don't match that template (`fail`).
--
-- Editing model. Eyes are edited by painting the portrait's own lid colour / sclera colour over
-- eye pixels; the mouth box is wiped (each pixel refilled from the same column four rows under
-- the mouth, which keeps beard stripes) and a new mouth is drawn in the portrait's own lip colours.
--
--   happy   grin: corners lifted, teeth, lower lid raised (squint)
--   sad     frown, upper lid dropped at the OUTER corners (inner corners look raised), one tear
--   angry   upper lid dropped at the INNER corners (glare), tight flat mouth, furrow above the nose
--   shocked eyes opened upward (extra sclera row, lid line lifted), small open oval mouth

local W, H = 64, 64
local pc = app.pixelColor
local function rgba(r, g, b, a) return pc.rgba(r, g, b, a or 255) end
local function R(p) return pc.rgbaR(p) end
local function G(p) return pc.rgbaG(p) end
local function B(p) return pc.rgbaB(p) end
local function A(p) return pc.rgbaA(p) end
local function luma(p) return 0.299 * R(p) + 0.587 * G(p) + 0.114 * B(p) end

local PUPIL = rgba(0x0a, 0x06, 0x04)
local TEETH = rgba(0xf0, 0xe2, 0xc8) -- the sclera cream every portrait already uses
local TEAR = rgba(0x9c, 0xc8, 0xe8)
local TEAR_HI = rgba(0xd8, 0xee, 0xff)

local function get(img, x, y)
  if x < 0 or y < 0 or x >= W or y >= H then return 0 end
  return img:getPixel(x, y)
end
local function put(img, x, y, c)
  if x >= 0 and y >= 0 and x < W and y < H then img:putPixel(x, y, c) end
end
local function shade(p, k)
  local function c(v) return math.max(0, math.min(255, math.floor(v * k))) end
  return rgba(c(R(p)), c(G(p)), c(B(p)), A(p))
end

-- ── Anatomy ────────────────────────────────────────────────────────────────────────────────

local function fail(name, why) return nil, why end

local function analyse(img)
  -- Pupils: exact-colour pixels in the eye band, split left/right of the face centre.
  local L, Rr = {}, {}
  for y = 30, 35 do
    for x = 18, 45 do
      -- Isolated: dark hair also uses this colour, in runs.
      if get(img, x, y) == PUPIL and get(img, x - 1, y) ~= PUPIL and get(img, x + 1, y) ~= PUPIL
         and get(img, x, y - 1) ~= PUPIL and get(img, x, y + 1) ~= PUPIL then
        table.insert(x < 32 and L or Rr, { x = x, y = y })
      end
    end
  end
  if #L ~= 1 or #Rr ~= 1 then
    return fail(nil, string.format("expected 1 pupil per eye, found %d left / %d right", #L, #Rr))
  end
  local a = { pxL = L[1].x, pxR = Rr[1].x, py = L[1].y }
  if L[1].y ~= Rr[1].y then return fail(nil, "pupils on different rows") end
  if a.pxR - a.pxL < 15 or a.pxR - a.pxL > 19 then return fail(nil, "pupils oddly spaced") end
  -- Lid lines: dark rows one above and one below the pupil row, under each pupil.
  for _, px in ipairs({ a.pxL, a.pxR }) do
    -- Upper lid is near-black; the lower one can be a mid brown (carlos), so it gets a looser bound.
    local up, lo = get(img, px, a.py - 2), get(img, px, a.py + 2)
    if A(up) < 255 or luma(up) > 80 then return fail(nil, "no upper lid line above pupil") end
    if A(lo) < 255 or luma(lo) > 150 then return fail(nil, "no lower lid line under pupil") end
  end
  -- Mouth box: x from 3 right of the left pupil to 3 left of the right pupil, 8..11 rows below.
  a.mx0, a.mx1 = a.pxL + 3, a.pxR - 3
  a.my0, a.my1 = a.py + 8, a.py + 11
  a.cx2 = a.mx0 + a.mx1 -- twice the centre x (63 => between columns 31 and 32)
  -- Lips are the reddish pixels: green well under red. Skin and beards stay above this ratio.
  local function isLip(p) return A(p) == 255 and R(p) >= 0x40 and G(p) <= R(p) * 0.62 and B(p) <= G(p) + 0x18 end
  local rowCount, rowColor = {}, {}
  local total = 0
  for y = a.my0, a.my1 do
    local counts = {}
    rowCount[y] = 0
    for x = a.mx0, a.mx1 do
      local p = get(img, x, y)
      if isLip(p) then
        rowCount[y] = rowCount[y] + 1
        total = total + 1
        counts[p] = (counts[p] or 0) + 1
      end
    end
    local best, bn = nil, 0
    for p, n in pairs(counts) do if n > bn then best, bn = p, n end end
    rowColor[y] = best
  end
  if total < 8 then return fail(nil, "no lips found (" .. total .. " px)") end
  -- Lip colours: upper line / body / lower lip; bearded faces only show one row, so derive.
  local body = rowColor[a.my0 + 1] or rowColor[a.my0] or rowColor[a.my0 + 2]
  if not body then return fail(nil, "no lip body row") end
  a.lipD = rowColor[a.my0] or shade(body, 0.72)
  if luma(a.lipD) > luma(body) then a.lipD = shade(body, 0.72) end
  a.lipM = body
  a.lipL = rowColor[a.my0 + 2] or body
  a.mouthInterior = shade(a.lipD, 0.45)
  -- Dark beards (omar): dark-red lips vanish into them, so use the brightest lip tone as the outline.
  local surround = get(img, a.mx0 + 2, a.my1 + 1)
  if luma(surround) < 70 then
    local top = luma(a.lipL) > luma(a.lipM) and a.lipL or a.lipM
    a.lipD = shade(top, 1.35)
    a.lipM = top
    a.lipL = top
  end
  return a
end

-- ── Painting helpers ───────────────────────────────────────────────────────────────────────

-- Eye geometry: which side is "inner" (towards the nose).
local function eyes(a)
  return {
    { cx = a.pxL, outer = a.pxL - 2, inner = a.pxL + 2, dir = 1 },   -- left eye, inner corner to the right
    { cx = a.pxR, outer = a.pxR + 2, inner = a.pxR - 2, dir = -1 },  -- right eye, inner corner to the left
  }
end

-- Paint `n` pixels of row y starting at x0 and stepping `dir`.
local function run(img, y, x0, dir, n, c)
  for i = 0, n - 1 do put(img, x0 + dir * i, y, c) end
end

local function wipeMouth(img, a)
  for y = a.my0, a.my1 do
    for x = a.mx0, a.mx1 do
      put(img, x, y, get(img, x, a.my1 + 1)) -- same column, first row under the mouth box
    end
  end
end

-- Mouth pixel writer in mouth-local coordinates: u = 0..11 across, v = 0..3 down.
local function mpix(img, a, u, v, c) put(img, a.mx0 + u, a.my0 + v, c) end

local function mouthHappy(img, a)
  wipeMouth(img, a)
  local D, M = a.lipD, a.lipM
  -- Cheek dimples lift the corners, top line straight, teeth, curved lower lip.
  mpix(img, a, 0, -1, D); mpix(img, a, 11, -1, D)
  for u = 0, 11 do mpix(img, a, u, 0, D) end
  for u = 2, 9 do mpix(img, a, u, 1, TEETH) end
  mpix(img, a, 1, 1, D); mpix(img, a, 10, 1, D)
  for u = 2, 9 do mpix(img, a, u, 2, M) end
  mpix(img, a, 1, 2, D); mpix(img, a, 10, 2, D)
  for u = 3, 8 do mpix(img, a, u, 3, D) end
end

local function mouthSad(img, a)
  wipeMouth(img, a)
  local D, M = a.lipD, a.lipM
  -- Inverted arc with a slightly pushed-up lower lip: centre high, corners dragged down.
  for u = 4, 7 do mpix(img, a, u, 0, D) end
  for u = 4, 7 do mpix(img, a, u, 1, M) end
  mpix(img, a, 2, 1, D); mpix(img, a, 3, 0, D); mpix(img, a, 3, 1, D)
  mpix(img, a, 8, 0, D); mpix(img, a, 9, 1, D); mpix(img, a, 8, 1, D)
  mpix(img, a, 1, 2, D); mpix(img, a, 2, 2, D)
  mpix(img, a, 9, 2, D); mpix(img, a, 10, 2, D)
  mpix(img, a, 0, 3, D); mpix(img, a, 11, 3, D)
end

local function mouthAngry(img, a)
  wipeMouth(img, a)
  local D, M = a.lipD, a.lipM
  -- Tight-lipped: a two-row pressed line (narrower than the neutral mouth), ends turned down.
  for u = 2, 9 do mpix(img, a, u, 0, D) end
  for u = 1, 10 do mpix(img, a, u, 1, D) end
  mpix(img, a, 0, 2, D); mpix(img, a, 11, 2, D)
  for u = 3, 8 do mpix(img, a, u, 2, M) end
end

local function mouthShocked(img, a)
  wipeMouth(img, a)
  local D, I = a.lipD, a.mouthInterior
  -- Small open oval, centred between columns 5 and 6.
  for u = 4, 7 do mpix(img, a, u, 0, D) end
  mpix(img, a, 3, 1, D); mpix(img, a, 8, 1, D)
  mpix(img, a, 3, 2, D); mpix(img, a, 8, 2, D)
  for u = 4, 7 do mpix(img, a, u, 1, I); mpix(img, a, u, 2, I) end
  for u = 4, 7 do mpix(img, a, u, 3, D) end
end

-- ── Eyes ───────────────────────────────────────────────────────────────────────────────────

local function lidColor(img, e, a) return get(img, e.cx, a.py - 2) end
local function lowerLidColor(img, e, a) return get(img, e.cx, a.py + 2) end

local function eyesHappy(img, a)
  for _, e in ipairs(eyes(a)) do
    -- Squint: the lower lid comes up over the bottom row of the eye.
    local c = lowerLidColor(img, e, a)
    run(img, a.py + 1, e.cx - 2, 1, 5, c)
    -- Outer corner crinkle.
    put(img, e.outer + e.dir * 1, a.py + 1, c)
  end
end

local function eyesSad(img, a)
  for _, e in ipairs(eyes(a)) do
    local c = lidColor(img, e, a)
    -- Upper lid drops at the outer corner: 3 px on the first row, 1 on the second.
    run(img, a.py - 1, e.outer, -e.dir, 3, c)
    put(img, e.outer, a.py, c)
  end
  -- One tear under the left eye's outer corner.
  local e = eyes(a)[1]
  put(img, e.outer, a.py + 3, TEAR)
  put(img, e.outer, a.py + 4, TEAR_HI)
  put(img, e.outer, a.py + 5, TEAR)
end

local function eyesAngry(img, a)
  for _, e in ipairs(eyes(a)) do
    local c = lidColor(img, e, a)
    -- Upper lid drops at the inner corner: 4 px on the first row, 2 on the second.
    run(img, a.py - 1, e.inner, -e.dir, 4, c)
    run(img, a.py, e.inner, -e.dir, 2, c)
    -- Brow furrow: continue the lid line past the inner corner, stepping down towards the nose.
    put(img, e.inner + e.dir * 1, a.py - 2, c)
    put(img, e.inner + e.dir * 2, a.py - 2, c)
    put(img, e.inner + e.dir * 2, a.py - 1, c)
    put(img, e.inner + e.dir * 3, a.py - 1, c)
  end
end

local function eyesShocked(img, a)
  for _, e in ipairs(eyes(a)) do
    local lid = lidColor(img, e, a)
    local sclera = get(img, e.outer, a.py) -- outer column of the eye is sclera in every portrait
    if A(sclera) < 255 or luma(sclera) < 170 then sclera = TEETH end
    -- Extra sclera row above the eye, lid line lifted one row.
    run(img, a.py - 2, e.cx - 2, 1, 5, sclera)
    run(img, a.py - 3, e.cx - 3, 1, 7, lid)
    -- Pupil ringed by white: clear the iris pixels beside it on the same row.
    put(img, e.cx - 1, a.py, sclera)
    put(img, e.cx + 1, a.py, sclera)
  end
end

local MOODS = {
  { name = "happy", eyes = eyesHappy, mouth = mouthHappy },
  { name = "sad", eyes = eyesSad, mouth = mouthSad },
  { name = "angry", eyes = eyesAngry, mouth = mouthAngry },
  { name = "shocked", eyes = eyesShocked, mouth = mouthShocked },
}

-- ── Build ──────────────────────────────────────────────────────────────────────────────────

local function build(dir, name)
  local src = Image{ fromFile = app.fs.joinPath(dir, name .. "_portrait.png") }
  if src.width ~= W or src.height ~= H then
    print("skip " .. name .. " (not 64x64)")
    return
  end
  local base = Image(W, H, ColorMode.RGB); base:clear(0); base:drawImage(src, Point(0, 0))
  local a, why = analyse(base)
  if not a then
    print(string.format("SKIP %-18s %s", name, why))
    return
  end

  local frames, tags = { base }, { { "neutral", 1, 1 } }
  for _, m in ipairs(MOODS) do
    local img = Image(W, H, ColorMode.RGB); img:drawImage(base, Point(0, 0))
    m.mouth(img, a)
    m.eyes(img, a)
    table.insert(frames, img)
    table.insert(tags, { m.name, #frames, #frames })
    img:saveAs(app.fs.joinPath(dir, name .. "_portrait_" .. m.name .. ".png"))
  end

  local spr = Sprite(W, H, ColorMode.RGB)
  spr.filename = name .. "_portraits"
  for i = 2, #frames do spr:newEmptyFrame() end
  local layer = spr.layers[1]
  layer.name = "portrait"
  for i, img in ipairs(frames) do
    spr:newCel(layer, spr.frames[i], img, Point(0, 0))
    spr.frames[i].duration = 1
  end
  for _, t in ipairs(tags) do
    local tag = spr:newTag(t[2], t[3]); tag.name = t[1]
  end
  spr:saveAs(app.fs.joinPath(dir, name .. "_portraits.aseprite"))
  spr:close()
  print(string.format("ok   %-18s pupils=(%d,%d),(%d,%d) mouth=x%d-%d y%d-%d", name,
    a.pxL, a.py, a.pxR, a.py, a.mx0, a.mx1, a.my0, a.my1))
end

local dir = app.params.dir or "public/sprites/agents"
local only = app.params.only
for _, f in ipairs(app.fs.listFiles(dir)) do
  local name = f:match("^(.-)_portrait%.png$")
  if name and (not only or only == name) then build(dir, name) end
end
