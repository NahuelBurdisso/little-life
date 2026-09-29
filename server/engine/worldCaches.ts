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
import { clearWorkSkipCounts } from './systems/decisions';
import { clearLonelinessTracking } from '../lib/lonelinessEngine';
import { clearGiftTracking } from '../lib/giftEngine';
import { clearTavernTracking } from '../lib/tavernEngine';
import { clearAgingTracking } from '../lib/agingEngine';
import { clearPersonalityBaselines } from '../lib/personalityDrift';
import { clearHobbySkills } from '../lib/hobbyEngine';
import { clearReputationCache } from '../lib/reputationEngine';
import { clearFavorLedger } from '../lib/favorEngine';
import { clearSharedSecrets } from '../lib/secretSharing';
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
import { clearPerceptionDedup } from '../lib/memory/MemoryObserver';
import { statesTrackersSnapshotStore } from './systems/states';
import { hobbySnapshotStore } from '../lib/hobbyEngine';
import { favorSnapshotStore } from '../lib/favorEngine';
import { moodMomentumSnapshotStore } from '../lib/moodMomentum';
import { personalityBaselineSnapshotStore } from '../lib/personalityDrift';
import { hungerSnapshotStore } from '../lib/lifeEventsEngine';
import { tensionSnapshotStore } from '../lib/cascade';
import { loadSnapshots, saveSnapshots } from './simSnapshots';
import type { SnapshotStore } from './snapshotCodec';

/**
 * In-memory stores that outlive a restart. What is in and what is out:
 *
 * In — slow, earned state a player would notice resetting: hobby skills (game
 * weeks of practice), the favor ledger, tension toward a snap, mood momentum
 * streaks, personality drift baselines (without them the ±15 drift cap
 * re-anchors on every restart), the states-phase trackers (multi-day addiction
 * and debt histories) and the starvation counters.
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
  return loadSnapshots(PERSISTED_STORES);
}

/** Store keys, for tests (uniqueness, coverage). */
export function persistedStoreKeys(): string[] {
  return PERSISTED_STORES.map((s) => s.key);
}

export function clearPerWorldCaches(): void {
  // Game-minute stamps of recently stored perception lines (MemoryObserver).
  clearPerceptionDedup();
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
  clearMoodTrackers();
  clearCriticalNeedFired();
  clearConsecutiveWorkMinutes();
  clearHungerTracking();
  clearMilestoneTracking();
  clearWorkSkipCounts();
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

  // Wall-clock memos over the whole town. Without a reset the first seconds of a
  // new world showed the previous world's story arcs and cliques.
  resetChronicleCache();
  resetBrewingCache();
  resetCliqueCache();
}
