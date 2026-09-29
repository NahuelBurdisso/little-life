import type { HeldItemDef, HeldItemId } from './heldFrames';

/**
 * What an agent holds right now — pure, so every branch is unit tested. The system
 * gathers the inputs (agent row + location lookups) and only renders the answer.
 */
export interface HeldContext {
  /** `current_action.type`. */
  actionType: string;
  /** `current_action.zoneActivity` (fish, garden, perform...). */
  zoneActivity: string | null;
  /** `type` of the location the agent is in now (tavern, park...), or null when outdoors. */
  locationType: string | null;
  /** Whether the agent is inside their own workplace. */
  atWorkplace: boolean;
  /** `type` of the agent's workplace. */
  workplaceType: string | null;
  /** Just finished a shopping trip and is still carrying the goods home. */
  bag?: boolean;
}

const WORK_TOOL: Record<string, HeldItemId> = {
  bakery: 'rolling_pin',
  workshop: 'hammer',
  clinic: 'clipboard',
  shop: 'ledger',
  pawnshop: 'ledger',
  tavern: 'mug',
  divebar: 'mug',
  town_hall: 'quill',
  prison: 'keys',
  farm: 'hoe',
};

/** Zone activities ride on idle/comfort actions; jog, browse and the crimes hold nothing. */
const ZONE_TOOL: Record<string, HeldItemId> = {
  fish: 'rod',
  garden: 'watering_can',
  forage: 'basket',
  perform: 'lute',
  contemplate: 'book',
  rest: 'book',
  // A cup of tea on the park bench, a pan at the stove, a loudhailer at the podium...
  comfort: 'cup',
  cook: 'pan',
  speech: 'megaphone',
  announce: 'megaphone',
  protest: 'sign',
  plant: 'hoe',
  harvest: 'basket',
  pick_flowers: 'basket',
  collect_eggs: 'basket',
  feed_animals: 'basket',
};

const DRINKING_PLACES = new Set(['tavern', 'divebar']);

export function heldItemFor(c: HeldContext): HeldItemId | null {
  switch (c.actionType) {
    case 'working':
      // A tool only makes sense at the bench; commuting to work is empty-handed.
      return c.atWorkplace && c.workplaceType ? WORK_TOOL[c.workplaceType] ?? null : null;
    case 'eating':
      // No china behind bars: prison food comes in a bowl.
      return c.locationType === 'prison' ? 'bowl' : 'plate';
    case 'shopping':
      return 'basket';
    case 'socializing':
      return c.locationType && DRINKING_PLACES.has(c.locationType) ? 'mug' : null;
    case 'idle':
    case 'comfort': {
      const tool = c.zoneActivity ? ZONE_TOOL[c.zoneActivity] ?? null : c.actionType === 'comfort' ? 'cup' : null;
      return tool ?? (c.bag ? 'bag' : null);
    }
    case 'walking':
      return c.bag ? 'bag' : null;
    default:
      return null;
  }
}

/** How long the bag stays in hand after the trip, in ms — about the walk home. */
export const BAG_CARRY_MS = 45_000;

/**
 * When the bag should be put down: a shopping trip ending (`wasTrip` -> not `isTrip`) starts the
 * clock, a new trip or the end of the carry clears it. Returns the deadline in ms (0 = no bag).
 */
export function bagDeadline(wasTrip: boolean, isTrip: boolean, now: number, deadline: number): number {
  if (isTrip) return 0; // still shopping: the basket is the prop
  if (wasTrip) return now + BAG_CARRY_MS;
  return deadline > now ? deadline : 0;
}

/** Per-frame result of {@link heldPose}; reused by the caller to avoid allocating. */
export interface HeldPose {
  /** Sprite rotation about the grip, radians. */
  rot: number;
  /** Vertical offset of the grip, px (negative = up). */
  dy: number;
  /** Draw the item's alternate (raised) frame. */
  alt: boolean;
}

/** How long a sip / pour lasts, in seconds, out of `rate` seconds per cycle. */
const SIP_SECONDS = 0.9;
/** Below this stroke the hammer is drawn cocked back. */
const RAISED_BELOW = 0.5;

/**
 * Transform of a held item for this frame. `phase` (seconds, per agent) keeps neighbours
 * from moving in lockstep; `stroke` is `AgentSprite.workStroke`.
 */
export function heldPose(def: HeldItemDef, seconds: number, stroke: number, phase: number, out: HeldPose): HeldPose {
  out.rot = def.baseRot;
  out.dy = 0;
  out.alt = false;
  switch (def.motion) {
    case 'swing':
      out.rot += def.amp * stroke;
      out.alt = def.altFrame !== null && stroke < RAISED_BELOW;
      break;
    case 'bob': {
      const a = seconds * def.rate + phase * 3;
      out.rot += Math.sin(a) * def.amp;
      out.dy = Math.sin(a * 0.7 + 1) * 0.5;
      break;
    }
    case 'sip': {
      const t = (((seconds + phase) % def.rate) + def.rate) % def.rate;
      if (t < SIP_SECONDS) {
        const s = Math.sin((Math.PI * t) / SIP_SECONDS);
        out.rot += def.amp * s;
        out.dy = -2 * s;
      }
      break;
    }
    default:
      break;
  }
  return out;
}
