import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../../db';
import { agents } from '../../db/schema';

// ─── Who could see it ────────────────────────────────────────────────────────
//
// A kiss, later a night spent together, is private only as far as nobody else
// is looking. The witnesses are the other people who are awake and close enough
// to have seen it: in the same building, or, out in the open, within talking
// range. Shared by the kiss (kiss.ts, which asks whether anyone is watching
// before it happens and who saw it after) and by whatever else needs the same
// question, so "close enough to see" is answered in one place.

/**
 * Outdoors, how far someone can stand and still see two people who are together.
 * Matches the proposal engine's "together" range (milestonesEngine TALK_RANGE_PX,
 * which cannot be imported here: loading that module registers its listeners).
 */
export const WITNESS_RANGE_PX = 64;

interface Placed {
  id: number;
  current_location: number | null;
  position: unknown;
}

/** Awake and in the world: asleep and dead people see nothing. */
function couldSee(row: { current_action: unknown; is_active: boolean }): boolean {
  if (!row.is_active) return false;
  const type = (row.current_action as { type?: string } | null)?.type ?? 'idle';
  return type !== 'sleeping' && type !== 'dead';
}

/**
 * Agent ids (never `a` or `b`) that saw the pair. Inside a building that is
 * everyone awake in the same location; outdoors (no location), everyone awake
 * and outdoors within `WITNESS_RANGE_PX` of `a` (the pair are talking, so `b`
 * is at their side). A person indoors never sees the street and vice versa.
 */
export function witnessesOf(a: Placed, b: Placed): number[] {
  return onlookersNear(
    { current_location: a.current_location ?? b.current_location, position: a.position },
    [a.id, b.id],
  );
}

/**
 * How far a person leaving a house at dawn can be seen from outdoors: farther
 * than a whispered conversation, since a doorway and the lane in front of it are
 * watched. (tryst.ts; the kiss keeps `WITNESS_RANGE_PX`.)
 */
export const SNEAK_RANGE_PX = 96;

/**
 * Everyone awake (never one of `exclude`) who could see a person standing at
 * `spot`: in a building, everyone awake in it; outdoors, everyone awake and
 * outdoors within `range`. Used on its own by tryst.ts for one person leaving,
 * where there is no pair to anchor the location on.
 */
export function onlookersNear(
  spot: { current_location: number | null; position: unknown },
  exclude: number[],
  range: number = WITNESS_RANGE_PX,
): number[] {
  const others = db.select({
    id: agents.id,
    current_location: agents.current_location,
    position: agents.position,
    current_action: agents.current_action,
    is_active: agents.is_active,
  }).from(agents)
    .where(and(eq(agents.is_active, true), notInArray(agents.id, exclude)))
    .all();

  const origin = spot.position as { x: number; y: number } | null;
  return others
    .filter((o) => {
      if (!couldSee(o)) return false;
      if (spot.current_location != null) return o.current_location === spot.current_location;
      if (o.current_location != null || !origin) return false;
      const p = o.position as { x: number; y: number };
      return Math.hypot(p.x - origin.x, p.y - origin.y) <= range;
    })
    .map((o) => o.id);
}
