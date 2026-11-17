import { isOpenAt } from "../../../../../server/lib/gameClock";
import { inRect, zoneRect, type Rect } from "./zoneGeometry";
import type { LocationLite, WorldEventLite, WorldLite } from '../../../../lib/apiTypes';
import type { AgentLite } from '../../SpritePool';

/**
 * Who is where doing what, boiled down to one small record per location. Every reactive
 * detail of the town's buildings (forge glow, chimney smoke, OPEN sign, clinic cross...)
 * is a pure function of these records plus the climate, so the rules live here and are unit
 * tested; the renderer only turns the outcome into sprites.
 *
 * Pure — no PixiJS. Inputs are the loose row shapes the canvas already receives.
 */

/** The bits of the world clock and weather the rules read. */
export interface PlaceClimate {
  hour: number;
  dayPhase: string;
  weather: string;
  season: string;
  /** A `town_meeting` event is running. */
  meeting: boolean;
}

export interface PlaceState {
  id: number;
  type: string;
  /** Agents whose `current_location` is this place. */
  occupants: number;
  /** Occupants who are not asleep. */
  awake: number;
  working: number;
  eating: number;
  /** Occupants carrying a sickness state. */
  sick: number;
  arrested: number;
  /** Someone on the tavern stage (or busking by the activity they were given). */
  performing: number;
  /** Agents employed here, and how many of them are inside right now. */
  staffAssigned: number;
  staffInside: number;
  /** Inside its operating hours (a place with none is always open). */
  open: boolean;
}

/** Activities that put someone in front of an audience. */
const PERFORM_ACTIVITIES: ReadonlySet<string> = new Set(['perform', 'sing', 'play_music', 'busk']);
/** Actions that rule out standing on a stage entertaining the room. */
const NOT_PERFORMING: ReadonlySet<string> = new Set(['walking', 'sleeping', 'eating']);
const COLD_WEATHER: ReadonlySet<string> = new Set(['rainy', 'stormy', 'snowy', 'foggy']);

export function readClimate(world: WorldLite | null | undefined, events: WorldEventLite[] | undefined): PlaceClimate {
  let meeting = false;
  if (events) for (const e of events) if (e?.type === 'town_meeting') { meeting = true; break; }
  return {
    hour: typeof world?.time?.hour === 'number' ? world.time.hour : 12,
    dayPhase: world?.day_phase ?? 'morning',
    weather: world?.weather ?? 'sunny',
    season: world?.time?.season ?? 'spring',
    meeting,
  };
}

function actionParts(a: AgentLite): { type: string; activity: string } {
  const ca = a?.current_action;
  if (typeof ca === 'string') return { type: ca, activity: '' };
  return { type: ca?.type ?? 'idle', activity: ca?.zoneActivity ?? '' };
}

function hasState(a: AgentLite, type: string): boolean {
  const states = a?.activeStates;
  if (!states) return false;
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if ((typeof s === 'string' ? s : s?.type) === type) return true;
  }
  return false;
}

/** One record per location, in the order given. Called on data polls, not per frame. */
export function computePlaceStates(locations: LocationLite[], agents: AgentLite[], climate: PlaceClimate): PlaceState[] {
  const byId = new Map<number, PlaceState>();
  const out: PlaceState[] = [];
  const stages = new Map<number, Rect>();
  for (const loc of locations) {
    if (loc?.id == null) continue;
    const st: PlaceState = {
      id: loc.id, type: loc.type, occupants: 0, awake: 0, working: 0, eating: 0, sick: 0,
      arrested: 0, performing: 0, staffAssigned: 0, staffInside: 0,
      open: isOpenAt(loc.operating_hours, climate.hour),
    };
    byId.set(loc.id, st);
    out.push(st);
    if (loc.type === 'tavern') {
      const stage = zoneRect(loc, 'stage');
      if (stage) stages.set(loc.id, stage);
    }
  }

  for (const a of agents) {
    const work = a.workplace != null ? byId.get(a.workplace) : undefined;
    if (work) work.staffAssigned++;
    const st = a.current_location != null ? byId.get(a.current_location) : undefined;
    if (!st) continue;
    if (work === st) st.staffInside++;
    const { type, activity } = actionParts(a);
    st.occupants++;
    if (type !== 'sleeping') st.awake++;
    if (type === 'working') st.working++;
    if (type === 'eating') st.eating++;
    if (hasState(a, 'sick')) st.sick++;
    if (hasState(a, 'arrested')) st.arrested++;
    if (st.type === 'tavern' && !NOT_PERFORMING.has(type)) {
      const stage = stages.get(st.id);
      const p = a.position;
      if (PERFORM_ACTIVITIES.has(activity) || (stage && p && inRect(stage, p.x, p.y, 6))) st.performing++;
    }
  }
  return out;
}

/** Old fixed schedule of the two workplaces, kept for buildings nobody is employed at. */
const UNSTAFFED_SMOKE_PHASES: Record<string, readonly string[]> = {
  bakery: ['dawn', 'morning'],
  workshop: ['morning', 'afternoon'],
};

/**
 * Does this building's chimney smoke right now? Fires follow the people, not the clock:
 * a hearth burns while someone awake is home (and cooking, or it is cold, or evening); the
 * tavern smokes when it is busy; the oven and the forge while somebody works them. A bakery
 * or workshop with no employee at all keeps the old dawn/day schedule so a worldless town
 * still looks lived in.
 */
export function chimneySmokes(st: PlaceState, c: PlaceClimate): boolean {
  switch (st.type) {
    case 'home': {
      if (st.awake === 0) return false;
      const hearthHour = c.dayPhase === 'dawn' || c.dayPhase === 'evening' || c.dayPhase === 'night';
      const cold = c.season === 'winter' || c.season === 'autumn' || COLD_WEATHER.has(c.weather);
      return st.eating > 0 || hearthHour || cold;
    }
    case 'tavern':
    case 'divebar': {
      const late = c.dayPhase === 'evening' || c.dayPhase === 'night';
      return st.occupants >= 3 || (st.occupants >= 1 && late);
    }
    case 'bakery':
    case 'workshop':
      if (st.working > 0) return true;
      return st.staffAssigned === 0 && (UNSTAFFED_SMOKE_PHASES[st.type]?.includes(c.dayPhase) ?? false);
    default:
      return false;
  }
}
