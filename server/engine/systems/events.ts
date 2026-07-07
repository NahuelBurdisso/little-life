import { db } from '../../db';
import { worldState, worldEvents, agents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { weightedRandom } from '../../lib/utils';
import { emitter } from '../emitter';
import { logActivity } from '../../lib/activityLogger';
import { simEvents } from '../../lib/simEvents';

// Season-based weather weights (including snowy for winter, windy for autumn)
const WEATHER_WEIGHTS: Record<string, Record<string, number>> = {
  spring: { sunny: 30, cloudy: 25, rainy: 25, stormy: 5, foggy: 5, windy: 10 },
  summer: { sunny: 50, cloudy: 20, rainy: 12, stormy: 8, foggy: 2, windy: 5, hot: 3 },
  autumn: { sunny: 15, cloudy: 25, rainy: 20, stormy: 5, foggy: 15, windy: 20 },
  winter: { sunny: 10, cloudy: 20, rainy: 5, stormy: 8, foggy: 15, snowy: 30, windy: 12 },
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
  {
    type: 'traveling_merchant',
    name: 'Traveling Merchant',
    description: 'A mysterious merchant has arrived with rare and exotic wares.',
    duration: 6,
    effects: { shop_prices: 0.8, fun_boost: 5 },
    weight: 8,
    condition: (phase: string) => phase === 'morning' || phase === 'afternoon',
  },
  {
    type: 'town_meeting',
    name: 'Town Meeting',
    description: 'The mayor has called a town meeting to discuss important matters.',
    duration: 2,
    effects: { social_boost: 10 },
    weight: 7,
    condition: (phase: string) => phase === 'evening',
  },
  {
    type: 'wedding',
    name: 'Wedding Celebration',
    description: 'Love is in the air! A couple is getting married and the whole town is invited.',
    duration: 6,
    effects: { social_boost: 25, fun_boost: 20, romance_boost: 10 },
    weight: 3,
    condition: (phase: string, _weather: string) =>
      phase === 'afternoon' || phase === 'evening',
  },
  {
    type: 'fire_outbreak',
    name: 'Building Fire',
    description: 'A fire has broken out! Townspeople rush to help contain the blaze.',
    duration: 2,
    effects: { mood_outdoor: -10, social_boost: 15 },
    weight: 4,
    condition: (_phase: string, _weather: string, season: string) =>
      season === 'summer' || season === 'autumn',
  },
  {
    type: 'mysterious_stranger',
    name: 'Mysterious Stranger',
    description: 'A hooded figure has been spotted around town, whispering secrets to those who listen.',
    duration: 8,
    effects: { gossip_boost: 2.0 },
    weight: 5,
    condition: (phase: string) => phase === 'evening' || phase === 'night',
  },
  {
    type: 'competition',
    name: 'Town Competition',
    description: 'A friendly competition has been organized — fishing, cooking, or crafts!',
    duration: 4,
    effects: { fun_boost: 25, social_boost: 10 },
    weight: 8,
    condition: (phase: string, weather: string) =>
      (phase === 'morning' || phase === 'afternoon') && weather !== 'stormy',
  },
  {
    type: 'full_moon',
    name: 'Full Moon Night',
    description: 'The full moon bathes the town in silver light. Romance and mischief fill the air.',
    duration: 6,
    effects: { romance_boost: 15, fun_boost: 5, mood_outdoor: 5 },
    weight: 6,
    condition: (phase: string) => phase === 'night',
  },
  {
    type: 'heatwave',
    name: 'Scorching Heatwave',
    description: 'An oppressive heatwave grips the town. Everyone seeks shade and cool drinks.',
    duration: 10,
    effects: { energy_drain: 1.3, mood_outdoor: -8, fun_boost: -5 },
    weight: 7,
    condition: (_phase: string, weather: string, season: string) =>
      season === 'summer' && weather === 'sunny',
  },
  {
    type: 'bountiful_catch',
    name: 'Bountiful Catch',
    description: 'The river is teeming with fish! Anglers are having a field day.',
    duration: 8,
    effects: { farm_production: 1.5, fun_boost: 10 },
    weight: 6,
    condition: (_phase: string, _weather: string, season: string) =>
      season === 'spring' || season === 'summer',
  },
  {
    type: 'starry_night',
    name: 'Spectacular Starry Night',
    description: 'The sky is crystal clear, revealing a breathtaking display of stars.',
    duration: 4,
    effects: { mood_outdoor: 10, romance_boost: 5, fun_boost: 8 },
    weight: 5,
    condition: (phase: string, weather: string) =>
      phase === 'night' && weather === 'sunny',
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

  // Emit world event for all active agents
  const activeAgents = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all();
  const eventDescription = `${chosen.name}: ${chosen.description}`;
  for (const agent of activeAgents) {
    simEvents.emit('event:world', { agentId: agent.id, event: eventDescription });
  }

  eventsChanged = true;

  if (eventsChanged) {
    emitter.markDirty('world.state');
  }
}
