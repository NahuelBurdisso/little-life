import {
  bellSpot, chimneyCap, coopYard, cropFields, crossSpot, doorSpot, flagSpot, forgeSpot, ovenSpot, signSpot,
  stageSpot, windowCentres,
} from "./placeAnchors";
import type { PlaceClimate, PlaceState } from "./placeState";
import { inRect, type Pt, type Rect } from "./zoneGeometry";
import type { GlowShape } from "./placeFrames";
import type { LocationLite } from '../../../../lib/apiTypes';
import type { AgentLite } from '../../SpritePool';

/**
 * What the town's buildings are doing right now, as a flat list of visual items with stable
 * keys. The renderer diffs two plans by key: an item that appears fades in, one that
 * disappears fades out, one that stays keeps animating, so a forge that goes quiet cools down
 * instead of blinking off.
 *
 * Pure — no PixiJS. The rules here read the per-place records from `placeState`.
 */

export type GlowPulse = 'flicker' | 'heartbeat' | 'breath';

interface Base { key: string; x: number; y: number }

export interface GlowItem extends Base {
  kind: 'glow';
  shape: GlowShape;
  tint: number;
  /** Multiplier on the 32px glow cell. */
  scale: number;
  alpha: number;
  pulse: GlowPulse;
  /** How far the pulse swings the alpha, 0..1. */
  swing: number;
}
export interface SparksItem extends Base { kind: 'sparks'; mode: 'hammer' | 'vent' }
export interface CrowdItem extends Base {
  kind: 'crowd';
  /** Seconds between puffs. */
  interval: number;
  /** Chance that a puff is music instead of chatter. */
  notes: number;
}
export interface SignItem extends Base { kind: 'sign'; open: boolean }
export interface FlagItem extends Base { kind: 'flag'; gust: boolean }
export interface BellItem extends Base { kind: 'bell'; ringing: boolean }
export interface HandsItem extends Base { kind: 'hands' }
export interface LaundryItem extends Base { kind: 'laundry'; windy: boolean }
export interface ChickensItem extends Base { kind: 'chickens'; rect: Rect; count: number }
/** A farmer working the rows: the renderer follows the agent's sprite. */
export interface DustItem extends Base { kind: 'dust'; agentId: number }

export type PlaceItem =
  | GlowItem | SparksItem | CrowdItem | SignItem | FlagItem | BellItem | HandsItem | LaundryItem
  | ChickensItem | DustItem;

export interface PlanInput {
  locations: LocationLite[];
  states: PlaceState[];
  agents: AgentLite[];
  climate: PlaceClimate;
  /** Whether a world box is clear of roads and other buildings (for the laundry line). */
  isFree?: (box: Rect, selfId: number) => boolean;
}

const SIGNED_TYPES: ReadonlySet<string> = new Set(['shop', 'pawnshop', 'bakery', 'clinic']);
const DRYING_WEATHER: ReadonlySet<string> = new Set(['sunny', 'hot', 'windy']);
const WINDY: ReadonlySet<string> = new Set(['windy', 'stormy']);
const FIELD_JOBS: ReadonlySet<string> = new Set(['working', 'plant', 'harvest', 'garden']);

/** Quiet town-hall bell: rings while a crowd is inside or a town meeting is on. */
export const BELL_CROWD = 3;
/** A pub is "lively" from this many patrons. */
export const CROWD_MIN = 3;

const LAUNDRY_BOX = { w: 16, h: 14 };

/**
 * Laundry hangs in the gap beside a home, on whichever side (east first for even ids, west
 * for odd) has room. Returns the foot of the line's cell or null when both sides are taken.
 */
export function laundrySpot(loc: { id: number; position: Rect }, isFree: (box: Rect, selfId: number) => boolean): Pt | null {
  const { x, y, width, height } = loc.position;
  const east = { x: x + width + 6, y: y + height - LAUNDRY_BOX.h };
  const west = { x: x - 6 - LAUNDRY_BOX.w, y: y + height - LAUNDRY_BOX.h };
  const order = loc.id % 2 === 0 ? [east, west] : [west, east];
  for (const o of order) {
    if (isFree({ x: o.x, y: o.y, width: LAUNDRY_BOX.w, height: LAUNDRY_BOX.h }, loc.id)) {
      return { x: o.x + LAUNDRY_BOX.w / 2, y: o.y + LAUNDRY_BOX.h + 1 };
    }
  }
  return null;
}

/** Pub patter gets quicker with the crowd and with the dark. */
export function crowdInterval(occupants: number, night: boolean): number {
  const base = Math.max(0.7, 2.6 - 0.28 * occupants);
  return night ? base * 0.7 : base;
}

export function buildPlacePlan(input: PlanInput): PlaceItem[] {
  const { locations, states, agents, climate: c } = input;
  const items: PlaceItem[] = [];
  const stateById = new Map<number, PlaceState>();
  for (const s of states) stateById.set(s.id, s);
  const night = c.dayPhase === 'night';
  const windy = WINDY.has(c.weather);

  for (const loc of locations) {
    const st = stateById.get(loc.id);
    if (!st || !loc.position) continue;
    const id = loc.id;

    switch (loc.type) {
      case 'workshop': {
        if (st.working === 0) break;
        const forge = forgeSpot(loc);
        if (forge) {
          items.push({ kind: 'glow', key: `forge:${id}`, ...forge, shape: 'round', tint: 0xff7a2a, scale: 1.8, alpha: 0.72, pulse: 'flicker', swing: 0.35 });
          items.push({ kind: 'sparks', key: `hammer:${id}`, ...forge, mode: 'hammer' });
        }
        const cap = { x: 0, y: 0 };
        if (chimneyCap(loc, cap)) {
          items.push({ kind: 'glow', key: `vent:${id}`, ...cap, shape: 'round', tint: 0xff9a40, scale: 0.6, alpha: 0.4, pulse: 'flicker', swing: 0.5 });
          items.push({ kind: 'sparks', key: `vent-sparks:${id}`, ...cap, mode: 'vent' });
        }
        break;
      }
      case 'bakery': {
        if (st.working === 0) break;
        const oven = ovenSpot(loc);
        if (oven) items.push({ kind: 'glow', key: `oven:${id}`, ...oven, shape: 'round', tint: 0xffa050, scale: 1.5, alpha: 0.6, pulse: 'flicker', swing: 0.15 });
        windowCentres(loc).forEach((w, i) => {
          items.push({ kind: 'glow', key: `oven-window:${id}:${i}`, ...w, shape: 'round', tint: 0xffc46a, scale: 0.75, alpha: 0.4, pulse: 'breath', swing: 0.2 });
        });
        break;
      }
      case 'tavern':
      case 'divebar': {
        if (st.occupants >= CROWD_MIN || st.performing > 0) {
          const notes = st.performing > 0 ? 0.85 : night && st.occupants >= 5 ? 0.35 : 0;
          items.push({ kind: 'crowd', key: `crowd:${id}`, ...doorSpot(loc), interval: crowdInterval(st.occupants, night), notes });
        }
        if (loc.type === 'tavern' && st.performing > 0) {
          const stage = stageSpot(loc);
          if (stage) items.push({ kind: 'glow', key: `stage:${id}`, ...stage, shape: 'wide', tint: 0xffd27a, scale: 1.5, alpha: 0.5, pulse: 'breath', swing: 0.15 });
        }
        break;
      }
      case 'clinic': {
        if (st.sick > 0) {
          items.push({ kind: 'glow', key: `cross:${id}`, ...crossSpot(loc), shape: 'cross', tint: 0x7dffb0, scale: 0.9, alpha: 0.8, pulse: 'heartbeat', swing: 0.85 });
        }
        break;
      }
      case 'town_hall': {
        items.push({ kind: 'flag', key: `flag:${id}`, ...flagSpot(loc), gust: windy });
        items.push({ kind: 'bell', key: `bell:${id}`, ...bellSpot(loc), ringing: st.occupants >= BELL_CROWD || c.meeting });
        break;
      }
      case 'prison': {
        const windows = windowCentres(loc);
        const n = Math.min(st.arrested, windows.length);
        for (let i = 0; i < n; i++) items.push({ kind: 'hands', key: `hands:${id}:${i}`, ...windows[i] });
        break;
      }
      case 'home': {
        const dry = st.occupants > 0 && DRYING_WEATHER.has(c.weather) && (c.dayPhase === 'morning' || c.dayPhase === 'afternoon');
        if (dry && input.isFree) {
          const spot = laundrySpot(loc, input.isFree);
          if (spot) items.push({ kind: 'laundry', key: `laundry:${id}`, ...spot, windy: c.weather === 'windy' });
        }
        break;
      }
      case 'farm': {
        const yard = coopYard(loc);
        if (yard && !night) items.push({ kind: 'chickens', key: `chickens:${id}`, x: yard.x, y: yard.y, rect: yard, count: 3 });
        const fields = cropFields(loc);
        if (fields.length > 0) {
          for (const a of agents) {
            if (!a.position || a.current_location !== id) continue;
            const act = a.current_action;
            const type = typeof act === 'string' ? act : act?.type;
            const job = typeof act === 'object' ? act?.zoneActivity : '';
            if (!FIELD_JOBS.has(type ?? '') && !FIELD_JOBS.has(job ?? '')) continue;
            const at = a.position;
            if (at && fields.some((f) => inRect(f, at.x, at.y, 6))) {
              items.push({ kind: 'dust', key: `dust:${a.id}`, x: at.x, y: at.y, agentId: a.id });
            }
          }
        }
        break;
      }
      case 'farmyard': {
        if (!night) {
          const p = loc.position;
          const rect = { x: p.x + 8, y: p.y + 8, width: p.width - 16, height: p.height - 16 };
          items.push({ kind: 'chickens', key: `chickens:${id}`, x: rect.x, y: rect.y, rect, count: 2 });
        }
        break;
      }
    }

    if (SIGNED_TYPES.has(loc.type) && loc.entry_point) {
      const open = st.open && (st.staffAssigned === 0 || st.staffInside > 0);
      items.push({ kind: 'sign', key: `sign:${id}`, ...signSpot(loc), open });
    }
  }
  return items;
}
