# Feature loop (2026-09-30)

Branch `feat/loop-features` (off `aa6ca8a`). Opus plans, Sonnet implements one item at a time
(sequential — shared `data/test.db`), orchestrator reviews, runs `npm run check`, commits.
Four read-only Opus planners surveyed Drama, Player tools, Visual/UI, Bugs/balance.

Status legend: ☐ todo · ▶ in progress · ✔ done (commit) · ✗ dropped

## Player tools

- ✔ **P1 Watch a pair (S)** — `alertTiers.ts` `alertTier(row, favorites, watchedPairs)`; watched pair's
  status change → major, tryst → minor, other favourite-category rows ≥ FAVORITE_IMPORTANCE → minor.
  `activity.getAlerts` takes `watchedPairs`; `src/lib/favorites.ts` + `useWatchedPairs`; 👁 toggle in PairDossier.
- ☐ **P2 Aim at a pair (S/M)** — goal from the dossier reusing challenges: marry = `matchmaker`,
  befriend = `peacemaker`, sunder = `feud` with `baseline.friendPairs` = just that pair.
  `challenges/service.ts` `aimAtPair`, `source: 'aim'`, router mutation, dossier menu + progress.
  Validation: adults + `mayRomanceGrow` + not spoken for (export `spokenFor` from `suggest.ts`).
- ☐ **P3 Anonymous letter god power (M)** — `godPowers.ts` `sendAnonymousLetter(recipientId, factId)`:
  `addKnowers`, emit `gossip:learned` (sourceName "an unsigned letter") so ripple rules fire, replan,
  `player_letter` activity (player category, not newsworthy, counted by Hands off). Refusals: public/low
  sensitivity, already known, own secret, adults-only fact to a minor, 720-min cooldown per recipient.
  `knowledge.getLetterable`; NudgeMenu "letter" submenu; outcome via a `trackOutcome` refactor of
  `playerOutcomes.onConversationEnded`.
- ☐ **P4 Stirred-feeling outcomes (M)** — `stirFeeling` registers; first conversation with the target
  and `state:cleared` report deltas as `player_outcome` rows. Shares `trackOutcome` with P3.
- ☐ **P5 "Your hand" journal tab (M)** — pure `server/lib/playerLedger.ts` matching `player_*` actions
  to outcomes per day (pending / fizzled / came to something); `templateData.kind` on `player_nudge`
  rows; `activity.getPlayerLedger`; `YourHandView.tsx`, invalidated from `useActivityFeed`.

## Drama / emergence

Rule for every new beat: add to `DramaBeat` + `DRAMA_BEAT_KIND` (`server/data/dramaBeats.ts`), `BEAT_ICONS`
(`recap.ts`), `BEAT_CUE` (`src/lib/audio/soundscape.ts`); hostile relationship events that feed the chronicle go
in `HOSTILE_EVENTS` (`storyBeats.ts`).

- ☐ **D1a Town roster in prompts (S)** — `server/lib/townRoster.ts` `rosterLine(excludeIds)` ("First Last (job)",
  ≤32, "never make up names"); `AgentEnrichment.roster` in dialogue system prompt, "People in town" in plan and
  gazette prompts. Stops invented townsfolk ("Silas").
- ☐ **D1b Snaps, beat tags, ousted mayor, mood cap (S/M)** — SnapResolver culprit from tension sources (confront
  carries perpetrator/victim, plot's `angry` gets a target → revenge fires), beat `snap`; tag untagged drama rows
  (states/tavern/economy/loneliness/gift/conversations) with new beats release/drunk/outburst/blackmail/lonely;
  ousted mayor takes the winner's old trade; cap stacked `conversation` mood modifiers at ±6.
- ☐ **D2a Observer goal triggers (S)** — `goals.ts:199` skip → friends (≥40) / family get `comfort_grieving` /
  `protect` toward a sufferer; cap 3 per sufferer; `'sick'` in DISTRESS.
- ☐ **D2b Grave illness (M)** — pure `server/lib/illness.ts` hazards; `sick` → grave (metadata, 5 days, public
  fact, beat `grave_illness`), treatment clears (beat `recovered`); death check in `lifeEventsEngine.ts:115` that
  can actually fire; gravely ill stay home. Soak: 0-2 illness deaths / 30 days.
- ☐ **D3 Funeral + contested will (M)** — `server/lib/mourning.ts` side-effect module: `life:death` schedules a
  daytime funeral at the square (venue), gathering pull, memories/closure/eulogy; heir contest → `will_contested`.
- ☐ **D4a Feud engine (M)** — `feuds` table (schema + CREATE + ALL_TABLES), `server/lib/feuds.ts` staged
  slight → slander → sabotage → brawl, kin join, reconciliation/mediation/death end it; chronicle "The X–Y feud".
- ☐ **D4b Feed feuds (S)** — kindle from grudge tag, holdGrudge, plot snap, will contest, repeat confrontations; cap 3.
- ☐ **D5 Trial at the town hall (M)** — arrest schedules a trial (town_meeting event at the hall), pure
  `trialVerdict.ts`, witnesses testify, guilty/acquitted outcomes.

Found: funerals have no location and no one attends (`lifeEventsEngine.ts:341`, `decisions.ts:1865`); blackmail
and letters from home already exist.

## Order

B1 → B6 → D1a → V1 → P2 → D1b → B3 → D2a → V2 → P3 → B2 → D2b → D3 → V3 → P4 → D4a → D4b → V4 → V5 → P5 → B4 → B5 → D5

## Bugs / balance

- ☐ **B1 G11 gossip memory text (S)** — `gossip.ts:686` emits `otherName` but `MemoryObserver.ts:277` reads
  `targetName` → "I told undefined that…". Emit `targetId/targetName`, add `sourceId` to `gossip:learned`;
  `gossip_witnessed` template for `smallMisdeeds.ts:221` ("their own eyes told me"); `withSelfAsFirstPerson` in
  `factText.ts` (owner → I/me/my; name kept before present-tense -s verbs other than is/has/does); idempotent boot
  repair of "I told undefined that".
- ☐ **B2 T1 template chats respect sick/grieving/heartbroken (M)** — `ChatPerson.states` from `getAgentStates`
  in `templateChatContext.ts`; `toneOf` cool for grieving/heartbroken/depressed; new `condolence` and
  `feeling_poorly` scripts; no flirt/sunny scripts or flirt beat around grief.
- ☐ **B3 M2 proposals (S)** — `PROPOSAL_PENDING_MINUTES` 42 h; keep `announced` across expiry/retry and
  snapshot restore (one `proposal` row per cycle); proposer memory on expiry.
- ☐ **B4 E11 sated residents keep eating (M, soak)** — `SATED_ABOVE_HUNGER` 75; morning coffee = idle at cafe;
  drop duplicate wake breakfast `decisions.ts:785-787`; planned eating when sated → idle. Step B only if avg > 65.
  Soak targets: hunger avg 50-65, 0 deaths, money ratio 0.95-1.15.
- ☐ **B5 B13b retention on game minutes (M)** — `memories.created_minute` (+ addColumnIfMissing + backfill);
  consolidator and `pruneActivityLog` cut off by game minutes.
- ☐ **B6 W3 wizard step order (S)** — pure `wizardSteps.ts`; preview after agents + relationships.
- Backlog S: EmbeddingBatcher abort + settle on clear; sharedSecrets from `shared_knowledge`.

Stale STATUS (bugs): E1 inflation closed (treasury), getPair refetch fixed, long bells fixed,
lastBirthdayYear not a bug, EmbeddingBatcher harmless.

## Visual / UI

- ☐ **V1 One state-style table (S)** — pure `server/data/stateTypes.ts` (`STATE_TYPES`, `states.ts` derives
  `StateType`), `src/lib/stateStyle.ts` (`STATE_STYLE`, `STATE_PRIORITY`, `topState`) replacing six drifted
  copies: `AgentSprite.ts:82-104`, `RelationshipGraph.tsx:56-66`, `TownStats.tsx:149-154`, `BubbleSystem.ts:20-24`,
  `CurrentThought.tsx:119-128` (checks non-existent in_love/injured/enraged), `portraitMood.ts:13-19`.
  `envious` gets a ring (mustard/olive), `angry` portrait, new `envy` emote appended in `emotes.lua` + `emoteFrames.ts`.
  Intimacy states decided explicitly (UNSTYLED set).
- ☐ **V2 "On their mind" hover card (S/M)** — pure `src/lib/thoughtLine.ts` `thoughtOf` (states with target
  names, talk line via `directorCaption.contextLine`, needs, mood); hovered **id** in App (tooltip no longer a
  stale snapshot); `AgentTooltip` with MiniPortrait; `CurrentThought` uses `thoughtOf`. Discreet intimacy wording.
- ☐ **V3 Talk canvas system (M)** — `systems/talk/`: tone-coloured links (last 3 message sentiments + topic),
  3+ participants as spokes, a dot travelling on each new line; remove the fixed arc in `GameCanvas.tsx:302-308`;
  bubbles use the speaker's last message sentiment (convo.sentiment is 0 until the end); `bubbleOffsetX` for 3+.
- ☐ **V4 Seasons I: foliage (M)** — autumn/bare/snow prop cells appended in `nature-props.lua` + `propFrames.ts`
  `SEASON_CELLS`; pure `foliage.ts` (`foliageStage` creeping per tree hash, `groundTint`);
  `TilemapRenderer.setFoliageSeason`; dev `?season=&seasonDay=` override.
- ☐ **V5 Seasons II: snow cover (M)** — `ground-seasons.lua` snow strip, pure `snowCover`, snow container in
  TilemapRenderer under props, roof snow overlay in `BuildingRenderer.addRoof`.
- Later: Families journal tab; relationship web "changed recently" + focus filter.

Stale STATUS items (visual): lowercase "the" homes, door paths, Priya back view, LocationPanel width,
recap vs Director caption are all fixed already.

Stale STATUS gaps found: whispers already have outcomes (`playerOutcomes.ts:332-459`);
`NewAgentDialog` already uses `JOB_OPTIONS`. Deferred: consequence preview; bless/blight a business (L).
