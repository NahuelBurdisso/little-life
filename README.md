# Little Life

A spectator "god game" of a small town around 1900. About a dozen townsfolk, each driven by a
local LLM (Gemma 4 through Ollama), live their lives on a procedurally generated pixel-art map:
they get hungry and tired, hold jobs, keep secrets, fall in love, hold grudges and gossip. You
set up a scenario (a cast, a drama preset, a seeded town), then watch the stories that emerge
and meddle when you feel like it: whisper a thought, start a rumor, stage a confrontation,
throw a storm over the square. It mixes Stanford's Generative Agents (memory stream, reflection,
planning), Sims-style needs and RimWorld-style drama.

## Features

**Simulation**
- Needs (hunger, energy, social, fun...), jobs, wages, shops and a town treasury economy.
- Relationships, romances and rivalries; proposals, engagements and weddings; aging and death.
- Secrets, gossip and rumors that spread and distort; a cascade system (ripples, tension, snaps).
- Goals and aspirations, daily planning, and a per-resident memory stream with reflection.
- Conversations at three tiers (template, standard LLM, deep LLM); the game drops to template
  lines by itself when the model is too slow or offline.

**Player powers**
- Right-click a resident to nudge: suggest a chat or destination, give money, pair two people up,
  slip a secret, stage a confrontation. God powers: whisper a thought, start a rumor, stir a feeling.
- Town events and weather (Events button); storyteller presets Calm / Balanced / Chaos and an
  optional boredom auto-nudger in the Autoplay panel (off by default).
- Scenario wizard with drama presets (Cozy Village, Soap Opera, Small-Town Noir, Romance Novel,
  Balanced) and sliders. There are no scored challenges or win conditions.

**Watching**
- Director mode with lower-third captions; a cast bar with mood faces, favourites and follow-cam.
- Town Journal (`J`): Brewing, Stories, Timeline, Paper (the Town Crier, a daily newspaper written
  by the model), Inbox (alerts and what your nudges led to) and Talks (every conversation).
- "Previously on..." recap, pair dossier (the full story of two people), per-resident Story tab.

**World**
- Procedural towns, grid or organic layout, seeded; generated pixel-art residents and portraits.
- Day/night lighting, weather, animated props and places; a procedural Web Audio soundscape.

**Quality of life**
- Save slots and an autosave every game day (last 3 kept); skip the night; health banner
  (connection, LLM, memory search, tick lag); onboarding cards, coach marks and a `?` help overlay.

## Requirements

- **Node.js** 22 works (no `engines` field is set) and npm.
- **Ollama 0.35** running on `:11434`. A **24 GB GPU** (developed on an RTX 3090) is what the
  default model needs: Gemma 4 26B-A4B (MoE, ~4B active, ~18 GB) plus the embedding model.
- Models (named in `.env`):

```bash
ollama pull gemma4:26b-a4b-it-mtp-q4_K_M     # CHAT_MODEL and LIGHT_MODEL
ollama pull qwen3-embedding:0.6b             # EMBEDDING_MODEL (memory search)
```

Keep `LIGHT_MODEL` equal to `CHAT_MODEL` on a single 24 GB card: two big models do not fit
together. `.env` also has `LLM_BACKEND` (`ollama` or `openai` for llama-server, vLLM or LM Studio),
`LLM_BASE_URL`, `EMBED_BASE_URL`, `LLM_PARALLEL`, `SERVER_PORT` and `DATABASE_PATH`.
Optional switches: `LLM_GAZETTE=0` (no newspaper), `LLM_CONVERSATION_SUMMARIES=0`.

## Run it

**Windows launcher.** Double-click `start-game.bat`. It starts Ollama with the flags the game
expects (`OLLAMA_NUM_PARALLEL=4`, flash attention, q8 KV cache, up to 2 loaded models), runs
`npm run dev` and opens the browser. It hardcodes `D:\proyects\little-life` and
`D:\Ollama\ollama.exe`; edit those paths if your install differs. `LLM_PARALLEL` in `.env` must
match `OLLAMA_NUM_PARALLEL`.

**Manually:**

```bash
npm install
cp .env.example .env   # once; edit it if your models or ports differ
npm run dev        # server + client together
```

| What | Where |
|---|---|
| Game (Vite) | http://localhost:5173 |
| Server (tRPC over WebSocket only) | ws://localhost:3001 (`SERVER_PORT`; client override `VITE_WS_URL`) |

If you start Ollama yourself, set the same env vars as `start-game.bat` first, otherwise it
serves one request at a time and dialogue waits behind planning.

### Without an LLM

The game still runs when Ollama is down. The health banner under the top bar shows "LLM offline"
(or "The townsfolk are thinking slowly" when degraded), conversations fall back to grounded template
lines, and planning falls back to deterministic plans. Memory search shows its own "Memory search is
offline" notice if only the embedder is missing. Stories are much flatter, but needs, economy,
movement and events keep going. `npm run soak` runs the whole sim this way, headless.

## Controls

| Key | Action |
|---|---|
| `Space` | Pause or resume the town |
| `1` `2` `3` `4` | Speed 0.5x / 1x / 2x / 4x |
| `Tab` / `Shift+Tab` | Select next / previous resident (favourites first) |
| `F` | Follow the selected resident with the camera |
| `C` | Show or hide the Director's captions |
| `J` | Open or close the Journal |
| `Left` / `Right` | Switch Journal tabs (`1`-`6` also pick one while it is open) |
| `Esc` | Close the topmost panel, menu or overlay |
| `?` | Show or hide the help overlay |

| Mouse / button | Action |
|---|---|
| Click a resident | Inspect: needs, thoughts, plans, memories, ties |
| Right-click a resident | Meddle: chat, destination, money, pair up, secret, confrontation |
| Click a building | See who is inside and what is going on |
| Drag / scroll the map | Pan and zoom |
| Events button | Trigger a town event or set the weather |
| Journal button or `J` | Town Crier, alerts, brewing, stories, timeline, talks |
| Toolbar: Director | Camera picks the best scene and captions it; moving the map pauses it 20 s |
| Toolbar: Meet the Town | Reopen the residents overview |

## Developer notes

```bash
npm run check          # tsc --noEmit + vitest run: the gate before and after every change
npm test               # vitest only (server logic and pure client modules)
npm run typecheck
npm run build          # tsc + vite build
npm run deadcode       # orphan files and unused exports
```

| Script | What it does |
|---|---|
| `npm run soak -- --days 5` | Headless multi-day run, LLM off, temp DB copy, economy table + anomaly flags (`--seed --preset --season --tick-speed --db`) |
| `npx tsx scripts/tick-profile.ts` | Per-phase tick timing and SQL counts (`--ticks --tick-speed --top --json`) |
| `npx tsx scripts/worldgen-metrics.ts` | Grid vs organic town-quality metrics over many seeds; pure worldgen, safe anytime |
| `npx tsx scripts/llm-smoke.ts` | One of each structured prompt against the model |
| `npx tsx scripts/llm-bench.ts --trace t.jsonl --models a,b` | Replay a captured `LLM_TRACE` against models |
| `npx tsx scripts/embed-eval.ts --a m1 --b m2 --trace t.jsonl` | Blind retrieval eval of two embedders |
| `npx tsx scripts/diagnose.ts` | Dump live DB state (table sizes, world clock) |
| `node scripts/shot-gallery.mjs day` | Playwright screenshots of :5173 (needs `npm run dev` running) |
| `npm run db:seed` / `db:reset` | Seed or reset the DB |
| `npm run db:generate` | After editing `server/db/schema.ts`: write the next migration. It is applied at the next start (`db:migrate` applies it now) |

`playwright` is a devDependency (it comes with `npm install`), but browser binaries are not: run
`npx playwright install chromium` once before `shot-gallery.mjs`. `docs/STATUS.md` still says it
is missing from `package.json`; that note is out of date.

Never point tests or experiments at the live world. Use `data/verify.db` (a copy of the live DB
and the `little-life-verify` launch config in `.claude/launch.json`) or the soak script.

**Where things live**

```
server/   Express + tRPC (WebSocket), engine/ (tick loop, 11 phases), lib/ (subsystems, worldgen/,
          memory/, planning/, cascade/), ai/ (LLM client, semaphore, warmup), data/ (static content), db/
src/      React 19 + Pixi.js 8 client: components/canvas (renderers, systems/), components/ui, components/setup
scripts/  soak, profiling, LLM tools, screenshot tools, Aseprite Lua sprite generators
docs/     STATUS.md, superpowers/ (specs and plans), living-agents/, scratch/ (throwaway probes)
```

- Database: `data/little-life.db` (SQLite, created on first boot; gitignored, as are `data/*.db-wal`).
  Save slots and autosaves: `data/saves/`. Tests use a separate throwaway `data/test.db`.
- One tick is one game minute. `docs/STATUS.md` is the living record of state, open bugs and next
  steps; [`CLAUDE.md`](CLAUDE.md) has the full architecture map and gotchas (also read by AI agents,
  see `AGENTS.md`). Design history is in `docs/superpowers/specs` and `docs/superpowers/plans`.
- Commits: small, themed, Conventional Commits in English.

## License

No license is specified for this project.
