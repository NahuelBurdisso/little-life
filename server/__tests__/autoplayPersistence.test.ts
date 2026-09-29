import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { db } from '../db';
import { worldState } from '../db/schema';
import { autoplayRouter } from '../routers/autoplay';
import { worldRouter } from '../routers/world';
import { AUTOPLAY_DEFAULTS, CONFIG } from '../lib/constants';
import { loadAutoplayConfig, parseAutoplaySettings } from '../lib/autoplaySettings';
import { clearRulesCache } from '../lib/worldRules';
import { crossedBoundary } from '../lib/gameClock';
import { STORYTELLERS, matchStoryteller, DEFAULT_LIVE_RULES } from '../data/rulesCatalog';
import { getRules } from '../lib/worldRules';

/**
 * The Storyteller's autoplay half used to live only in process memory, so a
 * Chaos world read "Custom" after every reboot. It is saved on the world row
 * (`rule_overrides.autoplay`) and reloaded by `loadAutoplayConfig`.
 */

let createdWorld = false;
let saved: { rule_overrides: Record<string, unknown> | null } | null = null;
const autoplay = autoplayRouter.createCaller({} as any);
const world = worldRouter.createCaller({} as any);

/** What a fresh process has before anything is loaded. */
function bootDefaults(): void {
  Object.assign(CONFIG.AUTOPLAY, AUTOPLAY_DEFAULTS);
}

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const w = db.select().from(worldState).get();
  if (!w) {
    createdWorld = true;
    db.insert(worldState).values({
      time: { day: 1, hour: 9, minute: 0, totalTicks: 0, seasonDay: 1, season: 'spring' },
      day_phase: 'morning', weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true,
      last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
      map_width: 40, map_height: 30, collision_grid: '',
    }).run();
  } else {
    saved = { rule_overrides: w.rule_overrides ?? null };
  }
});

afterAll(() => {
  if (createdWorld) db.delete(worldState).run();
  else if (saved) db.update(worldState).set(saved).run();
  clearRulesCache();
  bootDefaults();
  vi.restoreAllMocks();
});

beforeEach(() => {
  db.update(worldState).set({ rule_overrides: null }).run();
  clearRulesCache();
  bootDefaults();
});

describe('autoplay config per world', () => {
  it('survives a restart: a Chaos world still reads as Chaos', async () => {
    const chaos = STORYTELLERS.find((p) => p.id === 'chaos')!;
    await world.setRules(chaos.rules);
    await autoplay.configure({
      enabled: chaos.autoplay.enabled,
      boredThreshold: chaos.autoplay.boredThreshold,
      autoNudge: true,
    });

    // "Reboot": memory back to shipped defaults, then load from the DB.
    bootDefaults();
    expect(CONFIG.AUTOPLAY.ENABLED).toBe(false);
    loadAutoplayConfig();

    expect(CONFIG.AUTOPLAY.ENABLED).toBe(true);
    expect(CONFIG.AUTOPLAY.BOREDOM_THRESHOLD).toBe(35);
    clearRulesCache();
    expect(matchStoryteller(getRules(), {
      enabled: CONFIG.AUTOPLAY.ENABLED,
      boredThreshold: CONFIG.AUTOPLAY.BOREDOM_THRESHOLD,
    })).toBe('chaos');
  });

  it('a later rules change keeps the autoplay settings', async () => {
    await autoplay.configure({ enabled: true, boredThreshold: 40 });
    await world.setRules({ sicknessRate: 'off' });
    bootDefaults();
    loadAutoplayConfig();
    expect(CONFIG.AUTOPLAY.ENABLED).toBe(true);
    expect(CONFIG.AUTOPLAY.BOREDOM_THRESHOLD).toBe(40);
    expect(getRules().sicknessRate).toBe('off');
  });

  it('a world without saved settings (new or replaced) loads the defaults', async () => {
    await autoplay.configure({ enabled: true, boredThreshold: 40 });
    db.update(worldState).set({ rule_overrides: null }).run();
    loadAutoplayConfig();
    expect(CONFIG.AUTOPLAY.ENABLED).toBe(AUTOPLAY_DEFAULTS.ENABLED);
    expect(CONFIG.AUTOPLAY.BOREDOM_THRESHOLD).toBe(AUTOPLAY_DEFAULTS.BOREDOM_THRESHOLD);
    expect(matchStoryteller(DEFAULT_LIVE_RULES, {
      enabled: CONFIG.AUTOPLAY.ENABLED,
      boredThreshold: CONFIG.AUTOPLAY.BOREDOM_THRESHOLD,
    })).toBe('balanced');
  });

  it('ignores malformed stored values', () => {
    expect(parseAutoplaySettings({ enabled: 'yes', boredomThreshold: 500, windowMinutes: 5, maxNudgesPerDay: -1 })).toEqual({});
    expect(parseAutoplaySettings(null)).toEqual({});
    expect(parseAutoplaySettings({ windowMinutes: 120, autoNudge: false })).toEqual({ windowMinutes: 120, autoNudge: false });
  });

  it('stores the window in game minutes', async () => {
    await autoplay.configure({ windowMinutes: 120 });
    bootDefaults();
    loadAutoplayConfig();
    expect(CONFIG.AUTOPLAY.WINDOW_MINUTES).toBe(120);
  });
});

describe('autoplay window on the game clock', () => {
  // tick.ts closes a window with crossedBoundary(prev, now, WINDOW_MINUTES).
  function windowsClosed(tickSpeed: number, startMinute: number, ticks: number, window: number): number {
    let closed = 0;
    let now = startMinute;
    for (let i = 0; i < ticks; i++) {
      const prev = now;
      now += tickSpeed;
      if (crossedBoundary(prev, now, window)) closed++;
    }
    return closed;
  }

  it('closes one window per game hour at every speed, even off the boundary', () => {
    const day = 1440;
    // A `totalTicks % 60` test fired 24 times at 1x, 6 at 4x, and never at all
    // when the count never landed on a multiple.
    expect(windowsClosed(1, 7, day, 60)).toBe(24);
    expect(windowsClosed(2, 7, day / 2, 60)).toBe(24);
    expect(windowsClosed(4, 7, day / 4, 60)).toBe(24);
  });
});
