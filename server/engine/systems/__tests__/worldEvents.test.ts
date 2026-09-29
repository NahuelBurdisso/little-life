import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { worldEvents, worldState } from '../../../db/schema';
import { CONFIG } from '../../../lib/constants';
import { gameMinutes } from '../../../lib/gameClock';
import { eventsTick, startWorldEvent } from '../events';
import { advanceClock, computeDayPhase, detectTransitions } from '../../tick';
import { clearRulesCache } from '../../../lib/worldRules';
import {
  aggregateEventEffects,
  EVENT_EFFECT_KEYS,
  EVENT_EFFECT_STACKING,
  PLAYER_EVENT_TYPES,
  WORLD_EVENTS,
  type WorldEventType,
} from '../../../data/worldEventCatalog';

/** Ensure a world row exists; returns its clock in game minutes. */
function ensureWorld(): number {
  const existing = db.select().from(worldState).get();
  if (existing) return gameMinutes(existing.time);
  db.insert(worldState).values({
    time: { day: 1, hour: 9, minute: 0, totalTicks: 540, seasonDay: 1, season: 'spring' },
    day_phase: 'morning',
    weather: 'sunny',
    weather_duration: 120,
    tick_speed: 1,
    is_paused: true,
    last_tick_completed: 0,
    current_tick_phase: 0,
    tick_id: 'test',
    pending_transitions: [],
    tax_pool: 0,
    map_width: 40,
    map_height: 30,
    collision_grid: '',
  }).run();
  return gameMinutes({ day: 1, hour: 9, minute: 0 });
}

describe('world event catalog', () => {
  it('only uses effect keys some system reads', () => {
    for (const [type, def] of Object.entries(WORLD_EVENTS)) {
      for (const key of Object.keys(def.effects)) {
        expect(EVENT_EFFECT_KEYS, `${type}.${key}`).toContain(key);
      }
    }
  });

  it('gives every player event a real effect', () => {
    // scandal and blessing used to carry keys nothing read, so they only notified.
    for (const type of PLAYER_EVENT_TYPES) {
      expect(Object.keys(WORLD_EVENTS[type].effects).length, type).toBeGreaterThan(0);
    }
  });

  it('gives every effect key a stacking rule', () => {
    for (const key of EVENT_EFFECT_KEYS) {
      expect(['add', 'multiply'], key).toContain(EVENT_EFFECT_STACKING[key]);
    }
  });

  it('keeps durations in game hours', () => {
    for (const [type, def] of Object.entries(WORLD_EVENTS)) {
      expect(def.durationHours, type).toBeGreaterThan(0);
      expect(def.durationHours, type).toBeLessThanOrEqual(24);
    }
  });
});

describe('aggregateEventEffects', () => {
  it('returns the identity for every key when no event is active', () => {
    const fx = aggregateEventEffects([]);
    expect(fx.social_boost).toBe(0);
    expect(fx.mood_boost).toBe(0);
    expect(fx.energy_drain).toBe(1);
    expect(fx.shop_prices).toBe(1);
    expect(fx.gossip_boost).toBe(1);
  });

  it('multiplies energy_drain across events instead of summing it', () => {
    // B15: needs.ts summed 1.5 + 1.3 = 2.8, i.e. (2.8 - 1) × 2 = 3.6 energy/h
    // lost during a flu + heatwave instead of (1.95 - 1) × 2 = 1.9.
    const fx = aggregateEventEffects([
      WORLD_EVENTS.sickness.effects,
      WORLD_EVENTS.heatwave.effects,
    ]);
    expect(fx.energy_drain).toBeCloseTo(1.95);
  });

  it('adds deltas and multiplies factors in the same fold', () => {
    const fx = aggregateEventEffects([
      WORLD_EVENTS.festival.effects, // social 20, fun 15, shop × 0.7
      WORLD_EVENTS.market_day.effects, // shop × 0.5
      WORLD_EVENTS.heatwave.effects, // fun -5, mood_outdoor -8
      WORLD_EVENTS.starry_night.effects, // fun 8, mood_outdoor 10
    ]);
    expect(fx.social_boost).toBe(20);
    expect(fx.fun_boost).toBe(15 - 5 + 8);
    expect(fx.mood_outdoor).toBe(2);
    expect(fx.shop_prices).toBeCloseTo(0.35);
  });

  it('ignores unknown keys, non-numbers and null rows from the DB', () => {
    const fx = aggregateEventEffects([
      null,
      'nope',
      { legacy_key: 5, gossip_boost: 'x', fun_boost: Number.NaN },
      { gossip_boost: 2 },
    ]);
    expect(fx).not.toHaveProperty('legacy_key');
    expect(fx.gossip_boost).toBe(2);
    expect(fx.fun_boost).toBe(0);
  });
});

describe('startWorldEvent', () => {
  let nowMinutes: number;
  beforeEach(() => {
    db.delete(worldEvents).run();
    nowMinutes = ensureWorld();
  });

  it('inserts the catalog definition stamped with the current game minute', () => {
    const result = startWorldEvent('scandal', { triggeredBy: 'player' });

    expect(result.ok).toBe(true);
    const row = db.select().from(worldEvents).get()!;
    expect(row).toMatchObject({
      type: 'scandal',
      name: WORLD_EVENTS.scandal.name,
      duration: WORLD_EVENTS.scandal.durationHours,
      effects: WORLD_EVENTS.scandal.effects,
      started_at: nowMinutes,
      triggered_by: 'player',
      is_active: true,
    });
  });

  it('refuses a second copy of an active event', () => {
    startWorldEvent('festival', { triggeredBy: 'player' });
    const again = startWorldEvent('festival', { triggeredBy: 'autoplay' });

    expect(again).toEqual({ ok: false, reason: 'A "Town Festival" event is already active' });
    expect(db.select().from(worldEvents).all()).toHaveLength(1);
  });

  it('refuses past the concurrency cap unless limits are waived', () => {
    const types: WorldEventType[] = ['festival', 'storm', 'market_day', 'harvest', 'sickness', 'blessing'];
    for (const type of types.slice(0, CONFIG.EVENTS.MAX_CONCURRENT_EVENTS)) {
      expect(startWorldEvent(type, { triggeredBy: 'random' }).ok).toBe(true);
    }

    expect(startWorldEvent('scandal', { triggeredBy: 'player' }).ok).toBe(false);
    expect(startWorldEvent('funeral', { triggeredBy: 'death:1', enforceLimits: false }).ok).toBe(true);
  });

  it('applies per-instance names but keeps catalog duration', () => {
    // The funeral used to be inserted with duration 240 ("4 hours") — read as 240 hours.
    const result = startWorldEvent('funeral', {
      triggeredBy: 'death:7',
      name: 'Funeral of Rosa',
      description: 'The town gathers to mourn Rosa.',
      enforceLimits: false,
      announce: false,
    });

    expect(result.ok && result.event).toMatchObject({ name: 'Funeral of Rosa', duration: 4 });
  });
});

type WorldTime = typeof worldState.$inferSelect['time'];

/** Put the world clock at day 1, 08:<startMinute>, running at `speed`, with no weather roll due. */
function resetClock(startMinute: number, speed: number): WorldTime {
  db.delete(worldEvents).run();
  ensureWorld();
  const world = db.select().from(worldState).get()!;
  const time = { ...world.time, day: 1, hour: 8, minute: startMinute };
  db.update(worldState)
    .set({ time, tick_speed: speed, weather: 'sunny', weather_duration: 1_000_000, pending_transitions: [] })
    .where(eq(worldState.id, world.id)).run();
  return time;
}

/**
 * One tick of the real clock through eventsTick, the way tick.ts does it: the
 * new time and this tick's transitions are in world_state before the phase runs.
 */
function tickEvents(time: WorldTime, speed: number): WorldTime {
  const world = db.select().from(worldState).get()!;
  const next = advanceClock(time, speed);
  const transitions = detectTransitions(time, computeDayPhase(time.hour), next, computeDayPhase(next.hour));
  db.update(worldState).set({ time: next, tick_speed: speed, pending_transitions: transitions })
    .where(eq(worldState.id, world.id)).run();
  eventsTick();
  return next;
}

describe('eventsTick random-event roll', () => {
  afterEach(() => vi.restoreAllMocks());

  function rollsOver(speed: number, startMinute: number, hours: number): number {
    let time = resetClock(startMinute, speed);
    // With no weather roll due, the hourly gate is the only Math.random call.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999); // roll, but never start one
    for (let i = 0; i < (hours * 60) / speed; i++) time = tickEvents(time, speed);
    const calls = random.mock.calls.length;
    random.mockRestore();
    return calls;
  }

  for (const speed of [1, 2, 4]) {
    it(`rolls once per game hour at ${speed}x from an off-hour start`, () => {
      // The old `minute === 0` gate never rolled at 2x/4x from :15 (17, 19, ... / 19, 23, ...).
      expect(rollsOver(speed, 15, 6)).toBe(6);
      expect(rollsOver(speed, 0, 6)).toBe(6);
    });
  }
});

describe('eventsTick under the Drama Intensity rule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    db.update(worldState).set({ rule_overrides: null }).run();
    clearRulesCache();
  });

  /** Events started over one game hour with every roll at `roll`. */
  function eventsStartedAt(drama: string, roll: number): number {
    let time = resetClock(15, 1);
    db.update(worldState).set({ rule_overrides: { dramaIntensity: drama } }).run();
    clearRulesCache();
    vi.spyOn(Math, 'random').mockReturnValue(roll);
    for (let i = 0; i < 60; i++) time = tickEvents(time, 1);
    return db.select().from(worldEvents).all().length;
  }

  it("starts an hour's event at a roll only chaos passes", () => {
    // 0.3 is over the 0.20 base (medium) and under 0.20 x 2.5 (chaos).
    expect(eventsStartedAt('medium', 0.3)).toBe(0);
    expect(eventsStartedAt('chaos', 0.3)).toBe(1);
  });

  it("skips an hour's event at a roll low drama no longer passes", () => {
    // 0.15 is under the base 0.20 and over 0.20 x 0.5 (low).
    expect(eventsStartedAt('medium', 0.15)).toBe(1);
    expect(eventsStartedAt('low', 0.15)).toBe(0);
  });
});

describe('storm weather', () => {
  afterEach(() => vi.restoreAllMocks());

  const stormMinutes = WORLD_EVENTS.storm.durationHours * 60;
  const weather = () => db.select({ weather: worldState.weather, duration: worldState.weather_duration })
    .from(worldState).get()!;
  const setWeather = (w: string, duration: number) =>
    db.update(worldState).set({ weather: w, weather_duration: duration }).run();

  it('turns the sky stormy for the length of the event', () => {
    resetClock(15, 1);
    startWorldEvent('storm', { triggeredBy: 'player', announce: false });
    expect(weather()).toEqual({ weather: 'stormy', duration: stormMinutes });
  });

  it('does not cut short a longer storm spell already running', () => {
    resetClock(15, 1);
    setWeather('stormy', stormMinutes * 3);
    startWorldEvent('storm', { triggeredBy: 'player', announce: false });
    expect(weather()).toEqual({ weather: 'stormy', duration: stormMinutes * 3 });
  });

  it('keeps it stormy when the weather spell runs out mid-storm, then lets the roll resume', () => {
    let time = resetClock(15, 4);
    startWorldEvent('storm', { triggeredBy: 'player', announce: false });
    vi.spyOn(Math, 'random').mockReturnValue(0.999); // a roll would pick the season's last entry, never stormy

    // 5 ticks in, the player's own 0-length spell (or any shorter one) runs out.
    for (let i = 0; i < 5; i++) time = tickEvents(time, 4);
    setWeather('sunny', 0);
    time = tickEvents(time, 4);
    expect(weather()).toEqual({ weather: 'stormy', duration: stormMinutes - 6 * 4 });

    // Storm over and its spell spent: the ordinary seasonal roll takes back over.
    while (db.select().from(worldEvents).get()!.is_active) time = tickEvents(time, 4);
    setWeather('stormy', 0);
    tickEvents(time, 4);
    expect(weather().weather).not.toBe('stormy');
  });
});

describe('heatwave weather', () => {
  afterEach(() => vi.restoreAllMocks());

  const heatMinutes = WORLD_EVENTS.heatwave.durationHours * 60;
  const weather = () => db.select({ weather: worldState.weather, duration: worldState.weather_duration })
    .from(worldState).get()!;

  it('turns the sky hot for the length of the event', () => {
    resetClock(15, 1);
    startWorldEvent('heatwave', { triggeredBy: 'player', announce: false });
    expect(weather()).toEqual({ weather: 'hot', duration: heatMinutes });
  });

  it('keeps it hot when the weather spell runs out mid-heatwave', () => {
    let time = resetClock(15, 4);
    startWorldEvent('heatwave', { triggeredBy: 'player', announce: false });
    vi.spyOn(Math, 'random').mockReturnValue(0.999); // a seasonal roll would give a fresh 1-4h spell, not the event's remainder
    for (let i = 0; i < 5; i++) time = tickEvents(time, 4);
    db.update(worldState).set({ weather: 'sunny', weather_duration: 0 }).run();
    time = tickEvents(time, 4);
    expect(weather()).toEqual({ weather: 'hot', duration: heatMinutes - 6 * 4 });
  });
});

describe('world event expiry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lasts its catalog duration in game minutes across a speed change', () => {
    let time = resetClock(15, 4);
    const startedAt = gameMinutes(time);
    expect(startWorldEvent('scandal', { triggeredBy: 'player', announce: false }).ok).toBe(true);
    vi.spyOn(Math, 'random').mockReturnValue(0.999); // no random events on top

    // 10 ticks at 4x, then the player drops to 1x. Converting a tick stamp with
    // the current speed used to cut the rest of the event to a quarter.
    let ticks = 0;
    while (db.select().from(worldEvents).get()!.is_active) {
      time = tickEvents(time, ticks < 10 ? 4 : 1);
      if (++ticks > 10_000) throw new Error('event never expired');
    }
    expect(gameMinutes(time) - startedAt).toBe(WORLD_EVENTS.scandal.durationHours * 60);
  });
});
