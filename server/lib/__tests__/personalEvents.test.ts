import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, goals, locations, needs, relationships, worldState } from '../../db/schema';
import { CONFIG } from '../constants';
import { logActivity } from '../activityLogger';
import { personalEventsHourly, pickPersonalEvent } from '../personalEvents';

/**
 * 30-70% of a 13-resident town went a whole day without an important feed row. Residents the
 * story passed by get a small personal event of their own (at most once a day).
 */

describe('pickPersonalEvent (pure)', () => {
  it('never picks an event about someone when there is nobody to think of', () => {
    for (let i = 0; i < 20; i++) expect(pickPersonalEvent(false, () => i / 20).aboutSomeone).toBeFalsy();
  });
});

describe('personalEventsHourly', () => {
  const made: number[] = [];
  let quiet: number;
  let busy: number;
  const DAY = 11;
  const NOW = DAY * 1440 + 13 * 60;

  beforeAll(() => {
    const time = { day: DAY, hour: 13, minute: 0, totalTicks: NOW, seasonDay: DAY, season: 'spring' };
    const existing = db.select().from(worldState).get();
    if (existing) db.update(worldState).set({ time, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    else {
      db.insert(worldState).values({
        time, day_phase: 'afternoon', weather: 'sunny', weather_duration: 120, tick_speed: 1,
        is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
        pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
      }).run();
    }
    const home = db.insert(locations).values({
      name: 'Letter Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 4, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    db.update(agents).set({ current_action: { type: 'sleeping' } }).where(eq(agents.is_active, true)).run();
    const insert = (name: string) => {
      const id = db.insert(agents).values({
        name, bio: 'test', traits: [], age: 30, gender: 'female', personality: null,
        sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
        current_action: { type: 'idle' }, action_started: 0, action_queue: [],
        schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
        home, current_location: home, created_at: 0, is_active: true,
      }).returning({ id: agents.id }).get().id;
      db.insert(needs).values({
        agent_id: id, hunger: 60, energy: 60, social: 60, comfort: 60, fun: 60, mood: 60, stress: 20,
        decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES }, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
        mood_modifiers: [], last_updated: NOW,
      }).run();
      made.push(id);
      return id;
    };
    quiet = insert('Quiet Quill');
    busy = insert('Busy Bee');
    db.insert(relationships).values({
      agent_a: Math.min(quiet, busy), agent_b: Math.max(quiet, busy),
      friendship_ab: 30, friendship_ba: 30, romance_ab: 0, romance_ba: 0, trust_ab: 20, trust_ba: 20,
      familiarity: 30, status: 'acquaintances', tags: [], interaction_count: 3, average_interaction_sentiment: 0.3,
      last_interaction: 0, created_at: 0, last_updated: 0,
    }).run();
    // Busy is already in today's story.
    logActivity({ type: 'drama', initiator: busy, templateData: { description: 'Busy did something dramatic.' } });
  });

  afterAll(() => {
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  it('only acts at its check hours', () => {
    expect(personalEventsHourly(10, NOW - 180, () => 0)).toBe(0);
  });

  it('gives the overlooked resident a visible event, a mood modifier, and maybe a goal; leaves the busy one alone', () => {
    // rng 0: the roll hits and the pick is the first event (a good letter).
    expect(personalEventsHourly(13, NOW, () => 0)).toBe(1);
    const row = db.select().from(activityLog)
      .where(and(eq(activityLog.type, 'personal_event'), eq(activityLog.initiator_id, quiet))).get();
    expect(row?.importance).toBeGreaterThanOrEqual(0.6);
    expect(db.select().from(activityLog).where(and(eq(activityLog.type, 'personal_event'), eq(activityLog.initiator_id, busy))).get())
      .toBeUndefined();
    const mods = db.select().from(needs).where(eq(needs.agent_id, quiet)).get()!.mood_modifiers;
    expect(mods.some((m) => m.source.startsWith('personal:'))).toBe(true);

    // Now in today's story: no second event today.
    expect(personalEventsHourly(19, NOW + 360, () => 0)).toBe(0);
  });

  it('an event about someone seeds a goal to reconnect with them', () => {
    const DAY2 = NOW + 1440;
    // rng 0.4 picks from the 7 events: index 2 = keepsake (about someone).
    personalEventsHourly(13, DAY2, () => 0.4);
    const g = db.select().from(goals).where(and(eq(goals.agent_id, quiet), eq(goals.type, 'befriend'))).get();
    expect(g?.target_id).toBe(busy);
  });
});
