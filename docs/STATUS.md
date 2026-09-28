# Project status

Living document. Every session reads it first and updates it last (see `CLAUDE.md`).

**Last verified:** 2026-09-28 — `tsc` 0 errors, vitest 46 files / 518 tests passing.
Branch `feat/living-agents-phase1`, working tree clean.

## Where the project is

| Area | State |
|---|---|
| Simulation core (11 tick phases, needs/states/economy/relationships/decisions/movement) | Working |
| LLM conversations (template / llm_standard / llm_deep tiers, fallbacks) | Working (B3 open) |
| Memory stream, reflection, planning, self-descriptions | Working |
| Goals & aspirations (GoalMapper/Reviewer/PivotEvaluator) | Done |
| Drama setup wizard (presets, sliders, conflict web, preview) | Done |
| Cascade (Ripple/Tension/Snap/Witness) | Working; perf smells |
| Procedural worldgen (dimensions → roads → layout → homes → terrain) | Done, well tested |
| Worldgen stages `interiors`, `names` | **Stubs**; output discarded by `pipeline.ts` |
| Living-agents phase 3 (11 believability fixes + 3 deferred) | Done |
| Chronicle / cliques / drama alerts / common knowledge | Done |
| Autoplay profiler + auto-nudger | Working, no UI, **off by default** (opt-in: `autoplay.configure({ enabled: true })`) |
| Visual polish (RimWorld art bible, 30 polish rounds, lighting, props) | Done |
| Agent animation | Procedural bob/flip/pose only; no frame animation |

## History note

On 2026-09-28 a ~6.5k-line pile of uncommitted work (phase 3 fixes, autoplay, chronicle,
worldgen + setup rework, DB/test isolation) was split into themed commits `6284a95..4393882`.
The previous HEAD did **not** typecheck (a committed file imported an uncommitted module),
so intermediate commits of that series may not build; every commit from `5b5d866` on is green.
Lesson: commit per theme, with its new files, and run `npm run check` before each commit.

## Bug backlog (verified in code 2026-09-28)

Severity: **H** breaks behaviour/data · **M** visible wrongness · **L** cleanup.

### Engine
- **B3 [M]** `truncated` flag collected (`conversations.ts:~203`) but never passed on (`:~461`).
- **B6 [M]** Plan retry storm when LLM down: `PlanGenerator.ts:235` throws uncaught →
  no plan cached → decisions re-queue every pass (`decisions.ts:~1137`); `PlanLLMQueue` doesn't dedupe.
- **B8 [M]** Stale per-tick state cache: built after `states` (`tick.ts:~215`), not
  invalidated when later phases insert states.
- **B9 [M]** In-memory sim state lost on restart (hobby skills, favors, tension, momentum);
  drift cap re-baselines from drifted value (`personalityDrift.ts:26-33`).
- **B10 [L]** Tick-count cadences drift at `tick_speed > 1` (`states.ts:222`, `tick.ts:230`);
  same-pair cooldown uses wall-clock (`decisions.ts:~1534`).
- **B12 [L]** `EmbeddingBatcher` bypasses the LLM semaphore (`EmbeddingBatcher.ts:158,187`).
- **B13 [L]** Public-knowledge spread runs twice per tick (`states.ts:241` + `gossipEngine.ts:99-114`).
- **B15 [L]** `needs.ts` sums event effects across active events, so two `energy_drain`
  multipliers (1.5 + 1.3) compound oddly; economy multiplies instead. Pick one rule per key.

### Client
- **C2 [M]** TopBar restart (`TopBar.tsx:~26`) doesn't `utils.invalidate()` → old-world
  locations/graph linger.
- **C3 [M]** Agent panel spins forever for a removed agent: `useSelectedAgent.ts` turns
  `null` into `undefined` → `isLoading` stays true.
- **C4 [M]** Weather change doesn't update ambient light until next day phase
  (`LightingSystem.ts:267-290`).
- **C6 [L]** Agent lanterns use server position, not interpolated sprite position, and
  render for indoor agents (`LightingSystem.ts:~429`).
- **C7 [L]** Rain drawn twice (WeatherEffects + `weather_rain` particles); snow particles
  follow *season* not weather.
- **C8 [L]** Per-frame allocations: `BubbleSystem.update`, `ParticleEngine.update`,
  `drawAgentLinks`, `LightingSystem.render`; occupancy dots recreated at 1 Hz.

## Dead code

Swept 2026-09-28 (`c62a48a`, `1c7ca5f`, `6c876b0`, `d13157f`, `631a1c7`): ~3.4k lines of orphan
modules, unused exports, tRPC procedures, listener-less events and obsolete scripts.
Remaining, cosmetic only: ~75 exports used solely inside their own file (could drop `export`).
Re-check with `npm run deadcode` (clean as of this sweep).

## Tech debt

- God-functions: `states.ts` `processStateEffects` (~940 lines), `evaluateTriggers` (~680);
  `decisions.ts` `tick()` (~860); `conversations.ts` `processCompletedConversation` (~815).
- `statesTick` does ~6N agentStates queries per tick.
- RippleEngine `buildContext` runs twice per rule; sub-systems typed `any`.
- DB migration chain stale (see CLAUDE.md gotchas). Consider baselining a fresh migration.
- `playwright` is used by scripts but not in `package.json`.
- No README. `.env` is tracked (no secrets) — consider `.env.example`.

## Fixed

- 2026-09-28: B1+B2 `3ccf5ad`, B4 `64032b6`, C1 `0345aed` (with regression tests; C1 verified live).
- 2026-09-28: B5 autoplay off by default `afa02d7`; B11 memo reset on world replace `a3f3f4f`.
- 2026-09-28: C5 single world-event catalog + `startWorldEvent` `42f4919` (also fixed 240-hour
  funerals and 120-hour autoplay events); B7 bounded conversation reads + archive cap `1c4b751`;
  B14 real comfort visits `31566d4` (verified end to end on a DB copy).

## Next steps (suggested order)

1. Small client fixes: C2 restart invalidation, C3 panel spinner, C4 weather lighting.
2. B6 plan retry storm when the LLM is down (dedupe PlanLLMQueue, cache a fallback plan).
3. B3 pass the `truncated` flag through; B8 invalidate the per-tick state cache on insert.
4. Worldgen stubs: `interiors` / `names` stages.
