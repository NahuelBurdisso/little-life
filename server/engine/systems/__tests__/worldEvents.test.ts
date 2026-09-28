import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../db';
import { worldEvents, worldState } from '../../../db/schema';
import { CONFIG } from '../../../lib/constants';
import { startWorldEvent } from '../events';
import {
  EVENT_EFFECT_KEYS,
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

  it('keeps durations in game hours', () => {
    for (const [type, def] of Object.entries(WORLD_EVENTS)) {
      expect(def.durationHours, type).toBeGreaterThan(0);
      expect(def.durationHours, type).toBeLessThanOrEqual(24);
    }
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
