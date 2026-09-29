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
import { resetCliqueCache } from '../lib/cliques';
import { goalReviewer, pivotEvaluator } from '../lib/goals/instance';
import { planLLMGate, planLLMQueue } from '../lib/planning/instance';
import { resetConversationPacing } from '../lib/conversationPacing';
import { clearPerceptionDedup } from '../lib/memory/MemoryObserver';

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
  resetCliqueCache();
}
