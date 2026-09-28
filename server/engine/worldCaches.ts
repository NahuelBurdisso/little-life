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
import { clearCriticalNeedFired, clearConsecutiveWorkTicks } from './systems/needs';
import { clearMilestoneTracking } from './systems/economy';
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

export function clearPerWorldCaches(): void {
  // Tick-valued trackers
  clearStatesTrackers();
  clearLonelinessTracking();
  clearGiftTracking();
  clearTavernTracking();
  clearAgingTracking();
  // Goal-system singletons. Both compare a stored tick stamp against `totalTicks`;
  // after a replace the difference goes negative and the guard never opens again,
  // which silently disables goal pivoting, stale-goal abandonment, and agent-name
  // refresh in goal-review prompts.
  pivotEvaluator.clear();
  goalReviewer.clear();

  // Per-agent identity-bound caches
  clearPersonalityBaselines();
  clearHobbySkills();
  clearReputationCache();
  clearFavorLedger();
  clearSharedSecrets();
  clearMoodTrackers();
  clearCriticalNeedFired();
  clearConsecutiveWorkTicks();
  clearHungerTracking();
  clearMilestoneTracking();
  clearWorkSkipCounts();

  // Caches keyed on conversation/agent id pairs. Both id spaces restart at 1 after
  // the wipe, and neither is evicted by the normal completion paths when a world
  // replace abandons the work in flight.
  clearAllConversationCaches();
  clearConfrontationCooldowns();

  // Wall-clock memos over the whole town. Without a reset the first seconds of a
  // new world showed the previous world's story arcs and cliques.
  resetChronicleCache();
  resetCliqueCache();
}
