# Dark realism: hostile intent, violence, homicide and justice

Status: approved design (2026-09-30), not implemented.
Stages E1–E4 below each get their own implementation plan.

## Why

A playtest whisper — *"I want to kill James"* to Elena Voss — changed nothing
visible. The trace in `play.db` showed:

- The whisper landed as an importance-9 reflection and triggered a replan, but
  Gemma rewrote the day as "Stare at the horizon in silence" followed by the old
  plan verbatim.
- Nothing mechanical moved: friendship 55 / trust 65 with James unchanged, no
  state, no goal.
- Even if the plan had said "Confront James", `inferActionType`
  (`server/lib/planning/planParser.ts:302`) has no verb for confront, fight,
  sabotage, steal or hurt; unmatched text becomes `idle`. Tier-3 verbs
  (`scheme`, `lock_out`, …) become `idle` + a `zoneActivity` that
  `executeZoneAction` (`server/engine/systems/zoneActions.ts:71`) does not know, so the
  ripple rules that listen for them (`rippleRules.ts:557-724`) never fire.
- There is no violent crime at all: deaths are starvation, sickness,
  alcoholism, old age and accidents only.

The player wants the town to be realistic in its darkness too: hostile
intentions must be represented, must not be softened away by the model, and
can escalate up to (implied, off-screen) homicide with investigation and trial.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| Violence ceiling | Up to homicide, always implied / off-screen, never graphic |
| Minors | Same rules as adults as victims. Actors need a minimum age (`VIOLENCE_ACTOR_MIN_AGE = 12`) for plausibility. One eligibility function, one constant. The intimacy layer's adults-only boundary is untouched. |
| Player knowledge | God sees everything; the drama is whether the town finds out (Columbo irony) |
| Opt-in | Always active, no wizard toggle. Pacing is scaled by Drama Intensity. |
| Homicide sources | Premeditated, crime of passion, player-induced (whisper) |
| Punishment | Public trial at the town hall; guilty → long prison then banishment; innocents can be convicted |
| Architecture | **Code decides, Gemma narrates** (approach A). The LLM picks from enums and writes flavor; mechanics never depend on the model's willingness. |
| Scope | One spec, four staged implementations |

## Architecture overview

```
 whisper ─┐
 grudge  ─┤                ┌──────────────────┐      ┌──────────────────────┐
 snap    ─┼─► INTENT ─────►│ HostileActEngine │─────►│ act resolver         │─► interaction:completed
 goal    ─┤  (hostile_     │ which act, whom, │      │ confront insult      │   (ripple, goals, witnesses,
 plan    ─┘   intents)     │ when?            │      │ sabotage steal       │    rumors, blackmail — existing)
                           └──────────────────┘      │ assault murder       │─► drama row + beat + FX
                                                     └──────────────────────┘
```

Three pieces; every source of hostility funnels into them.

### 1. Hostile intent (persistent)

New table `hostile_intents`:

| column | type | notes |
|---|---|---|
| id | int pk | |
| actor_id | int | |
| target_id | int | |
| kind | text | `hostile` (wants to act against) or `fear` (wants to avoid) |
| level | text | `dislike` → `hurt` → `ruin` → `kill` (ordered; `hostile` only, null for `fear`) |
| heat | real 0-100 | drives scoring; decays |
| source | text | `whisper`, `grudge`, `angry`, `revenge_stalled`, `snap`, `assault_victim`, … |
| created_minute / updated_minute | int | game minutes |
| resolved_minute | int null | set when the intent is fulfilled or abandoned |

One open row per (actor, target, kind). It is **the** number escalation reads, so a
dark thought is data, not something Gemma must remember. A `fear` row feeds no
acts; its heat becomes a negative free-time score for being at the target's
location and for socializing with them (avoidance), and decays like hostility.

- Grows from: `grudge` tag, `angry` with a target, revenge goals that stall,
  snap `plot`, whispers, being assaulted, learning of a partner's affair.
- Decays: per game hour (personality-scaled: warmth and morality decay faster,
  aggression and neuroticism slower); faster after positive chats with the
  target; reset by forgiveness events (existing warm ripple rules).
- `level` rises when heat stays above a per-level threshold for a sustained
  window (game time, not ticks), and falls when heat stays low.

Lives in SQLite (not in memory) because it must survive restarts; follow the
new-table checklist in `CLAUDE.md` (`schema.ts`, `CREATE TABLE IF NOT EXISTS` in
`server/db/index.ts`, `ALL_TABLES` in `db/worldTables.ts`, `db/seed.ts`).

Module: `server/lib/hostility/intents.ts` — `raiseIntent(actor, target, {heat, source, minLevel?})`,
`getIntent`, `openIntentsFor(actor)`, `decayIntents(nowMinute)` (called from the
states phase), `resolveIntent`.

### 2. Declarative act registry

`server/data/hostileActs.ts` — pure data (the client imports it for visuals):

```ts
interface HostileActDef {
  id: 'confront' | 'insult' | 'sabotage' | 'steal' | 'assault' | 'murder';
  severity: 1 | 2 | 3 | 4 | 5;
  minLevel: IntentLevel;            // murder requires 'kill'
  verbs: RegExp;                    // plan text → act (planParser)
  gates: {
    together?: boolean;             // same location as target
    unobserved?: boolean;           // no third party at location or within radius
    night?: boolean;                // preferred, not required (score bonus)
    maxMorality?: number;
    minAggression?: number;
  };
  crime?: { factType: string; weight: number; direct: boolean };
  interaction: string;              // action emitted on interaction:completed
  goalOutcome: GoalOutcome;         // goalProgress mapping
  beat: DramaBeat;                  // feed + canvas
}
```

`interaction` **reuses existing action names** wherever one exists, so goal
progress, ripple rules and `DARK_ACTIONS` keep working: `confront` →
`'confrontation'` (→ `fought_target`), `insult` → `'insult'` (→
`insulted_target`), `steal` → `'theft'` plus the existing
`economy:theft_success` / `theft_caught` events (→ `stole_from_target`). New
names only for new acts: `'sabotage'`, `'assault'`, `'murder'`.

Resolvers live in `server/lib/hostility/resolvers.ts`, a
`Record<HostileActId, (ctx) => ActOutcome>`. **Adding an act = one registry entry
+ one resolver.** Existing `shoplifting`/`pickpocket` (`decisions.ts:1368-1404`,
`2191-2251`) stay as they are; migrating them is optional later work.

Eligibility: `isViolenceEligible(actor, target)` in
`server/lib/hostility/eligibility.ts`: both active, actor age ≥
`VIOLENCE_ACTOR_MIN_AGE`, not the same agent. Victims of any age.

### 3. HostileActEngine

`server/lib/hostility/HostileActEngine.ts`.

- `scoreHostileActs(agent, world): ScoredAction[]` — for each open intent of the
  agent, each act with `minLevel ≤ intent.level` whose gates pass against the
  target now: score = f(heat, severity fit, personality, opportunity,
  `dramaMultiplier(rules)`). Returns candidates with
  `source: 'hostile:<act>'` and `targetAgentId`.
- Called from `decisions.ts` as a new phase 1h at score **6200**: below the
  existing 1a tiers (comfort 7000, own wedding/christening 6500, proposal 6400,
  tryst 6300) and above the plan (6000), so a strong intent overrides the plan
  but never a wedding. Only candidates over a heat/opportunity threshold enter
  1h; weaker ones are merged into phase 3 free-time candidates.
- Resolution: at action start, at the same place theft is resolved today
  (≈`decisions.ts:2191`), a single `if (decision.source?.startsWith('hostile:'))`
  dispatches to the resolver. The resolver emits
  `interaction:completed { agentId, perpetratorId, victimId, action, locationId }`
  so the ~60 ripple rules, goal progress, witness amplification, rumors and
  blackmail work unchanged; then logs a drama row with the act's `beat`.
- New actions go into `DARK_ACTIONS` (`lib/cascade/ruleTone.ts:31`) and
  `INTERACTION_OUTCOMES` (`engine/systems/goals.ts:571`).
- If gates fail when a plan asked for the act: the agent *broods* instead — a
  memory ("I wanted to … but …") and +heat — instead of a silent `idle`.

Tier-3 dead ends fixed in E1, all with the same small change: when a plan step
resolving to any tier-3 verb (`scheme`, `lock_out`, `speech`, `protest`,
`confide`, `announce`, `smuggle`, `secret_meeting`, `escape_attempt`) starts,
emit `interaction:completed { agentId, perpetratorId: agentId, victimId:
targetAgentId, action: verb, locationId }` (`victimId` is undefined for
untargeted steps such as `speech` or `announce`; the rules key on `action`) so the ripple rules and
WitnessAmplifier phrases that already listen for them fire. No new effects are
invented for them.

**Plan text → act** (`inferActionType`, `planParser.ts:302`): the registry's
hostile verbs are matched **before** the tier-3 regexes (today "plot" maps to
`scheme` first, so "plot to kill James" would never reach `murder`). The
action type is `hostile:<id>`. Target resolution, in order: the replan
`target` field → a town name found in the step text → the actor's strongest
open hostile intent → none (the step becomes brooding).

## Sources of intent and anti-softening (E1)

### Whisper, redesigned

`whisperThought` (`server/lib/godPowers.ts:149`) keeps the memory + replan and adds:

1. **Classification** — one structured call, `purpose: 'whisper.classify'`,
   schema `{ target: enum(town names) | null, stance: hostile | affectionate |
   fearful | ambitious | neutral, level: dislike | hurt | ruin | kill | null,
   intensity: 1-5 }`. Regex fallback (name match + verb list: kill, murder,
   hurt, hit, hate, ruin, get rid of, …) when the call fails. The call runs
   async after the synchronous part returns; its result applies in a later tick.
2. **Personality filter** — hostile stance → `raiseIntent` with heat scaled by
   aggression, low morality, low warmth and existing friendship. A warm, moral
   agent gets little heat and a `stressed` state ("the thought disturbed
   them"); a cold, aggressive one gets high heat and an `angry` state aimed at
   the target (which already chains to revenge goal → tension → grudge → snap).
   Non-hostile stances keep today's behaviour (memory + replan only).
3. **Player feedback** — a `player_outcome` row describes how it landed
   ("Elena shook the thought off" / "Elena can't stop thinking about hurting
   James"), via `playerOutcomes.ts`.

### Other sources

| Source | Effect |
|---|---|
| `grudge` tag, `angry` with target | intent `dislike`/`hurt` |
| revenge goal stalled for N game days | level +1 |
| Snap `plot` | level up by current heat |
| Snap new option `attack` | immediate `assault` attempt on the culprit (E2) |
| Level reaches `kill` | new goal type `eliminate` (hostile, targeted), completed only by the `murder` outcome |
| Assault victim (E2) | a `fear` intent (avoidance) or a `hostile` intent at `hurt`, by personality (aggression, neuroticism) |

### Anti-softening, three layers

1. **Schema, not prose.** For agents with an open intent ≥ `hurt`, the replan
   schema (`buildReplanPrompt`, `planPrompts.ts:295`) adds optional per-block
   `act: enum(HOSTILE_ACTS ids)` and `target: enum(town names)`. The prompt
   states the intent plainly ("You want James dead. Plan the rest of the day
   as the person you are right now."). **The engine acts regardless of the
   plan**: when heat and opportunity are there, the act is scored even if the
   plan came back soft. The plan adds flavor and timing, it does not decide.
2. **`darknessDirective()`** in `server/ai/contentRating.ts`, sibling of
   `maturityDirective`, added to dialogue, plan/replan/decompose, goal review,
   gazette, summary, whisper classification and the **snap prompt**
   (`SnapResolver.ts`, which today has no directive at all). Framed as fiction:
   people here hate, scheme, hurt and sometimes kill; play characters
   truthfully and don't make them nicer than they are; violence happens off-page
   and is never described in gory detail.
3. **Measurement.** Dark scenarios in `scripts/llm-smoke.ts` (whisper
   classification, replan with a kill intent, snap, dialogue with a hidden
   intent) reporting a **softening rate**: share of runs where the hostile act
   is chosen / the dialogue reflects the intent. Record before/after the
   directive in `docs/STATUS.md`.

### Realism note: concealment

Someone who wants to kill hides it. The dialogue prompt gets a private line
("Secretly, you want James dead."), and how much leaks depends on honesty and
aggression (low honesty → hides well; high aggression + low honesty → barbed
remarks; drunk → may slip). Visibility for the player comes from the UI (see
Visuals), not from confessions.

## Assault and injury (E2)

**Act `assault`** (severity 3): gates `together`, intent ≥ `hurt` *or* an
escalating fight. Aggression, drunkenness push; morality holds back.

- Victim gets `injured` with rolled severity:
  1 bruised (1 day) · 2 hurt (3 days) · 3 badly hurt (7 days, needs a doctor).
- An aggressive victim fights back: the attacker may be injured too.
- Fact `assault`: arrestable, direct crime, known by the victim and co-located
  witnesses.
- Victim gains an intent toward the attacker: `kind: 'fear'` or `kind: 'hostile'`
  at `hurt`, by personality.

**Existing fights gain consequences:** the confrontation engine's physical
fight (`confrontationEngine.ts:203`) and `emitFightBeat`
(`conversationBeats.ts:97`) roll for a light injury via the same injury helper.

**State `injured`** (add to `STATE_TYPES`, `STATE_DEFINITIONS`, client
`STATE_STYLE`):

- Slower: movement reads `STATE_DEFINITIONS[*].speedMultiplier` instead of the
  hardcoded `sick`/`drunk` factors at `movement.ts:530-536` (fixes the dead
  field for `sick` too).
- No work at severity ≥ 2: a guard **before** the plan phase, like the
  `arrested` guard (`decisions.ts:1656`) — today a plan saying "work" sends a
  sick agent to work because the plan phase runs before `checkSchedule`.
- Goes to the clinic/doctor if one exists (branch in `checkSchedule` like
  `sick`); a doctor visit halves the remaining duration.
- Extra energy decay.
- Severity 3 untreated → daily death risk ("died of their wounds"). In E2 this
  is an ordinary immediate death with a new `DEATH_TRIGGERS` entry `wounds`
  (description only, `check: () => false`, called directly). From E3 on, if an
  assault fact names an attacker, the same death opens a `homicide_cases` row
  with `ruled_as: 'homicide'`, already discovered (the town knows about the
  assault).

**Arrests:**

- Extract the inline arrest (`decisions.ts:2548-2669`) into
  `arrestAgent({ subjectId, arresterId, sentenceMinutes, reason, caseId? }): boolean`
  in `lib/arrests.ts`; the fact-based constable path calls it with today's
  sentence formula, so its behaviour is unchanged.
- **Where the arrested are held:** the prison if one exists; otherwise the
  subject is confined to their **home** (house arrest, the `arrested` state's
  `metadata.held_at` = home location id). The jail guard at `decisions.ts:1656`
  pins the agent to `held_at` instead of looking up the prison. Today an arrest
  in a prison-less town is a silent no-op (`if (!prison) continue;`); it no
  longer is.
- **Fact weights:** new `CRIME_WEIGHTS: Record<string, number>` in
  `lib/arrests.ts`; every current arrestable type weighs 1, `assault` 3,
  `sabotage` 2. The threshold (4 with first-hand knowledge of a direct crime,
  else 8) and the sentence formula stay as they are but take the summed weight
  instead of the count, so existing arrests behave identically. `assault` is
  added to `DIRECT_CRIME_TYPES` and `ARRESTABLE_FACT_TYPES`.

## Homicide (E3)

**Act `murder`** (severity 5, `minLevel: 'kill'`, gates `unobserved`).

Paths:

- **Premeditated:** intent reaches `kill` → `eliminate` goal → days of
  brooding (distant, hostile; occasional slips by honesty) → opportunity
  scoring: target alone, nobody at the location or within radius, night bonus.
- **Passion:** the assault resolver has a small lethal roll, raised by intent
  `kill`, drunkenness, a snap and both parties' aggression, times
  `dramaMultiplier`.
- **Induced:** a whisper only adds heat/level; the premeditated path does the
  rest. Personality still has to allow it.

**Last threshold:** immediately before the act, a final roll on morality,
warmth and bond with the victim. On failure the agent **can't go through with
it**: `guilty`-flavored memory, heat drops, player is told. This is a window
for player intervention.

**Methods** — `MURDER_METHODS` in `server/data/murderMethods.ts` (pure data,
1900-appropriate), each with an evidence profile:

| method | where | how it looks when found | evidence |
|---|---|---|---|
| poison | food/drink (home, tavern) | death hours later, **looks like sickness** | low; a doctor may suspect |
| struggle | outdoors, at night | signs of violence | high; clearly homicide |
| staged accident | farm, river, workshop | **looks like an accident** | medium; may be ruled accidental |

Method choice: by location type, actor job and personality; data-driven.

**Off-screen with deferred discovery** — new table `homicide_cases`:

| column | notes |
|---|---|
| id, victim_id, perpetrator_id, method, location_id, minute | ground truth |
| discovered_minute, discovered_by | null until found |
| ruled_as | `homicide` / `accident` / `natural` (the town's view) |
| status | `undiscovered` → `open` → `cold` / `trial` → `closed` |
| verdict, convicted_id | E4 |

**Split of `DEATH_EFFECTS`** (`lifeEventsEngine.ts:400-408`).
`processAgentDeath` gains `{ deferred: true }`:

| step | at the kill | at discovery (`discoverDeath(caseId, finderId)`) |
|---|---|---|
| `deactivateAgent` (retire) | ✔ | |
| death fact | | ✔ |
| grieving | | ✔ (before discovery nobody may grieve: it would leak the death) |
| inheritance | | ✔ |
| funeral event | | ✔ |
| memorial memories | | ✔ |
| death feed row | | ✔ |
| `life:death` emit (family, vacancies, other listeners) | | ✔ |
| god-only feed row + `homicide_cases` insert | ✔ | |

**Cause as the town sees it:** `TOWN_CAUSE[ruled_as][method]` in
`server/data/murderMethods.ts`, e.g. homicide/struggle → "found dead, and it
was no accident"; accident/staged → "found dead after a fall in the barn";
natural/poison → "taken suddenly ill". It never names the perpetrator and must
keep the "has died" wording `MemorialCard` parses.

**Discovery mechanism** (`server/lib/hostility/discovery.ts`): the retired
victim can't be "missed" by systems that skip inactive agents, so the case row
drives it:

1. An `agent:arrived` listener: any active agent arriving at the case's
   `location_id` while `status = 'undiscovered'` discovers it.
2. After `MISSED_AFTER_MINUTES` of waking time, the closest person (partner,
   housemate, family, then employer; from relationship tags) gets a phase-1
   action at score 6200 to go to the victim's home, then to the case location;
   arriving triggers (1).

**Per method:**

- **Poison:** the victim stays active; the case row stores `dies_at` (a few game
  hours later). At `dies_at` the victim dies wherever they are, discovered
  immediately if anyone is present, `ruled_as: 'natural'`. If the town has a
  doctor, a suspicion roll on discovery can re-rule it `homicide` and open the
  investigation.
- **Struggle / staged accident:** deferred discovery as above; the ruling comes
  from the method's evidence profile plus a roll.
- **Passion kill in front of witnesses** (the assault path has no `unobserved`
  gate): immediate discovery with the witness as finder, `ruled_as:
  'homicide'`, and witness facts naming the perpetrator — usually a fast arrest.

The player sees every kill at once: a god-only feed row ("Elena killed James in
the barn — staged accident") and a body marker on the canvas while the case is
undiscovered.

**Aftermath for the perpetrator:** `guilty` state; `eliminate` completes;
intent resolved. By honesty: **conceal** (lie, invent an alibi, may frame
someone with a rumor through the existing rumor machinery) or **crack**
(confession within days). High suspicion → may **flee** town (existing
populationFlow departure).

**Pacing:** minimum game days between homicides, by drama level: `low` 14,
`medium` 7, `high` 5, `chaos` 3 (always possible, never frequent). After each case a town-wide fear modifier reduces
night outings and raises caution for a few days.

## Investigation and trial (E4)

The investigator knows what the town knows, not the truth. They never read
`hostile_intents`; they work from facts, testimony and alibis, so they can be
wrong.

**Alibis** — new table `location_trail` (`agent_id, location_id,
arrived_minute`), written on `agent:arrived`, pruned to 3 game days. Nothing
positional exists today. `agent:arrived` currently carries only
`{ agentId, locationName }` (`movement.ts:412`); add `locationId` to the
payload (E3 discovery needs it too, so it lands in E3).

**Suspicion** — new table `case_suspects` (`case_id, suspect_id, score,
reasons json`):

- Opportunity: near the scene at time of death with no alibi (from the trail).
- Motive: facts the **investigator knows** (fights, assault, grudge, affairs,
  debts involving the victim).
- Witnesses: seen near the scene (trail + perception).
- Slips: a low-honesty perpetrator can contradict themselves under questioning.
- Framing: rumors planted by the perpetrator raise an innocent.

**Investigator loop:** the constable (or, without one, the mayor / most
respected adult, less skilled) takes the existing `investigate` goal: visits
the scene, queues interrogation conversations (topic "the death of X"). What
each interviewee *knows* is decided in code from trail and facts; Gemma only
voices it. Each interview updates scores. Top suspect over threshold with a
margin → `arrestAgent` with `caseId`. No suspect in N days → case goes `cold`;
reopened by a confession or a slip.

**Arrest → trial sequencing:**

1. A case arrest inserts `arrested` with `metadata.case_id` and an open-ended
   duration (`PRETRIAL_MAX_MINUTES`, 3 game days); the 2880-minute cap applies
   only to fact-based arrests. Held in prison or at home as in E2.
2. The trial is scheduled at once for the next town-hall opening: 9-17, taken
   from the `town_hall` building template's hours if it defines them
   (`buildingTemplates.ts:94-105`), otherwise a new `TRIAL_HOURS` constant.
   Next day 10:00 if the arrest is after 15:00.
3. The trial's outcome replaces the pretrial state: acquitted → state removed;
   guilty → a new `arrested` state with the sentence, and banishment when it
   expires.
4. If pretrial detention runs out before the trial happened (e.g. the event
   could not start), the suspect is released and the case returns to `open`.

**Trial** — world event `trial` (`worldEventCatalog.ts`) at `town_hall`
(fallback town square), `triggeredBy: 'trial:<caseId>'`.

- Principals (defendant, investigator, witnesses) pulled like wedding
  principals (`decisions.ts:1761-1790`); public pulled with a venue-aware
  guest pull (town_meeting's pull ignores `location_id`, so trial gets its
  own branch).
- **Verdict is deterministic:** evidence vs doubt, plus the attendees' average
  friendship toward the defendant and the defendant's reputation (the
  well-liked get acquitted more easily; outsiders get convicted more easily).
- Gemma narrates one structured JSON: prosecution line, one line per witness,
  the defendant's plea, the verdict speech → a sequence of feed rows across
  the event.
- Guilty → long prison (~5 game days if a prison exists) then **banishment**
  (`retireResident(id, 'banished')`; `RetireReason` in `residents.ts:423` is
  `'death' | 'left' | 'removed'` today, so add `'banished'` and audit its
  consumers). Acquitted → returns with reputation
  damage. Innocent convicted → injustice: their family gains intent toward the
  accuser; the real killer keeps `guilty`. Gazette covers it all.
- No prison (small towns): straight to trial; guilty → banishment.

## Visuals

**UI**

- **Case file** overlay (modelled on `PairDossier`): opened from the feed row,
  from `MemorialCard`, and from a new Journal tab **Cases**
  (`src/lib/journal.ts`, `Journal.tsx`). Two columns — *what really happened*
  (god view) vs *what the town thinks* — plus suspects with suspicion bars and
  reasons, and a case timeline. New tRPC query; wire it to a channel so it
  refreshes.
- **Dark intentions** section in `AgentPanel`: the `dislike → kill` ladder,
  source and heat, "only you see these".
- **Brewing**: new `BrewingKind 'violence'` when an intent passes `hurt`.

**Canvas** (new cells in the beats atlas via `scripts/aseprite/beat-fx.lua`;
new `DramaBeat`s + `BEAT_STYLE` entries)

| moment | effect |
|---|---|
| intent `ruin`/`kill` | small dark cloud over the head (selected agent or overlay on, like the tension fuse) |
| selected agent | red thread to their target (same style as the Talk system lines) |
| assault | beat `assault`: scuffle with impact stars |
| injured | bandage overlay, irregular limp bob, slower walk |
| murder (god only) | brief dark vignette + beat `murder` (snuffed candle) |
| undiscovered body | sheet-covered body sprite at the location, visible to the player only |
| discovery | beat `discovery`: "!" + scream emote from the finder; crowd gathers |
| investigating | magnifier over the investigator; "?" bubble during interrogations |
| trial | beat `gavel` at the town hall with the crowd |
| verdict | guilty: cuffs, then walks off the map (`FarewellFx`); acquitted: light burst |

Feed and Gazette: icons per beat; case headlines.

## Stages

Each stage merges on its own and leaves the game playable.

| Stage | Contents |
|---|---|
| **E1 Hostility wiring** | `hostile_intents`, `HOSTILE_ACTS` (confront, insult, sabotage, steal), `HostileActEngine`, planParser verbs + replan `act`/`target`, whisper classification + feedback, `darknessDirective`, snap directive, tier-3 verbs emit interactions, intents in AgentPanel, red thread, Brewing, llm-smoke softening rate |
| **E2 Assault and injury** | `assault`, `injured`, `speedMultiplier` refactor, work guard, clinic branch, fights injure, fact weights, `arrestAgent()` extraction, bandage + assault beat, snap `attack` |
| **E3 Homicide** | `murder`, `MURDER_METHODS`, `homicide_cases`, deferred death + discovery, `eliminate` goal, last threshold, pacing + fear, conceal/crack/flee, body + murder/discovery beats, god-only row |
| **E4 Investigation and trial** | `location_trail`, `case_suspects`, investigator + interrogations, framing, cold cases, trial event + verdict + banishment, case file + Cases tab, Gazette |

`sabotage` (E1): target's workplace output or an owned item is damaged; fact
`sabotage`, added to `ARRESTABLE_FACT_TYPES` in E1 (weight 2 once E2 lands
weights).

## Repo rules this must follow

- New tables: `schema.ts` + `CREATE TABLE IF NOT EXISTS` + `ALL_TABLES` + `seed.ts`.
- Any in-memory per-world cache registered in `server/engine/worldCaches.ts`.
- LLM calls: `purpose` tag, JSON-schema `format`, tolerant parser,
  `TOWN_SETTING` + directives, no per-call `num_ctx`.
- Cadences in game time, not `totalTicks % N`.
- Client-imported data (`hostileActs.ts`, `murderMethods.ts`) stays free of
  Node/DB imports.
- New queries wired to a subscription channel.

## Testing

- **Unit (pure):** registry gates and scoring with seeded RNG; each resolver;
  intent raise/decay/level transitions; whisper classifier (LLM mocked) and
  regex fallback; injury rolls; murder method choice; suspicion scoring;
  trial verdict.
- **Integration (test DB, fake LLM):** whisper → intent → act; assault →
  injury → arrest; homicide → discovery → investigation → trial → banishment.
- **Real LLM:** `scripts/llm-smoke.ts` dark scenarios with softening rate
  before/after.
- **Soak:** autoplay N game days counting acts per day to tune pacing (no
  massacre, no drought).
- **Live:** `little-life-verify` on a DB copy; screenshots of new effects.

## Out of scope

- Graphic depiction of violence in any prompt or UI.
- Migrating `shoplifting`/`pickpocket` into the registry.
- A mystery mode where the player doesn't know the culprit.
- An uncensored/abliterated model for dark prompts (possible later if the
  softening rate stays high after E1).
- Executions.
