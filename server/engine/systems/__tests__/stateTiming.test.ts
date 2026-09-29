import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, agentStates, locations, worldState } from '../../../db/schema';
import { statesTick } from '../states';
import { advanceClock, computeDayPhase, detectTransitions } from '../../tick';
import { gameMinutes } from '../../../lib/gameClock';
import { gameMinutesNow } from '../../../lib/worldClock';

type WorldTime = typeof worldState.$inferSelect['time'];

function ensureWorld(): void {
  if (db.select().from(worldState).get()) return;
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
}

function setClock(time: WorldTime, speed: number, transitions: Record<string, unknown>[] = []): void {
  db.update(worldState).set({ time, tick_speed: speed, pending_transitions: transitions }).run();
}

/** One tick of the real clock, then the states phase, the way tick.ts runs it. */
function tickStates(time: WorldTime, speed: number): WorldTime {
  const next = advanceClock(time, speed);
  setClock(next, speed, detectTransitions(time, computeDayPhase(time.hour), next, computeDayPhase(next.hour)));
  statesTick();
  return next;
}

function stateOf(agentId: number, type: string) {
  return db.select().from(agentStates)
    .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, type))).get();
}

describe('agent state durations are game minutes', () => {
  let agentId: number;

  beforeAll(() => {
    ensureWorld();
    const home = db.insert(locations).values({
      name: 'State clock home',
      type: 'house',
      position: { x: 0, y: 0, width: 4, height: 4 },
      entry_point: { x: 1, y: 4 },
      owner: null,
      capacity: 2,
      current_occupants: [],
      operating_hours: null,
      services: [],
      description: 'test',
    }).returning({ id: locations.id }).get().id;
    agentId = db.insert(agents).values({
      name: 'State clock subject',
      bio: 'test',
      traits: [],
      // No personality and no needs row: statesTick skips trigger evaluation and
      // the death check for this agent, so expiry is the only thing that runs.
      personality: null,
      age: 30,
      gender: 'female',
      sprite_sheet: 'x',
      portrait_sprite: 'x',
      position: { x: 0, y: 0 },
      current_destination: null,
      current_location: null,
      current_action: { type: 'idle' },
      action_started: 0,
      action_duration: null,
      action_queue: [],
      current_path: null,
      schedule: {
        wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [],
      },
      home,
      workplace: null,
      created_at: Date.now(),
      is_active: true,
    }).returning({ id: agents.id }).get().id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.delete(agentStates).where(eq(agentStates.agent_id, agentId)).run();
  });

  it('stamps states on the game-minute clock', () => {
    const time = { ...db.select().from(worldState).get()!.time, day: 3, hour: 8, minute: 15 };
    setClock(time, 4);
    expect(gameMinutesNow()).toBe(gameMinutes(time));
  });

  it('ends a 120-minute drunk spell after 120 game minutes at 4x, and stamps the hangover', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    let time = { ...db.select().from(worldState).get()!.time, day: 1, hour: 20, minute: 15 };
    setClock(time, 4);
    db.insert(agentStates).values({
      agent_id: agentId, type: 'drunk', severity: 0.5,
      started_at: gameMinutesNow(), duration: 120, source: 'test', metadata: null,
    }).run();

    // Tick-stamped, this took 120 ticks = 8 game hours at 4x.
    let ticks = 0;
    while (stateOf(agentId, 'drunk')) {
      time = tickStates(time, 4);
      if (++ticks > 1000) throw new Error('drunk never expired');
    }
    expect(ticks).toBe(30);
    expect(stateOf(agentId, 'hungover')?.started_at).toBe(gameMinutes(time));
  });
});
