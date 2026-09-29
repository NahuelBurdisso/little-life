-- agent-sheets.lua — derive walk/idle animation sheets from the static agent sprites.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/agents --script scripts/aseprite/agent-sheets.lua
--   (add --script-param only=carlos_mendez to rebuild one agent)
--
-- The hand-authored 32x32 front sprite `<name>.png` stays the source of truth. For each one this
-- writes `<name>_sheet.aseprite` (frames + tags, editable in Aseprite) and `<name>_sheet.png`, a
-- horizontal strip the client slices by index. Frame layout — keep in sync with `SHEET_FRAMES` in
-- src/components/canvas/agentFrames.ts and with `bodyFrames` in src/lib/residentArt/bodySheet.ts
-- (the generator for residents without art); agentFrames.test.ts parses `TAGS` below to check:
--
--   0 idle_down   1 blink_down   2-5 walk_down   6 idle_up   7-10 walk_up
--   11 idle_side   12-15 walk_side
--
-- The side view faces right. The client mirrors the whole rig for a walk to the left, so one
-- profile serves both directions (and the rig's held item swaps hands with it).
--
-- Everything is derived rather than drawn so all 13 residents keep their identity and a retouch of
-- the base sprite only needs a re-run. The derivations lean on the layout every base sprite shares:
-- feet at the bottom with a translucent drop shadow under them, legs split by an outline column at
-- x=15/16, head on top of a wider torso whose outermost columns are the arms, and a face template
-- with the eyes five rows above the neck.

local W, H = 32, 32
local MID = 16 -- first column of the right half

local pc = app.pixelColor
local function A(p) return pc.rgbaA(p) end
local function key(p) return p end
local function luma(p) return 0.299 * pc.rgbaR(p) + 0.587 * pc.rgbaG(p) + 0.114 * pc.rgbaB(p) end
local OUTLINE = app.pixelColor.rgba(0x1a, 0x15, 0x10, 255) -- the art bible's universal outline
local EYE_WHITE = app.pixelColor.rgba(0xf0, 0xe2, 0xc8, 255) -- same eye colours as bodySheet.ts
local PUPIL = app.pixelColor.rgba(0x1a, 0x10, 0x0a, 255)
local EYE_MAX_LUMA = 34 -- pupils are near-black; so is a lot of hair, hence the isolation test

-- Tag name, first frame, last frame (1-based, Aseprite's numbering) and per-frame duration in ms.
local TAGS = {
  { "idle_down", 1, 1, 400 }, { "blink_down", 2, 2, 120 }, { "walk_down", 3, 6, 140 },
  { "idle_up", 7, 7, 400 }, { "walk_up", 8, 11, 140 },
  { "idle_side", 12, 12, 400 }, { "walk_side", 13, 16, 140 },
}

local function blank() local i = Image(W, H, ColorMode.RGB); i:clear(0); return i end
local function get(img, x, y)
  if x < 0 or y < 0 or x >= W or y >= H then return 0 end
  return img:getPixel(x, y)
end

-- ── Anatomy ────────────────────────────────────────────────────────────────────────────────

local function analyse(img)
  local a = { shadowTop = H }
  -- Drop shadow: bottom rows whose pixels are all translucent.
  for y = H - 1, 0, -1 do
    local any, solid = false, false
    for x = 0, W - 1 do
      local al = A(get(img, x, y))
      if al > 0 then any = true end
      if al == 255 then solid = true end
    end
    if solid then a.bottom = y; break end
    if any then a.shadowTop = y end
  end
  for y = 0, H - 1 do
    for x = 0, W - 1 do
      if A(get(img, x, y)) == 255 then a.top = a.top or y end
    end
  end
  -- Legs: rows (walking up from the feet) where the centre seam x=15/16 is outline or empty.
  local function seam(y)
    for _, x in ipairs({ MID - 1, MID }) do
      local p = get(img, x, y)
      if A(p) == 255 and luma(p) > EYE_MAX_LUMA then return false end
    end
    return true
  end
  a.legTop = a.bottom
  for y = a.bottom - 1, a.top, -1 do
    if seam(y) then a.legTop = y else break end
  end
  -- Row extents: the opaque run through the centre columns, so a braid or a held basket hanging
  -- beside the body doesn't widen it. The widest rows are the torso/arms band.
  a.minX, a.maxX = {}, {}
  local widest = 0
  for y = a.top, a.bottom do
    local cx = (A(get(img, MID - 1, y)) > 0) and MID - 1 or ((A(get(img, MID, y)) > 0) and MID or nil)
    if cx then
      local l, r = cx, cx
      while l > 0 and A(get(img, l - 1, y)) > 0 do l = l - 1 end
      while r < W - 1 and A(get(img, r + 1, y)) > 0 do r = r + 1 end
      a.minX[y], a.maxX[y] = l, r
      widest = math.max(widest, r - l)
    end
  end
  -- Neck: the narrowest centre run a head-height below the top. Every base sprite has an ~11-row
  -- head, and measuring only the centre run keeps hat brims and braids out of the picture.
  local narrow, neck = 99, nil
  for y = a.top + 9, math.min(a.top + 14, a.legTop - 4) do
    if a.minX[y] then
      local w = a.maxX[y] - a.minX[y]
      if w < narrow then narrow, neck = w, y end
    end
  end
  a.neck = neck or (a.top + 11)
  -- Arms: rows under the neck at (near) full width.
  a.armTop, a.armBottom = nil, nil
  for y = a.neck + 1, a.legTop do
    if a.minX[y] and (a.maxX[y] - a.minX[y]) >= widest - 1 then
      a.armTop = a.armTop or y
      a.armBottom = y
    end
  end
  a.armLeftX = a.minX[a.armTop or a.neck] or 9
  a.armRightX = a.maxX[a.armTop or a.neck] or 22
  -- Eyes: the head row with the most very dark pixels strictly inside the outline.
  local best, bestN = nil, 0
  for y = a.top + 3, a.neck - 2 do
    local n = 0
    if a.minX[y] then
      for x = a.minX[y] + 1, a.maxX[y] - 1 do
        local p, l, r = get(img, x, y), get(img, x - 1, y), get(img, x + 1, y)
        local dark = function(q) return A(q) == 255 and luma(q) < EYE_MAX_LUMA end
        -- A pupil is a lone dark pixel between lighter ones; hair and brims come in runs.
        if dark(p) and not dark(l) and not dark(r) then n = n + 1 end
      end
    end
    if n >= 2 and n <= 4 and n > bestN then best, bestN = y, n end
  end
  a.eyeRow = best
  return a
end

local function mode(counts, exclude)
  local bestK, bestN = nil, 0
  for k, n in pairs(counts) do
    if n > bestN and not (exclude and exclude[k]) then bestK, bestN = k, n end
  end
  return bestK
end

-- Only the exact outline colour counts as line work. Near-black hair and clothes are common, and
-- treating them as outline made the back view throw them away.
local function isInk(p) return p == OUTLINE end
local function dist(p, q)
  local dr, dg, db = pc.rgbaR(p) - pc.rgbaR(q), pc.rgbaG(p) - pc.rgbaG(q), pc.rgbaB(p) - pc.rgbaB(q)
  return math.sqrt(dr * dr + dg * dg + db * db)
end

local function isWarm(p)
  local r, g, b = pc.rgbaR(p), pc.rgbaG(p), pc.rgbaB(p)
  return r > g and g > b and r - b > 40
end

-- Colours on the top three rows of the head: a hat, or the crown of the hair.
local function crownColours(img, a)
  local keep = {}
  for y = a.top, a.top + 2 do
    for x = 0, W - 1 do
      local p = get(img, x, y)
      if A(p) == 255 and not isInk(p) then keep[p] = true end
    end
  end
  return keep
end

-- Skin = most common warm, mid-to-light colour on the face rows (eyes down to the chin).
-- Hair = most common colour on the head below the crown that is not skin-like, not an eye white
-- and not part of the hat. Bare heads fall back to the crown colours (the crown *is* the hair).
local function palette(img, a)
  local eye = a.eyeRow or (a.top + 6)
  local skinC, hairC, crownC = {}, {}, {}
  for y = eye - 1, a.neck - 1 do
    if a.minX[y] then
      for x = a.minX[y] + 1, a.maxX[y] - 1 do
        local p = get(img, x, y)
        if A(p) == 255 and isWarm(p) and luma(p) > 90 then skinC[p] = (skinC[p] or 0) + 1 end
      end
    end
  end
  local skin = mode(skinC) or pc.rgba(200, 152, 108, 255)
  local crown = crownColours(img, a)
  -- Skin shading is not hair. A deep cheek or jaw shadow sits far enough from the mid skin tone
  -- to pass the `dist > 70` test below, and on a dark complexion (Priya: 4a3020 against 9a6d4c) it
  -- was the only candidate, so her back view came out face-brown. The centre of the neck row is
  -- bare skin on every base sprite, so any colour found there is a skin shade and never hair.
  local neckSkin = {}
  for x = MID - 2, MID + 1 do
    local p = get(img, x, a.neck)
    if A(p) == 255 and not isInk(p) then neckSkin[p] = true end
  end
  for y = a.top, a.neck - 2 do
    if a.minX[y] then
      for x = a.minX[y] + 1, a.maxX[y] - 1 do
        local p = get(img, x, y)
        if A(p) == 255 and not isInk(p) and crown[p] then crownC[p] = (crownC[p] or 0) + 1 end
      end
      -- Hair is sampled only beside the face (sideburns, hair under a brim): the middle columns
      -- hold eyebrows, pupils and beards.
      if y >= a.top + 3 then
        for _, x in ipairs({ a.minX[y] + 1, a.minX[y] + 2, a.maxX[y] - 2, a.maxX[y] - 1 }) do
          local p = get(img, x, y)
          if A(p) == 255 and not isInk(p) and not crown[p] and not neckSkin[p]
             and dist(p, skin) > 70 and luma(p) < 200 then
            hairC[p] = (hairC[p] or 0) + 1
          end
        end
      end
    end
  end
  return skin, mode(hairC) or mode(crownC) or skin
end

-- ── Pixel operations ───────────────────────────────────────────────────────────────────────

local function copy(img) return img:clone() end

-- Lift one leg: shift rows [legTop, bottom] of one half up by `dy`. The top of the leg slides
-- under the torso (lost), the vacated bottom rows go transparent — the leg foreshortens.
local function liftLeg(img, a, side, dy)
  local out = copy(img)
  local x0, x1 = 0, MID - 1
  if side == "right" then x0, x1 = MID, W - 1 end
  for y = a.legTop, a.bottom do
    for x = x0, x1 do
      local src = y + dy
      out:drawPixel(x, y, src <= a.bottom and get(img, x, src) or 0)
    end
  end
  return out
end

-- Move everything above `legTop` down `dy` px (contact-frame bob). The lowered torso covers the
-- top rows of the legs, which is what a knee bend looks like at this size.
local function bob(img, a, dy)
  local out = copy(img)
  for y = a.legTop - 1, 0, -1 do
    for x = 0, W - 1 do
      local p = get(img, x, y)
      out:drawPixel(x, y + dy, p)
      if y < dy then out:drawPixel(x, y, 0) end
    end
  end
  for y = 0, dy - 1 do for x = 0, W - 1 do out:drawPixel(x, y, 0) end end
  return out
end

-- Swing an arm: slide its columns down `dy` px (hand drops = arm swings toward camera).
local function swingArm(img, a, side, dy)
  if not a.armTop then return copy(img) end
  local out = copy(img)
  local x0, x1
  if side == "left" then x0, x1 = a.armLeftX, a.armLeftX + 1
  else x0, x1 = a.armRightX - 1, a.armRightX end
  for y = a.armBottom + dy, a.armTop + dy, -1 do
    for x = x0, x1 do
      out:drawPixel(x, y, get(img, x, y - dy))
    end
  end
  return out
end

local function blink(img, a, skin)
  local out = copy(img)
  if not a.eyeRow then return out end
  local y = a.eyeRow
  -- Closed lid: the dark pupil becomes a darker skin line, the eye white becomes skin.
  local lid = pc.rgba(math.floor(pc.rgbaR(skin) * 0.72), math.floor(pc.rgbaG(skin) * 0.62),
                      math.floor(pc.rgbaB(skin) * 0.58), 255)
  for x = a.minX[y] + 2, a.maxX[y] - 2 do
    local p = get(img, x, y)
    if A(p) == 255 then
      if isInk(p) then out:drawPixel(x, y, lid)
      elseif luma(p) > luma(skin) + 25 then out:drawPixel(x, y, skin) end
    end
  end
  return out
end

-- ── Front-only garments ───────────────────────────────────────────────────────────────────

-- Colours that only ever show on the front of the torso: aprons, bibs, ties, collars. They never
-- reach the torso's side columns (the ones next to the arms) nor the arms themselves. That is what
-- tells Priya's apron — white from the shoulder seam to below the waist, but never at her sides —
-- from Sofia's pale shirt, which wraps round to the sleeves.
local function frontOnlyColours(img, a)
  local out = {}
  if not a.armTop then return out end
  local l, r = a.armLeftX + 3, a.armRightX - 3
  local seen, allRound = {}, {}
  for y = a.neck + 1, a.legTop - 1 do
    for x = l, r do
      local p = get(img, x, y)
      if A(p) == 255 and not isInk(p) then seen[p] = true end
    end
    for _, x in ipairs({ l, r, a.armLeftX + 1, a.armRightX - 1 }) do
      local p = get(img, x, y)
      if A(p) == 255 and not isInk(p) then allRound[p] = true end
    end
  end
  for p in pairs(seen) do
    if not allRound[p] then out[p] = true end
  end
  return out
end

-- The colour of each torso row seen from behind or from the side: the most common colour of the
-- three columns inside each arm, front-only garments excluded, so horizontal bands — blouse, belt,
-- skirt — survive. A row the front garment covers edge to edge (an apron's skirt, the bib's top
-- row) takes the torso's most common side colour instead: the dress under the apron. It used to
-- take the apron itself, which is why Priya showed a white apron from behind.
local function torsoSides(img, a, frontOnly)
  local sides = {}
  if not a.armTop then return sides end
  local l, r = a.armLeftX + 3, a.armRightX - 3
  local tally, missing = {}, {}
  for y = a.neck + 1, a.legTop - 1 do
    local counts = {}
    for _, x in ipairs({ l, l + 1, l + 2, r - 2, r - 1, r }) do
      local p = get(img, x, y)
      if A(p) == 255 and not isInk(p) and not frontOnly[p] then counts[p] = (counts[p] or 0) + 1 end
    end
    local side = mode(counts)
    if side then
      sides[y] = side
      tally[side] = (tally[side] or 0) + 1
    else
      table.insert(missing, y)
    end
  end
  local fill = mode(tally)
  for _, y in ipairs(missing) do sides[y] = fill end
  return sides
end

-- Back view: the head turns to hair, front details (ties, buttons, aprons, bibs) turn to the
-- garment colour at the side of each row. Silhouette, outline, arms and legs are untouched.
local function backView(img, a, skin, hair, sides)
  local out = copy(img)
  -- Whatever sits on the top three rows of the head is a hat or the crown of the hair; both look
  -- the same from behind, so those colours are kept wherever they appear.
  local keep = crownColours(img, a)
  keep[skin] = nil
  local hairDark = pc.rgba(math.floor(pc.rgbaR(hair) * 0.75), math.floor(pc.rgbaG(hair) * 0.75),
                           math.floor(pc.rgbaB(hair) * 0.75), 255)
  for y = a.top + 1, a.neck do
    if a.minX[y] then
      for x = a.minX[y] + 1, a.maxX[y] - 1 do
        local p = get(img, x, y)
        local inside = A(get(img, x - 1, y)) == 255 and A(get(img, x + 1, y)) == 255
        if A(p) == 255 and inside and not keep[p] then
          if y >= a.neck - 1 then
            out:drawPixel(x, y, isInk(p) and p or skin)                   -- nape
          elseif y == a.neck - 2 then
            out:drawPixel(x, y, hairDark)                                 -- hairline shadow
          else
            out:drawPixel(x, y, hair)
          end
        end
      end
    end
  end
  -- Torso: each row flattens to its side colour (`torsoSides`), so the centre loses its
  -- front-only detail.
  if a.armTop then
    local l, r = a.armLeftX + 3, a.armRightX - 3
    for y = a.neck + 2, a.legTop - 1 do
      local side = sides[y]
      if side then
        for x = l, r do
          local p = get(img, x, y)
          if A(p) == 255 and not isInk(p) then out:drawPixel(x, y, side) end
        end
      end
    end
  end
  return out
end

-- ── Side view ──────────────────────────────────────────────────────────────────────────────
-- Facing right. Built from the front sprite in layers: the crown/hat rows as they are (a hat or
-- the top of the hair looks the same from every side), a profile face, the hair that hangs below
-- the ears, the torso with its centre columns (and so its front-only detail) taken out, one arm
-- over it, and two legs in stride. Keep in step with `drawSide` in bodySheet.ts.

local function scaled(p, f)
  local function c(v) return math.max(0, math.min(255, math.floor(v * f))) end
  return pc.rgba(c(pc.rgbaR(p)), c(pc.rgbaG(p)), c(pc.rgbaB(p)), 255)
end

local function round(v) return math.floor(v + 0.5) end

-- Profile head as palette slots from x = PROFILE_X, keyed by row offset from the eye row. Every
-- base sprite shares the face template (eyes five rows above the neck, an 8-px face at x 12..19),
-- so one profile fits all of them; what makes it theirs is the palette, the crown rows kept above
-- it, the hair hanging behind it and the beard on its jaw. The back half is hair with the ear in
-- front of it, the eye sits one pixel in from the brow, and the nose is the one pixel that sticks
-- out past the face (x = 20).
--   1/2 hair dark/mid · s/k/l skin shade/mid/light · w/e eye white/pupil · p mouth · O outline
local PROFILE_X = 11
local PROFILE = {
  [-1] = "O1221kkkk.",
  [0]  = "O122skwek.",
  [1]  = "O121sklkkk",
  [2]  = ".O1sklllk.",
  [3]  = "..Oskklkp.",
  [4]  = "...OskkkO.",
}

-- Hair hanging below the ears — long hair, Elena's braid, Priya's ponytail — lies outside the face
-- columns on the front sprite. Returns the lowest such row and its colour, or nil for short hair.
local function hangingHair(img, a, skin, eye)
  local counts, bottom = {}, nil
  for y = eye + 1, a.neck do
    for x = 0, W - 1 do
      if x < 12 or x > 19 then
        local p = get(img, x, y)
        if A(p) == 255 and not isInk(p) and dist(p, skin) > 70 and luma(p) < 200 then
          counts[p] = (counts[p] or 0) + 1
          bottom = y
        end
      end
    end
  end
  return bottom, mode(counts)
end

-- Facial hair: jaw rows (under the nose down to the chin) with at least three pixels that are
-- hair, not lips and not the shading of a darker skin — very dark, or close to the hair colour.
-- Two is not enough: Carlos's jaw shadow is two hair-dark pixels, and side-on it became a strap.
local function beardRows(img, eye, skin, hair)
  local rows, counts = {}, {}
  for y = eye + 2, eye + 4 do
    local n = 0
    for x = 13, 18 do
      local p = get(img, x, y)
      if A(p) == 255 and not isInk(p) and dist(p, skin) > 70 then
        local r, g, b = pc.rgbaR(p), pc.rgbaG(p), pc.rgbaB(p)
        local lip = r - g > 40 and r - b > 40
        if not lip and (luma(p) < 60 or dist(p, hair) < 40) then
          n = n + 1
          counts[p] = (counts[p] or 0) + 1
        end
      end
    end
    if n >= 3 then rows[y] = true end
  end
  return rows, mode(counts)
end

-- The first row of the legs proper: walking up from the feet, rows holding nothing but the two
-- legs (nothing outside x 12..19, a dark seam at 15/16). At most six rows: dark trousers pass the
-- seam test right up to the belt, and a hip that long would stride from the waist.
local function sideLegTop(img, a)
  local top = a.bottom
  for y = a.bottom, a.top, -1 do
    local ok = true
    for x = 0, W - 1 do
      if (x < 12 or x > 19) and A(get(img, x, y)) == 255 then ok = false end
    end
    for _, x in ipairs({ MID - 1, MID }) do
      local p = get(img, x, y)
      if A(p) == 255 and luma(p) > EYE_MAX_LUMA then ok = false end
    end
    if not ok then break end
    top = y
  end
  return math.max(top, a.bottom - 5)
end

-- Caps and brimmed hats. On the front sprite a cap's brim is a row exactly two pixels wider than
-- the cheeks on each side (James's hat, Ray's police cap), which copied straight across made a
-- profile with a bulge behind the head as well as in front — a hat that faces nowhere. Side-on the
-- brim belongs to the front only: the row shifts one pixel forward so the back of the head ends in
-- the crown's outline, and the bill grows `BILL_EXTRA` pixels past the face. Wider brims (Elena's
-- straw hat) are round and stay symmetric, and so does anything narrower: a bun or a bucket hat
-- has no row that overhangs the cheeks by two, so those sprites are untouched.
local BILL_EXTRA = 1
local function billForward(out, img, a, eye)
  -- The cheeks: the row two under the eyes is the widest bare-face row on every base sprite.
  local cheek = eye + 2
  local faceMin, faceMax = a.minX[cheek], a.maxX[cheek]
  if not faceMin then return end
  local moved, backX = false, nil
  for y = a.top + 3, eye - 2 do
    local l, r = a.minX[y], a.maxX[y]
    -- Two wider than the cheeks AND one wider than the crown row above: Elena's straw hat is also
    -- two wider than her (braid-widened) cheeks, but three wider than its own crown.
    local aboveL, aboveR = a.minX[y - 1], a.maxX[y - 1]
    if l and aboveL and l == faceMin - 2 and r == faceMax + 2 and l == aboveL - 1 and r == aboveR + 1 then
      local row = {}
      for x = l, r do row[#row + 1] = get(img, x, y); out:drawPixel(x, y, 0) end
      for i, px in ipairs(row) do
        if i == #row then
          for k = 0, BILL_EXTRA - 1 do out:drawPixel(l + i + k, y, row[#row - 1]) end
          out:drawPixel(l + i + BILL_EXTRA, y, px)
        else
          out:drawPixel(l + i, y, px)
        end
      end
      moved, backX = true, l
    end
  end
  if moved then
    -- The brim's soft shadow on the row below hung behind the head too; only the front stays.
    for x = 0, backX do
      local px = out:getPixel(x, eye - 1)
      if A(px) > 0 and A(px) < 255 then out:drawPixel(x, eye - 1, 0) end
    end
  end
end

-- Everything but the moving parts: crown, profile, hanging hair, neck, torso and drop shadow.
local function sideBody(img, a, skin, hair, frontOnly, sides, legTop)
  local out = blank()
  local eye = a.neck - 5
  for y = 0, eye - 2 do
    for x = 0, W - 1 do out:drawPixel(x, y, get(img, x, y)) end
  end
  -- Brim shadows and other translucent pixels on the face rows stay; so does the drop shadow.
  for y = eye - 1, H - 1 do
    for x = 0, W - 1 do
      local p = get(img, x, y)
      if (A(p) > 0 and A(p) < 255) or (y > a.bottom and A(p) > 0) then out:drawPixel(x, y, p) end
    end
  end

  billForward(out, img, a, eye)

  local hb, long = hangingHair(img, a, skin, eye)
  if hb then
    -- Behind the head: drawn first so the profile's back outline lies over it.
    for y = eye + 1, hb do
      out:drawPixel(10, y, OUTLINE)
      out:drawPixel(11, y, long)
      out:drawPixel(12, y, scaled(long, 0.8))
    end
    if hb < a.neck then
      out:drawPixel(11, hb + 1, OUTLINE)
      out:drawPixel(12, hb + 1, OUTLINE)
    end
  end

  local slots = {
    O = OUTLINE, ["1"] = scaled(hair, 0.75), ["2"] = hair,
    s = scaled(skin, 0.8), k = skin, l = scaled(skin, 1.12),
    w = EYE_WHITE, e = PUPIL,
    p = pc.rgba(math.floor(pc.rgbaR(skin) * 0.72), math.floor(pc.rgbaG(skin) * 0.62),
                math.floor(pc.rgbaB(skin) * 0.58), 255),
  }
  local beard, beardC = beardRows(img, eye, skin, hair)
  for dy = -1, 4 do
    local row, y = PROFILE[dy], eye + dy
    for i = 1, #row do
      local c = row:sub(i, i)
      if c ~= "." then
        local x = PROFILE_X + i - 1
        local p = slots[c]
        if beard[y] and beardC and x >= 15 and (c == "s" or c == "k" or c == "l") then p = beardC end
        out:drawPixel(x, y, p)
      end
    end
  end
  -- Neck, as on the front (its centre run only: long hair beside it was drawn above).
  if a.minX[a.neck] then
    for x = a.minX[a.neck], a.maxX[a.neck] do out:drawPixel(x, a.neck, get(img, x, a.neck)) end
  end

  -- Torso: drop the two centre columns (placket, tie, buttons — the front's own detail) and close
  -- the halves up, so the chest is two pixels narrower than the front and the arms are gone. A
  -- front-only garment keeps only the two frontmost columns: the edge of an apron seen side-on.
  for y = a.neck + 1, legTop - 1 do
    local x0, x1 = a.minX[y], a.maxX[y]
    if x0 and x0 < MID - 1 and x1 > MID then
      -- The body's own outline is the first ink out from the centre. The row's opaque run can go
      -- further: through the arms, or into Carlos's hammer hanging at his hip, which side-on
      -- became a stray fist in front of the belly.
      local l, r = x0, x1
      for x = MID - 2, x0, -1 do if isInk(get(img, x, y)) then l = x; break end end
      for x = MID + 1, x1 do if isInk(get(img, x, y)) then r = x; break end end
      if r - l >= 5 then x0, x1 = l, r end
      -- Arms drawn without an inner outline (Elena's two-pixel sleeves) have no ink to stop at:
      -- clamp to the torso proper and close it with outline. The arm band is the four rows over
      -- the hand, whatever `analyse` measured.
      local band = a.armBottom and y >= a.armBottom - 4 and y <= a.armBottom + 1
      if band then x0, x1 = math.max(x0, a.armLeftX + 2), math.min(x1, a.armRightX - 2) end
      for x = x0, MID - 2 do out:drawPixel(x + 1, y, get(img, x, y)) end
      for x = MID + 1, x1 do out:drawPixel(x - 1, y, get(img, x, y)) end
      if band then
        out:drawPixel(x0 + 1, y, OUTLINE)
        out:drawPixel(x1 - 1, y, OUTLINE)
      end
      if sides[y] then
        for x = x0 + 2, x1 - 4 do
          if frontOnly[out:getPixel(x, y)] then out:drawPixel(x, y, sides[y]) end
        end
      end
    end
  end
  return out
end

-- The near arm, from the shoulder to the hand, swung `swing` px at the hand (+ = forward). Sleeve
-- colours come from the front's arm column; an arm hidden under a braid falls back to the other
-- arm, then to the torso's side colour.
local DARK_SLEEVE_LUMA = 60
-- A lighter step of a dark colour (added, not scaled: scaling black stays black).
local function lifted(p)
  local function c(v) return math.min(255, v + 42) end
  return pc.rgba(c(pc.rgbaR(p)), c(pc.rgbaG(p)), c(pc.rgbaB(p)), 255)
end

local function sideArm(out, img, a, sides, skin, swing)
  if not a.armBottom then return end
  local top, bottom = a.armBottom - 3, a.armBottom
  local function armColour(y, fallback)
    for _, x in ipairs({ a.armLeftX + 1, a.armRightX - 1 }) do
      local p = get(img, x, y)
      if A(p) == 255 and not isInk(p) then return p end
    end
    return fallback
  end
  -- Near-black cloth (Marco's suit, Diego's jacket) sits on a torso of the same tone, so the arm
  -- (outline, sleeve, a darker shade) vanished. On a dark sleeve the leading column becomes a lit
  -- rim over the true sleeve colour, and the hand is always the skin-toned one with its shade.
  local dark = luma(armColour(top + 1, sides[top + 1] or skin)) < DARK_SLEEVE_LUMA
  for y = top, bottom do
    local x = 15 + round(swing * (y - top + 1) / (bottom - top + 1))
    local c = (y == bottom) and armColour(y, skin) or armColour(y, sides[y] or skin)
    out:drawPixel(x - 1, y, OUTLINE)
    if dark and y == bottom then
      out:drawPixel(x, y, skin)
      out:drawPixel(x + 1, y, scaled(skin, 0.8))
    elseif dark then
      out:drawPixel(x, y, lifted(c))
      out:drawPixel(x + 1, y, c)
    else
      out:drawPixel(x, y, c)
      out:drawPixel(x + 1, y, scaled(c, 0.8))
    end
    if y == bottom then out:drawPixel(x + 2, y, OUTLINE) end
  end
  out:drawPixel(15 + swing, bottom + 1, OUTLINE)
  out:drawPixel(16 + swing, bottom + 1, OUTLINE)
end

-- One leg from the front's left-leg strip (x 12..15: outline, two colours, seam). The hip stays
-- put and the foot lands `foot` px forward (+) or back (-), the rows between sheared along; `lift`
-- raises the foot like `liftLeg`. The sole and the closing outline reach one pixel further forward:
-- the toe that says which way the body faces. The far leg is darker, so a stride reads as two legs.
local function sideLeg(out, img, top, bottom, foot, lift, far)
  local n = math.max(1, bottom - top)
  for y = top, bottom do
    local sy = y + lift
    if sy <= bottom then
      local x = 14 + round(foot * (y - top) / n)
      for i = 0, 3 do
        local p = get(img, 12 + i, sy)
        if A(p) == 255 then
          if far and not isInk(p) then p = scaled(p, 0.7) end
          out:drawPixel(x + i, y, p)
        end
      end
      if sy == bottom - 1 then
        local shoe = get(img, 14, sy)
        if far and not isInk(shoe) then shoe = scaled(shoe, 0.7) end
        out:drawPixel(x + 3, y, shoe)
        out:drawPixel(x + 4, y, OUTLINE)
      elseif sy == bottom then
        out:drawPixel(x + 4, y, OUTLINE)
      end
    end
  end
end

-- idle, then the walk: contact (near leg forward, arm back) · passing (far leg swings through,
-- lifted) · contact (far leg forward, arm forward) · passing (near leg swings through). Contact
-- frames bob the body down a pixel, as the front walk does.
local SIDE_POSES = {
  { far = -1, near = 0, arm = 0, bob = 0 },
  { far = -2, near = 2, arm = -2, bob = 1 },
  { far = 1, farLift = 1, near = -1, arm = 0, bob = 0 },
  { far = 2, near = -2, arm = 2, bob = 1 },
  { far = -1, near = 1, nearLift = 1, arm = 0, bob = 0 },
}

local function sideFrames(img, a, skin, hair, frontOnly, sides)
  local legTop = sideLegTop(img, a)
  local body = sideBody(img, a, skin, hair, frontOnly, sides, legTop)
  local frames = {}
  for _, pose in ipairs(SIDE_POSES) do
    local f = copy(body)
    sideLeg(f, img, legTop, a.bottom, pose.far, pose.farLift or 0, true)
    sideLeg(f, img, legTop, a.bottom, pose.near, pose.nearLift or 0, false)
    sideArm(f, img, a, sides, skin, pose.arm)
    if pose.bob > 0 then f = bob(f, { legTop = legTop }, pose.bob) end
    table.insert(frames, f)
  end
  return frames
end

-- ── Build ──────────────────────────────────────────────────────────────────────────────────

local function walkCycle(base, a)
  -- lift L (right arm forward) · contact · lift R (left arm forward) · contact
  return {
    swingArm(liftLeg(base, a, "left", 1), a, "right", 1),
    bob(base, a, 1),
    swingArm(liftLeg(base, a, "right", 1), a, "left", 1),
    bob(base, a, 1),
  }
end

local function build(dir, name)
  local src = Image{ fromFile = app.fs.joinPath(dir, name .. ".png") }
  if src.width ~= W or src.height ~= H then
    print("skip " .. name .. " (not 32x32)")
    return
  end
  -- Normalise to an RGB image we own.
  local base = blank(); base:drawImage(src, Point(0, 0))
  local a = analyse(base)
  local skin, hair = palette(base, a)
  local frontOnly = frontOnlyColours(base, a)
  local sides = torsoSides(base, a, frontOnly)
  local back = backView(base, a, skin, hair, sides)

  local frames = { base, blink(base, a, skin) }
  for _, f in ipairs(walkCycle(base, a)) do table.insert(frames, f) end
  table.insert(frames, back)
  for _, f in ipairs(walkCycle(back, a)) do table.insert(frames, f) end
  for _, f in ipairs(sideFrames(base, a, skin, hair, frontOnly, sides)) do table.insert(frames, f) end
  assert(#frames == TAGS[#TAGS][3], "frame count out of step with TAGS")

  local spr = Sprite(W, H, ColorMode.RGB)
  spr.filename = name .. "_sheet"
  for i = 2, #frames do spr:newEmptyFrame() end
  local layer = spr.layers[1]
  layer.name = "body"
  for i, img in ipairs(frames) do spr:newCel(layer, spr.frames[i], img, Point(0, 0)) end
  for _, t in ipairs(TAGS) do
    for i = t[2], t[3] do spr.frames[i].duration = t[4] / 1000 end
    local tag = spr:newTag(t[2], t[3]); tag.name = t[1]
  end
  spr:saveAs(app.fs.joinPath(dir, name .. "_sheet.aseprite"))

  local strip = Image(W * #frames, H, ColorMode.RGB)
  strip:clear(0)
  for i, img in ipairs(frames) do strip:drawImage(img, Point((i - 1) * W, 0)) end
  strip:saveAs(app.fs.joinPath(dir, name .. "_sheet.png"))
  spr:close()
  local function hex(p) return string.format("%02x%02x%02x", pc.rgbaR(p), pc.rgbaG(p), pc.rgbaB(p)) end
  print(string.format("%-18s legTop=%d neck=%d arms=%s-%s eye=%s skin=%s hair=%s", name, a.legTop, a.neck,
    tostring(a.armTop), tostring(a.armBottom), tostring(a.eyeRow), hex(skin), hex(hair)))
end

local dir = app.params.dir or "public/sprites/agents"
local only = app.params.only
for _, f in ipairs(app.fs.listFiles(dir)) do
  local name = f:match("^(.-)%.png$")
  if name and not name:find("_portrait") and not name:find("_sheet$")
     and (not only or only == name) then
    build(dir, name)
  end
end
