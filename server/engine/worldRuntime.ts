import { eq } from 'drizzle-orm';
import { db } from '../db';
import { agents, locations } from '../db/schema';
import { memoryService, reflectionTrigger, reflectionRunner, selfDescriptionGenerator } from '../lib/memory/instance';
import { planCache, planLLMQueue, replanEvaluator } from '../lib/planning/instance';
import { clearEffectivePersonalities, clearAgentStatesCache } from '../lib/states';
import { perceptionSystem } from '../lib/perception/instance';
import { zoneOccupancy, reconstructZoneOccupancy } from '../lib/interiorGrid';
import { resetCascade } from '../lib/cascade';
import { invalidateCostMap, clearMovementState } from './systems/movement';
import { clearPerWorldCaches, restoreWorldCaches } from './worldCaches';
import { autoPlayer } from '../autoplay';

/**
 * Forget every piece of in-process state that describes "the world in the DB",
 * then rebuild what can be rebuilt from whatever world the DB holds now.
 *
 * Three flows swap the world under a running process — `setup.replaceWorld`
 * (Start / Restart), `setup.resetToWizard`, and a save load (lib/saves.ts) —
 * and all three must run exactly this list. It used to be written out twice in
 * setup.ts; a third copy for loading saves would have been the one that missed
 * the next cache someone adds. `clearPerWorldCaches` (worldCaches.ts) is the
 * per-agent half; this is the service-singleton half around it.
 *
 * Call it with the tick loop stopped and the task runner's slots reset, and on
 * the failure path too: after a rolled-back swap the DB holds the previous
 * world again, and the snapshot restore plus zone reconstruction below bring
 * its state back from the checkpoint the caller took before the swap.
 *
 * May throw (the zone reconstruction does real DB I/O). Callers wrap it so a
 * throw here can never skip their `startTickLoop()` / `markAllDirty()`.
 */
export function resetWorldRuntime(): void {
  clearEffectivePersonalities();
  clearAgentStatesCache();
  // Drops queued memory writes too: they belong to agents of the outgoing
  // world, and SQLite reuses agent ids.
  memoryService.clear();
  reflectionTrigger.clear();
  reflectionRunner.clearQueue();
  selfDescriptionGenerator.clear();
  planCache.clear();
  planLLMQueue.clear();
  replanEvaluator.clear();
  perceptionSystem.clear();
  zoneOccupancy.clear();
  resetCascade();
  autoPlayer.reset();
  // The terrain cost map was keyed on season only, so it survived into the new
  // world and was read out of range whenever the map size changed.
  invalidateCostMap();
  // Agent ids restart at 1 after a wipe and totalTicks resets, so stale
  // per-agent recalc/stuck timestamps would disable re-pathing in the new world.
  clearMovementState();
  clearPerWorldCaches();
  // Whatever world the DB now holds: nothing for a fresh one, the loaded save's
  // checkpoint after a load, the caller's own checkpoint after a rollback.
  restoreWorldCaches();

  // Zone occupancy is in-memory only; rebuild it from the agent positions
  // actually in the DB (none after a reset to the wizard).
  const activeAgentsForZone = db.select({
    id: agents.id,
    current_location: agents.current_location,
    position: agents.position,
  }).from(agents).where(eq(agents.is_active, true)).all();
  const allLocsForZone = db.select({
    id: locations.id,
    type: locations.type,
    position: locations.position,
  }).from(locations).all();
  reconstructZoneOccupancy(activeAgentsForZone, allLocsForZone);
}
