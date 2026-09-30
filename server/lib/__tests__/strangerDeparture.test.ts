import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, goals, locations, worldEvents, worldState } from '../../db/schema';
import { gameMinutes } from '../gameClock';
import { STRANGER_GOAL, strangerLeaves } from '../strangerDeparture';
import { startWorldEvent } from '../../engine/systems/events';

/**
 * Playtest #4: the hooded stranger visited 10 times in 27 days and never left,
 * and 9 of ~30 active goals were "find out who the hooded stranger is".
 */

let agentId: number;

beforeAll(() => {
  if (!db.select().from(worldState).get()) {
    db.insert(worldState).values({
      time: { day: 20, hour: 9, minute: 0, totalTicks: 0, seasonDay: 20, season: 'spring' },
      day_phase: 'morning', weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true,
      last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [],
      tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
    }).run();
  }
  const home = db.insert(locations).values({
    name: 'Stranger Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
    capacity: 4, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  agentId = db.insert(agents).values({
    name: 'Stranger Marco', bio: 'test', traits: [], age: 41, gender: 'male', personality: null,
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, current_location: home, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
});

describe('the stranger leaves', () => {
  it('recognises goals about the stranger, not other goals', () => {
    for (const g of ['Find out who the hooded stranger is.', 'Observe the hooded figure to understand their motives.',
      'Keep a close eye on the mysterious stranger.']) expect(STRANGER_GOAL.test(g), g).toBe(true);
    for (const g of ['Impress Yuki with my wit.', 'Find a way to earn a bit more.']) expect(STRANGER_GOAL.test(g), g).toBe(false);
  });

  it('announces the departure and settles the questions it raised', () => {
    const goal = (description: string) => db.insert(goals).values({
      agent_id: agentId, type: 'investigate', target_id: null, motivation: 'curiosity', priority: 0.5,
      created_at: 0, description, source: 'llm',
    }).returning({ id: goals.id }).get().id;
    const about = goal('Find out who the hooded stranger is.');
    const other = goal('Find a way to earn a bit more than my usual scraps.');

    expect(strangerLeaves(30_000)).toBe(1);

    const status = (id: number) => db.select({ s: goals.status }).from(goals).where(eq(goals.id, id)).get()!.s;
    expect(status(about)).toBe('completed');
    expect(status(other)).toBe('active');
    const lines = db.select().from(activityLog).where(eq(activityLog.type, 'world_event')).all()
      .map((r) => (r.template_data as { description?: string }).description ?? '');
    expect(lines.some((d) => d.startsWith('The Stranger Leaves'))).toBe(true);
  });
});

describe('story events wait out a longer cooldown', () => {
  it('the auto-nudger cannot bring the stranger or a storm back early; the player can', () => {
    db.delete(worldEvents).run();
    const now = gameMinutes(db.select().from(worldState).get()!.time);
    const past = (type: string, daysAgo: number) => db.insert(worldEvents).values({
      type, name: type, description: 'test', started_at: now - daysAgo * 1440, duration: 1, effects: {},
      triggered_by: 'random', is_active: false,
    }).run();
    past('mysterious_stranger', 5); // inside its 10 days
    past('storm', 3); // inside its 5 days
    past('christening', 3); // no own cooldown, so the default 2 days: over

    expect(startWorldEvent('mysterious_stranger', { triggeredBy: 'autoplay', announce: false }).ok).toBe(false);
    expect(startWorldEvent('storm', { triggeredBy: 'autoplay', announce: false }).ok).toBe(false);
    expect(startWorldEvent('christening', { triggeredBy: 'autoplay', announce: false }).ok).toBe(true);
    expect(startWorldEvent('storm', { triggeredBy: 'player', announce: false }).ok).toBe(true);
    db.delete(worldEvents).run();
  });
});
