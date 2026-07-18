# Living Agents — Phase 2: Believability Audit

Date: 2026-07-17. Method: 2 fresh-eyes auditors (visual: 11 screenshots over ~8 game hours; data: DB sampling) + orchestrator adversarial verification of every claim.

Context: town reseeded (13 agents), backend restarted, weather=sunny, tick 1x. Screenshots in `docs/scratch/shots/va-*.png`, `audit-t0-wide.png`.

## Verified breaks (ranked)

### H1. No walk animation, no directional facing, no idle motion — HIGH
- Evidence: `va-detail-agent-walk{,-t1,-t2}.png` — identical sprite frame across 45 game minutes of movement. Code: `AgentSprite.ts` static PIXI.Sprite, no frame system, no flip, no rotation.
- Agents glide like chess pieces. Single biggest believability killer.

### H2. Conversations lack physical staging — HIGH
- Initiation requires ≤64px or same location, but no approach choreography, no facing, no position lock during talk. Verified pairs 80-150px apart both in `talking` (t0 snapshot: Sofia 1264,624 / Omar 1264,704 same conversation).
- Speech bubbles float independently; nothing visually links partners.

### H3. Template one-liner conversation flood — HIGH
- Verified: 130/157 conversations (83%) have exactly 1 message. Breakdown: 125 `perception_casual_chat (template)`, rest location-encounter templates.
- NOT an LLM outage (Ollama 200 OK; 27 multi-turn LLM convs completed with good quality, e.g. conv 732, 5 coherent turns).
- Root cause: perception casual-chat tier creates single-utterance conversations marked ended ("James nodded at Rosa Chen") — reads as agents talking AT nobody, floods feed, ~10 convs/game-hour (≈4.8 per agent per day vs believable 2-3).

### M4. Sleeping/working/idle visually identical — MEDIUM
- `va-evening-all.png` at 00:50: 11 sleeping agents indistinguishable from idle. Code: no pose variants, no Zzz, no lying rotation. Working agents likewise static standers.

### M5. Dead plaza / weak gathering readability — MEDIUM
- `audit-t0-wide.png` 9:37 AM: town square fully empty while agents socialize scattered elsewhere. Square scored in decisions (afternoon promenade) but gathering never visually reads as a group.

### L6. Bubble/emote reach — LOW
- Emotes + thought bubbles work but no directional cue toward conversation partner; no visible reaction when passing friends (perception happens in DB only).

## Claims checked and REJECTED / downgraded

- "LLM timeout causes 1-msg stubs" — REJECTED. Ollama running; one-liners are by-design template tier.
- "Hungry agents ignore needs (Sofia hunger 1.3 idle)" — NOT REPRODUCIBLE at re-check; all agents coherent (Lucia energy 9.5 while sleeping = correct). Watchpoint only; emergency threshold is 15 and decisions run every tick.
- "Agents stuck walking hours" — mismeasured: `action_started` persists across long multi-segment walks; Marco path fresh at re-check. Watchpoint.
- "Teleporting" — none found. "Wall clipping" — 0 violations across samples.

## What already works

- Lighting day/night/season/weather, chimney smoke, weather particles.
- Mood rings, state rings, name pills, speech/thought bubbles, emotes.
- LLM conversation content quality (multi-turn tier), relationships/economy coherent.
- Night behavior correct: 11/13 asleep at 00:50, bartender Marco legitimately late (sleepTime 0).

## Fix priorities for Phase 3 design

1. Procedural walk/facing/idle animation (no per-agent frame assets exist — 13 custom 32x32 statics; LimeZu raw sheets don't match identities → procedural bob/flip/sway).
2. Conversation staging: approach → stand adjacent → face partner → locked during talk + visual link.
3. Action poses: sleeping (lie + Zzz), working (tool bounce or posture), sitting.
4. Perception chat rework: one-liners become overhead flavor emotes/bubbles, not conversation records; cap frequency.
5. Gathering: plaza/tavern group magnetism so social hotspots read on screen.
