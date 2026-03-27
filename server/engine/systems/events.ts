import { db } from '../../db';
import { worldState, worldEvents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { weightedRandom } from '../../lib/utils';
import { emitter } from '../emitter';
import { logActivity } from '../../lib/activityLogger';

// Season-based weather weights
const WEATHER_WEIGHTS: Record<string, Record<string, number>> = {
  spring: { sunny: 30, cloudy: 30, rainy: 30, stormy: 5, foggy: 5 },
  summer: { sunny: 50, cloudy: 25, rainy: 15, stormy: 8, foggy: 2 },
  autumn: { sunny: 20, cloudy: 35, rainy: 25, stormy: 5, foggy: 15 },
  winter: { sunny: 15, cloudy: 35, rainy: 15, stormy: 10, foggy: 25 },
};

// Random event definitions
const EVENT_DEFINITIONS = [
  {
    type: 'festival',
    name: 'Town Festival',
    description: 'The town is celebrating with music, food, and games!',
    duration: 4,
    effects: { social_boost: 20, fun_boost: 15, shop_prices: 0.7 },
    weight: 10,
    condition: (phase: string) => phase === 'afternoon' || phase === 'evening',
  },
  {
    type: 'market_day',
    name: 'Market Day',
    description: 'Merchants have set up stalls with discounted goods.',
    duration: 8,
    effects: { shop_prices: 0.5 },
    weight: 15,
    condition: (phase: string) => phase === 'morning',
  },
  {
    type: 'storm',
    name: 'Heavy Storm',
    description: 'A heavy storm is battering the town. Best stay indoors!',
    duration: 3,
    effects: { mood_outdoor: -15, force_indoors: 1 },
    weight: 8,
    condition: (_phase: string, weather: string) =>
      weather === 'cloudy' || weather === 'rainy',
  },
  {
    type: 'sickness',
    name: 'Flu Outbreak',
    description: 'A flu outbreak is spreading through town. Visit the doctor!',
    duration: 24,
    effects: { energy_drain: 1.5, doctor_demand: 2 },
    weight: 5,
    condition: (_phase: string, _weather: string, season: string) =>
      season === 'winter' || season === 'autumn',
  },
  {
    type: 'harvest',
    name: 'Harvest Bounty',
    description: 'An abundant harvest has brought plenty of food to town.',
    duration: 12,
    effects: { farm_production: 2.0, food_prices: 0.6 },
    weight: 10,
    condition: (_phase: string, _weather: string, season: string) =>
      season === 'summer' || season === 'autumn',
  },
];

export function eventsTick(): void {
  const world = db.select().from(worldState).get();
  if (!world) return;

  let eventsChanged = false;

  // --- 1. Expire Events ---
  const activeEvents = db.select().from(worldEvents).where(eq(worldEvents.is_active, true)).all();

  for (const event of activeEvents) {
    const effectiveTickSpeed = Math.max(world.tick_speed, 0.5);
    const expirationTick =
      event.started_at + (event.duration * 60) / effectiveTickSpeed;
    if (world.time!.totalTicks > expirationTick) {
      db.update(worldEvents).set({ is_active: false }).where(eq(worldEvents.id, event.id)).run();
      eventsChanged = true;
    }
  }

  // --- 2. Weather Transitions ---
  if (world.weather_duration <= 0) {
    const season = world.time!.season;
    const weights = WEATHER_WEIGHTS[season] ?? WEATHER_WEIGHTS.spring;

    const weatherItems = Object.entries(weights).map(([value, weight]) => ({
      value,
      weight,
    }));
    const newWeather = weightedRandom(weatherItems);

    const minHours = CONFIG.EVENTS.WEATHER_DURATION_RANGE.min;
    const maxHours = CONFIG.EVENTS.WEATHER_DURATION_RANGE.max;
    const durationHours =
      minHours + Math.floor(Math.random() * (maxHours - minHours + 1));
    const newDuration = durationHours * 60; // convert hours to ticks (1 tick = 1 game minute)

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
  // Only fire on exact minute 0 to prevent multi-fire at high tick speeds
  const isNewHour = world.time!.minute === 0;
  if (!isNewHour) {
    if (eventsChanged) emitter.markDirty('world.state');
    return;
  }

  if (Math.random() >= CONFIG.EVENTS.RANDOM_EVENT_CHANCE_PER_HOUR) {
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
  const eligible = EVENT_DEFINITIONS.filter(
    (def) =>
      !activeTypes.has(def.type) &&
      def.condition(currentPhase, world.weather, world.time!.season),
  );

  if (eligible.length === 0) {
    if (eventsChanged) emitter.markDirty('world.state');
    return;
  }

  const chosen = weightedRandom(
    eligible.map((def) => ({ value: def, weight: def.weight })),
  );

  // Insert world event
  db.insert(worldEvents).values({
    type: chosen.type,
    name: chosen.name,
    description: chosen.description,
    started_at: world.time!.totalTicks,
    duration: chosen.duration,
    effects: chosen.effects,
    location_id: null,
    triggered_by: 'random',
    is_active: true,
  }).run();

  // Log to activity log
  logActivity({
    type: 'world_event',
    templateData: { description: `${chosen.name}: ${chosen.description}` },
  });

  eventsChanged = true;

  if (eventsChanged) {
    emitter.markDirty('world.state');
  }
}
