/**
 * Per-world module cache reset.
 *
 * A number of engine and lib modules keep module-level `Map`s keyed by agent id
 * holding either tick values or derived per-agent data. Neither survives a world
 * replace correctly:
 *
 *   - `totalTicks` restarts at 0, so a surviving tick stamp sits in the future
 *     and every `currentTick - stamp` comparison goes negative. Cooldowns and
 *     duration gates guarded by those comparisons then never fire again.
 *   - SQLite reuses rowids after a DELETE, so a brand-new agent inherits the
 *     previous world's data for the same id (drift baselines, hobby skills,
 *     reputation, favors, secrets, mood momentum, ...).
 *
 * `setup.replaceWorld` and `setup.resetToWizard` must call this. It is
 * deliberately a single flat function rather than a registry: adding a new
 * per-agent module cache means adding one line here, and that line is the only
 * thing a reviewer has to look for.
 *
 * Note: this does NOT reset the `initialized` flags that guard one-time
 * `simEvents.on(...)` registration in several of these modules. Those listeners
 * must stay registered exactly once for the lifetime of the process.
 *
 * The other half of the lifecycle lives here too: `PERSISTED_STORES` lists the
 * caches that are gameplay state rather than derived data, and are checkpointed
 * to `sim_snapshots` so they survive a server restart (see simSnapshots.ts).
 * A store in that list must also be cleared on a world replace (here, or for
 * tension by `resetCascade`), and `restoreWorldCaches` must run after every clear — it loads the rows of
 * whichever world the DB now holds (none for a fresh world, the old world's on
 * a rolled-back replace).
 */

import { clearStatesTrackers } from './systems/states';
import { clearCriticalNeedFired, clearConsecutiveWorkMinutes } from './systems/needs';
import { clearMilestoneTracking, clearPurchaseTracking, resetMoneySupplyState } from './systems/economy';
import { clearWorkSkipCounts, clearDateAnnouncements } from './systems/decisions';
import { clearLonelinessTracking } from '../lib/lonelinessEngine';
import { clearGiftTracking } from '../lib/giftEngine';
import { clearTavernTracking } from '../lib/tavernEngine';
import { clearAgingTracking } from '../lib/agingEngine';
import { clearPersonalityBaselines } from '../lib/personalityDrift';
import { clearHobbySkills } from '../lib/hobbyEngine';
import { clearReputationCache } from '../lib/reputationEngine';
import { clearFavorLedger } from '../lib/favorEngine';
import { clearSharedSecrets } from '../lib/secretSharing';
import { clearPlayerOutcomes } from '../lib/playerOutcomes';
import { clearMoodTrackers } from '../lib/moodMomentum';
import { clearAllConversationCaches } from '../helpers/conversationHelpers';
import { clearConfrontationCooldowns } from '../lib/confrontationEngine';
import { clearHungerTracking } from '../lib/lifeEventsEngine';
import { resetChronicleCache } from '../lib/chronicle';
import { resetBrewingCache } from '../lib/brewing';
import { resetCliqueCache } from '../lib/cliques';
import { goalReviewer, pivotEvaluator } from '../lib/goals/instance';
import { planLLMGate, planLLMQueue } from '../lib/planning/instance';
import { resetConversationPacing } from '../lib/conversationPacing';
import { clearSpotlight } from '../lib/spotlight';
import { nightSkip } from './nightSkip';
import { clearPerceptionDedup } from '../lib/memory/MemoryObserver';
import { clearRulesCache } from '../lib/worldRules';
import { clearTopicMemory } from '../lib/topicMemory';
import { clearTownTemplates } from '../lib/templateVariety';
import { loadAutoplayConfig } from '../lib/autoplaySettings';
import { statesTrackersSnapshotStore } from './systems/states';
import { hobbySnapshotStore } from '../lib/hobbyEngine';
import { favorSnapshotStore } from '../lib/favorEngine';
import { moodMomentumSnapshotStore } from '../lib/moodMomentum';
import { personalityBaselineSnapshotStore } from '../lib/personalityDrift';
import { hungerSnapshotStore } from '../lib/lifeEventsEngine';
import { tensionSnapshotStore } from '../lib/cascade';
import { clearMilestones, milestonesSnapshotStore } from '../lib/milestonesEngine';
import { clearPopulationFlow, populationFlowSnapshotStore } from '../lib/populationFlow';
import { clearVacancies } from '../lib/vacancies';
import { clearFamilyState, familySnapshotStore } from '../lib/familyState';
import { loadSnapshots, saveSnapshots } from './simSnapshots';
import type { SnapshotStore } from './snapshotCodec';

/**
 * In-memory stores that outlive a restart. What is in and what is out:
 *
 * In — slow, earned state a player would notice resetting: hobby skills (game
 * weeks of practice), the favor ledger, tension toward a snap, mood momentum
 * streaks, personality drift baselines (without them the ±15 drift cap
 * re-anchors on every restart), the states-phase trackers (multi-day addiction
 * and debt histories), the starvation counters, and the life-milestone timers
 * (an engaged couple's wedding day, a refused suitor's wait, a pending
 * proposal — the `engaged`/`married` tags themselves are in the DB), and the
 * population flow's timers (who is thinking of leaving, who sets off in the
 * morning, when the last stranger arrived — without them a restart could send
 * two newcomers on consecutive days or forget a leaver halfway down the road),
 * and the family timers (a baby on the way, when a couple married, a
 * christening waiting for daylight, a husband looking for his wife's lover —
 * the children themselves are in the `children` table).
 *
 * Out, deliberately:
 *   - LLM backoffs (`planLLMGate`, goal reviewer/pivot stamps): they describe
 *     the previous process's LLM, and a restart is very often the fix for
 *     whatever made it fail. Persisting them would keep agents off the LLM
 *     after the problem is gone. They expire in game minutes anyway.
 *   - Short cooldowns and dedupe sets (gifts, confrontations, loneliness,
 *     taverns, critical-need edges, conversation caches, perception dedup,
 *     ripple cooldowns, work streaks, milestones): hour-scale throttles whose
 *     loss lets at most one extra event through right after a restart.
 *   - Derived caches (reputation, chronicle, cliques, money balancer): rebuilt
 *     from tables.
 *   - Shared-secret bookkeeping and birthday stamps: the facts table already
 *     dedupes a confided secret per pair, and a restart on a birthday is rare.
 */
const PERSISTED_STORES: readonly SnapshotStore[] = [
  hobbySnapshotStore,
  favorSnapshotStore,
  tensionSnapshotStore,
  moodMomentumSnapshotStore,
  personalityBaselineSnapshotStore,
  statesTrackersSnapshotStore,
  hungerSnapshotStore,
  milestonesSnapshotStore,
  populationFlowSnapshotStore,
  familySnapshotStore,
];

/** Checkpoint every persisted store for the current world. Never throws. */
export function saveWorldCaches(): number {
  return saveSnapshots(PERSISTED_STORES);
}

/**
 * Load every persisted store from the current world's checkpoint. Call it at
 * boot, after `initCascade`, and right after every `clearPerWorldCaches`.
 * Never throws.
 */
export function restoreWorldCaches(): number {
  // Not a snapshot store, but it has the same lifecycle: the autoplay config is
  // per world, so it is reloaded from the world row at boot and after every
  // swap (a new world falls back to the defaults).
  loadAutoplayConfig();
  return loadSnapshots(PERSISTED_STORES);
}

/** Store keys, for tests (uniqueness, coverage). */
export function persistedStoreKeys(): string[] {
  return PERSISTED_STORES.map((s) => s.key);
}

export function clearPerWorldCaches(): void {
  // Game-minute stamps of recently stored perception lines (MemoryObserver).
  clearPerceptionDedup();
  // The resolved world rules (wizard + Storyteller overrides). The new world
  // row carries its own setup_config and no overrides; without this the old
  // town's drama and sickness settings would keep ruling the new one until the
  // server restarted.
  clearRulesCache();
  // What each resident talked about today (game-minute stamps, agent ids).
  clearTopicMemory();
  // Template chats heard town-wide this game hour (lib/templateVariety.ts).
  clearTownTemplates();
  // Tick-valued trackers
  clearStatesTrackers();
  clearLonelinessTracking();
  clearGiftTracking();
  clearTavernTracking();
  clearAgingTracking();
  // Keyed on `action_started`: a stale entry could match a new world's action
  // and silently skip that agent's first meal/shopping purchase.
  clearPurchaseTracking();
  // Goal-system singletons. Both compare a stored game-minute stamp against the
  // clock; a replaced world can start earlier, the difference goes negative and
  // the guard never opens again,
  // which silently disables goal pivoting, stale-goal abandonment, and agent-name
  // refresh in goal-review prompts.
  pivotEvaluator.clear();
  goalReviewer.clear();
  // Planning LLM backoff is stamped in absolute game minutes, and the clock
  // restarts at day 1 after a replace: a surviving stamp would keep that agent
  // id from asking the LLM for days of game time. Clearing also bumps the
  // gate's world epoch, so plan/decompose/replan jobs still awaiting the LLM
  // drop their results instead of writing them onto a new agent with the same
  // rowid. The queue's dedupe keys go too, or a request stuck in flight from
  // the old world would block that new agent. (setup.ts also clears the queue
  // directly; doing it twice is harmless.) Replan cooldowns are game minutes
  // as well and are cleared by setup.ts via replanEvaluator.clear().
  planLLMGate.clear();
  planLLMQueue.clear();

  // Per-agent identity-bound caches
  clearPersonalityBaselines();
  clearHobbySkills();
  clearReputationCache();
  clearFavorLedger();
  clearSharedSecrets();
  // Conversation / fact / relationship-event ids the outcome reporter is
  // waiting on or has reported: rowids restart with a new world.
  clearPlayerOutcomes();
  clearMoodTrackers();
  clearCriticalNeedFired();
  clearConsecutiveWorkMinutes();
  clearHungerTracking();
  clearMilestoneTracking();
  // Proposal/engagement timers keyed on agent-id pairs (lib/milestonesEngine.ts).
  clearMilestones();
  // Leavers, thinkers and arrival timers: agent ids and game minutes of the old town.
  clearPopulationFlow();
  // Posted trades and planned career moves (lib/vacancies.ts).
  clearVacancies();
  // Pregnancies, marriage clocks, christenings: agent/child ids of the old town.
  clearFamilyState();
  clearWorkSkipCounts();
  // Game-minute stamps keyed on agent-id pairs: both restart with a new world.
  clearDateAnnouncements();
  // The balancer's multipliers were measured on the old world's money: a
  // replaced rich town would start the new one with its savings pulled hard.
  resetMoneySupplyState();

  // Caches keyed on conversation/agent id pairs. Both id spaces restart at 1 after
  // the wipe, and neither is evicted by the normal completion paths when a world
  // replace abandons the work in flight.
  clearAllConversationCaches();
  clearConfrontationCooldowns();
  // Turn-latency samples and the probe stamp are game-minute stamped; a new
  // world's clock can start earlier, and old samples belong to a different town.
  resetConversationPacing();
  // Who the player is watching is a set of agent ids, and rowids restart with
  // the new world: a stale spotlight would hand the old town's favourites'
  // id-twins the LLM budget until the client's next refresh.
  clearSpotlight();

  // A skip in progress belongs to the old town (its target is an absolute game
  // minute of the old clock, its sleepers are old agent ids). The new world has
  // its own tick_speed already.
  nightSkip.reset();

  // Wall-clock memos over the whole town. Without a reset the first seconds of a
  // new world showed the previous world's story arcs and cliques.
  resetChronicleCache();
  resetBrewingCache();
  resetCliqueCache();
}
