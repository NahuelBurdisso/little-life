import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, locations, needs, worldState } from '../../db/schema';
import { statesTick } from '../../engine/systems/states';
import { updateHungerTracking, clearHungerTracking } from '../lifeEventsEngine';
import { clearRulesCache, isDeathEnabled } from '../worldRules';
import { CONFIG } from '../constants';

/**
 * B20: the wizard's "Death Enabled" rule was saved with the world and never
 * read — a town set up without death still lost its farmhand to an accident.
 */

let createdWorld = false;
let savedConfig: Record<string, unknown> | null = null;
let starving: number;

function setRules(rules: Record<string, unknown> | null): void {
  db.update(worldState).set({ setup_config: rules ? { rules } : null, rule_overrides: null }).run();
  // getRules() is cached; the server drops it on a world replace, the test has to do it itself.
  clearRulesCache();
}
const alive = () => db.select({ is_active: agents.is_active }).from(agents).where(eq(agents.id, starving)).get()!.is_active;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const w = db.select().from(worldState).get();
  if (!w) {
    createdWorld = true;
    db.insert(worldState).values({
      time: { day: 9, hour: 12, minute: 0, totalTicks: 9 * 1440 + 720, seasonDay: 9, season: 'spring' },
      day_phase: 'afternoon', weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true,
      last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
      map_width: 40, map_height: 30, collision_grid: '',
    }).run();
  } else {
    savedConfig = w.setup_config ?? null;
  }
  const home = db.insert(locations).values({
    name: 'Death rule home', type: 'house', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 1, y: 4 },
    owner: null, capacity: 2, current_occupants: [], operating_hours: null, services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  starving = db.insert(agents).values({
    name: 'Death rule subject', bio: 'test', traits: [], personality: null, age: 40, gender: 'male',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 }, current_destination: null,
    current_location: home, current_action: { type: 'idle' }, action_started: 0, action_duration: null,
    action_queue: [], current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, workplace: null, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
  db.insert(needs).values({
    agent_id: starving, hunger: 0, energy: 50, social: 50, comfort: 50, fun: 50, mood: 30, stress: 60,
    decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES }, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
    mood_modifiers: [], last_updated: 0,
  }).run();
});

afterAll(() => {
  clearHungerTracking();
  db.update(agents).set({ is_active: false }).where(eq(agents.id, starving)).run();
  if (createdWorld) db.delete(worldState).run();
  else db.update(worldState).set({ setup_config: savedConfig }).run();
  clearRulesCache();
  vi.restoreAllMocks();
});

describe('the Death Enabled rule', () => {
  it('defaults to on for worlds without a saved rule', () => {
    setRules(null);
    expect(isDeathEnabled()).toBe(true);
    setRules({ sicknessRate: 'low' });
    expect(isDeathEnabled()).toBe(true);
    setRules({ deathEnabled: false });
    expect(isDeathEnabled()).toBe(false);
  });

  it('keeps a starving agent alive when off, and lets them die when on', () => {
    updateHungerTracking(starving, 0, 5 * 1440); // five days at zero: past the 3-day gate
    setRules({ deathEnabled: false });
    statesTick();
    expect(alive()).toBe(true);

    setRules({ deathEnabled: true });
    statesTick();
    expect(alive()).toBe(false);
  });
});
