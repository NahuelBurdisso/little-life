# Living Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the town's drama *visible*: pixel-art emotes and state poses, on-map story beats, job
tools in hand, town-event decorations, ambient life and expressive portraits — without hurting frame
rate, and without server changes.

**Architecture:** Six independent workstreams on top of a shared foundation (commit "feat(canvas):
pluggable canvas systems"). Each workstream is a *canvas system* (`src/components/canvas/systems/`)
registered with one line in `systems/index.ts`, plus one Aseprite Lua script that generates its atlas.
Pure logic (what to show, when) lives in a pixi-free module with vitest tests; the system class only
renders. Workstreams A (emotes/poses) and F (portraits) extend existing modules instead.

**Tech Stack:** PixiJS 8, React 19, TypeScript strict, Vitest 2, Aseprite 1.3.18 CLI (Lua).

---

## Ground rules for every workstream

- Read `CLAUDE.md` and `docs/STATUS.md` first. Gate: `npm run check` (tsc + vitest) green before
  every commit. Test output is noisy — grep for `Test Files` / `FAIL`.
- **No server changes.** Everything the canvas needs is already on the client (see "Data" below).
- **Art:** Aseprite CLI at `D:\SteamLibrary\steamapps\common\Aseprite\Aseprite.exe`, batch Lua
  scripts in `scripts/aseprite/`, following `scripts/aseprite/nature-props.lua` (deterministic
  seeded rand, writes `<name>.aseprite` with tags + `<name>.png` strip). Run:
  `"/d/SteamLibrary/steamapps/common/Aseprite/Aseprite.exe" -b --script-param dir=public/sprites/<dir> --script scripts/aseprite/<file>.lua`
  Palette: 24 swatches in `scripts/aseprite/furniture.lua` (`P` table). Outline `#1a1510` for
  objects/agent-scale things; terrain-level decoration uses dark green/brown outlines (see
  nature-props.lua). Emotes and FX may be brighter — agents and their overlays are the foreground.
- **Loading:** strips are sliced with `loadStrip(url, frameCount, frameSize)` from
  `src/components/canvas/stripAtlas.ts` (frameSize defaults to 32; emotes use 16). Keep the frame
  table in a pure `*Frames.ts` module next to the system and in sync with the Lua header comment.
- **Performance contract** (`systems/types.ts`): no allocation per frame in the steady state (pool
  sprites, reuse arrays), skip/hide what `inView(frame.view, x, y)` rejects, thin decoration with
  `detailLevel(frame.view.scale)`, never throw from `update`. Target: the whole feature set adds
  < 1 ms/frame and < 150 display objects at a normal zoom.
- **Verification in the browser** is done by the integrator, not by workstream agents (only one dev
  server can own ports 3001/5173). Workstreams verify with tsc + unit tests + a rendered preview of
  their atlas (Aseprite contact sheet).
- Commits: Conventional Commits, English, small and themed, ending with
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Foundation (done by the integrator before fan-out)

- `AgentSprite.rig` — container holding the body sprite; all pose transforms apply to it.
  `AgentSprite.hand` (front, at the right hand of a right-facing body, mirrors with facing) and
  `AgentSprite.behind` (behind the body) accept attachments. Read-only getters: `facingDir`,
  `viewFacing` ('down'|'up'), `currentAction`, `isWalking`, `workStroke` (0..1), `lyingBlend`.
  `HEAD_HEIGHT` export (27 px above the feet).
- `systems/types.ts` — `CanvasSystem { update(frame); onData?(data); destroy() }`,
  `SystemFactory(layers, services)`, layers `ground` (under agents) and `overAgents` (over agents,
  under particles/bubbles), services `{ sprites: SpritePool, bubbles: BubbleSystem }`.
- `systems/view.ts` — `inView`, `detailLevel`.
- `DataContext` — agents, world, events, locations, conversations, relationships, activity (newest
  50 `activity_log` rows).
- `SpritePool.recentlyRemoved` — agents dropped by the last update with their last x/y (deaths).
- `src/lib/canvasBus.ts` — `onCanvasEvent`/`emitCanvasEvent`; `useNudge` emits
  `{type:'intervention', kind, agentIds}` after a successful nudge.

## Data available on the client (no server work needed)

- Agent (`agents.getActive`, ~1 Hz): `current_action {type, pose?, zoneActivity?, conversationId?,
  emote?, emote_at?}` — types: idle, sleeping, eating, working, socializing, walking, shopping,
  comfort, talking. Zone activities ride on idle/comfort: fish, garden, forage, contemplate, perform,
  jog, browse, rest, shoplifting, pickpocket, comfort. `activeStates[] {type, severity,
  target_agent_id}` — drunk, hungover, sick, heartbroken, angry, stressed, euphoric, grieving,
  infatuated, lonely, depressed, confident, jealous, alcoholic, in_debt, arrested. `needs.mood`,
  `workplace` (location id), `hobbies[] {hobby, level}`, `age`, `gender`.
- Relationships rows: `status` (partners, romantic_interest, best_friends, enemies, rivals,
  estranged...), `tags` (grudge...).
- Activity rows: `type` (`gift`, `hobby_levelup`, `relationship_status_change`, `drama`,
  `player_*`...), `initiator_id`, `target_id`, `agent_ids`, `template_data.description` (prose;
  `drama` has no subtype — classify by description), `real_timestamp`.
- World events (`events` prop): festival, market_day, storm, sickness, harvest, traveling_merchant,
  town_meeting, wedding, fire_outbreak, mysterious_stranger, competition, full_moon, heatwave,
  bountiful_catch, starry_night, scandal, blessing, funeral (`triggered_by: 'death:<id>'`),
  new_arrival. Rows: `type, name, started_at, duration, location_id|null`.
- Locations: `type` (home, shop, tavern, clinic, town_hall, bakery, workshop, prison, pawnshop,
  divebar, town_square, park, farm, market_square, alley, farmyard...), `position {x,y,width,height}`,
  `entry_point`.

---

## Workstream A — Pixel emotes & state poses

**Why:** today emotes are OS emoji rendered with `PIXI.Text` (off-style, one allocation per emote),
and states only show as a ring under the feet.

**Files:**
- Create: `scripts/aseprite/emotes.lua` → `public/sprites/fx/emotes.{aseprite,png}` (16×16 cells)
- Create: `src/components/canvas/emoteFrames.ts` (pure: emote → frame indices, frame timing)
- Create: `src/components/canvas/statePose.ts` (pure: activeStates + mood → pose + params)
- Test: `src/components/canvas/__tests__/emoteFrames.test.ts`, `__tests__/statePose.test.ts`
- Modify: `src/components/canvas/BubbleSystem.ts` (`showEmote` renders atlas frames, pooled)
- Modify: `src/components/canvas/AgentSprite.ts` (apply state pose in `animate`; add `setStatePose`)
- Modify: `src/components/canvas/SpritePool.ts` (call `setStatePose(statePoseFor(agent))`)

- [ ] **A1 Atlas.** Every key of `EMOTE_EMOJIS` in BubbleSystem.ts (heart, anger, laugh, wave,
  question, exclaim, zzz, cry, sparkle, fish, flower, music, sweat, money, skull, fire, star, drink,
  sick, think, work) plus new ones used by other workstreams: gift, handcuffs, whisper, levelup,
  candle, cake, broken_heart, dizzy. 2–4 frames each (e.g. heart pulses, zzz rises, anger cross
  throbs, sweat drop falls). 16×16, 1px `#1a1510` outline, saturated fills. Layout = one strip;
  `emoteFrames.ts` maps name → `{ frames: number[], fps }`. Export the full name list so other
  workstreams can reference names safely.
- [ ] **A2 Test the frame table:** every name has ≥1 frame, all indices < frame count, names cover
  every key BubbleSystem uses.
- [ ] **A3 BubbleSystem.showEmote:** keep the public signature. Render a `PIXI.Sprite` from the
  atlas (fallback to the old emoji Text while the atlas loads or if it fails), animate through the
  frames by elapsed time in `update`, float + fade as today. Pool emote sprites (reuse destroyed
  entries' sprites) instead of creating containers per call.
- [ ] **A4 statePose (pure, tested):** priority-ordered mapping to a pose descriptor:
  drunk → `sway` (slow ±0.12 rad lean + lateral drift ±1.5px, 0.4 Hz); sick/hungover → `shiver`
  (fast ±0.5px x jitter, green-ish tint 0xd8f0c8 multiplied); heartbroken/depressed/grieving or
  mood < 20 → `slump` (scale.y 0.94, lean forward 0.08 rad, slower breathing); angry → `stomp`
  (every ~1.2s a 1px hop + tiny shake); euphoric or mood > 85 → `bounce` (small happy hop every 2s);
  stressed → `fidget` (quick 0.5px x twitch every ~0.8s); arrested → `hunch` (like slump, no bob);
  otherwise `none`. Tests: priority (angry beats drunk? define and test the order), thresholds.
- [ ] **A5 AgentSprite:** `setStatePose(p)`; in `animate`, when not sleeping/walking, add the pose
  offsets *on top of* the existing idle/sit/work transforms on `rig` (never replace them); while
  walking only `sway` applies (drunk walk). Tint for `shiver` multiplies with the mood tint.
- [ ] **A6** `npm run check`, commit per step group (atlas; bubble emotes; state poses).

## Workstream B — Story beats on the map

**Why:** fights, gifts, love, arrests, secrets, level-ups and deaths only exist as feed text.

**Files:**
- Create: `scripts/aseprite/beat-fx.lua` → `public/sprites/fx/beats.{aseprite,png}` (32×32)
- Create: `src/components/canvas/systems/beats/beatDetect.ts` (pure)
- Create: `src/components/canvas/systems/beats/beatFrames.ts` (pure frame table)
- Create: `src/components/canvas/systems/beats/BeatSystem.ts` (+ register in `systems/index.ts`)
- Test: `src/components/canvas/systems/beats/__tests__/beatDetect.test.ts`

- [ ] **B1 beatDetect (pure, tested).** Input: previous + current snapshot (activity rows, agents,
  relationships, removed agents) and a watermark (last seen activity id, initialised to the newest
  id on first call so a page load does not replay history). Output: `Beat[]` =
  `{ kind, agentIds, at? }` with kinds:
  - `fight` — drama rows whose description matches fight/punch/shouting match/insulted/started a
    fight (grep the exact phrasings in `server/lib/confrontationEngine.ts`,
    `server/engine/systems/conversations.ts`, `server/lib/cascade/SnapResolver.ts`).
  - `gift` — `type === 'gift'` (initiator = giver, target = receiver).
  - `romance` — `relationship_status_change` to partners/romantic_interest, drama "on a date",
    "flirted with", reconciliation.
  - `heartbreak` — breakup/affair discovered rows, status change to estranged.
  - `arrest` — agent gains `arrested` state (target_agent_id = constable) or the arrest drama row.
  - `secret` — "confided", "overheard", "told", "discovered" rows.
  - `levelup` — any `hobbies[].level` increase per agent (diff, not the milestone rows).
  - `birthday` — `age` increased.
  - `death` — agent in `removed` list whose id appears as initiator of a "has died" row (or any
    removal when a funeral event for them exists); carries last x/y.
  - `intervention` — from canvasBus (handled in the system, not the detector).
  Dedupe: one beat per (kind, sorted agentIds) per 20 s. Tests with fixture rows for each kind and
  the watermark/first-load behaviour.
- [ ] **B2 FX atlas** (32×32, 3–6 frames each): dust-cloud brawl (swirl with stars/limbs), gift box
  (pops open with sparkle), heart burst, cracked heart, handcuffs clink, whisper swirl (curly
  lines), level-up star burst, birthday cake with candle flicker, ghost/soul rising (death, soft
  white, tasteful), intervention ping (a ring with sparkles, gold).
- [ ] **B3 BeatSystem.** On each beat, spawn a pooled FX sprite in `overAgents` at the agents'
  midpoint (fight/romance/secret: between the two; gift: travels from giver to receiver over 0.8s
  as a small box sprite, then pops at the receiver), play once (~1–1.5 s), fade. Also call
  `services.bubbles.showEmote` for the matching emote on each participant (names from A's list:
  exclaim, heart, broken_heart, handcuffs, whisper, levelup, cake, gift; fall back to existing
  names if A isn't merged yet — the emoji fallback covers unknown names). Death: ghost rises from
  the last x/y. Intervention (canvasBus): gold ping on each agent + `exclaim` emote. Cap 8 live
  FX; drop oldest. Hide FX not in view.
- [ ] **B4** register, `npm run check`, commit.

## Workstream C — Tools in hand

**Files:**
- Create: `scripts/aseprite/held-items.lua` → `public/sprites/fx/held.{aseprite,png}` (16×16)
- Create: `src/components/canvas/systems/held/heldItem.ts` (pure)
- Create: `src/components/canvas/systems/held/HeldItemSystem.ts` (+ register)
- Test: `src/components/canvas/systems/held/__tests__/heldItem.test.ts`

- [ ] **C1 heldItem (pure, tested):** `(actionType, zoneActivity, workplaceType, currentLocationId,
  workplaceId) → item | null`. Working *at* the workplace: bakery → rolling pin, workshop → hammer,
  clinic → clipboard, shop/pawnshop → ledger, tavern/divebar → mug, town_hall → quill, prison →
  keys, farm → hoe. Eating → plate, socializing at tavern → mug, shopping → basket, zone activity
  fish → rod, garden/forage → watering can / basket, perform → lute, contemplate/rest → book,
  jog → none. Sleeping/walking-without-purpose → none. Tests for each branch.
- [ ] **C2 atlas:** the items above, 16×16, 1–2 frames (hammer has a raised frame).
- [ ] **C3 HeldItemSystem:** one pooled sprite per agent attached to `sprite.hand` (anchor at the
  grip). Sync: hammer/rolling pin rotate with `sprite.workStroke` (swing), rod bobs, mug tilts
  every few seconds. Hide when `sprite.viewFacing === 'up'` for items held in front (back view),
  when lying, or when not in view. Recompute item in `onData` (look up workplace type via
  locations), only transforms per frame.
- [ ] **C4** register, `npm run check`, commit.

## Workstream D — Town event decorations

**Files:**
- Create: `scripts/aseprite/event-decor.lua` → `public/sprites/fx/decor.{aseprite,png}` (32×32)
- Create: `src/components/canvas/systems/townEvents/eventDecor.ts` (pure: event types → decor plan)
- Create: `src/components/canvas/systems/townEvents/TownEventSystem.ts` (+ register)
- Test: `src/components/canvas/systems/townEvents/__tests__/eventDecor.test.ts`

- [ ] **D1 eventDecor (pure, tested):** active event types + locations → list of placements
  `{ frame, x, y, animated? }`, deterministic. Anchor at the town_square (fallback: market_square,
  then map centre). Festival: bunting strings along the square's edges + lantern posts + a stall;
  market_day / traveling_merchant: extra stalls with awnings and crates at market_square; wedding:
  flower arch + petals + white bunting; funeral: wreath + candles + dark bunting; harvest:
  pumpkins/hay bales/baskets; competition: flag poles + podium; town_meeting: benches + lectern;
  fire_outbreak: flames + smoke on a random building roof (seeded by event id) — animated; scandal:
  pinned notices on a board; blessing/starry_night/full_moon: soft sparkles (few); sickness: closed
  sign + herb bundles at the clinic; heatwave: none (weather already). Tests: each type yields
  placements inside the anchor rect; unknown types yield none; placements stable across calls.
- [ ] **D2 atlas:** bunting segment (2 frames flutter), lantern post (2 frames flicker), stall with
  awning, crate, flower arch, petals, wreath, candle (3 frames), dark bunting, pumpkin, hay bale,
  flag pole (2 frames), podium, bench, lectern, fire (4 frames), smoke puff (3 frames), notice
  board, sparkle (3 frames), herb bundle, closed sign.
- [ ] **D3 TownEventSystem:** diff events in `onData`; build placements into `layers.ground`
  (flames/smoke/sparkles into `overAgents`); fade in over 1 s on start and out on end; animate only
  animated frames at 4–6 fps and only when in view.
- [ ] **D4** register, `npm run check`, commit.

## Workstream E — Ambient life

**Files:**
- Create: `scripts/aseprite/critters.lua` → `public/sprites/fx/critters.{aseprite,png}` (16×16)
- Create: `src/components/canvas/systems/ambientLife/ambientPlan.ts` (pure)
- Create: `src/components/canvas/systems/ambientLife/AmbientLifeSystem.ts` (+ register)
- Test: `src/components/canvas/systems/ambientLife/__tests__/ambientPlan.test.ts`

- [ ] **E1 ambientPlan (pure, tested):** from day_phase, weather, season, world size, zoom detail
  level → how many of each critter to keep alive: birds (day, not raining; pecking on grass, flying
  off when an agent passes within 40px), butterflies (spring/summer day), fireflies… **no** (art
  bible cut them) → instead night moths around lit windows are fine at most 6; one cat per 4 homes
  wandering near homes, sitting, sometimes following an agent; ducks on water terrain if any;
  fountain water animation at the town square well (always, 3 frames). Nothing when detailLevel is 0
  except the fountain. Rain/storm: birds hide. Tests for each rule.
- [ ] **E2 atlas:** bird (peck ×2, hop, fly ×2), butterfly (2), moth (2), cat (sit, walk ×2, lick),
  duck (swim ×2), fountain splash (3).
- [ ] **E3 AmbientLifeSystem:** a fixed pool sized by the plan; simple state machines (wander,
  idle, flee) stepping with `frame.dt`; spawn only near the view; recycle critters that leave the
  view. Ground critters in `layers.ground`, flying ones in `overAgents`.
- [ ] **E4** register, `npm run check`, commit.

## Workstream F — Expressive portraits

**Files:**
- Create: `scripts/aseprite/portrait-moods.lua` → `public/sprites/agents/<name>_portrait_<mood>.png`
  (+ one `<name>_portraits.aseprite` with a frame per mood) for mood ∈ happy, sad, angry, shocked
- Create: `src/components/ui/portraitMood.ts` (pure: mood + states → mood key)
- Test: `src/components/ui/__tests__/portraitMood.test.ts` (check vitest includes src/**)
- Modify: `src/components/ui/AgentPortrait.tsx` (optional `states` prop; pick variant, fall back to
  the neutral portrait on load error), `src/components/ui/AgentPanel.tsx` (pass states)

- [ ] **F1 portraitMood (pure, tested):** angry/jealous → angry; heartbroken/grieving/depressed or
  mood < 25 → sad; euphoric/infatuated or mood > 75 → happy; recent arrest or shock → shocked
  (arrested state); else neutral (existing file).
- [ ] **F2 Lua:** derive variants from the 64×64 `<name>_portrait.png` like
  `scripts/aseprite/agent-sheets.lua` derives frames: detect eye row and mouth row (dark pixels
  inside the face), then edit: happy = mouth corners up + slight eye squint; sad = mouth corners
  down + brows tilted; angry = brows angled down toward the centre + flat mouth; shocked = open
  mouth (small dark oval) + raised brows. Produce a contact sheet for review. If detection fails on
  a portrait, skip that variant (the client falls back to neutral).
- [ ] **F3** AgentPortrait picks `${portrait_sprite}_${mood}.png` (neutral = existing), crossfades
  on change. `npm run check`, commit.

---

## Integration (integrator)

1. Merge workstream branches one at a time into `feat/living-agents-phase1`; resolve
   `systems/index.ts` and `BubbleSystem.ts` conflicts.
2. After each merge: `npm run check`, live check on `data/verify.db` (launch config
   `little-life-verify`), console errors, a frame-time sample (`performance` over 5 s at 4x with all
   systems), screenshots.
3. Update `docs/STATUS.md`.
