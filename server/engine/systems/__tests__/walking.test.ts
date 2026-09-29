import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// No LLM: the decisions pass requests a plan for an agent without one.
vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn(), callOllamaEmbedding: vi.fn() }));

import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, economy, locations, needs } from '../../../db/schema';
import { callOllamaChat, callOllamaEmbedding } from '../../../ai/ollama';
import {
  tick as decisionsTick, sleepWindow, commuteLeadMinutes, isCommuteDue, checkEmergency,
} from '../decisions';
import { sleepDurationMinutes, effectiveSleepWindow } from '../../../lib/sleepSchedule';
import { isPastBedtime } from '../../../lib/conversationPacing';
import { tick as movementTick, invalidateCostMap } from '../movement';
import { CONFIG } from '../../../lib/constants';
import { zoneSlotOffset } from '../../../lib/interiorGrid';
import { INTERIOR_ZONES } from '../../../data/interiors';

/**
 * E6: walking dominated the day. The pieces that were walking for nothing:
 * leaving the place you are already in to re-enter it, standing on a reached
 * destination for a tick, a conversation detour starting the interrupted
 * errand in the street, and a commute that always came out of the shift.
 */

const T = 32;
const tag = `walk-${Date.now()}`;
// Far from the other files' rows in this worker's DB (they sit near 0,0), so
// footprint lookups only ever find this file's buildings.
const OX = 200 * T;
const MAP_W = 230;
const MAP_H = 20;

let otherActive: number[] = [];
let farmId: number;
let homeId: number;
let parkId: number;
const made: number[] = [];

function world(hour: number, minute = 0, speed = 1) {
  return {
    time: { day: 2, hour, minute, totalTicks: 2 * 1440 + hour * 60 + minute, seasonDay: 1, season: 'spring' },
    tick_speed: speed,
    collision_grid: '0'.repeat(MAP_W * MAP_H),
    map_width: MAP_W,
    map_height: MAP_H,
  };
}

function farmer(opts: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name: `${tag} farmer ${made.length}`, bio: 'test', traits: [], personality: null, age: 40, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: OX + 2 * T, y: 2 * T },
    current_destination: null, current_location: farmId, current_action: { type: 'working' },
    action_started: 0, action_duration: 1, action_queue: [], current_path: null,
    schedule: { wakeTime: 5, sleepTime: 21, workStart: 6, workEnd: 15, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, workplace: farmId, created_at: 0, is_active: true,
    ...opts,
  }).returning({ id: agents.id }).get().id;
  db.insert(needs).values({
    agent_id: id, hunger: 90, energy: 90, social: 90, comfort: 90, fun: 90, mood: 80, stress: 10,
    decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES }, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
    mood_modifiers: [], last_updated: 0,
  }).run();
  db.insert(economy).values({
    agent_id: id, job: 'farmer', job_title: 'Farmer', salary: 10, work_performance: 0.5,
    money: 50, daily_expenses: 0, inventory: [], last_payday: 0, production_remainder: 0,
  }).run();
  made.push(id);
  return id;
}

const row = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
  vi.mocked(callOllamaChat).mockImplementation(() => { throw new Error('connect ECONNREFUSED'); });
  vi.mocked(callOllamaEmbedding).mockImplementation(() => { throw new Error('connect ECONNREFUSED'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  otherActive = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all().map((r) => r.id);
  if (otherActive.length) db.update(agents).set({ is_active: false }).where(inArray(agents.id, otherActive)).run();
  invalidateCostMap();

  farmId = db.insert(locations).values({
    name: `${tag} Farm`, type: 'farm',
    position: { x: OX, y: 0, width: 10 * T, height: 7 * T }, entry_point: { x: OX + 5 * T, y: 7 * T },
    capacity: 6, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  parkId = db.insert(locations).values({
    name: `${tag} Park`, type: 'park',
    position: { x: OX + 30 * T, y: 0, width: 8 * T, height: 6 * T }, entry_point: { x: OX + 34 * T, y: 6 * T },
    capacity: 10, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  homeId = db.insert(locations).values({
    name: `${tag} Home`, type: 'home',
    position: { x: OX + 20 * T, y: 2 * T, width: 3 * T, height: 3 * T }, entry_point: { x: OX + 21.5 * T, y: 5 * T },
    capacity: 2, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
});

afterAll(() => {
  if (made.length) db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  if (otherActive.length) db.update(agents).set({ is_active: true }).where(inArray(agents.id, otherActive)).run();
  invalidateCostMap();
  vi.unstubAllGlobals();
});

describe('a worker already at work', () => {
  it('walks straight to the work spot instead of out to the gate and back', () => {
    const id = farmer();
    decisionsTick(world(10));
    const a = row(id);
    expect(a.current_action).toMatchObject({ type: 'walking' });
    const zone = INTERIOR_ZONES.farm.find((z) => z.allowedActions.includes('working'))!;
    const slot = zoneSlotOffset(id);
    expect(a.current_destination).toEqual({
      x: OX + zone.center[0] * T + 16 + slot.dx, y: zone.center[1] * T + 16 + slot.dy, locationId: farmId,
    });
    // Not the entry_point, the old first leg of every re-decision.
    expect(a.current_destination).not.toMatchObject({ x: OX + 5 * T, y: 7 * T });
    // What arrival needs: the zone (effects run for open areas too) and the length.
    expect(a.action_queue[0]).toMatchObject({
      type: 'working', _arrivalZone: zone.id, _arrivalBuilding: 'farm', _duration: 60,
    });
    expect(a.action_queue[0]).not.toHaveProperty('zoneX');
    db.update(agents).set({ is_active: false }).where(eq(agents.id, id)).run();
  });
});

describe('arrival', () => {
  it('starts the queued action on the tick the walker reaches the spot', () => {
    const spot = { x: OX + 3 * T, y: 2 * T };
    const id = farmer({
      position: { x: spot.x - 10, y: spot.y },
      current_action: { type: 'walking' }, current_destination: { ...spot, locationId: farmId },
      current_path: [[spot.x, spot.y]], action_queue: [{ type: 'working' }], action_duration: null,
    });
    movementTick(world(10, 0, 4));
    const a = row(id);
    expect(a.position).toEqual(spot);
    expect(a.current_action).toMatchObject({ type: 'working' });
    expect(a.current_destination).toBeNull();
    db.update(agents).set({ is_active: false }).where(eq(agents.id, id)).run();
  });

  it('does not start the interrupted errand at the end of a walk over to talk', () => {
    const spot = { x: OX + 12 * T, y: 9 * T };
    const id = farmer({
      position: { x: spot.x - 4, y: spot.y }, current_location: null,
      current_action: { type: 'walking', reason: 'approaching_conversation' },
      current_destination: spot, current_path: [[spot.x, spot.y]],
      // Left over from the walk to work the conversation replaced.
      action_queue: [{ type: 'working' }], action_duration: null,
    });
    movementTick(world(10));
    const a = row(id);
    expect(a.current_action).toEqual({ type: 'idle' });
    expect(a.action_queue).toEqual([]);
    db.update(agents).set({ is_active: false }).where(eq(agents.id, id)).run();
  });
});

describe('zone activities in open areas', () => {
  it('lands a fish on arriving at the park riverside', () => {
    const riverside = INTERIOR_ZONES.park.find((z) => z.id === 'riverside')!;
    const spot = { x: OX + 30 * T + riverside.center[0] * T + 16, y: riverside.center[1] * T + 16 };
    const id = farmer({
      position: { x: spot.x - 6, y: spot.y }, current_location: parkId,
      current_action: { type: 'walking' }, current_destination: { ...spot, locationId: parkId },
      current_path: [[spot.x, spot.y]], action_duration: null,
      action_queue: [{ type: 'idle', zoneActivity: 'fish', _arrivalZone: 'riverside', _arrivalBuilding: 'park', _duration: 10 }],
    });
    movementTick(world(10));
    const inv = db.select().from(economy).where(eq(economy.agent_id, id)).get()!.inventory as { itemId: string; quantity: number }[];
    expect(inv.find((i) => i.itemId === 'food_raw')?.quantity).toBeGreaterThanOrEqual(1);
    expect(row(id).current_action).toEqual({ type: 'idle', zoneActivity: 'fish' });
    db.update(agents).set({ is_active: false }).where(eq(agents.id, id)).run();
  });

  it('converts a queue saved before the change (zoneX/zoneY) into a walk to the spot', () => {
    const spot = { x: OX + 3 * T + 16, y: 1 * T + 16 };
    const gate = { x: OX + 5 * T, y: 7 * T };
    const id = farmer({
      position: { x: gate.x - 2, y: gate.y }, current_location: farmId,
      current_action: { type: 'walking' }, current_destination: { ...gate, locationId: farmId },
      current_path: [[gate.x, gate.y]], action_duration: null,
      action_queue: [{ type: 'working', zoneX: spot.x, zoneY: spot.y, targetZone: 'crops_north', targetBuildingType: 'farm' }],
    });
    movementTick(world(10));
    const a = row(id);
    expect(a.current_destination).toEqual(spot);
    expect(a.action_queue[0]).toEqual({ type: 'working', _arrivalZone: 'crops_north', _arrivalBuilding: 'farm' });
    db.update(agents).set({ is_active: false }).where(eq(agents.id, id)).run();
  });
});

describe('a walked-to sleep', () => {
  it('keeps the length decided for it: ends at the wake time, not six hours later', () => {
    const sched = { wakeTime: 7, sleepTime: 22, workStart: 8, workEnd: 16, lunchTime: 12, freeTimePreferences: [] };
    const id = farmer({ current_action: { type: 'idle' }, schedule: sched });
    decisionsTick(world(2, 30));
    const walking = row(id);
    expect(walking.action_queue[0]).toMatchObject({ type: 'sleeping', _duration: 270 });
    // Put them at the bed and let movement finish the walk.
    const dest = walking.current_destination!;
    db.update(agents).set({ position: { x: dest.x - 3, y: dest.y }, current_path: [[dest.x, dest.y]] })
      .where(eq(agents.id, id)).run();
    movementTick(world(2, 30));
    const asleep = row(id);
    expect(asleep.current_action).toMatchObject({ type: 'sleeping' });
    expect(asleep.action_duration).toBe(270); // 02:30 → 07:00
    db.update(agents).set({ is_active: false }).where(eq(agents.id, id)).run();
  });
});

describe('the commute', () => {
  it('sets off before the shift so the walk does not come out of it', () => {
    const id = farmer({
      position: { x: OX + 21.5 * T, y: 5 * T }, current_location: homeId, current_action: { type: 'idle' },
      schedule: { wakeTime: 5, sleepTime: 21, workStart: 8, workEnd: 16, lunchTime: 12, freeTimePreferences: [] },
    });
    const locs = db.select().from(locations).where(inArray(locations.id, [farmId, homeId])).all();
    const lead = commuteLeadMinutes(row(id), locs);
    // Door to door is 16.5 tiles = 33 min at 16 px/min; +30% and 10 min.
    expect(lead).toBe(Math.round((Math.hypot(16.5 * T, 2 * T) / 16) * 1.3 + 10));
    const leave = 8 * 60 - lead;
    decisionsTick(world(Math.floor(leave / 60), leave % 60));
    expect(row(id).current_destination).toMatchObject({ locationId: farmId });
    expect(row(id).action_queue[0]).toMatchObject({ type: 'working' });
    db.update(agents).set({ is_active: false }).where(eq(agents.id, id)).run();
  });

  it('is due before midnight for a shift at 00:00', () => {
    const locs = db.select().from(locations).where(inArray(locations.id, [farmId, homeId])).all();
    const night = {
      home: homeId, workplace: farmId,
      schedule: { wakeTime: 14, sleepTime: 8, workStart: 0, workEnd: 8, lunchTime: 4, freeTimePreferences: [] },
    };
    expect(isCommuteDue(night, locs, 23, 40)).toBe(true);
    expect(isCommuteDue(night, locs, 22, 0)).toBe(false);
    expect(isCommuteDue(night, locs, 0, 0)).toBe(false); // the shift has started
  });

  it('allows for the walk at most two hours ahead', () => {
    const far = [{ id: 1, entry_point: { x: 0, y: 0 } }, { id: 2, entry_point: { x: 100_000, y: 0 } }];
    expect(commuteLeadMinutes({ home: 1, workplace: 2 }, far)).toBe(120);
    expect(commuteLeadMinutes({ home: 1, workplace: 99 }, far)).toBe(0);
  });
});

describe('sleep', () => {
  it('ends a sleep started in the small hours at the wake-up time', () => {
    // 04:00, wake at 7: three hours, not the full six (which ran to 10:00).
    expect(sleepDurationMinutes(4, 0, 7, 360, false)).toBe(180);
    // A 22:00 bedtime keeps the full night.
    expect(sleepDurationMinutes(22, 0, 7, 360, false)).toBe(360);
    // At least an hour, even right before the alarm.
    expect(sleepDurationMinutes(6, 45, 7, 360, false)).toBe(60);
    // An energy emergency sleeps the full length whatever the time.
    expect(sleepDurationMinutes(14, 0, 7, 360, true)).toBe(360);
  });

  it('is one window for decisions and for conversations', () => {
    const owl = { impulsiveness: 100, sensuality: 100, morality: 0, neuroticism: 0 } as never;
    const sched = { wakeTime: 7, sleepTime: 22, workStart: 8, workEnd: 16, lunchTime: 12, freeTimePreferences: [] };
    const w = effectiveSleepWindow(sched, owl, true);
    expect(sleepWindow({ schedule: sched, workplace: 3 }, owl)).toEqual({ sleep: w.sleepHour, wake: w.wakeHour });
    // At work at 07:30, the owl is awake for both: a conversation there is not
    // cut short as "past bedtime" (the unclamped window said asleep until 9).
    expect(isPastBedtime(sched, owl, 7, true)).toBe(false);
    expect(isPastBedtime(sched, owl, 7, false)).toBe(true);
  });

  it('never lets a night owl sleep into the shift', () => {
    const owl = { impulsiveness: 100, sensuality: 100, morality: 0, neuroticism: 0 } as never;
    const sched = { wakeTime: 7, sleepTime: 22, workStart: 8, workEnd: 16, lunchTime: 12, freeTimePreferences: [] };
    expect(sleepWindow({ schedule: sched, workplace: 3 }, owl).wake).toBe(7);
    // No job: the chronotype stands (7 + 2).
    expect(sleepWindow({ schedule: sched, workplace: null }, owl).wake).toBe(9);
  });
});

describe('social crisis target', () => {
  type Agent = Parameters<typeof checkEmergency>[0];
  const sched = { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] };
  const person = (id: number, action: string, x: number): Agent => ({
    id, is_active: true, personality: null, schedule: sched, home: 900 + id, workplace: null,
    position: { x, y: 0 }, current_location: 700 + id, current_action: { type: action },
  }) as unknown as Agent;
  const lonely = person(1, 'idle', 0);
  const friends = [person(2, 'sleeping', 50), person(3, 'sleeping', 90)];
  const rels = friends.map((f) => ({
    agent_a: 1, agent_b: f.id, friendship_ab: 60, friendship_ba: 60, romance_ab: 0, romance_ba: 0, trust_ab: 50, trust_ba: 50,
  })) as never;
  const needsRow = {
    hunger: 80, energy: 80, social: 5, mood: 50, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
  } as unknown as Parameters<typeof checkEmergency>[1];
  const loc = (id: number, type: string, x: number, hours: { open: number; close: number } | null = null) => ({
    id, type, position: { x, y: 0, width: 64, height: 64 }, entry_point: { x, y: 64 },
    operating_hours: hours, current_occupants: [],
  });
  const town = [loc(801, 'tavern', 100, { open: 17, close: 23 }), loc(802, 'town_square', 400)] as never;

  it('is no crisis at 03:00 inside the agent\'s own sleeping hours with every friend asleep', () => {
    expect(checkEmergency(lonely, needsRow, town, rels, [lonely, ...friends], undefined, () => null, 3)).toBeNull();
  });

  it('skips sleeping friends and a closed tavern for the square by day', () => {
    const d = checkEmergency(lonely, needsRow, town, rels, [lonely, ...friends], undefined, () => null, 15);
    expect(d).toMatchObject({ action: 'socializing', targetLocationId: 802 });
    expect(d).not.toHaveProperty('targetAgentId');
  });

  it('goes to an awake friend', () => {
    const awake = [person(2, 'sleeping', 50), person(3, 'working', 90)];
    const d = checkEmergency(lonely, needsRow, town, rels, [lonely, ...awake], undefined, () => null, 3);
    expect(d).toMatchObject({ action: 'socializing', targetAgentId: 3, targetLocationId: 703 });
  });
});
