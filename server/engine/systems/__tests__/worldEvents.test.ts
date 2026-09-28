import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { worldEvents, worldState } from '../../../db/schema';
import { CONFIG } from '../../../lib/constants';
import { eventsTick, startWorldEvent } from '../events';
import { advanceClock, computeDayPhase, detectTransitions } from '../../tick';
import {
  aggregateEventEffects,
  EVENT_EFFECT_KEYS,
  EVENT_EFFECT_STACKING,
  PLAYER_EVENT_TYPES,
  WORLD_EVENTS,
  type WorldEventType,
} from '../../../data/worldEventCatalog';

function ensureWorld(): number {
  const existing = db.select().from(worldState).get();
  if (existing) return existing.time.totalTicks;
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
  return 540;
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
  let tick: number;
  beforeEach(() => {
    db.delete(worldEvents).run();
    tick = ensureWorld();
  });

  it('inserts the catalog definition stamped with the current tick', () => {
    const result = startWorldEvent('scandal', { triggeredBy: 'player' });

    expect(result.ok).toBe(true);
    const row = db.select().from(worldEvents).get()!;
    expect(row).toMatchObject({
      type: 'scandal',
      name: WORLD_EVENTS.scandal.name,
      duration: WORLD_EVENTS.scandal.durationHours,
      effects: WORLD_EVENTS.scandal.effects,
      started_at: tick,
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

describe('eventsTick random-event roll', () => {
  afterEach(() => vi.restoreAllMocks());

  // Drive the real clock through eventsTick the way tick.ts does: new time and
  // this tick's transitions are in world_state before the phase runs.
  function runHours(speed: number, startMinute: number, hours: number): number {
    db.delete(worldEvents).run();
    ensureWorld();
    const world = db.select().from(worldState).get()!;
    let time = { ...world.time, day: 1, hour: 8, minute: startMinute };
    // No weather roll in the window, so the hourly gate is the only Math.random call.
    db.update(worldState).set({ tick_speed: speed, weather_duration: 1_000_000 })
      .where(eq(worldState.id, world.id)).run();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999); // roll, but never start one

    for (let i = 0; i < (hours * 60) / speed; i++) {
      const next = advanceClock(time, speed);
      const transitions = detectTransitions(time, computeDayPhase(time.hour), next, computeDayPhase(next.hour));
      db.update(worldState).set({ time: next, pending_transitions: transitions })
        .where(eq(worldState.id, world.id)).run();
      eventsTick();
      time = next;
    }
    const calls = random.mock.calls.length;
    random.mockRestore();
    return calls;
  }

  for (const speed of [1, 2, 4]) {
    it(`rolls once per game hour at ${speed}x from an off-hour start`, () => {
      // The old `minute === 0` gate never rolled at 2x/4x from :15 (17, 19, ... / 19, 23, ...).
      expect(runHours(speed, 15, 6)).toBe(6);
      expect(runHours(speed, 0, 6)).toBe(6);
    });
  }
});
