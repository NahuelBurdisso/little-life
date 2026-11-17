/**
 * Gatherings (see ./engine.ts for the why): the public API and the wiring.
 *
 * Side-effect module, like lib/socialCalls: importing it registers the built-in
 * kinds (GATHERING_KINDS) and one simEvents listener per event it reacts to
 * (server/index.ts and engine/tick.ts import it). Listeners run inside the
 * emitting phase's transaction, so each only SCHEDULES — a few reads and an
 * in-memory write — and never throws into the emitter. Everything else happens
 * in the 10-minute pass (`gatheringsTick`, engine/tick.ts) and the decision pass.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, locations, worldEvents } from '../../db/schema';
import { simEvents, type SimEventPayloads } from '../simEvents';
import { gameMinutesNow } from '../worldClock';
import { clearGatherings, forgetInvitee, gatheringsPass, registerGatheringKind } from './engine';
import { FUNERAL, WAKE, onDeath } from './kinds/funeral';
import { SEND_OFF, onLeavingDecided } from './kinds/sendOff';
import { MARKET, onMarketStarted } from './kinds/market';
import type { GatheringKind } from './types';

export {
  scheduleGathering, gatheringAt, attendanceOf, gatheringRecords, registerGatheringKind, gatheringsSnapshotStore, gatheringTally,
} from './engine';
export type { Gathering, GatheringKind, GatheringRecord, InviteLevel, Attendance } from './types';

/** The built-in kinds. Later passes register their own (`registerGatheringKind`). */
export const GATHERING_KINDS: readonly GatheringKind[] = [FUNERAL, WAKE, SEND_OFF, MARKET];

function registerBuiltInKinds(): void {
  for (const k of GATHERING_KINDS) registerGatheringKind(k);
}

registerBuiltInKinds();

/** Forget every gathering (a world replace; worldCaches.ts). */
export function clearGatheringState(): void {
  clearGatherings();
}

/**
 * Every 10 game minutes (engine/tick.ts, in a transaction): the engine's pass,
 * with what it needs read from the DB once.
 */
export function gatheringsTick(nowMin: number): void {
  const rows = db.select({
    id: agents.id, current_location: agents.current_location, position: agents.position, action: agents.current_action,
  }).from(agents).where(eq(agents.is_active, true)).all();
  const doors = new Map(db.select({ id: locations.id, door: locations.entry_point }).from(locations).all().map((l) => [l.id, l.door]));
  const storm = db.select({ type: worldEvents.type }).from(worldEvents).where(eq(worldEvents.is_active, true)).all()
    .some((e) => e.type === 'storm');
  gatheringsPass({
    nowMin,
    agents: rows.map((r) => ({
      id: r.id, current_location: r.current_location, position: r.position,
      action: (r.action as { type?: string } | null)?.type ?? 'idle',
    })),
    venueDoor: (id) => doors.get(id) ?? null,
    storm,
  });
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

function guarded<T>(name: string, fn: (p: T) => void): (p: T) => void {
  return (p: T) => {
    try {
      fn(p);
    } catch (err) {
      console.warn(`[gatherings] ${name} failed:`, (err as Error).message);
    }
  };
}

let initialized = false;

function initGatherings(): void {
  if (initialized) return;
  initialized = true;

  simEvents.on('world:event_started', guarded<SimEventPayloads['world:event_started']>('world:event_started', (p) => {
    switch (p.type) {
      case 'market_day': onMarketStarted(p.eventId, p.locationId, p.startedAtMin, p.durationHours); break;
    }
  }));
  simEvents.on('life:leaving_decided', guarded<SimEventPayloads['life:leaving_decided']>('life:leaving_decided',
    (p) => onLeavingDecided(p.agentId, p.leaveAtMin, gameMinutesNow())));
  // The dead are buried; the departed are struck from every list.
  simEvents.on('life:death', guarded<{ agentId: number; name: string }>('life:death', (p) => {
    forgetInvitee(p.agentId);
    onDeath(p.agentId, p.name, gameMinutesNow());
  }));
  simEvents.on('life:departed', guarded<{ agentId: number }>('life:departed', (p) => forgetInvitee(p.agentId)));
}

initGatherings();
