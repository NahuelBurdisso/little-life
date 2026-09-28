# Living Agents — Phase 3: Cheap High-Impact Fixes

Date: 2026-07-30. Branch: feat/living-agents-phase1.
Source: phase1-understanding.md + phase2-audit.md + fresh code verification (4 parallel probes, 2026-07-30).

## Status correction vs Phase 2 audit

Phase 2 ranked **H1 (no walk animation)** as the single biggest killer. Verified today:
`AgentSprite.animate()` (src/components/canvas/AgentSprite.ts:213-237) **already implements**
horizontal flip (L220,228), walk bob (L226), sway rotation (L227) and idle breathing (L233-235).
This work is uncommitted (`M src/components/canvas/AgentSprite.ts`). H1 is ~80% closed.
Remaining gap: no pose for `sleeping` / `working` because `current_action` never reaches `AgentSprite`.

## Effort / impact map

```
            LOW EFFORT (<1h)              MED EFFORT (1-3h)
          +---------------------------+---------------------------+
 HIGH     | 1 Feed rows clickable     | 6 Perception chat -> emote|
 IMPACT   | 2 Camera follow-lock      | 7 Template convs 2-3 turns|
          | 3 Sleep pose + zzz        | 8 Conversation staging    |
          | 4 TopBar live stats       | 9 Drama highlights tab    |
          +---------------------------+---------------------------+
 MED      | 5 Wire tell_secret /      | 10 Weather + scandal/     |
 IMPACT   |   force_confront nudges   |    blessing in EventMenu  |
          |                           | 11 Secret network overlay |
          +---------------------------+---------------------------+
                                        DEFER: gathering magnetism,
                                        getAgentSummary consolidation
```

Everything below is verified against current code. No fix requires new tables, new
subscriptions, or LLM budget changes.

---

## Tier S — under 1 hour each

### 1. Activity feed rows clickable -> select agent + focus camera
**Problem:** "Maria stole from the tavern" scrolls by and the player cannot find Maria.
Rows are inert divs (ActivityFeed.tsx:319-345) even though each event already carries
`agent_ids?: number[]` (ActivityFeed.tsx:94). App.tsx:201 renders `<ActivityFeed />` with
no props, so there is no path to `setSelectedAgentId`.

**Fix:** pass `onSelectAgent={setSelectedAgentId}` from App.tsx; make the row a button that
calls it with `agent_ids[0]`. Camera focus is automatic — GameCanvas.tsx:400-406 already
calls `cameraRef.current.focusOn()` on every `selectedAgentId` change.

**Files:** src/App.tsx, src/components/ui/ActivityFeed.tsx. ~15 lines.

### 2. Camera follow-lock
**Problem:** `focusOn()` (CameraController.ts:121-125) is a one-shot jump. Select an
interesting agent, they walk off screen, you lose them.

**Fix:** add `followAgentId` ref in GameCanvas; in the existing per-frame ticker
(GameCanvas.tsx:302-364, alongside `spritePool.lerpAll`) re-center on that sprite each
frame. Toggle button in AgentPanel header. Clear on manual drag.

**Files:** src/components/canvas/GameCanvas.tsx, CameraController.ts, AgentPanel.tsx. ~30 lines.

### 3. Sleep pose + zzz emote (closes M4)
**Problem:** 11 sleeping agents look identical to idle ones (phase2 M4).

**Fix:** `current_action` is already in `AgentData` (SpritePool.ts:4-21) but is never
forwarded. Add `AgentSprite.setActionType(t)`; call it from `SpritePool.update()` (~L55);
add a branch at the top of `animate()`: `sleeping` -> `body.rotation = Math.PI/2`, no bob.
`zzz: "💤"` already exists in `EMOTE_EMOJIS` (BubbleSystem.ts:39) and is never triggered —
fire `showEmote(id,'zzz',pos)` on the idle->sleeping edge, reusing the action-change
detection already present at GameCanvas.tsx:243-254.

**Files:** AgentSprite.ts, SpritePool.ts, GameCanvas.tsx. ~20 lines.

### 4. TopBar live stats
**Problem:** TopBar shows day/time/weather/season/raw tick. It does not show the single most
important spectator number — how many conversations are live right now. During 4x speed the
player cannot tell whether the LLM is keeping up.

**Fix:** add active-conversation count (data already in `useConversations()`), active agent
count, and LLM queue depth via `world.getLLMStats` (server/routers/world.ts:16 — built,
never called from src/).

**Files:** src/components/ui/TopBar.tsx. ~20 lines.

### 5. Wire tell_secret + force_confront into NudgeMenu
**Problem:** the two highest-drama player actions are fully implemented server-side
(server/routers/nudge.ts:611-650 `tell_secret`, :652-703 `force_confront`, both in the zod
schema at :81-83) and have **zero UI entry point**. NudgeMenu.tsx exposes only suggestTalk,
suggestGoTo, giveMoney, removeAgent.

**Fix:** add both to pair mode (`isPairMode`, NudgeMenu.tsx:33). `tell_secret` needs a
secret picker — reuse `knowledge.getKnownBy` already used by SecretsOpinions.tsx:70.
Also add a hint that pair mode exists (select A, right-click B).

**Files:** src/components/overlays/NudgeMenu.tsx. ~60 lines. Zero backend work.

---

## Tier A — 1-3 hours each

### 6. Perception casual chat -> overhead emote, not a conversation record
**Biggest believability win available.** Closes phase2 H3 (83% of conversations are
1-message stubs).

**Root cause chain (verified):**
`PerceptionSystem.scan()` (every 10 ticks, tick.ts:215) picks a best rule; two rules
(`acquaintance_happy` registry:142, `someone_euphoric` registry:192) resolve to reaction
`approach_chat` (registry:291-297) which sets `conversation_tier:'template'` and inserts a
`conversationQueue` row. `conversationsTick()` Step D (conversations.ts:207-213) dequeues
every template entry *immediately* into `processTimedOutEntry()`, which writes a full
`conversations` row with `max_turns:1` plus relationshipEvents + needs + 2 memories +
2 `conversation:ended` emissions (which then trigger cascade rules, gossip, planning).
Result: "James nodded at Rosa Chen" is recorded as a first-class conversation.

**Fix:** change `approach_chat` to a non-conversation reaction. Do not queue a conversation;
instead set a short-lived emote marker on the agent (BubbleSystem already diffs agent state
per frame at BubbleSystem.ts:323-362 and has 20 emote types). Keep the small
familiarity/social nudge, drop the conversation + memory + cascade writes.

**Why cheap:** no new client channel needed — the client already polls agent state and the
emote system already exists. Removing the conversation write also removes ~2 memory rows
and N cascade evaluations per occurrence, so it is a perf win too.

**Files:** perceptionRegistry.ts, PerceptionSystem.ts (~L326-336), BubbleSystem.ts. Tests to update.

### 7. Template conversations get 2-3 exchanges, not 1
**Problem:** even legit template conversations (decisions.ts:1566, :1656 — "acquaintances
with nothing to say") end after one line. Reads as talking AT nobody.

**Fix:** `processTimedOutEntry()` (conversations.ts:1211-1477) calls `selectTemplate()` once.
Make it alternate 2-3 template lines between speakers with `max_turns` matched. Still zero
LLM cost.

**Files:** server/engine/systems/conversations.ts. ~30 lines.

### 8. Conversation physical staging (closes H2)
**Problem:** verified pairs 80-150px apart both in `talking` state. No approach, no facing,
no visual link. `conversationsTick()` (conversations.ts:298-311) sets
`current_action={type:'talking'}` and **never touches position or path**.

**Fix, three independent pieces — ship any subset:**
- **Approach (server):** before setting `talking`, if distance > ~40px, write
  `current_destination` = midpoint-offset next to the partner, `current_path=null`,
  `current_action={type:'walking'}` and start the conversation on arrival. Movement runs on
  the standard guard (movement.ts:338-339). No helper exists — replicate the inline pattern
  used at movement.ts:218-229.
- **Facing (client):** `facing` is private (AgentSprite.ts:59) and only set from step delta.
  Add `setFacing(dir)`; when an agent is in an active conversation, force facing toward the
  partner. Client already has `participants: number[]` per conversation
  (server/routers/conversations.ts:9-15 returns raw rows).
- **Link graphic (client):** draw a faint arc between participants. `relLines: Graphics`
  already exists in `worldContainer` (GameCanvas.tsx:152-154, z=6, redrawn per frame in the
  effect at :408-496) — add a conversation pass to the same clear/redraw.

**Files:** conversations.ts, AgentSprite.ts, GameCanvas.tsx.

### 9. Drama highlights tab
**Problem:** ActivityFeed pulls the raw stream and filters client-side; story beats drown in
economy/system noise. `activity.getDramaticEvents` (server/routers/activity.ts:63) is a
pre-filtered high-importance drama/relationship/goal/aspiration query — **never called from
src/**.

**Fix:** second tab on ActivityFeed backed by that endpoint. Combine with fix #1 so
highlights are clickable.

**Files:** ActivityFeed.tsx (+ hook). ~50 lines.

### 10. Weather + scandal/blessing controls
`world.setWeather` (world.ts:79 — 8 weather types) and `world.triggerEvent` (world.ts:29 —
includes `scandal` and `blessing`, which the EventMenu's nudge path lacks) are both dead.
EventMenu currently routes through `nudge.execute` with a duplicate EVENT_DEFS list.
Watching the town react to a sudden storm is pure spectator delight for ~30 min of work.

**Files:** src/components/ui/EventMenu.tsx.

### 11. Secret network overlay
`knowledge.getSecretNetwork` (knowledge.ts:29) returns every sensitivity>=2 secret enriched
with agent names and known-by counts. Never called. A "Town Secrets" panel showing which
scandals are spreading is the most compelling spectator content in the DB.
`knowledge.getAboutAgent` (:19) is also dead.

---

## Deferred (real cost, or unclear payoff)

All three have since been done — kept here for the reasoning that held them back.

- ~~**M5 gathering magnetism**~~ (plaza reads as empty). Done as decision scoring only:
  `gatheringBonus()` in `decisions.ts` adds crowd pull to the tavern and town-square
  scores. Position clustering turned out to be unnecessary — `findAvailableZone` already
  routes arrivals to the fountain/plaza zones.
- ~~**getAgentSummary consolidation**~~ (agents.ts, was dead): the panel's five per-agent
  queries now come from `agents.getAgentSummary`. `agents.getFull`, `agents.getStates`,
  `conversations.getHistory` and the whole `memories` router were dead afterwards and
  were removed.
- ~~**Working/sitting pose variants**~~: solved with zone-derived poses rather than new
  per-agent frame assets.

---

## Suggested order

1. #3 sleep pose (finishes the animation work already in the working tree)
2. #1 + #2 clickable feed + follow-lock (the "who is that, show me" loop)
3. #6 + #7 conversation flood (the biggest believability defect left)
4. #4 + #5 TopBar stats + nudge wiring (dead-code activation, near-zero risk)
5. #8 staging, #9 highlights, #10 weather, #11 secrets

Constraint: 432 tests must stay green (`npx vitest run`). #6 and #7 will need test updates.
