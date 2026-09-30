import { db } from '../../db';
import { worldState, worldEvents, agents } from '../../db/schema';
import { eq, gte } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { gameMinutes, hourChanged } from '../../lib/gameClock';
import { weightedRandom } from '../../lib/utils';
import { emitter } from '../emitter';
import { logActivity } from '../../lib/activityLogger';
import { simEvents } from '../../lib/simEvents';
import { WORLD_EVENTS, EVENT_WEATHER, type WorldEventDef, type WorldEventType } from '../../data/worldEventCatalog';
import { dramaMultiplier, getRules, type LiveRules } from '../../lib/worldRules';
import { strangerLeaves } from '../../lib/strangerDeparture';

/**
 * The hourly chance of a random world event under the world's drama rule.
 * RANDOM_EVENT_CHANCE_PER_HOUR is the 'medium' rate; 'low' halves it and
 * 'chaos' makes an event about every other hour. Capped at 1 so a future
 * base/multiplier pair can't turn the roll into nonsense — MAX_CONCURRENT_EVENTS
 * still bounds how many run at once.
 */
export function randomEventChancePerHour(rules: LiveRules = getRules()): number {
  return Math.min(1, CONFIG.EVENTS.RANDOM_EVENT_CHANCE_PER_HOUR * dramaMultiplier(rules));
}

// Season-based weather weights (including snowy for winter, windy for autumn)
const WEATHER_WEIGHTS: Record<string, Record<string, number>> = {
  spring: { sunny: 30, cloudy: 25, rainy: 25, stormy: 5, foggy: 5, windy: 10 },
  summer: { sunny: 50, cloudy: 20, rainy: 12, stormy: 8, foggy: 2, windy: 5, hot: 3 },
  autumn: { sunny: 15, cloudy: 25, rainy: 20, stormy: 5, foggy: 15, windy: 20 },
  winter: { sunny: 10, cloudy: 20, rainy: 5, stormy: 8, foggy: 15, snowy: 30, windy: 12 },
};

type WorldEventRow = typeof worldEvents.$inferSelect;


export type StartWorldEventResult =
  | { ok: true; event: WorldEventRow }
  | { ok: false; reason: string };

export interface StartWorldEventOptions {
  /** Stored in `world_events.triggered_by`: 'player', 'random', 'autoplay', 'death:<id>', ... */
  triggeredBy: string;
  /** Per-instance overrides (e.g. "Funeral of Rosa"). Duration and effects always come from the catalog. */
  name?: string;
  description?: string;
  locationId?: number | null;
  /**
   * Refuse when the same type is already running or MAX_CONCURRENT_EVENTS is
   * reached. Off for events other systems must record regardless (funerals).
   */
  enforceLimits?: boolean;
  /** Feed entry + `event:world` memory for every agent. Off when the caller logs its own. */
  announce?: boolean;
}

/**
 * The one way a world event starts. Player triggers, nudges, the autoplay
 * nudger, random rolls and life events all used to insert rows by hand with
 * their own copy of the definitions — and their own bugs (a 120-hour autoplay
 * "2 hour" event with no effects, a 240-hour funeral meant to last 4).
 */
export function startWorldEvent(type: WorldEventType, opts: StartWorldEventOptions): StartWorldEventResult {
  const world = db.select().from(worldState).get();
  if (!world?.time) return { ok: false, reason: 'No world state' };
  const def: WorldEventDef = WORLD_EVENTS[type];
  const name = opts.name ?? def.name;
  const description = opts.description ?? def.description;

  if (opts.enforceLimits ?? true) {
    const active = db.select({ type: worldEvents.type }).from(worldEvents).where(eq(worldEvents.is_active, true)).all();
    if (active.some((e) => e.type === type)) {
      return { ok: false, reason: `A "${name}" event is already active` };
    }
    if (active.length >= CONFIG.EVENTS.MAX_CONCURRENT_EVENTS) {
      return { ok: false, reason: `Maximum concurrent events reached (${CONFIG.EVENTS.MAX_CONCURRENT_EVENTS})` };
    }
  }

  // The auto-nudger reaches for the same few events (storm, merchant, market…);
  // it waits out the type's cooldown like a random roll. The player never does.
  if (opts.triggeredBy === 'autoplay' && recentlyStartedTypes(gameMinutes(world.time)).has(type)) {
    return { ok: false, reason: `A "${name}" event happened too recently` };
  }

  const event = db.insert(worldEvents).values({
    type,
    name,
    description,
    // CLOCK: GAME MINUTES, so expiry holds across speed changes (see eventsTick).
    started_at: gameMinutes(world.time),
    duration: def.durationHours,
    effects: def.effects,
    location_id: opts.locationId ?? null,
    triggered_by: opts.triggeredBy,
    is_active: true,
  }).returning().get();

  const eventWeather = EVENT_WEATHER[type];
  if (eventWeather) {
    // Same write as the world router's setWeather; `world.state` is marked
    // dirty below. Never shorten a spell of that weather already running.
    const eventMinutes = def.durationHours * 60;
    db.update(worldState).set({
      weather: eventWeather,
      weather_duration: world.weather === eventWeather
        ? Math.max(world.weather_duration, eventMinutes)
        : eventMinutes,
    }).where(eq(worldState.id, world.id)).run();
  }

  if (opts.announce ?? true) {
    logActivity({
      type: opts.triggeredBy === 'player' ? 'player_event' : 'world_event',
      // The player's own events read as theirs in the "✦ You" feed tab.
      templateData: { description: opts.triggeredBy === 'player' ? `You called a ${name}: ${description}` : `${name}: ${description}` },
    });
    const activeAgents = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all();
    for (const agent of activeAgents) {
      // Name and description apart: the memory puts each in its own sentence.
      simEvents.emit('event:world', { agentId: agent.id, name, description });
    }
  }

  emitter.markDirty('world.state');
  return { ok: true, event };
}

function cooldownDays(type: string): number {
  const def = (WORLD_EVENTS as Record<string, WorldEventDef>)[type];
  return def?.random?.cooldownDays ?? CONFIG.EVENTS.RANDOM_TYPE_COOLDOWN_DAYS;
}

const LONGEST_COOLDOWN_DAYS = Math.max(
  CONFIG.EVENTS.RANDOM_TYPE_COOLDOWN_DAYS,
  ...Object.values(WORLD_EVENTS as Record<string, WorldEventDef>).map((d) => d.random?.cooldownDays ?? 0),
);

/** Event types started within their own cooldown (WorldEventDef.random.cooldownDays) before `nowMinutes`. */
function recentlyStartedTypes(nowMinutes: number): Set<string> {
  const since = nowMinutes - LONGEST_COOLDOWN_DAYS * 1440;
  return new Set(
    db.select({ type: worldEvents.type, started_at: worldEvents.started_at }).from(worldEvents)
      .where(gte(worldEvents.started_at, since))
      .all()
      .filter((r) => r.started_at >= nowMinutes - cooldownDays(r.type) * 1440)
      .map((r) => r.type),
  );
}

export function eventsTick(): void {
  const world = db.select().from(worldState).get();
  if (!world) return;

  let eventsChanged = false;

  // --- 1. Expire Events ---
  const activeEvents = db.select().from(worldEvents).where(eq(worldEvents.is_active, true)).all();

  // Game minutes on both sides. The expiry used to be a tick stamp converted
  // with the CURRENT tick_speed, so changing speed mid-event rescaled the whole
  // event: a 3-hour storm started at 4x and switched to 1x after 10 ticks ended
  // 35 game minutes later instead of 140.
  const nowMinutes = gameMinutes(world.time!);
  const stillActive: WorldEventRow[] = [];
  for (const event of activeEvents) {
    if (nowMinutes >= event.started_at + event.duration * 60) {
      db.update(worldEvents).set({ is_active: false }).where(eq(worldEvents.id, event.id)).run();
      eventsChanged = true;
      if (event.type === 'mysterious_stranger') strangerLeaves(nowMinutes);
    } else {
      stillActive.push(event);
    }
  }

  // --- 2. Weather Transitions ---
  if (world.weather_duration <= 0) {
    // An event that brings its own weather holds it until the event ends. It
    // normally set a spell exactly as long as itself, but the player can
    // override the weather mid-storm, and that spell running out must not roll
    // clear skies under an active storm.
    const forcing = stillActive.find((e) => EVENT_WEATHER[e.type as WorldEventType]);
    let newWeather: string;
    let newDuration: number; // game minutes; decremented by tick_speed below
    if (forcing) {
      newWeather = EVENT_WEATHER[forcing.type as WorldEventType]!;
      newDuration = forcing.started_at + forcing.duration * 60 - nowMinutes;
    } else {
      const season = world.time!.season;
      const weights = WEATHER_WEIGHTS[season] ?? WEATHER_WEIGHTS.spring;

      const weatherItems = Object.entries(weights).map(([value, weight]) => ({
        value,
        weight,
      }));
      newWeather = weightedRandom(weatherItems);

      const minHours = CONFIG.EVENTS.WEATHER_DURATION_RANGE.min;
      const maxHours = CONFIG.EVENTS.WEATHER_DURATION_RANGE.max;
      const durationHours =
        minHours + Math.floor(Math.random() * (maxHours - minHours + 1));
      newDuration = durationHours * 60;
    }

    db.update(worldState).set({
      weather: newWeather,
      weather_duration: newDuration,
    }).where(eq(worldState.id, world.id)).run();
    eventsChanged = true;
  } else {
    db.update(worldState).set({
      weather_duration: world.weather_duration - world.tick_speed,
    }).where(eq(worldState.id, world.id)).run();
  }

  // --- 3. Random Events (once per game hour) ---
  // Roll when the clock crosses an hour. This used to require `minute === 0`,
  // which the clock never lands on at 2x (odd start) or 4x (start not a multiple
  // of 4): random events silently stopped at any speed above 1.
  if (!hourChanged(world.pending_transitions)) {
    if (eventsChanged) emitter.markDirty('world.state');
    return;
  }

  if (Math.random() >= randomEventChancePerHour()) {
    if (eventsChanged) emitter.markDirty('world.state');
    return;
  }

  // Re-query active events to account for any we just expired
  const currentActiveEvents = db.select().from(worldEvents).where(eq(worldEvents.is_active, true)).all();

  if (currentActiveEvents.length >= CONFIG.EVENTS.MAX_CONCURRENT_EVENTS) {
    if (eventsChanged) emitter.markDirty('world.state');
    return;
  }

  // Determine current day phase
  const hour = world.time!.hour;
  let currentPhase = 'night';
  for (const [phase, range] of Object.entries(CONFIG.TIME.DAY_PHASES)) {
    if (range.start < range.end) {
      if (hour >= range.start && hour < range.end) {
        currentPhase = phase;
        break;
      }
    } else {
      // Wraps around midnight (night: 20-5)
      if (hour >= range.start || hour < range.end) {
        currentPhase = phase;
        break;
      }
    }
  }

  // Filter to eligible events
  const activeTypes = new Set(currentActiveEvents.map((e) => e.type));
  // Per-type cooldown: a type that started (by any trigger) in the last
  // RANDOM_TYPE_COOLDOWN_DAYS is not rolled again. With ~5 random events a day
  // over a small eligible pool, playtest #3 got Bountiful Catch and Full Moon
  // three times each in about two game days — the same news every few hours.
  const recentTypes = recentlyStartedTypes(gameMinutes(world.time!));
  const eligible = (Object.keys(WORLD_EVENTS) as WorldEventType[]).flatMap((type) => {
    const random = (WORLD_EVENTS[type] as WorldEventDef).random;
    // Weight 0 means "never on its own" (weddings belong to a real couple now):
    // left in, a lone eligible zero-weight entry made weightedRandom throw.
    return random && random.weight > 0 && !activeTypes.has(type) && !recentTypes.has(type)
      && random.condition(currentPhase, world.weather, world.time!.season)
      ? [{ value: type, weight: random.weight }]
      : [];
  });

  if (eligible.length === 0) {
    if (eventsChanged) emitter.markDirty('world.state');
    return;
  }

  // Limits were checked above against the same active set.
  startWorldEvent(weightedRandom(eligible), { triggeredBy: 'random', enforceLimits: false });
}
