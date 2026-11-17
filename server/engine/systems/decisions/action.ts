/**
 * Turning a decision into an action: the action object, the destination, and starting it.
 */

import { db } from '../../../db';
import { agents, type AgentAction } from '../../../db/schema';
import { logActivity } from '../../../lib/activityLogger';
import { findAvailableZone, zoneSlotOffset, fallbackInteriorTile } from '../../../lib/interiorGrid';
import { startQueuedAction } from '../movement';
import { isSeatedZone } from '../../../data/interiors';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../../../lib/constants';
import { sleepDurationMinutes } from '../../../lib/sleepSchedule';
import { PersonalityProfile } from '../../../lib/personality';
import { getEffectivePersonality } from '../../../lib/states';
import type { AgentRow, LocationRow, ScoredAction } from './types';
import { groceryList } from './meals';
import { sleepWindow } from './schedule';
import type { DecisionTickContext, AgentTurn, DecisionDestination } from './context';

// --- Build action object ---

/** Action types the engine models itself; anything else a plan names is an activity verb. */
const CORE_ACTIONS = new Set(['sleeping', 'eating', 'working', 'socializing', 'walking', 'idle', 'shopping', 'comfort']);

/**
 * The zone activity a decision stands for ('fish', 'perform', 'scheme'...), or undefined.
 * Free-time scoring rides it on `source` of an idle action. A plan step puts the verb in
 * `action` instead (PlanExecutor._actionToScored, `source: 'plan:decomposed'`), which used
 * to fall through buildAction's default to a bare `idle` — the renderer, the zone lookup
 * and the zone effects never heard what the agent was actually doing.
 */
export function zoneVerbOf(decision: Pick<ScoredAction, 'action' | 'source'>): string | undefined {
  const fromPlan = decision.source?.startsWith('plan:') ?? false;
  if (fromPlan) return CORE_ACTIONS.has(decision.action) ? undefined : decision.action;
  return decision.action === 'idle' ? decision.source : undefined;
}

export function buildAction(decision: ScoredAction, shoppingList: string[] = []): AgentAction {
  const zoneActivity = zoneVerbOf(decision);
  switch (decision.action) {
    case 'sleeping':
      return { type: 'sleeping' };
    case 'eating':
      return { type: 'eating', locationId: decision.targetLocationId ?? '' };
    case 'working':
      return { type: 'working', taskDescription: 'daily work' };
    case 'socializing':
      return { type: 'socializing', locationId: decision.targetLocationId ?? '' };
    case 'walking':
      return { type: 'walking', to: { x: 0, y: 0 } };
    case 'idle':
      return { type: 'idle', ...(zoneActivity ? { zoneActivity } : {}) };
    case 'shopping':
      return { type: 'shopping', shopId: decision.targetLocationId ?? '', items: shoppingList };
    case 'comfort':
      return { type: 'comfort', zoneActivity: 'comfort' };
    default:
      return { type: 'idle', ...(zoneActivity ? { zoneActivity } : {}) };
  }
}

/** Where the decision sends the agent: the target's door, the zone (or floor tile) inside, or nowhere. */
export function resolveDestination(agent: AgentRow, decision: ScoredAction, allLocations: LocationRow[]): DecisionDestination {
  // Build destination from the target location
  let destination: { x: number; y: number; locationId?: number } | null = null;
  let zoneTarget: { x: number; y: number } | null = null;
  let matchedZoneId: string | undefined;
  let matchedBuildingType: string | undefined;
  let seatedZone = false;
  if (decision.targetLocationId) {
    const loc = allLocations.find((l) => l.id === decision!.targetLocationId);
    if (loc) {
      // Always pathfind to the entry point — this is guaranteed to be a walkable tile.
      // If the action targets an interior zone, store the zone center separately and
      // teleport the agent there on arrival (two-phase interior movement).
      const destX = loc.entry_point.x;
      const destY = loc.entry_point.y;

      const locType = loc.type as string;
      // Zone activities ride on `action: 'idle'` with the real intent in `source`
      // ('fish', 'garden', 'perform', ...). Passing the action alone sent every
      // activity to whichever zone happened to allow 'idle'.
      // `agent.id` is passed so the agent is not counted against the capacity of
      // the zone it is already standing in — otherwise a single-occupant zone
      // (home:bed) blocks its own occupant on every re-decision.
      const zone = findAvailableZone(locType, zoneVerbOf(decision!) ?? decision!.source ?? decision!.action, loc.id, agent.id);
      if (zone) {
        const locPos = loc.position as { x: number; y: number; width: number; height: number };
        const slot = zoneSlotOffset(agent.id);
        zoneTarget = {
          x: locPos.x + zone.center[0] * 32 + 16 + slot.dx,
          y: locPos.y + zone.center[1] * 32 + 16 + slot.dy,
        };
        matchedZoneId = zone.id;
        matchedBuildingType = locType;
        seatedZone = isSeatedZone(locType, zone.id);
      } else {
        // No zone matched (plenty of action/building pairs have no mapping —
        // 'idle' in a shop, 'resting' anywhere). Standing them on a floor tile
        // keeps them inside; the alternative is the entry_point, which is a
        // tile outside the south wall, so they'd loiter on the doorstep.
        const tile = fallbackInteriorTile(locType, agent.id);
        if (tile) {
          const locPos = loc.position as { x: number; y: number; width: number; height: number };
          const slot = zoneSlotOffset(agent.id);
          zoneTarget = {
            x: locPos.x + tile[0] * 32 + 16 + slot.dx,
            y: locPos.y + tile[1] * 32 + 16 + slot.dy,
          };
          matchedBuildingType = locType;
        }
      }

      // Every zone is genuinely full and the agent is already inside: keep them
      // where they stand. Re-routing to the entry_point would park them in the
      // doorway for the whole action.
      const alreadyHere = agent.current_location === loc.id;
      if (!zone && alreadyHere) {
        destination = null;
      } else {
        destination = {
          x: destX,
          y: destY,
          locationId: loc.id,
        };
      }
    }
  }
  return { destination, zoneTarget, matchedZoneId, matchedBuildingType, seatedZone };
}

/**
 * Start the decision: work out its duration and action, then either set the
 * agent walking with the action queued for arrival or start it where they stand.
 */
export function startDecision(t: AgentTurn, decision: ScoredAction, dest: DecisionDestination, d: DecisionTickContext): void {
  const { agent, agentNeeds, agentEcon, critical } = t;
  const { world, allLocations, nowMinutes } = d;
  const { zoneTarget, matchedZoneId, matchedBuildingType, seatedZone } = dest;
  let { destination } = dest;
  // Determine action duration
  const durationKey = decision.action;
  const minDuration =
    CONFIG.DECISIONS.ACTION_MIN_DURATIONS[durationKey] ??
    CONFIG.DECISIONS.ACTION_MIN_DURATIONS['idle'];

  const actionDuration =
    decision.action === 'idle' &&
    agentNeeds.mood < CONFIG.NEEDS.MOOD_CRITICAL_THRESHOLD
      ? 120
      : decision.action === 'sleeping'
        ? sleepDurationMinutes(
            world.time.hour, world.time.minute,
            sleepWindow(agent, getEffectivePersonality(agent.id) ?? agent.personality as PersonalityProfile | null).wake,
            minDuration,
            agentNeeds.energy < critical,
          )
        : minDuration;

  const baseAction = buildAction(
    decision,
    decision.action === 'shopping'
      ? groceryList(agentEcon, allLocations.find((l) => l.id === decision!.targetLocationId))
      : [],
  );

  // Walk straight to the spot. The destination above is the entry_point, and
  // the spot used to be reached in a second walk started on arrival
  // (handleArrival in movement.ts: an interior hop inside buildings, a 5-tick
  // lerp in open areas). Two costs came with it:
  //  - a place the agent was already in was left and re-entered: a farmer
  //    re-deciding `working` every hour (the action is 60 minutes) walked
  //    from the crops out to the farm gate and back, a clerk from the counter
  //    out onto the doorstep and back — ~5 such walks per agent a day in the
  //    soaks, and at 4x each leg costs a whole 4-minute tick to arrive;
  //  - every trip was two walks, so paid that arrival tick twice, and the open
  //    area lerp padded the action by 5 ticks (20 game minutes at 4x).
  // planRoute (movement.ts) routes into a building through its door on the
  // building's own grid, so one walk covers door and spot.
  //
  // The queued action carries what starting it needs (startQueuedAction):
  //  - `_arrivalZone`/`_arrivalBuilding` for any matched zone, indoor or open
  //    area: the zone's effects (fish → food, garden, jog...) run on arrival,
  //    and indoor zones register occupancy;
  //  - `_duration`: the length decided here. Arrival used to reset it to the
  //    action type's minimum, so a sleep shortened to end at the wake time
  //    (or a 120-minute mope) was six hours / ten minutes again once walked to.
  // `pose` is a cosmetic hint for the renderer and rides on the action itself.
  const queuedAction: AgentAction = {
    ...(baseAction.type === 'walking' ? { type: 'idle' } : baseAction),
    ...(matchedZoneId && matchedBuildingType
      ? { _arrivalZone: matchedZoneId, _arrivalBuilding: matchedBuildingType }
      : {}),
    ...(seatedZone ? { pose: 'sitting' } : {}),
    // A 'walking' decision can't be started in place (no destination: movement
    // skips it and decisions never re-assigns it); it becomes a short idle.
    _duration: baseAction.type === 'walking'
      ? (CONFIG.DECISIONS.ACTION_MIN_DURATIONS['idle'] ?? 10)
      : actionDuration,
  };
  if (destination && zoneTarget) {
    destination = { x: zoneTarget.x, y: zoneTarget.y, locationId: destination.locationId };
  }

  const needsToTravel =
    destination &&
    (Math.abs(agent.position.x - destination.x) > 4 ||
      Math.abs(agent.position.y - destination.y) > 4);

  if (needsToTravel) {
    db.update(agents)
      .set({
        current_action: { type: 'walking', to: { x: destination!.x, y: destination!.y } },
        current_destination: destination,
        action_started: nowMinutes,
        action_duration: null,
        action_queue: [queuedAction],
        current_path: null,
      })
      .where(eq(agents.id, agent.id))
      .run();
  } else {
    // Already on the spot (or staying where they stand): start it here, the
    // same way an arrival would — so an angler who re-decides `fish` on the
    // riverbank still lands a fish.
    if (destination) {
      db.update(agents).set({ position: { x: destination.x, y: destination.y } }).where(eq(agents.id, agent.id)).run();
    }
    startQueuedAction(agent.id, agent.current_location, queuedAction, [], world.time);
  }
}

/** Write a feed row for a zone-driven activity (fishing, performing, lurking...). */
export function logZoneActivity(agent: AgentRow, decision: ScoredAction): void {
  // Log zone-driven activities to activity feed
  if (decision.source && ['contemplate', 'fish', 'garden', 'forage', 'perform', 'jog', 'browse', 'rest', 'shoplifting', 'pickpocket'].includes(decision.source)) {
    const activityNames: Record<string, string> = {
      contemplate: 'is contemplating by the riverside',
      fish: 'is fishing at the river',
      garden: 'is tending the garden',
      forage: 'is foraging in the grove',
      perform: 'is performing in the town square',
      jog: 'is jogging around town',
      browse: 'is browsing the market stalls',
      rest: 'is resting at home',
      shoplifting: 'is eyeing goods at the shop suspiciously',
      pickpocket: 'is lurking near someone with money',
    };
    logActivity({
      type: decision.source as string,
      initiator: agent.id,
      templateData: { agent: agent.name, description: `${agent.name} ${activityNames[decision.source] ?? decision.source}` },
    });
  }
}
