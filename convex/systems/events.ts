import { MutationCtx } from "../_generated/server";
import { Doc } from "../_generated/dataModel";
import { CONFIG } from "../engine/constants";
import { weightedRandom } from "../lib/utils";

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
    type: "festival",
    name: "Town Festival",
    description: "The town is celebrating with music, food, and games!",
    duration: 4,
    effects: { social_boost: 20, fun_boost: 15, shop_prices: 0.7 },
    weight: 10,
    condition: (phase: string) => phase === "afternoon" || phase === "evening",
  },
  {
    type: "market_day",
    name: "Market Day",
    description: "Merchants have set up stalls with discounted goods.",
    duration: 8,
    effects: { shop_prices: 0.5 },
    weight: 15,
    condition: (phase: string) => phase === "morning",
  },
  {
    type: "storm",
    name: "Heavy Storm",
    description: "A heavy storm is battering the town. Best stay indoors!",
    duration: 3,
    effects: { mood_outdoor: -15, force_indoors: 1 },
    weight: 8,
    condition: (_phase: string, weather: string) =>
      weather === "cloudy" || weather === "rainy",
  },
  {
    type: "sickness",
    name: "Flu Outbreak",
    description: "A flu outbreak is spreading through town. Visit the doctor!",
    duration: 24,
    effects: { energy_drain: 1.5, doctor_demand: 2 },
    weight: 5,
    condition: (_phase: string, _weather: string, season: string) =>
      season === "winter" || season === "autumn",
  },
  {
    type: "harvest",
    name: "Harvest Bounty",
    description: "An abundant harvest has brought plenty of food to town.",
    duration: 12,
    effects: { farm_production: 2.0, food_prices: 0.6 },
    weight: 10,
    condition: (_phase: string, _weather: string, season: string) =>
      season === "summer" || season === "autumn",
  },
];

export async function tick(
  ctx: MutationCtx,
  world: Doc<"worldState">,
): Promise<void> {
  // --- 1. Expire Events ---
  const activeEvents = await ctx.db
    .query("worldEvents")
    .withIndex("by_isActive", (q) => q.eq("isActive", true))
    .collect();

  for (const event of activeEvents) {
    const effectiveTickSpeed = Math.max(world.tickSpeed, 0.5);
    const expirationTick =
      event.startedAt + (event.duration * 60) / effectiveTickSpeed;
    if (world.time.totalTicks > expirationTick) {
      await ctx.db.patch(event._id, { isActive: false });
    }
  }

  // --- 2. Weather Transitions ---
  if (world.weatherDuration <= 0) {
    const season = world.time.season;
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

    await ctx.db.patch(world._id, {
      weather: newWeather,
      weatherDuration: newDuration,
    });
  } else {
    await ctx.db.patch(world._id, {
      weatherDuration: world.weatherDuration - world.tickSpeed,
    });
  }

  // --- 3. Random Events (once per game hour) ---
  const isNewHour = world.time.minute < world.tickSpeed;
  if (!isNewHour) return;

  if (Math.random() >= CONFIG.EVENTS.RANDOM_EVENT_CHANCE_PER_HOUR) return;

  // Re-query active events to account for any we just expired
  const currentActiveEvents = await ctx.db
    .query("worldEvents")
    .withIndex("by_isActive", (q) => q.eq("isActive", true))
    .collect();

  if (currentActiveEvents.length >= CONFIG.EVENTS.MAX_CONCURRENT_EVENTS) return;

  // Determine current day phase
  const hour = world.time.hour;
  let currentPhase = "night";
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
      def.condition(currentPhase, world.weather, world.time.season),
  );

  if (eligible.length === 0) return;

  const chosen = weightedRandom(
    eligible.map((def) => ({ value: def, weight: def.weight })),
  );

  // Insert world event
  await ctx.db.insert("worldEvents", {
    type: chosen.type,
    name: chosen.name,
    description: chosen.description,
    startedAt: world.time.totalTicks,
    duration: chosen.duration,
    effects: chosen.effects,
    locationId: null,
    triggeredBy: "random",
    isActive: true,
  });

  // Log to activity log
  await ctx.db.insert("activityLog", {
    type: "world_event",
    message: `${chosen.name}: ${chosen.description}`,
    agentIds: [],
    timestamp: world.time.totalTicks,
    realTimestamp: Date.now(),
  });
}
