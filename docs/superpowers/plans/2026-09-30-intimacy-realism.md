# Intimacy & Romance Realism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give romance a body: attraction and orientation, kisses, lovers who spend the night together
(implied, fade-to-black), longing, affairs that are *acts* instead of inferences, suspicion, unwed
pregnancy as a 1900 scandal — all behind an opt-in "Adult content (18+)" rule, with suggestive
(non-explicit) visuals and an LLM tone that lets townsfolk speak frankly about desire.

**Architecture:** A new side-effect module family `server/lib/intimacy/` modelled on
`milestonesEngine.ts`: pure decision functions + an in-memory pair/agent state checkpointed through a
`SnapshotStore`, a `conversation:ended` listener, and a periodic `intimacyTick` from the tick loop.
Durable truth lives in relationship tags (`kissed`, `lovers`) and `shared_knowledge` facts; the client
reads tags, `drama` feed rows with `metadata.beat`, `current_action.zoneActivity` and agent states.

**Tech Stack:** Node/tsx, Drizzle + better-sqlite3, Vitest 2, React 19, Pixi 8, Aseprite batch Lua.

---

## Content boundaries (non-negotiable, enforced in code and tests)

1. **Adults only.** Every intimacy path (kiss, rendezvous, tryst, longing, conception, flirt escalation)
   goes through `isIntimacyEligible(a, b)` which requires `age >= 18` for both. A test enumerates it.
   The LLM tone line also states it.
2. **Implied, never explicit.** No sexual acts are narrated by code, templates, feed rows, memories or
   prompts. Feed/memory wording is discreet ("spent the night together", "the lamp was turned down").
   The LLM directive tells the model physical intimacy happens off-stage. Visuals are suggestive only:
   leaning in, hearts, blush, lights out, curtains, fade-to-black. No nudity/sex sprites or frames.
3. **Consent is modelled.** Both sides decide. A refusal is a real outcome with its own consequences.
4. **Opt-in.** `adultContent` rule defaults to `false`. Off = kisses and chaste romance only (kissing
   is PG and ships on by default); the adult layer (longing, rendezvous, trysts, unwed pregnancy,
   frank tone) only runs when on.

## Contract shared by server and client (lock these names)

| Thing | Name |
|---|---|
| Live rule | `LiveRules.adultContent: boolean` (default `false`) |
| Relationship tags | `kissed` (sticky once), `lovers` (sticky once a tryst happened) |
| Drama beats (`server/data/dramaBeats.ts`) | `kiss`, `kiss_rebuffed`, `tryst`, `caught` (seen leaving at dawn), `scandal` |
| Beat kind mapping | `kiss`→`kiss` (new BeatKind), `kiss_rebuffed`→`heartbreak`, `tryst`→`romance`, `caught`→`secret`, `scandal`→`secret` |
| zoneActivity | `tryst` (the private evening), `sneak_home` (the dawn walk back) |
| Agent states | `afterglow` (after a tryst, ~8 game h), `guilty` (cheated, high morality), `suspicious` (targets the partner) |
| Fact types (`gossip.ts`) | `kiss_seen`, `tryst_seen`, `illegitimate_pregnancy`; `affair` now also born from acts |
| simEvents | `intimacy:kiss` `{a,b,first,witnessIds}`, `intimacy:tryst` `{a,b,venueId,secret}`, `intimacy:caught` `{a,b,witnessId}` |
| Topic labels (`server/ai/prompts.ts`) | `RENDEZVOUS_TOPIC` |
| LLM purpose (`llmMetrics.ts`) | `intimacy.consent` |
| Orientation | `agents.orientation`: `'straight' | 'gay' | 'bi'` |
| Portrait mood | `smitten` (blush) |
| Emotes | `blush`, `kiss`, `wink` |

## File map

Create:
- `server/lib/intimacy/eligibility.ts` — age/orientation/state gates, `isIntimacyEligible`, `attractionCompatible`.
- `server/lib/intimacy/orientation.ts` — assignment at seed + lazy backfill.
- `server/lib/intimacy/attraction.ts` — pure `chemistry(a,b)` and romance-gain multiplier.
- `server/lib/intimacy/state.ts` — in-memory pair/agent state + `intimacySnapshotStore` + `clearIntimacy`.
- `server/lib/intimacy/longing.ts` — per-agent desire 0..100, hourly growth, resets.
- `server/lib/intimacy/kiss.ts` — kiss decision after conversations + effects.
- `server/lib/intimacy/rendezvous.ts` — invitation, consent, venue choice, pending tryst, decision hook.
- `server/lib/intimacy/tryst.ts` — tryst start/end, sleepover, dawn return, witnesses, consequences.
- `server/lib/intimacy/suspicion.ts` — partner notices absences, confrontation queue.
- `server/lib/intimacy/pregnancy.ts` — unwed conception roll + scandal + shotgun proposal hook.
- `server/lib/intimacy/index.ts` — side-effect registration (listeners) + `intimacyTick`.
- `server/ai/contentRating.ts` — maturity directive strings.
- `server/ai/intimacyContext.ts` — prompt lines about kisses/lovers/longing/secrecy.
- `server/routers/intimacy.ts` — `getLedger` for the Hearts panel.
- `src/components/canvas/systems/couples/CoupleSystem.ts` — couples walk close, hold hands, glances.
- `src/components/canvas/systems/curtains/CurtainSystem.ts` — curtains on tryst homes.
- `src/components/ui/FadeToBlack.tsx` — cinematic fade for followed/favourite agents.
- `src/components/ui/RomanceLedger.tsx` — Hearts panel.
- Tests next to each (`__tests__/`).

Modify (main ones): `server/data/rulesCatalog.ts`, `server/lib/worldRules.ts`,
`src/components/setup/configRegistry.ts`, `server/db/schema.ts`, `server/db/index.ts`,
`server/lib/relationshipImpact.ts`, `server/data/interiors.ts`, `server/lib/conversationBeats.ts`,
`server/lib/cascade/rippleRules.ts`, `server/lib/cascade/WitnessAmplifier.ts`, `server/lib/gossip.ts`,
`server/lib/states.ts`, `server/engine/systems/states.ts`, `server/engine/systems/decisions.ts`,
`server/engine/tick.ts`, `server/engine/worldCaches.ts`, `server/index.ts`, `server/ai/prompts.ts`,
`server/ai/llmMetrics.ts`, `server/lib/family.ts`, `server/lib/milestonesEngine.ts`,
`server/data/dramaBeats.ts`, `server/data/activityRegistry.ts`, `server/lib/storyBeats.ts`,
`server/router.ts`, `server/routers/nudge.ts`, client beat/emote/portrait/lighting files, `App.tsx`,
`FloatingToolbar.tsx`, `PairDossier.tsx`.

## Conventions every task follows

- TDD: write the failing test, see it fail, implement, see it pass. `npm run check` green before commit.
- Game time only (`gameMinutesNow`, `ClockTime`), never `totalTicks % N`.
- New in-memory state → registered in `server/engine/worldCaches.ts` (clear + snapshot).
- New column → `schema.ts` **and** `addColumnIfMissing` in `server/db/index.ts`.
- Long *why* comments, matching the codebase. English commits, Conventional Commits, one theme each,
  ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: grep output for `Test Files` / `FAIL` (runs are noisy). Never touch `data/little-life.db`.

---

## Phase 0 — Foundations

### Task 1: `adultContent` live rule + wizard toggle

**Files:** Modify `server/data/rulesCatalog.ts`, `server/lib/worldRules.ts` (`pickValid`,
`RuleOverridesSchema`), `src/components/setup/configRegistry.ts`; Test
`server/lib/__tests__/worldRules.test.ts` (extend) or new `adultContentRule.test.ts`.

- [ ] Test: `getRules().adultContent === false` on a fresh world; `setRules({... adultContent: true})`
      persists and `getRules()` returns true; a non-boolean in `setup_config.rules.adultContent` is ignored.
- [ ] Add `adultContent: boolean` to `LiveRules` with a doc comment (opt-in, 18+, what it unlocks),
      `DEFAULT_LIVE_RULES.adultContent = false`, `pickValid` boolean branch, `RuleOverridesSchema`.
- [ ] `CONFIG_REGISTRY` entry `{ key: 'adultContent', type: 'toggle', category: 'simulation', label:
      'Adult content (18+)', description: 'Lovers, desire, affairs and scandal. Intimacy is implied and
      off-screen. Only adults (18+) are ever involved.' }` — follow the registry's existing shape.
- [ ] Export `isAdultContent(): boolean` helper from `worldRules.ts` (one call site style for engines).
- [ ] check green → commit `feat(rules): an opt-in adult content rule`.

### Task 2: Eligibility gate + orientation

**Files:** Create `server/lib/intimacy/eligibility.ts`, `server/lib/intimacy/orientation.ts`;
Modify `server/db/schema.ts` (agents.orientation text nullable), `server/db/index.ts`
(`addColumnIfMissing('agents','orientation','TEXT')`), seeding path (`server/routers/setup.ts`
initialize + `server/db/seed.ts`) to call `assignOrientations`, server start (backfill null rows once);
Tests `server/lib/intimacy/__tests__/eligibility.test.ts`, `orientation.test.ts`.

- [ ] `export const INTIMACY_MIN_AGE = 18;`
- [ ] `isIntimacyEligible(a: {age, gender, orientation, alive?/is_active}, b): boolean` — both ≥18,
      different ids, both active, and `attractionCompatible(a,b) && attractionCompatible(b,a)`.
- [ ] `attractionCompatible(self, other)`: straight → other gender; gay → same gender; bi → either;
      null orientation → treat as straight (legacy rows before backfill).
- [ ] `canBeAttractedTo(self, other)` one-sided version (for one-sided crushes and romance gain).
- [ ] `assignOrientations(agents, relationships, rng)`: deterministic per seed. Respect seeded romance:
      an agent with romance > 30 toward someone of the same gender gets `gay` if all their >30 targets
      are same-gender, else `bi`. Others: 88% straight, 7% bi, 5% gay. Pure; returns `Map<id, Orientation>`.
- [ ] Tests (the boundary tests are mandatory):
      - 17-year-old + 30-year-old → false in both argument orders; 18 + 18 → true (compatible).
      - Every orientation × gender pair truth table.
      - Seeded same-gender crush pair keeps both non-straight.
      - Same seed → same assignment.
- [ ] Backfill: on server start, agents with `orientation IS NULL` get `assignOrientations` against the
      current relationships (idempotent). Put it next to other startup backfills (grep `embeddingBackfill`
      call site in `server/index.ts` for the pattern).
- [ ] check → commit `feat(intimacy): adults-only eligibility and orientation`.

### Task 3: Attraction shapes romance gain

**Files:** Create `server/lib/intimacy/attraction.ts`; Modify `server/lib/relationshipImpact.ts`
(`computeRelationshipDeltas`); Test `server/lib/intimacy/__tests__/attraction.test.ts` + extend
`server/lib/__tests__/conversationImpact.test.ts`.

- [ ] `chemistry(aId, bId, worldSeed)`: deterministic 0.6..1.4 from a hash of the sorted pair + seed
      (some pairs just click). `ageGapFactor(a,b)`: 1 up to 10 years, linearly to 0.5 at 30 years.
- [ ] `romanceGainMultiplier(self, other, seed)`: `0` if `!canBeAttractedTo(self, other)` or either
      under 18; else `chemistry * ageGapFactor`. Negative romance deltas are **not** scaled.
- [ ] In `computeRelationshipDeltas`, multiply positive `romance_ab` by the multiplier for a→b and
      `romance_ba` for b→a. Read agent rows the function already has (add fields to its input type if
      needed; keep callers compiling).
- [ ] Tests: straight man/straight man positive flirting chat → romance delta 0; friendship unchanged.
      Minor involved → romance 0. High chemistry pair gains more than low.
- [ ] check → commit `feat(intimacy): chemistry and orientation shape romance`.

### Task 4: Shared beds + affair-detection bug fixes

**Files:** Modify `server/data/interiors.ts` (home `bed.maxOccupants: 2`), `server/lib/conversationBeats.ts`
(`reactToPartnerAffair`), `server/lib/cascade/rippleRules.ts` (`affair_heartbreak` match); Tests extend
`affairSensitivity.test.ts` / new `partnerAffair.test.ts`, `rippleRules.test.ts`.

- [ ] Married couples currently sleep one in bed and one on the floor (`bed.maxOccupants: 1`,
      `interiorGrid.ts` fallback). Set home bed capacity 2; test with `findAvailableZone` that two
      residents of one home both get the bed zone.
- [ ] `reactToPartnerAffair` only checks facts whose *subject* is the partner; also match facts whose
      *target* is the partner (and exclude facts where the discoverer is a party). Test both directions.
- [ ] Quiet-breakup branch leaves the `partner` tag until the next `updateTags`: strip it in the same
      write. Test.
- [ ] `affair_heartbreak` matches content containing "affair"/"cheating", but generated affair content is
      "are getting suspiciously close" — match on `fact.type === 'affair'` (look at the event payload
      for the type; add it to the `gossip:learned` emit if missing). Test the rule fires on an affair fact.
- [ ] check → commit `fix(romance): couples share a bed and affairs are noticed both ways`.

## Phase 1 — Kisses (always on, PG)

### Task 5: Intimacy state, longing, snapshot and tick wiring

**Files:** Create `server/lib/intimacy/state.ts`, `longing.ts`, `index.ts`; Modify
`server/engine/worldCaches.ts`, `server/engine/tick.ts` (`runGuarded` block like `milestonesTick`),
`server/index.ts` (side-effect import); Tests `state.test.ts`, `longing.test.ts`.

- [ ] `PairIntimacy { firstKissAt?, lastKissAt?, kisses: number, trysts: number, lastTrystAt?,
      firstTrystAt?, pendingRendezvous?: { initiatorId, since, venueId? }, rendezvousRetryAfter?,
      secret: boolean }` keyed by `pairKey` (reuse `pairKey` from milestonesEngine — move it to
      `server/lib/utils.ts` or import it).
- [ ] `AgentIntimacy { longing: number (0..100), lastTouchedAt? , suspicion: Record<partnerId, number> }`.
- [ ] `intimacySnapshotStore` (key `intimacy`, version 1) with tolerant `restore` (copy the
      milestones pattern); `clearIntimacy()`; register both in `worldCaches.ts`.
- [ ] `longing.ts`: `growLonging(agent, hours, ctx)` = `hours * 0.9 * (sensuality/50) * (infatuated ? 1.5 : 1)`,
      capped 100; `0` growth and value forced 0 for under-18 or when `adultContent` is off.
      `relieveLonging(agentId, amount)`. Hourly pass in `intimacyTick` (game-time based: remember last
      processed minute; apply elapsed hours).
- [ ] `intimacyTick(now: ClockTime)` every 10 game minutes (mirror milestones cadence); for now only
      longing. Guard with `runGuarded`.
- [ ] Tests: snapshot round-trip; growth scales with sensuality; adultContent off → stays 0; minor → 0;
      world replace clears.
- [ ] check → commit `feat(intimacy): per-pair intimacy state and longing`.

### Task 6: The kiss

**Files:** Create `server/lib/intimacy/kiss.ts`; Modify `server/lib/intimacy/index.ts` (listen to
`conversation:ended`), `server/data/dramaBeats.ts` (`kiss`, `kiss_rebuffed`), `server/data/activityRegistry.ts`
if a new type is needed (prefer `drama` rows with `metadata.beat`), `server/lib/storyBeats.ts`
(`ROMANTIC_EVENTS` += `kiss`, `tryst`), `server/lib/simEvents.ts` doc; Test `kiss.test.ts`.

- [ ] Pure `kissChance(ctx)`: requires `isIntimacyEligible`, sentiment > 0.3, both romance ≥ 45
      (initiator) — initiator = higher romance side. Base 0.30 first kiss, 0.55 once `kissed`;
      ×1.5 on date (evening + romance>30 topic), ×1.3 during `romance_boost` world events,
      ×0.3 if a third agent is co-located (privacy) unless impulsiveness > 70, 0 if either is
      in `heartbroken|grieving|sick|arrested`, 0 if already kissed this game day.
- [ ] Rebuff: if the receiver's romance toward initiator < 30 → `kiss_rebuffed`: initiator mood −10
      (4 h), romance −5 both ways, `drama` row beat `kiss_rebuffed` importance 0.55.
- [ ] Success effects: tag `kissed` (sticky; confirm `updateTags` keeps unknown tags, add to static list
      if needed), `relationship_events` row `event_type: 'kiss'` (+6/+6 romance first time, +2 after),
      first kiss → `life:milestone` for both ("I kissed {other} for the first time."), `drama` row beat
      `kiss` importance 0.7 first / 0.3 routine (`newsworthy: false` for routine), emit `intimacy:kiss`,
      `relieveLonging` 10, bump `PairIntimacy`.
- [ ] If either is spoken for (`isSpokenFor(id, except other)`) → `createFact('affair', …)` with
      `affairSensitivity` (4 if married), `known_by` = the two + co-located witnesses, source `observed`.
- [ ] Deterministic tests with an injected rng: eligible pair kisses; minor never (even rng=0);
      same-gender straight pair never; witness makes the affair fact known to them; rebuff path.
- [ ] check → commit `feat(intimacy): first kisses and rebuffs`.

### Task 7: Witnesses and rumours for kisses

**Files:** Modify `server/lib/cascade/WitnessAmplifier.ts` (phrase table), `server/lib/gossip.ts`
(`FACT_GENERATORS` `kiss_seen`, `tryst_seen`; add to `NEGATIVE_FACT_TYPES` when an affair),
`server/lib/intimacy/kiss.ts`; Test `witnessKiss.test.ts`.

- [ ] On `intimacy:kiss` with witnesses and the pair **not** openly together (not `partners`/married
      to each other): each witness gets a `kiss_seen` fact (sensitivity 2, 3 if one is spoken for,
      4 if married) "{a} was seen kissing {b}". Openly together couples kissing → no fact (nobody cares).
- [ ] Gossip spreads it through the existing engine; `PARTICIPANT_TARGET_TYPES` includes `kiss_seen`
      so the lovers don't gossip about themselves.
- [ ] Test: witness learns, participants don't create gossip about themselves, married → sens 4.
- [ ] check → commit `feat(intimacy): a stolen kiss can be seen`.

## Phase 2 — The adult layer (runs only when `adultContent`)

### Task 8: Rendezvous invitation and consent

**Files:** Create `server/lib/intimacy/rendezvous.ts`; Modify `server/ai/prompts.ts`
(`RENDEZVOUS_TOPIC`, `topicIntent`, exempt it from the "be flirty" push like `PROPOSAL_TOPIC` so a no is
possible), `server/ai/llmMetrics.ts` (`'intimacy.consent'`), `server/engine/systems/decisions.ts`
(seek tier at 6300, below proposal 6400, same `canSeekPartner` guards); Tests `rendezvous.test.ts`,
`consent.test.ts`.

- [ ] Candidate pairs in `intimacyTick` (evening 19–23 h, adultContent on): eligible, `kissed`, both
      romance ≥ 60, both trust ≥ 25, not in not-now states, no pending, past `rendezvousRetryAfter`,
      initiator longing ≥ 55 (married/partner pairs: ≥ 40). Initiator = higher longing.
- [ ] `willingness(self, other, ctx)` 0..1 pure: romance/100 * 0.5 + trust/100 * 0.2 + longing/100 * 0.3,
      − 0.35 if self is spoken for to someone else × (loyalty+morality)/200, − 0.2 if other is married
      to someone else × morality/100, + 0.15 impulsiveness>70; married/partnered to each other +0.25.
      Initiator only invites when willingness ≥ 0.55.
- [ ] Married couples at home together in the evening skip the conversation: direct tryst (Task 9) when
      both willingness ≥ 0.5 — they don't need to ask formally.
- [ ] Everyone else: `pendingRendezvous` + seek decision → when co-located queue an `llm_deep`
      conversation with `topic: RENDEZVOUS_TOPIC` at `PROPOSAL_QUEUE_PRIORITY`-style protected priority
      (copy `queueProposal`).
- [ ] On that conversation's end: `decideConsent(transcript, answerer, willingness)`:
      1) structured LLM call `purpose: 'intimacy.consent'`, `format` `{accepted: boolean, reason: string(≤120)}`,
      priority normal, reading only the last 4 lines; 2) fallback regex (reuse `YES_WORDS`/`NO_WORDS`
      pattern from milestones); 3) fallback rule `willingness(answerer) ≥ 0.5`. The answerer's rule-based
      willingness < 0.25 **overrides** an LLM yes (the LLM cannot make someone consent against character).
- [ ] Refusal: initiator mood −8, `rendezvousRetryAfter` +2 days, no feed row unless watched.
      Accept: choose venue (Task 9) → `pendingRendezvous.venueId`.
- [ ] Tests: minors never become candidates; willingness truth points; consent override; retry lock;
      adultContent off → no candidates.
- [ ] check → commit `feat(intimacy): lovers ask, and can be told no`.

### Task 9: The tryst — venue, meeting, night, dawn

**Files:** Create `server/lib/intimacy/tryst.ts`; Modify `decisions.ts` (tryst tier 6350: go to
venue; sleep-target override), `server/engine/systems/movement.ts` only if arrival hooks are needed,
`server/lib/zoneActions.ts` (`tryst` verb effects), `server/data/interiors.ts` (home `bed` accepts
`tryst`; barn `hookup` and grove `secret_meeting` zones accept `tryst`), `dramaBeats.ts` (`tryst`,
`caught`); Test `tryst.test.ts`.

- [ ] `pickVenue(pair)`: initiator's home if no other resident is home or expected (spouse/housemate);
      else partner's home likewise; else the barn `hookup` zone or a park grove (outdoor, riskier,
      only if weather isn't rain/snow and it is dark); else fail → retry tomorrow.
- [ ] Both agents get a 6350 decision to walk to the venue; when both present → both
      `current_action = { type: 'idle', zoneActivity: 'tryst', partnerId }` for 60–90 game min
      (`ACTION_MIN_DURATIONS` entry or duration field — follow how zone verbs set durations).
- [ ] Home venue: afterwards the guest sleeps there: `sleepTargetFor(agentId)` returns the venue for
      tonight; the sleeping validation at decisions.ts:~1869 must accept it. Outdoor venue: both go home.
- [ ] Dawn: guest wakes and walks home with `zoneActivity: 'sneak_home'` (client shows the `shifty` pose).
      Any non-participant within the venue's location or 96 px on the way within the first 30 min →
      `intimacy:caught` + `tryst_seen` fact (sens 3; 4 if either married to a third), beat `caught`.
      Outdoor trysts: witness check at start as well (higher base risk).
- [ ] Feed: beat `tryst` row, discreet text: "{a} and {b} spent the evening together at {venue}."
      importance 0.5, `newsworthy: false`. Never more explicit than that.
- [ ] Interruptions: a spouse/housemate arriving at a home venue during `tryst` → `caught` with the
      arriving agent as witness, the guest leaves immediately, the arriving agent's reaction goes through
      the existing affair-discovery path if they are the betrayed partner.
- [ ] Tests: venue selection (spouse home blocks), both-present start, sleepover target, dawn witness
      creates fact, outdoor rain → no venue, minors impossible (construct directly and assert throw/false).
- [ ] check → commit `feat(intimacy): lovers spend the night`.

### Task 10: Consequences — states, memories, tags, affairs from acts

**Files:** Modify `server/lib/states.ts` (`afterglow`, `guilty`, `suspicious` definitions with prompt
lines), `server/engine/systems/states.ts` (exits), `server/lib/intimacy/tryst.ts`; Test `trystConsequences.test.ts`.

- [ ] After a tryst: tag `lovers`; `relationship_events` `event_type: 'tryst'` +5/+5 romance, +3 trust;
      `relieveLonging` to 10; `afterglow` state 8 game h (prompt: "You are still glowing from last night
      with {name}; you catch yourself smiling."); memory via `life:milestone` ("I spent the night with
      {name}." first time importance high; later ones lower).
- [ ] Cheating: if either is spoken for to a third → `affair` fact from the act (sens 4 if married),
      known_by the two; morality > 60 → `guilty` state 24 h (prompt: "You betrayed {spouse}. Every kind
      word from them cuts."). Pair `secret = true` whenever either is spoken for or the pair is same-sex
      (1900: such love is hidden; facts get +1 sensitivity).
- [ ] Same-sex couples in 1900: milestones proposals are gated to opposite-sex pairs; same-sex lovers
      stay `partners` but secret (document why in a comment). Test.
- [ ] check → commit `feat(intimacy): what a night leaves behind`.

### Task 11: Suspicion and confrontation

**Files:** Create `server/lib/intimacy/suspicion.ts`; Modify `index.ts`; Test `suspicion.test.ts`.

- [ ] Each morning pass: for every agent whose spouse/partner slept away from home without a known
      reason (tryst guest), suspicion += 1 (+1 more if the partner has `afterglow` and the observer's
      curiosity > 60). Suspicion ≥ 2 → `suspicious` state targeting the partner and a queued `llm_deep`
      confrontation with topic "where you were last night" (use the existing situational prompt path for
      jealousy confrontations). Learning an affair fact resets suspicion (it's knowledge now).
- [ ] Confrontation outcome reuses sentiment → big negative → existing `reactToPartnerAffair`-style
      branches (make that function reusable if needed).
- [ ] Tests: two absences → suspicious + confrontation queued; partners-only (not strangers); reset on fact.
- [ ] check → commit `feat(intimacy): partners notice empty beds`.

### Task 12: Unwed pregnancy and the 1900 scandal

**Files:** Create `server/lib/intimacy/pregnancy.ts`; Modify `server/lib/family.ts` (accept unmarried
parents; keep married path unchanged), `milestonesEngine.ts` (export a `queueShotgunProposal`),
`gossip.ts` (`illegitimate_pregnancy`); Tests `unwedPregnancy.test.ts`, extend `family.test.ts`.

- [ ] Conception roll per tryst (not per day): male-female pair, mother 18–44, not already pregnant,
      max children rule from family.ts, chance 0.06 (married trysts use the existing daily roll — don't
      double count: skip this roll when married to each other).
- [ ] Pregnancy fact private (sens 3), known by mother; after 2 game days she tells the father.
      Father's response (pure function of loyalty, morality, romance, spoken-for): **marry** →
      `queueShotgunProposal` (skips the 4–7 day wait) / **deny** → mother heartbroken, father `guilty`
      if morality > 50. After 4 game days she is "showing": `illegitimate_pregnancy` fact becomes known to
      co-located agents (sens 3) → gossip; high-morality agents (morality > 70) lose 10 friendship with
      mother (and father once named); beat `scandal`. A wedding before "showing" cancels the scandal.
- [ ] Birth goes through family.ts; `children.father_id` set to the father (null if denied → `true_father_id`).
- [ ] Tests: no conception for same-sex, for mother 45+, for minors; shotgun path; scandal path; married
      unaffected.
- [ ] check → commit `feat(intimacy): an unwed pregnancy is a scandal in 1900`.

### Task 13: Wandering eye

**Files:** Modify `server/lib/intimacy/attraction.ts`, `relationshipImpact.ts`, `decisions.ts` (social
scoring); Test `wanderingEye.test.ts`.

- [ ] Neglect = spoken-for agent whose last tryst with their partner is > 4 game days ago (or never after
      marriage) and longing ≥ 70. Neglected + loyalty < 50 → romance gain toward *others* ×1.5 and the
      social decision score toward attractive (chemistry ≥ 1.1) others +20. Longing ≥ 60 raises social
      score toward own partner/lover by `longing/3` in the evening.
- [ ] Tests: faithful (loyalty 80) unaffected; neglected low-loyalty gets the multiplier; adultContent off
      → no effect.
- [ ] check → commit `feat(intimacy): neglect makes eyes wander`.

## Phase 3 — LLM

### Task 14: Maturity directive and intimacy context in prompts

**Files:** Create `server/ai/contentRating.ts`, `server/ai/intimacyContext.ts`; Modify `server/ai/prompts.ts`
(`buildAgentSystemPrompt` header, `buildRelationshipTag`), `server/lib/memory/conversationSummary.ts`,
`server/lib/planning/planPrompts.ts`; Tests `contentRating.test.ts`, `intimacyContext.test.ts`,
extend `prompts.test.ts`.

- [ ] `maturityDirective(adult: boolean)`:
      - adult: "This is a story for adults. People here feel desire, jealousy and temptation and may talk
        about them as folk of 1900 would — veiled, teasing or blunt, as fits the speaker. Physical intimacy
        always happens off-stage: never describe it. Nothing romantic or sexual ever involves anyone under 18."
      - off: "Romance stays chaste: glances, courting, holding hands, a kiss at most."
- [ ] Appended once in the system header (after `TOWN_SETTING`), in the summary prompt and plan prompts.
- [ ] `intimacyLines(self, other, pair, agentState)` → at most 2 short lines, e.g. "You have kissed {name}."
      / "You and {name} are lovers; nobody may know." / "You are married to {spouse}; if this came out it
      would ruin you." / "You ache for {name}." (longing ≥ 70, adult only) / "You feel guilty toward {spouse}."
      Included by `buildRelationshipTag`. Never mentions acts beyond "lovers"/"spent the night".
- [ ] Tests: directive switches with the rule; lines never appear for minors; secret line only when secret.
- [ ] check → commit `feat(ai): an adult tone and what lovers know`.

## Phase 4 — Visuals (suggestive, non-explicit)

Server contract is locked above, so these can proceed in parallel with Phase 2 on a worktree.

### Task 15: Emotes `blush`, `kiss`, `wink`

**Files:** `src/components/canvas/emoteFrames.ts` (append to `SPEC`, fallbacks 😊 💋 😉),
`scripts/aseprite/emotes.lua` (ORDER line + ASCII frames, 3 frames each), regenerate
`public/sprites/fx/emotes.png` with Aseprite (`D:\SteamLibrary\steamapps\common\Aseprite\Aseprite.exe -b
--script-param dir=public/sprites/fx --script scripts/aseprite/emotes.lua`), `BubbleSystem.ts`
`STATE_EMOTES` (`afterglow: 'blush'`, `guilty: 'sweat'` or existing), test `emoteFrames.test.ts` passes.
- [ ] Commit `feat(canvas): blush, kiss and wink emotes`.

### Task 16: Kiss beat

**Files:** `server/data/dramaBeats.ts` (kind mapping), `src/components/canvas/systems/beats/beatDetect.ts`
(`BeatKind` += `kiss`), `beatFrames.ts` (`FxName` `kiss`, `FX_ANIMS`, `BEATS_FRAME_COUNT`, `BEAT_STYLE.kiss =
{ fx:'kiss', lift: 20, emotes:['kiss','blush'] }`), `scripts/aseprite/beat-fx.lua` (5 cells: two small hearts
rising from a point, a pop), regenerate `beats.png`; `BeatSystem.ts`: on `kiss`, face both sprites toward
each other and apply a 1.2 s `lean` activity pose toward the midpoint; tests `beatFrames.test.ts`, a
`beatDetect` case for `metadata.beat:'kiss'`.
- [ ] Commit `feat(canvas): a kiss you can see`.

### Task 17: Couples walk together

**Files:** Create `src/components/canvas/systems/couples/CoupleSystem.ts` (+ pure helper
`couplePairs.ts` + test), register in `systems/index.ts`.
- [ ] Pure: open couples = relationship rows with `married`/`engaged`/`partner` tags; `lovers` only if not
      secret (the client can't know secrecy → only show hand-holding for married/engaged/partners; secret
      lovers keep distance in public — that's the realism).
- [ ] When both walking within 48 px and same direction: cosmetic render offset pulling them ~6 px closer,
      a 2-px hand-link drawn between them in `ground` layer; idle together within 40 px → face each other;
      a heart emote at most once per 25 s per pair. Infatuated agent near their target: faces them
      (glance) every few seconds. Pooled graphics, no allocation in `update`.
- [ ] Commit `feat(canvas): couples walk hand in hand`.

### Task 18: Lights out, curtains, lamp turned down

**Files:** `src/components/canvas/LightingSystem.ts` (occupants vs awake occupants; pass
`current_action` through in `GameCanvas.tsx:~630`), create `systems/curtains/CurtainSystem.ts`
(export `southWindowXs` from `BuildingRenderer.ts` if needed).
- [ ] Home window glow at night only if some occupant is awake; a home with an agent in `zoneActivity:
      'tryst'` shows a dim warm "lamp turned down" glow (≈30%) instead, fading to dark when they sleep.
- [ ] CurtainSystem draws drawn curtains (two pixel panels) over the south windows of a home hosting a
      `tryst`, animating closed over ~1 s.
- [ ] Pure helper `homeLightLevel(occupantActions)` with a test.
- [ ] Commit `feat(canvas): the lamp is turned down`.

### Task 19: Tryst & sneak-home activity visuals, heart particle

**Files:** `src/components/canvas/systems/activityFx/activity.ts` (`ZONE_ACTIVITY` += `tryst`, `sneak_home`),
`activitySpecs.ts` (`tryst`: heart particle emitter low rate, `sneak_home`: `shifty` pose), `activityFrames.ts`
+ `scripts/aseprite/activity-fx.lua` (`heart` 16×16 particle, regenerate), `src/lib/actionText.ts`
("spending the evening with {name}" / "slipping home"), tests for the fold.
- [ ] Commit `feat(canvas): lovers' evenings and dawn walks`.

### Task 20: Smitten portraits

**Files:** `src/components/ui/portraitMood.ts` (`smitten`: `afterglow` or `infatuated`), `src/lib/residentArt/portrait.ts`
(cheek blush pixels + happy mouth), `scripts/aseprite/portrait-moods.lua` (`smitten` entry adding blush),
regenerate the 13 `_portrait_smitten.png`, tests `portraitMood.test.ts`, `residentPortrait.test.ts`.
- [ ] Commit `feat(ui): smitten portraits blush`.

### Task 21: Fade to black

**Files:** Create `src/components/ui/FadeToBlack.tsx` (+ pure `fadeTrigger.ts` + test), mount in `App.tsx`.
- [ ] When a `drama` row with beat `tryst` arrives whose initiator/target is the selected or favourite agent:
      2.5 s ease to 88% black vignette with one italic line ("The lamp at {venue} is turned down.") then
      ease back. Setting "Cinematic moments" (localStorage, try/catch, default on). Never fires for old rows.
- [ ] Commit `feat(ui): the camera looks away`.

## Phase 5 — UI

### Task 22: Hearts ledger

**Files:** Create `server/routers/intimacy.ts` (`getLedger`), register in `server/router.ts`, subscription
wiring (reuse the relationships channel for invalidation), create `src/components/ui/RomanceLedger.tsx`,
toolbar button in `FloatingToolbar.tsx`, modal state + Escape handling in `App.tsx`; tests for the ledger
builder (pure function in `server/lib/intimacy/ledger.ts`).
- [ ] Ledger sections: Couples (married/engaged/partners), Lovers (secret badge), Longing (bars, adult
      only), Crushes (one-sided romance > 40), Scandals (known public facts), recent intimate milestones.
      Minors never listed in any romance section. God-view: the player sees secrets.
- [ ] Commit `feat(ui): the Hearts ledger`.

### Task 23: Pair dossier intimacy + rendezvous nudge

**Files:** `server/lib/pairDossier.ts` (first kiss, kisses, trysts, secret), `PairDossier.tsx` rows and
`EVENT_LOOK` for `kiss`/`tryst`; `server/routers/nudge.ts` new nudge `arrange_rendezvous` (adult only,
eligibility enforced, queues the Task 8 conversation; the partner can still refuse), second-person player
feed row; client nudge button where pair nudges live.
- [ ] Tests: nudge rejected for minors and when adultContent off; dossier fields.
- [ ] Commit `feat(ui): arrange a rendezvous and read the pair's history`.

## Phase 6 — Verification

### Task 24: Soak, live check, docs

- [ ] `npm run soak -- --days 3 --db data/verify.db` after copying the live DB to `data/verify.db*`, with
      `adultContent` forced on in the copy (`rule_overrides`). Report kisses/trysts/facts per day; expect
      some kisses, a few trysts, no minors anywhere (SQL check on `relationship_events` joined to ages).
- [ ] `npx tsx scripts/llm-smoke.ts` (consent prompt added to smoke if the script lists prompts).
- [ ] `preview_start little-life-verify`, screenshot a kiss beat, couple walking, lights-out home.
- [ ] Update `docs/STATUS.md` (area row, open issues, test count), commit `docs(status): intimacy realism`.
