# Drama-Prone Setup Flow: Conflict Web + Procedural SetupWizard

## Problem

The simulation starts with uneven drama distribution. 5 of 13 agents (Sofia, Omar, Elena, James, Yuki) have zero conflict threads — they're safe harbors that never generate emergent stories. Romantic threads run in parallel without intersecting. Secrets are siloed (only known by 2 people, no chain reactions). There are no love triangles, no faction dynamics, and no guaranteed ignition points.

The SetupWizard UI offers agent/relationship editing but no quick way to configure drama levels or replay with different tensions.

## Solution

Two-part improvement:

1. **Enriched conflict web** — Every agent gets 2-4 intersecting conflict threads. Secrets form chains and loops. No safe harbors.
2. **Procedural SetupWizard** — Presets + sliders that procedurally generate drama configurations. Same 13 agents, infinite starting conditions.

---

## Part 1: Conflict Web Redesign

### New Conflict Threads Per Agent

| Agent | Existing conflicts | New threads |
|-------|-------------------|-------------|
| **Dr. Sofia Petrov** | None | Prescribing Thomas anxiety meds off-books (complicit); developing feelings for Omar but terrified of vulnerability |
| **Omar** | None | Witnessed Ray shove Carlos behind the tavern; keeping quiet because Ray vouched for him when he arrived — loyalty vs justice |
| **Elena** | None | Owes Rosa 3 months for seed supplies; James confided he was drinking the night Margaret fell — Elena carries his guilt |
| **James** | Grief only | Was drunk the night Margaret fell (guilt, not crime); told Elena; blacked out at tavern, told Marco something he can't remember — fears what Marco knows |
| **Yuki** | Thomas political sparring | Caught Thomas picking up meds from Sofia's clinic at odd hours; confronted him, he denied it; she's watching |
| **Thomas** | Priya one-sided romance | Getting anxiety meds from Sofia off-books; skimming small amounts from town funds (Rosa noticed ledger discrepancies) |
| **Priya** | Thomas one-sided | Diego flirted with her at the tavern last month; she was flattered but pulled back because of Lucia. Hasn't told anyone. Guilt + attraction |
| **Carlos** | Ray rivalry, poverty | Rosa secretly extending him credit, hiding it in her books; suspects Ray planted evidence against him before |
| **Lucia** | Diego mutual crush | Saw Diego flirt with Priya at the tavern; hasn't confronted either; found discrepancies in Rosa's shop ledger (the hidden Carlos credit) |
| **Rosa** | Yuki emerging romance | Secretly extending Carlos credit, forging receipts — compassion that looks like fraud if discovered |
| **Diego** | Lucia mutual crush | Flirted with Priya (Lucia saw); Sofia treating his hand injury off-books |
| **Marco** | Ray mutual blackmail | James's drunk confession (unknown content); Rosa confided about the Carlos credit situation |
| **Ray** | Carlos rivalry, Marco blackmail | Shoved Carlos (Omar witnessed); suspects Carlos of theft; own disciplinary record is leverage Marco holds |

### Secret Chain Loops

- **Medical loop:** Thomas → Sofia → Diego (all connected through off-books medicine)
- **Economic loop:** Carlos → Rosa → Lucia (credit fraud discovery chain)
- **Power loop:** Ray → Carlos → Omar → Ray (violence, witness, loyalty debt)
- **Romantic loop:** Diego → Lucia → Priya → Diego (love triangle)
- **Information loop:** James → Elena (guilt), James → Marco (unknown confession), Marco → Ray (mutual blackmail)

### New shared_knowledge Entries

| Secret | Sensitivity | Known by | Category |
|--------|------------|----------|----------|
| Dr. Sofia Petrov prescribing Thomas unprescribed anxiety meds | 3 | Dr. Sofia Petrov, Thomas | medical |
| Dr. Sofia Petrov treating Diego's hand injury off-books | 2 | Dr. Sofia Petrov, Diego | medical |
| Omar witnessed Ray shove Carlos behind the tavern | 3 | Omar | witness |
| James was drinking the night Margaret had her fall | 3 | James, Elena | past |
| James told Marco something while blacked out at tavern | 2 | James, Marco | past |
| Yuki caught Thomas getting meds from clinic at odd hours | 2 | Yuki, Thomas | witness |
| Thomas skimming small amounts from town funds | 2 | Thomas | financial |
| Rosa noticed discrepancies in town ledger (independent discovery, not yet linked to Thomas) | 1 | Rosa | financial |
| Diego flirted with Priya at the tavern | 1 | Diego, Priya, Lucia, Marco | romantic |
| Rosa secretly extending Carlos credit, forging receipts | 2 | Rosa, Carlos | financial |
| Lucia found discrepancies in Rosa's shop ledger | 1 | Lucia | financial |
| Carlos suspects Ray planted evidence against him | 1 | Carlos | suspicion |

### Relationship Adjustments

New/modified relationships for the conflict web:

Note: In the `relationships` table, `agent_a < agent_b` by ID. `_ab` = agent_a's feeling toward agent_b, `_ba` = agent_b's feeling toward agent_a. Use the agent pair sorted by ID; the direction column tells you whose feeling it is.

| Agent pair (sorted by ID) | Change | Reason |
|---------------------------|--------|--------|
| Dr. Sofia Petrov & Omar Hassan | Sofia's romance toward Omar: 15, Omar's romance toward Sofia: 10 | Developing feelings, mutual but unspoken |
| Elena Voss & Rosa Chen | Elena's trust toward Rosa: lower to 30 | Debt creates unease despite friendship |
| James O'Brien & Marco Rivera | James's trust toward Marco: lower to 25 | James fears what he said while drunk |
| Yuki Tanaka & Thomas Park | Add "watching" tag to Yuki's side | Yuki suspects Thomas is hiding something. Tag is narrative context for LLM conversation prompts — no runtime behavior. |
| Diego Santos & Priya Sharma | Diego's romance toward Priya: 15, Priya's romance toward Diego: 20 | The flirtation left traces; Priya was more flattered than Diego intended |
| Lucia Fernandez & Priya Sharma | Lucia's friendship toward Priya: 25, trust: 20 | Lucia saw Diego flirt with Priya, feels betrayed |
| Lucia Fernandez & Diego Santos | Lucia's trust toward Diego: 35 | Saw the flirtation, hasn't confronted |

---

## Part 2: Procedural SetupWizard

### User Flow

```
Start Screen → "New Simulation" → Preset Selection → Slider Adjustment → Preview → Launch
```

### Presets

| Preset | Drama | Romance | Crime | Trust | Description |
|--------|-------|---------|-------|-------|-------------|
| Classic | 7 | 6 | 5 | 5 | The canonical enriched seed data |
| Powder Keg | 9 | 4 | 8 | 2 | Low trust, high crime pressure, secrets everywhere |
| Love & Lies | 6 | 9 | 3 | 6 | Multiple love triangles, romantic secrets, jealousy |
| Quiet Start | 3 | 3 | 2 | 8 | High trust, few secrets — drama emerges organically |
| Total Chaos | 10 | 8 | 9 | 1 | Maximum everything — every agent 4+ conflict threads |

### 4 Sliders (0-10)

| Slider | What it controls | Low (0-3) | High (7-10) |
|--------|-----------------|-----------|-------------|
| **Drama Intensity** | Number of secrets, relationship volatility, mood starting points | 1-2 secrets total, stable moods, high baseline mood (60-80) | 8-12 secrets, low moods (30-50), high stress (40-60) |
| **Romance Density** | Romantic threads count, love triangles, crush asymmetry | 0-1 mutual crushes, no triangles | 3-4 threads, 1-2 triangles, unrequited love |
| **Crime Pressure** | Economic desperation, wealth gaps, theft proximity | Even wealth ($60-80 all), comfortable | Extreme gaps ($10-150), 3-4 agents near broke |
| **Trust Level** | Baseline trust, faction formation, rival/grudge tags | Paranoid: baseline trust 10-20, 2-3 rival pairs, grudge tags | Naive: baseline trust 60-70, no rivals — fragile innocence |

### Procedural Generation Logic

When sliders are set and "Generate" is pressed:

1. **Start with base agents** — Fixed: names, personalities, jobs, locations, schedules. These never change.

2. **Secrets assignment** (Drama slider):
   - Target secret count: `N = Math.round(Drama * 1.2)` (so Drama=7 produces ~8 secrets, Drama=10 produces 12)
   - Shuffle the secrets pool, iterate through templates, attempt to fill agent slots
   - For each template, randomly assign agent slots respecting constraints:
     - Personality compatibility (moral agents get guilt/witness secrets, amoral agents get crime/deception secrets)
     - Job compatibility (medical secrets require a medical-job agent)
     - Relationship compatibility (romantic secrets require agents with compatible ages/orientations)
   - **Constraint fallback**: If no valid agents satisfy a template's constraints, skip it and try the next template. If constraints are close (within +/-10 of threshold), relax them. Never force-assign an incompatible agent.
   - Stop when N secrets are assigned or pool is exhausted
   - Output as `shared_knowledge` config entries (not yet inserted into DB — see integration below)

3. **Romance wiring** (Romance slider):
   - Pull N romantic thread templates from the romance pool
   - Wire romance_ab/romance_ba values between compatible agents
   - For triangles: ensure agent C has visibility (same location, or friends with A or B)
   - Age proximity filter: agents within 15 years preferred, 20 max

4. **Economy scaling** (Crime slider):
   - Low crime: flatten wealth (all agents $60-80 starting money)
   - High crime: amplify gaps — top 3 agents get $100-150, bottom 3 get $10-25
   - Salary variance increases with crime slider

5. **Trust calibration** (Trust slider):
   - Scale all baseline friendship and trust values
   - Low trust: inject 2-3 rival pairs with grudge tags, negative friendship
   - High trust: remove existing rivals, boost all friendship by +20

6. **Mood adjustment** (derived from Drama):
   - High drama: 4-5 agents start with mood 30-45, stress 40-60
   - Low drama: all agents start mood 55-75, stress 10-25

### Integration with Existing Setup Flow

The `generateFromSliders` endpoint returns a `SetupConfigSchema`-compatible object (agents, relationships, shared_knowledge, economy). It does NOT directly seed the database. The flow:

1. Client calls `generateFromSliders({ drama, romance, crime, trust })`
2. Server generates config and returns it as JSON (preview data)
3. Client shows preview in `SimulationPreview` component
4. "Regenerate" re-calls the same endpoint (new random seed, same sliders) — purely client-side preview swap, no DB writes
5. "Launch" calls the existing `initialize` mutation with the generated config
6. `initialize` seeds the world as it does today

The **Classic preset** calls `initialize` with the hardcoded enriched seed data directly (bypasses procedural generation).

**Quiet Start note**: Drama=3 intentionally produces minimal initial conflict (2-3 secrets, 1 romantic thread). The simulation relies on LLM-driven goal generation, perception, and gossip to create emergent drama over days 2-5. This is a valid playstyle for users who want to watch drama develop organically.

### Two seed paths

- **Direct seed** (`npm run db:seed` / `db:reset`): Uses enriched hardcoded data from `seed.ts` including all 12 conflict web secrets. This is the "Classic" preset equivalent.
- **Wizard seed** (`initialize` via setup router): Uses procedurally generated or manually configured data. Hardcoded drama entries in `seed.ts` are NOT used — the wizard generates its own `shared_knowledge` entries.

### Secrets Pool

New module: `server/data/secretsPool.ts`

~20 parameterized secret templates organized by category:

**Medical (3 templates):**
- `"{agent_a} is getting medication from {agent_b} without records"` — requires agent_b.job in medical
- `"{agent_a} is treating {agent_b}'s injury off the books"` — requires agent_a.job in medical
- `"{agent_a} has been self-medicating with alcohol to cope"` — requires agent_a.neuroticism > 40

**Financial (4 templates):**
- `"{agent_a} has been secretly lending money to {agent_b} and hiding it"` — requires agent_a.money > agent_b.money
- `"{agent_a} owes {agent_b} months of unpaid debt"` — any pair
- `"{agent_a} has been skimming from {source}"` — requires agent_a has authority/access
- `"{agent_a} found irregularities in {agent_b}'s records"` — requires agent_a works for/with agent_b

**Witness (3 templates):**
- `"{agent_a} saw {agent_b} get violent with {agent_c}"` — requires agent_b.aggression > 50
- `"{agent_a} overheard {agent_b} planning something against {agent_c}"` — any hostile pair
- `"{agent_a} caught {agent_b} stealing from {location}"` — requires agent_b.morality < 50

**Romantic (4 templates):**
- `"{agent_a} flirted with {agent_b} and {agent_c} saw it"` — requires romantic thread with agent_c
- `"{agent_a} has secret feelings for {agent_b} who is with {agent_c}"` — creates triangle
- `"{agent_a} and {agent_b} had a one-night encounter nobody knows about"` — requires sensuality > 50 for both
- `"{agent_a} discovered {agent_b} is attracted to {agent_c}"` — observer role

**Past (3 templates):**
- `"{agent_a} confided a shameful past event to {agent_b}"` — any pair with friendship > 40
- `"{agent_a} was responsible for something terrible that {agent_b} also knows about"` — sensitivity 3
- `"{agent_a} left their previous life under suspicious circumstances"` — solo secret

**Suspicion (3 templates):**
- `"{agent_a} suspects {agent_b} of {crime_type}"` — requires agent_a.curiosity > 50 or law enforcement
- `"{agent_a} has been watching {agent_b}'s movements"` — any pair with low trust
- `"{agent_a} thinks {agent_b} is lying about their identity"` — requires agent_b to have a "past" secret

Each template includes:
- `category`: medical | financial | witness | romantic | past | suspicion
- `template`: string with agent placeholders
- `sensitivity`: 1-3
- `constraints`: personality/job/relationship requirements for agent slots
- `min_drama_level`: minimum Drama slider value to include this template (prevents mild secrets in chaos mode)
- `constraint_flexibility`: how much to relax personality thresholds if no valid agents found (+/-10 default)

### Romance Pool

New module: `server/data/romancePool.ts`

~10 romantic thread templates:

- **Mutual crush** — Both have romance 40-60, neither has confessed. Known by 1 friend each.
- **Unrequited** — Agent A has romance 50+, agent B has 0. Creates longing + awkwardness.
- **Love triangle** — A→B mutual, but C also has feelings for B (or A). C witnessed A+B together.
- **Secret fling** — A and B had a past encounter, romance 30, trying to act normal. One friend knows.
- **Emerging tension** — A and B are friends/roommates, romance 10-20, unacknowledged warmth.
- **Jealousy seed** — A saw B flirt with C. A has feelings for B. Creates resentment toward C.
- **Rival suitors** — Both A and C have feelings for B. A and C don't know about each other.
- **Forbidden attraction** — A has feelings for B but there's a barrier (age gap, employer/employee, friend's ex).
- **Rebound risk** — A recently lost a relationship (widowed, heartbroken state), B shows interest. Vulnerable + hopeful.
- **Slow burn** — A and B work together daily, romance 5-10, building imperceptibly. Neither notices until someone else points it out.

Each template specifies:
- Romance values to set for each pair
- Trust/friendship adjustments
- Optional shared_knowledge entries (who knows about the thread)
- Compatibility constraints (age proximity, personality fit)

---

## Part 3: UI Components

### PresetSelector

Grid of 5 cards, each showing:
- Preset name and icon
- 1-line description
- Mini radar chart showing the 4 slider values
- Click to select → sliders auto-fill

### DramaSliders

4 horizontal sliders with:
- Label + current value (0-10)
- Color gradient (green at low, red at high)
- Tooltip explaining what the slider affects
- Real-time preview update as sliders move

### SimulationPreview

After sliders are set, shows a preview of what will be generated:
- Agent list with mood indicators (happy/neutral/stressed icons)
- Relationship web visualization (lines between agents, colored by type: green=friends, red=rivals, pink=romance)
- Secret count badge
- "Regenerate" button to re-roll with same slider values
- "Advanced" button to open the existing agent/relationship editor

### Flow Integration

The SetupWizard uses a `STEPS` array with typed `StepId` values. Add new step IDs to the array and type.

Updated steps:
1. **Welcome** (existing `StepId`) — unchanged
2. **Scenario** (new `StepId: 'scenario'`) — PresetSelector + DramaSliders
3. **Preview** (new `StepId: 'preview'`) — SimulationPreview with regenerate. Populated from `generateFromSliders` response.
4. **Advanced** (existing, optional via button) — AgentEditor/RelationshipEditor pre-populated with the generated config. User can tweak before launch.
5. **Launch** (existing) — Calls `initialize` with final config

### Chart dependency

PresetSelector's radar chart: use a lightweight inline SVG polygon — no external charting library needed. 4 axes (Drama, Romance, Crime, Trust) drawn as a simple `<polygon>` with computed points. ~30 lines of code.

---

## File Changes Summary

| File | Change |
|------|--------|
| `server/data/secretsPool.ts` | **NEW** — ~20 parameterized secret templates |
| `server/data/romancePool.ts` | **NEW** — ~10 romantic thread templates |
| `server/lib/setupGenerator.ts` | **NEW** — Procedural generation: sliders → seed data |
| `server/db/seed.ts` | Enrich with conflict web secrets + relationship adjustments for Classic preset |
| `server/routers/setup.ts` | Add `generateFromSliders` endpoint accepting 4 slider values + optional preset name |
| `src/components/setup/SetupWizard.tsx` | Add Scenario + Preview steps to wizard flow |
| `src/components/setup/PresetSelector.tsx` | **NEW** — Preset cards with radar charts |
| `src/components/setup/DramaSliders.tsx` | **NEW** — 4 slider controls |
| `src/components/setup/SimulationPreview.tsx` | **NEW** — Preview with agent list, relationship web, secret count |
