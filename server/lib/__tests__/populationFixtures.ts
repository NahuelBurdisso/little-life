/**
 * A small, known town for the resident lifecycle and population flow tests.
 *
 * Wipes every world table first: worker DBs carry rows from earlier files
 * (server/db/testWorker.ts), and these tests count residents and empty houses,
 * so a leftover cottage or a stray living agent would change every answer.
 * (setup.initialize wipes the same tables, so later files already cope.)
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, economy, locations, needs, relationships, worldState } from '../../db/schema';
import { ALL_TABLES } from '../../db/worldTables';
import { clearRulesCache } from '../worldRules';
import { gameMinutes } from '../gameClock';

export const TIME = { day: 20, hour: 0, minute: 0, totalTicks: 28_800, seasonDay: 5, season: 'spring' };
export const NOW = gameMinutes(TIME);
export const DAY = 24 * 60;

export const PERSONALITY = {
  honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
  curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
};

export interface Town {
  homes: number[];
  bakery: number;
  tavern: number;
  square: number;
}

export function freshTown(opts: { homes?: number[]; time?: typeof TIME } = {}): Town {
  for (const table of ALL_TABLES) db.delete(table).run();
  db.insert(worldState).values({
    time: opts.time ?? TIME, day_phase: 'night', weather: 'sunny', weather_duration: 120, tick_speed: 1,
    is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
    pending_transitions: [], tax_pool: 500, map_width: 40, map_height: 30, collision_grid: '',
    road_tiles: [{ x: 20, y: 10 }, { x: 20, y: 28 }, { x: 5, y: 15 }],
  }).run();
  clearRulesCache();
  const homes = (opts.homes ?? [2, 2, 4]).map((capacity, i) => insertLocation(`Home ${i + 1}`, 'home', capacity, { x: 4 + i * 6, y: 4 }));
  return {
    homes,
    bakery: insertLocation('The Bakery', 'bakery', 6, { x: 30, y: 6 }),
    tavern: insertLocation('The Tavern', 'tavern', 12, { x: 30, y: 14 }),
    square: insertLocation('Town Square', 'town_square', 30, { x: 16, y: 16 }),
  };
}

export function insertLocation(name: string, type: string, capacity: number, tile: { x: number; y: number }): number {
  return db.insert(locations).values({
    name, type, position: { x: tile.x * 32, y: tile.y * 32, width: 128, height: 128 },
    entry_point: { x: tile.x * 32 + 64, y: tile.y * 32 + 128 },
    owner: null, capacity, current_occupants: [], operating_hours: null, services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
}

export function insertResident(
  name: string,
  home: number,
  over: Partial<typeof agents.$inferInsert> = {},
  extra: { job?: string; mood?: number; money?: number } = {},
): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 35, gender: 'female', personality: PERSONALITY,
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 100, y: 100 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, current_location: home, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  db.insert(needs).values({
    agent_id: id, hunger: 70, energy: 70, social: 60, fun: 60, comfort: 70,
    mood: extra.mood ?? 60, stress: 20,
    decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
    thresholds: { critical: 10, low: 30, satisfied: 70 } as never,
    mood_modifiers: [], last_updated: NOW,
  }).run();
  db.insert(economy).values({
    agent_id: id, job: extra.job ?? 'farmer', job_title: 'Worker', salary: 20, work_performance: 70,
    money: extra.money ?? 50, daily_expenses: 5, inventory: [], last_payday: NOW, production_remainder: 0,
  }).run();
  return id;
}

export function relate(a: number, b: number, over: Partial<typeof relationships.$inferInsert> = {}): number {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  // A newcomer's starting tie may already be there: this one replaces it.
  db.delete(relationships).where(and(eq(relationships.agent_a, lo), eq(relationships.agent_b, hi))).run();
  return db.insert(relationships).values({
    agent_a: lo, agent_b: hi,
    friendship_ab: 20, friendship_ba: 20, romance_ab: 0, romance_ba: 0,
    trust_ab: 20, trust_ba: 20, familiarity: 40, interaction_count: 5,
    last_interaction: 0, last_interaction_minute: NOW, average_interaction_sentiment: 0,
    tags: [], status: 'acquaintances', created_at: 0, last_updated: 0, ...over,
  }).returning({ id: relationships.id }).get().id;
}
