# Project status

Living document. Every session reads it first and updates it last (see `CLAUDE.md`).

**Last verified:** 2026-09-28 — `tsc` 0 errors, vitest 43 files / 504 tests passing.
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
| Autoplay profiler + auto-nudger | Working, no UI, ON by default (see B5) |
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
- **B5 [M]** Autoplay ON by default (`server/lib/constants.ts:8,11`) while `tick.ts:~240`
  says it's off. Nudger writes DB outside tick transactions. Decide & align.
- **B6 [M]** Plan retry storm when LLM down: `PlanGenerator.ts:235` throws uncaught →
  no plan cached → decisions re-queue every pass (`decisions.ts:~1137`); `PlanLLMQueue` doesn't dedupe.
- **B7 [M]** Unbounded growth: decisions loads *every* ended conversation each tick
  (`decisions.ts:~1077`) and filters per pair; conversations table never pruned.
- **B8 [M]** Stale per-tick state cache: built after `states` (`tick.ts:~215`), not
  invalidated when later phases insert states.
- **B9 [M]** In-memory sim state lost on restart (hobby skills, favors, tension, momentum);
  drift cap re-baselines from drifted value (`personalityDrift.ts:26-33`).
- **B10 [L]** Tick-count cadences drift at `tick_speed > 1` (`states.ts:222`, `tick.ts:230`);
  same-pair cooldown uses wall-clock (`decisions.ts:~1534`).
- **B11 [L]** `resetChronicleCache`, `resetCliqueCache` not in `worldCaches.clearPerWorldCaches`.
- **B12 [L]** `EmbeddingBatcher` bypasses the LLM semaphore (`EmbeddingBatcher.ts:158,187`).
- **B13 [L]** Public-knowledge spread runs twice per tick (`states.ts:241` + `gossipEngine.ts:99-114`).

### Client
- **C2 [M]** TopBar restart (`TopBar.tsx:~26`) doesn't `utils.invalidate()` → old-world
  locations/graph linger.
- **C3 [M]** Agent panel spins forever for a removed agent: `useSelectedAgent.ts` turns
  `null` into `undefined` → `isLoading` stays true.
- **C4 [M]** Weather change doesn't update ambient light until next day phase
  (`LightingSystem.ts:267-290`).
- **C5 [M]** Three diverging `EVENT_DEFS` (`routers/world.ts:37`, `routers/nudge.ts:23`,
  `engine/systems/events.ts`); `scandal`/`blessing` effects read by nothing; `force_indoors` read nowhere.
- **C6 [L]** Agent lanterns use server position, not interpolated sprite position, and
  render for indoor agents (`LightingSystem.ts:~429`).
- **C7 [L]** Rain drawn twice (WeatherEffects + `weather_rain` particles); snow particles
  follow *season* not weather.
- **C8 [L]** Per-frame allocations: `BubbleSystem.update`, `ParticleEngine.update`,
  `drawAgentLinks`, `LightingSystem.render`; occupancy dots recreated at 1 Hz.

## Dead code (safe to delete, verify with grep first)

- Abandoned data-driven interaction pipeline: `server/lib/{effectApplicator,outcomeResolver,witnessResolver,prerequisites,validators}.ts`,
  `server/data/interactionRegistry.ts` (1233 lines, tests only).
- `src/components/canvas/DayNightCycle.ts` (unused), `useAssetLoader` stub.
- Unused endpoints: `agents.getAgent`, `activity.getByType`, `conversations.getOne`,
  `relationships.getOne`, `economy.getAgentEconomy|getTransactions`, `knowledge.getAboutAgent`,
  `locations.getOccupants`, `chronicle.onUpdate` (autoplay.* is intentional, no UI yet).
- Events emitted with no listener: `agent:drunk`, `agent:lonely`, `comfort:visit_needed`,
  `confrontation:witnessed`, `crime:released`, `goal:ambition_generated`.
- `scripts/generate-map-json.cjs` reads deleted `data/maps/default.ts`.

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

## Next steps (suggested order)

1. Decide autoplay default (B5) and give it a small UI or turn it off.
2. Delete dead code; unify `EVENT_DEFS`.
3. Bound growth (B7) — prune/limit ended conversations.
