/**
 * The single source of truth for world events.
 *
 * There used to be four copies of these definitions (systems/events.ts,
 * routers/world.ts, routers/nudge.ts and the client's EventMenu) that had
 * drifted apart: the same event had different durations depending on who
 * started it, and the player-only `scandal`/`blessing` carried effect keys no
 * system read, so they did nothing. Every event now starts through
 * `startWorldEvent` (engine/systems/events.ts) with a definition from here.
 *
 * Pure data: the client imports this module directly.
 */

/**
 * Every effect key a system actually reads. Typing `effects` against this list
 * turns an effect nobody consumes into a compile error instead of a no-op.
 *
 * Additive (summed across active events, identity 0):
 *   social_boost, fun_boost, romance_boost — need gain per game hour (× 0.1 / 0.05),
 *                   systems/needs.ts
 *   mood_outdoor  — mood delta for agents outside a building, systems/needs.ts
 *   mood_boost    — mood delta for everyone, systems/needs.ts
 * Multiplicative (multiplied across active events, identity 1):
 *   energy_drain  — systems/needs.ts: (value - 1) × 2 energy lost per game hour
 *   shop_prices, food_prices, farm_production — lib/economyEngine.ts
 *   gossip_boost  — gossip spread chance, systems/gossipEngine.ts
 *
 * Every reader must aggregate through `aggregateEventEffects` below. Each
 * system used to fold the active events itself and they disagreed: needs.ts
 * summed everything, so a flu (energy_drain 1.5) during a heatwave (1.3) read
 * as a 2.8× drain instead of 1.95×, while economy.ts multiplied everything.
 *
 * Behaviour that depends on *which* event is active (storms send people
 * indoors, festivals pull them to the square, ...) is keyed on the event type
 * in systems/decisions.ts, not on effects.
 */
export const EVENT_EFFECT_KEYS = [
  'social_boost',
  'fun_boost',
  'romance_boost',
  'energy_drain',
  'mood_outdoor',
  'mood_boost',
  'shop_prices',
  'food_prices',
  'farm_production',
  'gossip_boost',
] as const;
export type EventEffectKey = (typeof EVENT_EFFECT_KEYS)[number];
export type EventEffects = Partial<Record<EventEffectKey, number>>;

/**
 * How each key stacks when several events are active at once. A delta ("+10
 * social per hour") adds; a factor ("prices × 0.7") multiplies — summing two
 * factors would turn two discounts into a surcharge (0.7 + 0.5 = 1.2).
 * Typed as a full record so a new key without a rule is a compile error.
 */
export const EVENT_EFFECT_STACKING: Record<EventEffectKey, 'add' | 'multiply'> = {
  social_boost: 'add',
  fun_boost: 'add',
  romance_boost: 'add',
  mood_outdoor: 'add',
  mood_boost: 'add',
  energy_drain: 'multiply',
  shop_prices: 'multiply',
  food_prices: 'multiply',
  farm_production: 'multiply',
  gossip_boost: 'multiply',
};

/** Every key present, at its identity (0 / 1) when no active event sets it. */
export type AggregatedEventEffects = Record<EventEffectKey, number>;

/**
 * Fold the `effects` of the active events into one value per key.
 *
 * Takes the raw column values (JSON from the DB, so `unknown`): keys that are
 * not in the catalog — rows written before a key was renamed or dropped — and
 * non-numeric values are ignored, since no system reads them. Returning the
 * identity for absent keys lets readers apply a value unconditionally.
 */
export function aggregateEventEffects(effectsList: Iterable<unknown>): AggregatedEventEffects {
  const result = {} as AggregatedEventEffects;
  for (const key of EVENT_EFFECT_KEYS) {
    result[key] = EVENT_EFFECT_STACKING[key] === 'add' ? 0 : 1;
  }
  for (const effects of effectsList) {
    if (!effects || typeof effects !== 'object') continue;
    for (const [key, value] of Object.entries(effects)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (!Object.prototype.hasOwnProperty.call(EVENT_EFFECT_STACKING, key)) continue;
      const k = key as EventEffectKey;
      result[k] = EVENT_EFFECT_STACKING[k] === 'add' ? result[k] + value : result[k] * value;
    }
  }
  return result;
}

export interface WorldEventDef {
  name: string;
  description: string;
  /** Game hours. Expiry in systems/events.ts converts to ticks (× 60). */
  durationHours: number;
  effects: EventEffects;
  /** Present when the event can fire on its own once per game hour. */
  random?: {
    weight: number;
    condition: (phase: string, weather: string, season: string) => boolean;
  };
}

export const WORLD_EVENTS = {
  festival: {
    name: 'Town Festival',
    description: 'The town is celebrating with music, food, and games!',
    durationHours: 6,
    effects: { social_boost: 20, fun_boost: 15, shop_prices: 0.7 },
    random: { weight: 10, condition: (phase) => phase === 'afternoon' || phase === 'evening' },
  },
  market_day: {
    name: 'Market Day',
    description: 'Merchants have set up stalls with discounted goods.',
    durationHours: 8,
    effects: { shop_prices: 0.5 },
    random: { weight: 15, condition: (phase) => phase === 'morning' },
  },
  storm: {
    name: 'Heavy Storm',
    description: 'A heavy storm is battering the town. Best stay indoors!',
    durationHours: 3,
    effects: { mood_outdoor: -15 },
    random: { weight: 8, condition: (_phase, weather) => weather === 'cloudy' || weather === 'rainy' },
  },
  sickness: {
    name: 'Flu Outbreak',
    description: 'A flu outbreak is spreading through town. Visit the doctor!',
    durationHours: 24,
    effects: { energy_drain: 1.5 },
    random: { weight: 5, condition: (_phase, _weather, season) => season === 'winter' || season === 'autumn' },
  },
  harvest: {
    name: 'Harvest Bounty',
    description: 'An abundant harvest has brought plenty of food to town.',
    durationHours: 12,
    effects: { farm_production: 2.0, food_prices: 0.6 },
    random: { weight: 10, condition: (_phase, _weather, season) => season === 'summer' || season === 'autumn' },
  },
  traveling_merchant: {
    name: 'Traveling Merchant',
    description: 'A mysterious merchant has arrived with rare and exotic wares.',
    durationHours: 6,
    effects: { shop_prices: 0.8, fun_boost: 5 },
    random: { weight: 8, condition: (phase) => phase === 'morning' || phase === 'afternoon' },
  },
  town_meeting: {
    name: 'Town Meeting',
    description: 'The mayor has called a town meeting to discuss important matters.',
    durationHours: 2,
    effects: { social_boost: 10 },
    random: { weight: 7, condition: (phase) => phase === 'evening' },
  },
  wedding: {
    name: 'Wedding Celebration',
    description: 'Love is in the air! A couple is getting married and the whole town is invited.',
    durationHours: 6,
    effects: { social_boost: 25, fun_boost: 20, romance_boost: 10 },
    // Weight 0: a wedding is no longer a random roll with nobody at the altar.
    // lib/milestonesEngine.ts starts one for a real engaged couple, with
    // `triggered_by: 'wedding:<a>-<b>'` so the canvas can find the newlyweds
    // (STATUS C13). Kept as a `random` entry (not deleted) so the phase and
    // condition stay documented next to the other celebrations.
    random: { weight: 0, condition: (phase) => phase === 'afternoon' || phase === 'evening' },
  },
  fire_outbreak: {
    name: 'Building Fire',
    description: 'A fire has broken out! Townspeople rush to help contain the blaze.',
    durationHours: 2,
    effects: { mood_outdoor: -10, social_boost: 15 },
    random: { weight: 4, condition: (_phase, _weather, season) => season === 'summer' || season === 'autumn' },
  },
  mysterious_stranger: {
    name: 'Mysterious Stranger',
    description: 'A hooded figure has been spotted around town, whispering secrets to those who listen.',
    durationHours: 8,
    effects: { gossip_boost: 2.0 },
    random: { weight: 5, condition: (phase) => phase === 'evening' || phase === 'night' },
  },
  competition: {
    name: 'Town Competition',
    description: 'A friendly competition has been organized — fishing, cooking, or crafts!',
    durationHours: 4,
    effects: { fun_boost: 25, social_boost: 10 },
    random: {
      weight: 8,
      condition: (phase, weather) => (phase === 'morning' || phase === 'afternoon') && weather !== 'stormy',
    },
  },
  full_moon: {
    name: 'Full Moon Night',
    description: 'The full moon bathes the town in silver light. Romance and mischief fill the air.',
    durationHours: 6,
    effects: { romance_boost: 15, fun_boost: 5, mood_outdoor: 5 },
    random: { weight: 6, condition: (phase) => phase === 'night' },
  },
  heatwave: {
    name: 'Scorching Heatwave',
    description: 'An oppressive heatwave grips the town. Everyone seeks shade and cool drinks.',
    durationHours: 10,
    effects: { energy_drain: 1.3, mood_outdoor: -8, fun_boost: -5 },
    random: { weight: 7, condition: (_phase, weather, season) => season === 'summer' && weather === 'sunny' },
  },
  bountiful_catch: {
    name: 'Bountiful Catch',
    description: 'The river is teeming with fish! Anglers are having a field day.',
    durationHours: 8,
    effects: { farm_production: 1.5, fun_boost: 10 },
    random: { weight: 6, condition: (_phase, _weather, season) => season === 'spring' || season === 'summer' },
  },
  starry_night: {
    name: 'Spectacular Starry Night',
    description: 'The sky is crystal clear, revealing a breathtaking display of stars.',
    durationHours: 4,
    effects: { mood_outdoor: 10, romance_boost: 5, fun_boost: 8 },
    random: { weight: 5, condition: (phase, weather) => phase === 'night' && weather === 'sunny' },
  },

  // ── Player-only ──────────────────────────────────────────────────────────
  scandal: {
    name: 'Town Scandal',
    description: 'A shocking rumor sweeps through town, putting everyone on edge.',
    durationHours: 4,
    // Rumours travel twice as fast and the whole town is uneasy.
    effects: { gossip_boost: 2.0, mood_boost: -8 },
  },
  blessing: {
    name: 'Beautiful Day',
    description: 'The weather is perfect. Everyone feels lighter.',
    durationHours: 6,
    effects: { mood_boost: 10 },
  },

  // ── Started by other systems, with a per-instance name/description ───────
  funeral: {
    name: 'Funeral',
    description: 'The town gathers to mourn.',
    durationHours: 4,
    effects: { social_boost: 15, mood_outdoor: -5 },
  },
  new_arrival: {
    name: 'New Arrival',
    description: 'Someone new has moved to town!',
    durationHours: 1,
    effects: {},
  },
} satisfies Record<string, WorldEventDef>;

export type WorldEventType = keyof typeof WORLD_EVENTS;

/**
 * Events that bring their own weather, held for the event's whole duration.
 * The client draws rain and darkens the sky from `world.weather`, not from the
 * event list, so a "Heavy Storm" under a cloudy sky looked like nothing was
 * happening. Such an event's own `mood_outdoor` IS that weather's mood cost:
 * needs.ts drops the plain weather penalty outdoors while one is active (B18).
 */
export const EVENT_WEATHER: Partial<Record<WorldEventType, string>> = {
  storm: 'stormy',
  // A "Scorching Heatwave" under a sunny sky drew no heat at all: `hot` was only
  // ever reached by the 3% seasonal roll. The heat shimmer and the warm tint
  // key on `world.weather`, so the event has to set it like the storm does.
  heatwave: 'hot',
};

/** Events the player can start from the Events menu (`world.triggerEvent`). */
export const PLAYER_EVENT_TYPES = [
  'festival', 'storm', 'market_day', 'sickness', 'harvest', 'scandal', 'blessing',
] as const satisfies readonly WorldEventType[];

export function isWorldEventType(type: string): type is WorldEventType {
  return Object.prototype.hasOwnProperty.call(WORLD_EVENTS, type);
}
