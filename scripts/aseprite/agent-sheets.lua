-- agent-sheets.lua — derive walk/idle animation sheets from the static agent sprites.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/agents --script scripts/aseprite/agent-sheets.lua
--   (add --script-param only=carlos_mendez to rebuild one agent)
--
-- The hand-authored 32x32 front sprite `<name>.png` stays the source of truth. For each one this
-- writes `<name>_sheet.aseprite` (frames + tags, editable in Aseprite) and `<name>_sheet.png`, a
-- horizontal strip the client slices by index. Frame layout — keep in sync with
-- `SHEET_FRAMES` in src/components/canvas/agentSheet.ts:
--
--   0 idle_down   1 blink_down   2-5 walk_down   6 idle_up   7-10 walk_up
--
-- Everything is derived rather than drawn so all 13 residents keep their identity and a retouch of
-- the base sprite only needs a re-run. The derivations lean on the layout every base sprite shares:
-- feet at the bottom with a translucent drop shadow under them, legs split by an outline column at
-- x=15/16, head on top of a wider torso whose outermost columns are the arms.

local W, H = 32, 32
local MID = 16 -- first column of the right half

local pc = app.pixelColor
local function A(p) return pc.rgbaA(p) end
local function key(p) return p end
local function luma(p) return 0.299 * pc.rgbaR(p) + 0.587 * pc.rgbaG(p) + 0.114 * pc.rgbaB(p) end
local OUTLINE = app.pixelColor.rgba(0x1a, 0x15, 0x10, 255) -- the art bible's universal outline
local EYE_MAX_LUMA = 34 -- pupils are near-black; so is a lot of hair, hence the isolation test

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
          if A(p) == 255 and not isInk(p) and not crown[p] and dist(p, skin) > 70 and luma(p) < 200 then
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

-- Back view: the head turns to hair, front details (ties, buttons, aprons, bibs) turn to the
-- garment colour at the side of each row. Silhouette, outline, arms and legs are untouched.
local function backView(img, a, skin, hair)
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
  -- Torso: each row takes the most common colour of the three columns inside each arm, so
  -- horizontal bands — blouse, belt, skirt — survive while the centre loses its front-only detail.
  if a.armTop then
    local l, r = a.armLeftX + 3, a.armRightX - 3
    for y = a.neck + 2, a.legTop - 1 do
      local counts = {}
      for _, x in ipairs({ l, l + 1, l + 2, r - 2, r - 1, r }) do
        local p = get(img, x, y)
        if A(p) == 255 and not isInk(p) then counts[p] = (counts[p] or 0) + 1 end
      end
      local side = mode(counts)
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
  local back = backView(base, a, skin, hair)

  local frames = { base, blink(base, a, skin) }
  for _, f in ipairs(walkCycle(base, a)) do table.insert(frames, f) end
  table.insert(frames, back)
  for _, f in ipairs(walkCycle(back, a)) do table.insert(frames, f) end

  local spr = Sprite(W, H, ColorMode.RGB)
  spr.filename = name .. "_sheet"
  for i = 2, #frames do spr:newEmptyFrame() end
  local layer = spr.layers[1]
  layer.name = "body"
  for i, img in ipairs(frames) do spr:newCel(layer, spr.frames[i], img, Point(0, 0)) end
  local durations = { 400, 120, 140, 140, 140, 140, 400, 140, 140, 140, 140 }
  for i, d in ipairs(durations) do spr.frames[i].duration = d / 1000 end
  local tags = {
    { "idle_down", 1, 1 }, { "blink_down", 2, 2 }, { "walk_down", 3, 6 },
    { "idle_up", 7, 7 }, { "walk_up", 8, 11 },
  }
  for _, t in ipairs(tags) do
    local tag = spr:newTag(t[2], t[3]); tag.name = t[1]
  end
  spr:saveAs(app.fs.joinPath(dir, name .. "_sheet.aseprite"))

  local strip = Image(W * #frames, H, ColorMode.RGB)
  strip:clear(0)
  for i, img in ipairs(frames) do strip:drawImage(img, Point((i - 1) * W, 0)) end
  strip:saveAs(app.fs.joinPath(dir, name .. "_sheet.png"))
  spr:close()
  print(string.format("%-18s legTop=%d neck=%d arms=%s-%s eye=%s", name, a.legTop, a.neck,
    tostring(a.armTop), tostring(a.armBottom), tostring(a.eyeRow)))
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
