-- critters.lua — ambient critters and the well splash for the AmbientLifeSystem.
--
-- Usage (Aseprite CLI, batch mode):
--   Aseprite.exe -b --script-param dir=public/sprites/fx --script scripts/aseprite/critters.lua
--
-- Writes critters.aseprite (one frame per cell, tagged by kind) and critters.png, a strip of
-- 16x16 cells. Cell order — keep in sync with AMBIENT_FRAMES in
-- src/components/canvas/systems/ambientLife/ambientFrames.ts:
--
--   0-1 bird peck (head up, head down)   2 bird hop        3-4 bird fly (wings up, down)
--   5-6 butterfly (open, half closed)    7-8 moth (spread, raised)
--   9 cat sit   10-11 cat walk   12 cat lick   13-14 duck swim   15-17 well splash
--
-- Everything faces right (the system mirrors). Critters are background dressing, so they are
-- small and muted: a soft dark-brown outline (never the agents' near-black #1a1510), earthy
-- mid-tones, and a baked contact shadow under the walkers, cast down-right like the props'.
-- Frames are written as character grids; the palette key sits in PAL below.

local S = 16
local pc = app.pixelColor
local function hex(h, a) return pc.rgba((h >> 16) & 255, (h >> 8) & 255, h & 255, a or 255) end

-- Palette key. Lower case = sparrow, upper case = the rest.
local PAL = {
  -- sparrow
  o = hex(0x2f2620), b = hex(0x8c6c4a), d = hex(0x5c4430), l = hex(0xcfc0a0),
  c = hex(0xa4603a), k = hex(0xd6a63e), e = hex(0x16110d), g = hex(0xa88450),
  -- shared shadow (semi transparent)
  s = hex(0x1a2412, 70),
  -- butterfly (warm orange, cream spots) and its body
  W = hex(0xc98f4c), D = hex(0x5e3a1e), L = hex(0xf2d494), B = hex(0x33261a), A = hex(0x5e3a1e),
  -- moth (pale, dusty)
  M = hex(0xd6cbb0), N = hex(0xa39672), n = hex(0x6f6248), Y = hex(0xf0e8d0),
  -- cat (ginger tabby)
  C = hex(0xc98a44), T = hex(0x8c5a2a), F = hex(0xecc890), O = hex(0x3a2818),
  E = hex(0x2c3a14),
  -- duck (mallard)
  G = hex(0x44704c), H = hex(0x2e5238), U = hex(0x9a8a76), V = hex(0x6c5e4c), X = hex(0xf0ece0),
  Z = hex(0xdcae44), R = hex(0x5b3a1e),
  -- water (duck ripples, splash)
  w = hex(0xb6d8e2, 190), q = hex(0x8ab8c8, 150), z = hex(0xf2fbff, 230), y = hex(0x6a9aac, 110),
}

local function frame(name, rows)
  assert(#rows == S, name .. ": " .. #rows .. " rows")
  local img = Image(S, S, ColorMode.RGB)
  img:clear(0)
  for y = 1, S do
    local row = rows[y]
    assert(#row == S, name .. ": row " .. y .. " has " .. #row .. " cols")
    for x = 1, S do
      local ch = row:sub(x, x)
      if ch ~= "." then
        assert(PAL[ch], name .. ": unknown '" .. ch .. "'")
        img:drawPixel(x - 1, y - 1, PAL[ch])
      end
    end
  end
  return img
end

-- Left half (8 cols) mirrored into a full row: symmetric critters only need half a grid.
local function sym(half)
  local out = {}
  for i, r in ipairs(half) do out[i] = r .. r:reverse() end
  return out
end

-- ── Sparrow ─────────────────────────────────────────────────────────────────────────────

local bird = {}

bird.peckUp = {
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "...........ooo..",
  "..........occco.",
  "..........bbebko",
  "....oo....obbbo.",
  "...oddoo.oblllo.",
  "..odddboobllllo.",
  ".odddbbbbblllo..",
  "..oddbbbbbbbo...",
  "...oobbbbboo....",
  ".....og.og.sss..",
}

bird.peckDown = {
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....oo..........",
  "...oddoo........",
  "..odddboo..oo...",
  ".odddbbbboocco..",
  "..oddbbbbllbebk.",
  "...oobbbbllllo..",
  ".....obbbboo....",
  ".....og.og.sss..",
}

bird.hop = {
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "...........ooo..",
  "..........occco.",
  "..........bbebko",
  "....oo....obbbo.",
  "...oddoo.oblllo.",
  "..odddboobllllo.",
  ".odddbbbbblllo..",
  "..oddbbbbbbbo...",
  "...oobbbbboo.g..",
  "....sssssssss...",
}

bird.flyUp = {
  "................",
  "................",
  "......oo........",
  ".....oddo.o.....",
  "....oddddbo.....",
  "....odddbbbo....",
  ".....odbbbboooo.",
  "......obbbbcccbo",
  ".ooo..oblbbbebko",
  "oddbo.oblllbbbo.",
  ".odbboolllllbo..",
  "..oobbblllllo...",
  "....obbbbbbo....",
  ".....ooooooo....",
  "................",
  "................",
}

bird.flyDown = {
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  ".ooo......oooo..",
  "oddbo....occcbo.",
  ".oddbooooobebko.",
  "..obbbbbbbbbbo..",
  "...oblllllllo...",
  "...obbdddbbbo...",
  "....oodddddoo...",
  "......odddo.....",
  ".......ooo......",
  "................",
}

-- ── Butterfly (left halves, mirrored) ───────────────────────────────────────────────────

local E8 = "........"

local butterflyOpen = sym({
  E8,
  E8,
  "....A...",
  ".....A..",
  ".DDD.AB.",
  "DWWWD.B.",
  "DWLLWDDB",
  "DWLWWWWB",
  "DWWWWWWB",
  ".DWWWDDB",
  "..DWWD.B",
  "..DLWWD.",
  "..DWWWD.",
  "...DDD..",
  E8,
  E8,
})

local butterflyHalf = sym({
  E8,
  E8,
  E8,
  "....A...",
  ".....A..",
  "..DD.AB.",
  ".DWWD.B.",
  ".DWLWDDB",
  ".DWWWWWB",
  "..DWWWDB",
  "...DWWDB",
  "....DDD.",
  E8,
  E8,
  E8,
  E8,
})

-- ── Moth ────────────────────────────────────────────────────────────────────────────────

local mothSpread = sym({
  E8,
  E8,
  E8,
  E8,
  "......n.",
  ".nnn..nn",
  "nMMMNnnB",
  "nMYMMMMB",
  "nMMMMMNB",
  ".nNNNNnB",
  "..nnnnnB",
  E8,
  E8,
  E8,
  E8,
  E8,
})

local mothRaised = sym({
  E8,
  E8,
  E8,
  E8,
  ".nn...n.",
  "nMMn..nn",
  "nMYMnnnB",
  "nMMMMNNB",
  ".nMMNnNB",
  "..nnnnBB",
  E8,
  E8,
  E8,
  E8,
  E8,
  E8,
})

-- ── Cat ─────────────────────────────────────────────────────────────────────────────────

local cat = {}

-- Sitting: a front-facing head on an upright pin of a body, tail tip curling out at the left.
cat.sit = {
  "................",
  "................",
  "................",
  "....oo....oo....",
  "....oCo..oCo....",
  "....oCCooCCo....",
  "....oCTCCTCo....",
  "....oCeCCeCo....",
  "....oCCFFCCo....",
  ".....oCCCCo.....",
  "....oCCFFCCo....",
  "...oCTCFFCTCo...",
  "...oCCCFFCCCo...",
  "..oTCCCFFCCCCo..",
  ".oTTCCCooCCCCo..",
  "..ooooooooooo.ss",
}

-- Walking: profile, tail up, legs apart (A) then gathered (B).
local catBody = {
  "................",
  "................",
  "..o.......o..o..",
  ".oTo.....oCooCo.",
  ".oTo.....oCCCCCo",
  ".oTo...ooCCCCeFo",
  ".oTo.oCCCCCCFFo.",
  ".oTCCCCCCCCCCo..",
  ".oTCCCCTCCCCTCo.",
  "..oCCCCCCCCCCCo.",
  "...oCFFFFFFCCo..",
}

local function catWalk(legs)
  local rows = {}
  for i, r in ipairs(catBody) do rows[i] = r end
  for _, r in ipairs(legs) do rows[#rows + 1] = r end
  return rows
end

cat.walkA = catWalk({
  "...oCo....oCo...",
  "...oCo....oCo...",
  "...ooo....ooo.ss",
  "................",
  "................",
})

cat.walkB = catWalk({
  "....oCCoCCo.....",
  "....oCCoCCo.....",
  "....ooo.ooo.ss..",
  "................",
  "................",
})

-- Licking a raised paw: eyes shut, paw held up at the muzzle.
cat.lick = {
  "................",
  "................",
  "................",
  "....oo....oo....",
  "....oCo..oCo....",
  "....oCCooCCo....",
  "....oCTCCTCo....",
  "....oCTCCTCo....",
  "....oCCFFCCFFo..",
  ".....oCCCCCFo...",
  "....oCCFFCCo....",
  "...oCTCFFCTCo...",
  "...oCCCFFCCCo...",
  "..oTCCCFFCCCCo..",
  ".oTTCCCooCCCCo..",
  "..ooooooooooo.ss",
}

-- ── Duck ────────────────────────────────────────────────────────────────────────────────

local duck = {}

duck.a = {
  "................",
  "................",
  "................",
  "..........ooo...",
  ".........oGGGo..",
  ".........GeGGZZ.",
  ".........oGGoZZ.",
  "..........oXXo..",
  "....ooooo.oUUo..",
  "..ooUUUUUoUUUo..",
  ".oUUVVUUUUUUUo..",
  ".oUVVVUUUUUUo...",
  "..ooUUUUUUUoo...",
  "...wwooooowwww..",
  "..qqwwwqqwwqq...",
  "................",
}

duck.b = {
  "................",
  "................",
  "................",
  "..........ooo...",
  ".........oGGGo..",
  ".........GeGGZZ.",
  ".........oGGoZZ.",
  "..........oXXo..",
  "....ooooo.oUUo..",
  "..ooUUUUUoUUUo..",
  ".oUUVVUUUUUUUo..",
  ".oUVVVUUUUUUo...",
  "..ooUUUUUUUoo...",
  "..wwwooooowwwww.",
  "...qqwwqqwwqq...",
  "................",
}

-- ── Well splash (top-down water, ripple rings + droplets) ───────────────────────────────

local splash = {}

splash.a = {
  "................",
  "................",
  "................",
  "................",
  "................",
  "......yyyy......",
  "....yyqqqqyy....",
  "....yq....qy....",
  "....yq..z.qy....",
  "....yq....qy....",
  "....yyqqqqyy....",
  "......yyyy......",
  "................",
  "................",
  "................",
  "................",
}

splash.b = {
  "................",
  "................",
  "................",
  "................",
  "................",
  "......yqqy......",
  "....yqwwwwqy....",
  "...yqw....wqy...",
  "...yq..zz..qy...",
  "...yqw....wqy...",
  "....yqwwwwqy....",
  "......yqqy......",
  "................",
  "................",
  "................",
  "................",
}

splash.c = {
  "................",
  "................",
  "................",
  "................",
  ".....yyyyyy.....",
  "...yyqwwwwqyy...",
  "..yqww....wwqy..",
  "..yqw..z...wqy..",
  "..yq..z.z...qy..",
  "..yqw.....wwqy..",
  "..yqww....wwqy..",
  "...yyqwwwwqyy...",
  ".....yyyyyy.....",
  "................",
  "................",
  "................",
}

local cells = {
  { "bird", frame("bird.peckUp", bird.peckUp) },
  { "bird", frame("bird.peckDown", bird.peckDown) },
  { "bird", frame("bird.hop", bird.hop) },
  { "bird", frame("bird.flyUp", bird.flyUp) },
  { "bird", frame("bird.flyDown", bird.flyDown) },
  { "butterfly", frame("butterfly.open", butterflyOpen) },
  { "butterfly", frame("butterfly.half", butterflyHalf) },
  { "moth", frame("moth.spread", mothSpread) },
  { "moth", frame("moth.raised", mothRaised) },
  { "cat", frame("cat.sit", cat.sit) },
  { "cat", frame("cat.walkA", cat.walkA) },
  { "cat", frame("cat.walkB", cat.walkB) },
  { "cat", frame("cat.lick", cat.lick) },
  { "duck", frame("duck.a", duck.a) },
  { "duck", frame("duck.b", duck.b) },
  { "splash", frame("splash.a", splash.a) },
  { "splash", frame("splash.b", splash.b) },
  { "splash", frame("splash.c", splash.c) },
}

local dir = app.params.dir or "public/sprites/fx"
app.fs.makeAllDirectories(dir)

local spr = Sprite(S, S, ColorMode.RGB)
spr.filename = "critters"
for i = 2, #cells do spr:newEmptyFrame() end
for i, c in ipairs(cells) do spr:newCel(spr.layers[1], spr.frames[i], c[2], Point(0, 0)) end
local from = 1
for i = 1, #cells do
  if i == #cells or cells[i + 1][1] ~= cells[i][1] then
    local tag = spr:newTag(from, i); tag.name = cells[i][1]
    from = i + 1
  end
end
spr:saveAs(app.fs.joinPath(dir, "critters.aseprite"))
spr:close()

local strip = Image(S * #cells, S, ColorMode.RGB)
strip:clear(0)
for i, c in ipairs(cells) do strip:drawImage(c[2], Point((i - 1) * S, 0)) end
strip:saveAs(app.fs.joinPath(dir, "critters.png"))
print(#cells .. " critter frames")
