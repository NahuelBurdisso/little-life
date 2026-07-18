# Living Agents — Phase 1: System Understanding

Date: 2026-07-17. Branch: feat/living-agents-phase1.
Compiled from 3 parallel code-mapping passes (behavior, social, rendering).

## 1. Movement (server/engine/systems/movement.ts, ~644 lines)

- Position: `agents.position` JSON `{x,y}` pixels, DB-updated every tick (L633-636).
- Path: `agents.current_path` array of pixel waypoints; A* in `server/lib/pathfinding.ts`.
- Speed: `PIXELS_PER_GAME_MINUTE=16` * tick_speed * multiplier (drunk 0.7x, sick 0.6x) (L440-444).
- Arrival threshold 8px; `handleArrival()` L158-293.
- Stuck detection: 30 ticks immobile → force idle (L341-369). Blocked waypoint → recalc max 1/10 ticks (L564-585).
- Interiors: two-phase A* (exterior→interior), door-tile exit, 5-tick lerp on zone transitions (L309-336, 487-540).

## 2. Pathfinding (server/lib/pathfinding.ts, ~206 lines)

- A*, Chebyshev heuristic, 8-directional (diag cost 1.414, both ortho neighbors must be free).
- Collision grid: '0'/'1' string, `grid[y*width+x]`, 40x30 tiles. Optional terrain cost map (season-aware).
- **Fallback: direct line `[[start],[dest]]` if no path** (L171) — potential wall-clipping source.

## 3. Action Selection (server/engine/systems/decisions.ts, 1600+ lines)

Priority cascade per tick:
1. `isActionComplete()` L66-103 (duration-based; talking interrupted by critical needs <15).
2. Emergency L158-233, score 9999: hunger/energy/social/mood critical, storm outdoors → flee home.
3. Daily plan (PlanExecutor), score 6000.
4. Schedule L237-362, score 3500-5000: sleep (personality-shifted 19-26h), work, meals, morning routine; impulsiveness can skip.
5. Free-time scoring L366-820: eat/socialize/tavern/home/square/zone activities (fish, garden, forage, perform, jog, browse, rest, contemplate). Personality, reputation (pariah 0.1x), shared hobbies, coworker bonus, romance/infatuated/jealous modifiers, seasonal multipliers, weather gates, 10% noise.

Action stored: `agents.current_action` JSON `{type, targetLocationId?, targetAgentId?, zoneActivity?}` + `action_duration`, `action_started`.

## 4. Time / Schedules (server/engine/tick.ts)

- 1 tick = 1s real = 1 game minute (tick_speed 1-4). Phases: dawn 5-7, morning 7-12, afternoon 12-17, evening 17-20, night 20-5.
- Seasons 28 days. Transitions emitted: hour/day/phase/season changed.
- Tick order: needs → states → economy → relationships → conversations(async) → goals → decisions → movement → events → gossip → cascades. Perception scan every 10 ticks. Daily: memory consolidation, self-descriptions, reputations, mood momentum, aging.
- `agents.schedule` JSON: wakeTime, sleepTime, workStart/End, lunchTime — personality-adjusted, never changes after creation.

## 5. Needs / States (needs.ts, states.ts)

- Needs 0-100: hunger, energy, social, comfort, fun + mood, stress. Decay/hour: 4.2/3.5/2.0/1.0/2.5, action modifiers per type, stress multiplier `1+(stress/200)`.
- Mood = weighted needs + modifiers + weather + momentum. Stress = 100 - (lowest*0.6 + avg*0.4).
- Weather affects decay (storm outdoors comfort 2.5x etc), indoors cozy bonus.
- ~40 states in `agentStates` table (sick, depressed, infatuated, jealous, lonely, in_debt, alcoholic, heartbroken...). Trigger rules + expiry + conditional exits + cascades. States modify effective personality per tick.

## 6. Conversations (conversations.ts, decisions.ts L1450-1675)

- Initiation: low social need scan OR location encounter (15%/tick at tavern/square/park). Proximity: within 64px OR same location.
- Queue (`conversationQueue`): tier template (0 LLM turns) / llm_standard (4) / llm_deep (6, dramatic states/first meetings). max_wait ~10s then template fallback.
- Active: both agents set to `{type:'talking', conversationId}`; LLM (Ollama) fire-and-forget; 60s timeout.
- Post: relationship deltas (relationshipImpact.ts), memories, gossip/facts, quality score 0-1.
- **Agents do NOT visibly face each other or stand adjacent-locked — just action type set.**

## 7. Relationships (relationships.ts)

- Directional friendship/romance/trust [-100,100] per pair + symmetric familiarity, tags, status (strangers→...→partners/enemies).
- Change via `relationshipEvents` with diminishing returns; proximity familiarity gain; decay every 60 ticks after 7-day grace, grudges persist.
- Influence: socialize scoring bonuses, conversation tier, emergency-social friend preference.

## 8. Memory / Goals

- `memories`: description, importance 0-10, valence, 384-dim embedding (Ollama), reflections with citations. Retrieval: cosine + recency/importance ranking, token-budgeted (MemoryService.ts).
- ReflectionRunner: LLM questions → evidence retrieval → insights (importance 8).
- Goals: GoalReviewer (daily, LLM: continue/adjust/abandon + ambition shifts), PivotEvaluator (hourly check, pivot after ~2 days zero progress, emotional failure events), abandonment triggers (state expired, relationship threshold, money, elapsed).
- Daily plans: PlanGenerator → hourly blocks → PlanDecomposer → actions; PlanExecutor consumes.

## 9. Client Rendering (src/components/canvas/)

- Sprites: static 32x32 PNG per agent (`public/sprites/agents/{key}.png` + portrait), 18 agents. Anchor (0.5, 0.9). Fallback black circle + letter.
- **NO walk cycles, NO directional facing, NO idle animation, NO action poses.** Raw 16x16 animation frames exist unused in `assets-raw/modern-interiors/.../Characters_free/` (`*_run_16x16.png`, `*_idle_anim_16x16.png`, `*_sit_16x16.png`).
- Position sync: tRPC query + subscription invalidate → SpritePool.update targets → per-frame lerp LERP_SPEED=0.12 (~133ms convergence) (AgentSprite.ts L174-188).
- Indicators: interior glow, selection ring, mood ring (color 0-100), state ring (15 colors, 25-state priority), name label pill.
- BubbleSystem.ts: speech bubbles (60 chars, 4s, sentiment border), thought dots, text thoughts (action changes), 17 emote emojis (mood/state/activity), float+fade.
- Lighting: LightingSystem.ts lightmap 1/8 res — ambient per phase, season tints, weather modifiers, window glow, forge/oven emissives. WeatherEffects.ts particles (rain/storm/fog/snow/wind). DayNightCycle.ts legacy overlay.

## 10. Tooling

- Screenshot: `node docs/scratch/shot-r12.mjs <label> [dragX] [dragY] [zoomSteps] [repeats]` → `docs/scratch/shots/{label}.png`. Needs dev server at localhost:5173. Waits 6s init + 5s particles.
- Weather trick: `UPDATE world_state SET weather='sunny'` before shots.
- Tests: `npx vitest run` — 432 must stay green.

## Known believability gaps (pre-audit hypotheses)

1. Static sprites: no walk/facing/idle — agents glide like chess pieces.
2. Conversations lack physical staging: no facing, no approach-and-pause choreography.
3. A* direct-line fallback can walk through walls.
4. Server 1s position updates + 0.12 lerp: motion smooth but may look drifty/floaty.
5. Sleeping/working agents look identical to idle ones (single sprite).
