# Project status

Living document. Every session reads it first and updates it last (see `CLAUDE.md`).

**Last verified:** 2026-09-29 — `tsc` 0 errors, vitest 92 files / 977 tests passing.
Branch `feat/living-agents-phase1`. Two sessions commit to it: engine/gameplay fixes and the
worldgen v2 tracks (`docs/superpowers/plans/2026-09-28-worldgen-v2.md`).

## Where the project is

| Area | State |
|---|---|
| Simulation core (11 tick phases) | Working; **all timing on game minutes** (`server/lib/gameClock.ts`) |
| LLM conversations (template / llm_standard / llm_deep) | Working; output sanitised (`server/ai/sanitizeDialogue.ts`) |
| Memory stream, reflection, planning, self-descriptions | Working; planning survives LLM outages (`PlanLLMGate`) |
| Goals & aspirations | Done |
| Drama setup wizard | Done |
| Cascade (Ripple/Tension/Snap/Witness) | Working; rumors/cast attribution fixed 2026-09-29 |
| Procedural worldgen v2 (terrain, autotiling, social homes) | In progress in the other session |
| Worldgen stages `interiors`, `names` | **Stubs**; output discarded by `pipeline.ts` |
| Economy | Mechanics fixed; **balance open** (see E1–E4) |
| Autoplay profiler + auto-nudger | Working, no UI, **off by default** |
| Visual polish / lighting / weather | Done; lighting frame-rate independent |

## Tooling

- `npm run check` — gate (tsc + vitest).
- `npm run deadcode` — orphan files / unused exports.
- `npm run soak -- --days 5 [--tick-speed 4] [--db data/verify.db]` — headless multi-day run with
  the LLM disabled (template tier), on a temp DB copy; prints a daily economy table and flags
  anomalies. Refuses `data/little-life.db`. ~2 min per game day at speed 1.
- Playtest recipe (real LLM): copy `data/little-life.db*` → `data/verify.db*`, run the server with
  `DATABASE_PATH=./data/verify.db`, sample the DB read-only. See CLAUDE.md "Live verification".

## DB migration note

`server/db/clockMigration.ts` rebases old tick stamps to game minutes once per DB file
(`PRAGMA user_version` 0 → 2) the first time any process opens it through `server/db`. Verified on a
copy of the live world (tick 15 → stamps 1981/1980, second run no-op). Backup taken before the
change: `data/backup-2026-09-29-pre-gameclock/`. Running **old** code against a migrated DB would
write tick stamps into minute columns — don't switch back to pre-2026-09-29 branches on the same DB.

## Open issues (verified in code 2026-09-29)

Severity: **H** breaks behaviour/data · **M** visible wrongness · **L** cleanup.

### Economy balance (found by `npm run soak`)
- **E1 [M]** Structural inflation: salaries ≈ $275/day vs living costs ≈ $117/day; the money-supply
  ratio climbs ~0.1/day (1.6 → 2.1 in 5 days) and turns on robbery/scam/hyperinflation events.
- **E2 [M]** Sales tax is always $0: `Math.round(price * 0.05)` in `recordSale` (`economy.ts`) is 0
  for every price < $10; `tax_pool` is never spent anywhere.
- **E3 [L]** Tavern owner slowly loses money: restocks `food_raw` it never sells; `tavernEngine`
  pours free drinks separately from the cover charge; few tavern visits.
- **E4 [L]** Shopping list is always empty (`decisions.ts` builds `items: []`); bought meals go into
  inventory and are never consumed.

### Engine
- **B9 [M]** In-memory sim state lost on restart (hobby skills, favors, tension, momentum, gate
  backoffs); drift cap re-baselines from drifted value (`personalityDrift.ts`).
- **B12b [L]** Per-tick probabilities still roll per tick (drunk/sick chance in `states.ts`,
  old-age/accident hazards) → fewer rolls per game hour at speed 4.
- **B13b [L]** Memory consolidation and activity-log retention use tick stamps with day labels.
- **B16 [M]** Housemates/coworkers start as strangers: wizard `getDefaultRelationships()`
  (`src/components/setup/defaults.ts`) seeds 6 pairs; conversations concentrate there. Overlaps the
  worldgen "social placement" track — coordinate before changing.
- **B17 [L]** `server/routers/setup.ts:~741` always adds a fact's subject to `known_by`, so the person
  seen in a witness secret "knows" they were seen (generator side already fixed). Worldgen session's file.
- **B18 [L]** Storm hits outdoor mood twice (event `mood_outdoor` + stormy-weather penalty in needs).
- **B19 [L]** `templates` DB table is write-only (`seed.ts`, `setup.ts`): selection reads the static
  catalog in `server/data/templates.ts`.
- **P1 [M]** Pathfinding falls back to straight lines through buildings ("unroutable destination",
  ~20/game day in soak, 72 in the first playtest) — worldgen session's area.

### Client
- **C8 [L]** Per-frame allocations: `BubbleSystem.update`, `ParticleEngine.update`,
  `drawAgentLinks`, `LightingSystem.render`; occupancy dots recreated at 1 Hz.
- **C9 [L]** Nudge router now answers `{queued, message: "X is busy talking — queued"}`; the client
  ignores it.
- **C10 [L]** Old conversations stored before 2026-09-29 render canned fallback lines as speech.

### Dead code
`npm run deadcode`: 0 orphans; `WeatherType` in `server/lib/types.ts` unused.

## Tech debt

- God-functions: `states.ts` `processStateEffects`, `evaluateTriggers`; `decisions.ts` `tick()`;
  `conversations.ts` `finishCompletedConversation`.
- `statesTick` does ~6N agentStates queries per tick.
- RippleEngine `buildContext` runs twice per rule; sub-systems typed `any`.
- DB migration chain stale (see CLAUDE.md gotchas); now also `clockMigration.ts` via user_version.
- `playwright` is used by scripts but not in `package.json`. No README. `.env` tracked.

## Fixed (2026-09-28 → 29)

Work done with parallel agents in worktrees, each branch reviewed by a separate reviewer agent
before merging.

- **Earlier:** B1/B2/B4/C1, autoplay off, dead-code sweep, C5 event catalog, B7, B14.
- **B6 plan retry storm** + follow-ups: keyed dedupe in `PlanLLMQueue`, `PlanLLMGate` (per-agent
  game-time backoff + wall-clock floor + jitter, town-wide outage breaker with probes, empty/
  unusable answers don't count as outages), deterministic fallback plans (`source: 'fallback'`, badge
  in PlanTimeline), decomposition/replan gated and epoch-guarded, plan actions in game minutes.
- **B3** truncated flag → `conversation_cut_short` memory; zero-turn force-ended convs end quietly.
- **B8** state cache kept fresh via TEMP triggers + write version; rollback-safe.
- **B12** embeddings on their own semaphore pool; MemoryService never strands/drops queued writes.
- **B13** public-knowledge spread once per tick; **B15** one stacking rule per event-effect key.
- **B10 + playtest #1/#2** game-time everywhere: actions, states, events, goals, cooldowns,
  counters, hour/day gates; storm events bring stormy weather; old age reads `agents.age`.
- **Economy:** impulsive gifts capped (one per episode, 4 h cooldown, feed + ledger); one purchase
  per meal/trip; diners only buy hunger items; owners eat own stock; tavern cover per visit;
  wholesale capped; payday/gift cooldowns in game minutes.
- **Conversations:** no agent in two conversations; priority-ordered queue across tiers; orphaned
  `active` rows swept; player nudges/comfort visits protected while a participant is busy;
  "finished talking at <place>"; redundant goals skipped; template lines without name prefix, in the
  right weather/setting, grounded in the real town and each speaker's own state.
- **Gossip/cascade:** no self-gossip (incl. pair facts), grammatical fact sentences
  (`server/lib/factText.ts`), witness rumors describe the act and blame the right actor, confided
  secrets only from real speech, goal events cast correctly, rule-emitted events use the rule's
  agent as actor, setup secrets only known by who the text says.
- **Dialogue:** `sanitizeDialogue` (stage directions, quotes, emoji, placeholders, opening wrong
  vocative) conservative on reported speech/appositives; truncated replies trimmed; turn instruction
  after history + anti-repeat hint; honorific-aware first names; fallback lines flagged and shown
  as narration; conversation memories quote a charged line.
- **Client:** C2 restart invalidation, C3 missing-agent panel, C4 weather ambient, C6 lanterns,
  C7 single rain/snow renderer, single lightning owner, frame-rate independent fades.

## Next steps (suggested order)

1. Economy balance E1/E2 (use `npm run soak` to measure before/after).
2. B16 initial relationships — together with the worldgen social-placement track.
3. Playtest again with the real LLM at 1x and 4x; compare with the 2026-09-29 playtest.
4. Worldgen stubs `interiors` / `names`; C8 perf.
