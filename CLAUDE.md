# Little Life — guide for AI agents

Spectator "god game" of a small town: ~13 LLM-driven townsfolk with needs, secrets,
romances and rivalries. The player sets up a scenario (presets + drama sliders on a
seeded procedural town), watches emergent stories and pokes them (nudges, secrets,
confrontations, events, weather). Mixes Stanford Generative Agents (memory stream,
reflection, planning), Sims-style needs and RimWorld-style drama/art.

> **Not Convex.** The project started on Convex and dropped it on 2026-03-25
> (commit `bb21164`). Ignore any Convex skill or guideline — there is no `convex/` dir.

## Start of every session

1. Read [`docs/STATUS.md`](docs/STATUS.md) — current state, open bugs, what's next.
2. `git status --short | wc -l` — this repo has a history of large uncommitted piles.
   If the tree is dirty with work you didn't do, ask before building on top of it.
3. `npm run check` (typecheck + lint + tests, ~1.5 min). Must be green before and after your change.

## End of every session

- Update `docs/STATUS.md`: move fixed bugs out, add new findings with `file:line`,
  bump the "last verified" line with the test count.
- Commit in small themed commits (Conventional Commits, English). Never let the tree
  grow past one theme uncommitted.

## Stack

| Layer | Tech |
|---|---|
| Server | Node + `tsx`, Express 5, tRPC 11 over **WebSocket only** (`ws://localhost:3001`) |
| DB | SQLite via `better-sqlite3` (sync) + Drizzle ORM, WAL mode |
| Client | React 19, Vite 8, Tailwind 4, Pixi.js 8, React Query (is the store) |
| LLM | Ollama 0.35 (default, `:11434`) or OpenAI-compatible (llama-server `:8080`). Gemma 4 26B-A4B for everything, qwen3-embedding:0.6b for memory; config in `.env` (copy `.env.example`; `.env` is not tracked), Ollama flags in `start-game.bat` |
| Tests | Vitest 5, ~350 files / ~4100 tests (server + pure client modules) |

## Commands

```bash
npm run dev          # server (tsx watch, :3001) + vite (:5173)
npm run check        # tsc --noEmit + eslint (errors only) + vitest run (~1.5 min)  ← gate for every change
npm run lint         # eslint with warnings (hook deps)
npm test             # vitest only
npm run deadcode     # orphan files + exports nothing uses (confirm with grep before deleting)
npx tsx scripts/diagnose.ts        # dump live DB state (table sizes, world clock)
npx tsx scripts/llm-smoke.ts       # one of each structured prompt against the model
npx tsx scripts/llm-bench.ts --trace t.jsonl --models a,b   # replay a captured LLM_TRACE
npx tsx scripts/embed-eval.ts --a m1 --b m2 --trace t.jsonl # blind retrieval eval of two embedders
npx tsx server/seed-world.ts       # reseed the running server's world
node scripts/shot-gallery.mjs day  # Playwright screenshots of :5173 (needs dev running)
```

`start-game.bat` is the user's Windows launcher (starts Ollama + dev + browser).

**Live verification without touching the user's world:** `.claude/launch.json` defines
`little-life-verify`, which runs `npm run dev` against `data/verify.db`. Refresh the copy first
(`cp data/little-life.db* ` → `data/verify.db*`), then `preview_start` it. tRPC is WebSocket-only,
so to inspect requests patch `WebSocket.prototype.send` from the page and count `params.path`.
Never run the dev server against `data/little-life.db` for testing — the tick loop mutates it.

## Architecture map

```
server/
  index.ts            Express + WS tRPC server; side-effect imports giftEngine, secretSharing
  router.ts           16 routers: world agents conversations relationships economy locations
                      activity chronicle nudge knowledge setup autoplay gazette saves challenges intimacy
  engine/tick.ts      1 tick = 1 game minute, setTimeout loop (1000 ms / tick_speed)
  engine/systems/     11 phases in order: needs → states → economy → relationships →
                      conversations → goals → decisions → movement → events → gossip → cascade
                      (each sync phase in its own db.transaction; conversations is async)
  engine/emitter.ts   "channel dirty" pub/sub → client invalidates React Query caches
  lib/                *Engine.ts subsystems, cascade/ (Ripple/Tension/Snap), memory/,
                      goals/, planning/, perception/, worldgen/ (procedural town pipeline)
  lib/intimacy/       opt-in adult layer (kiss, longing, rendezvous, tryst, suspicion, unwed pregnancy);
                      adults only via isIntimacyEligible, implied never explicit — see docs/STATUS.md
  lib/simEvents.ts    sync EventEmitter; listeners run INSIDE the emitting phase's transaction
  ai/                 ollama.ts client (format/JSON schema, metrics, LLM_TRACE), llmSemaphore
                      (LLM_PARALLEL slots = OLLAMA_NUM_PARALLEL, 1 reserved for dialogue),
                      llmMetrics, warmup, generateResponse
  autoplay/           profiler + boredom auto-nudger (AUTOPLAY_CONFIG in lib/constants.ts)
  data/               static data: agents, templates, interiors, building templates
  db/                 schema.ts, index.ts (pragmas + additive ALTER migrations), seed.ts
src/
  App.tsx             layout + UI state (useState)
  hooks/use*.ts       subscribe to a channel → invalidate queries
  components/canvas/  Pixi layers: Tilemap → Building → Sprites → Particles → Bubbles,
                      then Lighting (lightmap) + Weather on stage; Camera/InteractionLayer
  components/ui/      panels & modals; components/setup/ = scenario wizard
```

The client imports pure-data modules from `server/data/` and `server/lib/worldgen/`
directly — keep those free of Node/DB imports.

## Gotchas (learned the hard way)

- **DB schema has one mechanism:** the migration chain in `server/db/migrations/`, generated
  from `schema.ts` and applied at every start by `server/db/schemaMigrations.ts` (game, tests,
  soak and scripts alike). **To change the schema: edit `schema.ts`, run `npm run db:generate`,
  commit the new `.sql`.** Files from before the chain are upgraded once by the frozen
  `LEGACY_COLUMNS` list there; never add to it. Data fixes for old worlds (not schema) stay
  as startup steps in `server/db/index.ts`.
- **Tests must never touch the live DB.** `vite.config.ts` pins `DATABASE_PATH=./data/test.db`;
  each worker copies it (`server/db/testWorker.ts`). Don't import `server/db` before setup.
- **Lots of sim state is in-memory only** (hobby skills, favors, tension, mood momentum,
  drift baselines, state trackers) — lost on restart. Per-world caches must be registered
  in `server/engine/worldCaches.ts` or they survive a world replace.
- **Tick-count vs game-time.** Some cadences use `totalTicks % N`; they drift when
  `tick_speed > 1`. Prefer game-time.
- **Client data freshness.** Only queries invalidated by a subscription hook refresh
  (`refetchOnWindowFocus: false`). A new query that isn't wired to a channel will be stale forever.
- **Ports:** client WS URL defaults to `ws://localhost:3001` (`src/lib/trpc.ts`), overridable with `VITE_WS_URL`.
- Windows + `core.autocrlf`: expect LF→CRLF warnings; don't commit whitespace-only diffs.
- Test runs are noisy (`[worldgen] done ...` logs) — grep for `Test Files` / `FAIL`.
- **LLM output that code parses is structured**: pass a JSON schema as `format` to `callOllamaChat`
  (see `planPrompts.ts`, `goalPrompts.ts`) and keep a tolerant parser. Tag every call with `purpose`.
  Changing `num_ctx` per call makes Ollama reload the model — it is pinned in `CONFIG.AI.NUM_CTX`
  (chat) and `CONFIG.AI.EMBED_NUM_CTX` (embeddings). Prompts that imagine town life include
  `TOWN_SETTING` (`server/ai/setting.ts`, around 1900).
- **New tables** go in `schema.ts` + `npm run db:generate`, plus `ALL_TABLES` in
  `db/worldTables.ts` (world replace *and* save load) and `db/seed.ts` if the rows belong to
  one world.
- Vitest quirk (seen on 2, not re-checked on 5): a `vi.fn` that throws after `mockReset()` in `beforeEach` fails the test even
  when the throw is caught. Use `mockClear()` + `mockImplementationOnce(() => { throw ... })`.

## Conventions

- TypeScript strict, `noUnusedLocals` — dead exports are fine for tsc but please delete them.
- **No `any`** (`@typescript-eslint/no-explicit-any` is an error). JSON columns are typed in
  `server/db/schema.ts`, API rows in `src/lib/apiTypes.ts`; pure canvas planners take the `*Lite`
  slices there. Unknown shape → `unknown` and narrow. In tests: `fakeServices` / `invalid()` from
  `src/components/canvas/systems/__tests__/kit.ts`, or `Parameters<typeof fn>[0]`.
- Comments explain *why* (the codebase uses long rationale comments; match that).
- Keep `docs/` for durable docs; `docs/scratch/` is throwaway probes (screenshots ignored).
- Design history: `docs/superpowers/specs|plans` (Apr 2026), `docs/living-agents/phase1-3`
  (Jul 2026), `docs/scratch/final-plan.md` (visual polish rounds).
