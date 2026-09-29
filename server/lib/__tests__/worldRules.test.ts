import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { db } from '../../db';
import { worldState } from '../../db/schema';
import { clearRulesCache, getRules, setRuleOverrides, RuleOverridesSchema } from '../worldRules';
import { clearPerWorldCaches } from '../../engine/worldCaches';
import { DEFAULT_LIVE_RULES } from '../../data/rulesCatalog';

/**
 * getRules(): defaults ← setup_config.rules ← rule_overrides, cached until a
 * world replace or a setRuleOverrides.
 */

let createdWorld = false;
let saved: { setup_config: Record<string, any> | null; rule_overrides: Record<string, unknown> | null } | null = null;

function writeRow(setupRules: Record<string, unknown> | null, overrides: Record<string, unknown> | null): void {
  db.update(worldState).set({ setup_config: setupRules ? { rules: setupRules } : null, rule_overrides: overrides }).run();
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
    saved = { setup_config: w.setup_config ?? null, rule_overrides: w.rule_overrides ?? null };
  }
});

afterAll(() => {
  if (createdWorld) db.delete(worldState).run();
  else if (saved) db.update(worldState).set(saved).run();
  clearRulesCache();
  vi.restoreAllMocks();
});

beforeEach(() => {
  writeRow(null, null);
  clearRulesCache();
});

describe('getRules', () => {
  it('reads the defaults for a world without a saved config', () => {
    expect(getRules()).toEqual(DEFAULT_LIVE_RULES);
  });

  it('reads the wizard rules and ignores unknown values and setup-only keys', () => {
    writeRow({ dramaIntensity: 'chaos', sicknessRate: 'nope', contagionRate: 3, deathEnabled: false, tickSpeed: 4 }, null);
    clearRulesCache();
    expect(getRules()).toEqual({
      ...DEFAULT_LIVE_RULES, deathEnabled: false, dramaIntensity: 'chaos', sicknessRate: 'low', contagionRate: 'low',
    });
  });

  it('layers live overrides over the wizard rules', () => {
    writeRow({ dramaIntensity: 'chaos', sicknessRate: 'high' }, { dramaIntensity: 'low' });
    clearRulesCache();
    expect(getRules()).toMatchObject({ dramaIntensity: 'low', sicknessRate: 'high' });
  });

  it('is cached until cleared', () => {
    expect(getRules().dramaIntensity).toBe('medium');
    writeRow({ dramaIntensity: 'high' }, null); // a write behind the cache's back
    expect(getRules().dramaIntensity).toBe('medium');
    clearRulesCache();
    expect(getRules().dramaIntensity).toBe('high');
  });

  it('is dropped on a world replace', () => {
    expect(getRules().sicknessRate).toBe('low');
    writeRow({ sicknessRate: 'off' }, null); // what replaceWorld leaves behind
    clearPerWorldCaches();
    expect(getRules().sicknessRate).toBe('off');
  });
});

describe('setRuleOverrides', () => {
  it('merges into the saved overrides and refreshes the cache at once', () => {
    writeRow({ dramaIntensity: 'high' }, null);
    expect(getRules().dramaIntensity).toBe('high');
    setRuleOverrides({ contagionRate: 'off' });
    const rules = setRuleOverrides({ dramaIntensity: 'low' });
    expect(rules).toMatchObject({ dramaIntensity: 'low', contagionRate: 'off' });
    expect(getRules()).toEqual(rules);
    expect(db.select({ o: worldState.rule_overrides }).from(worldState).get()!.o).toEqual({
      contagionRate: 'off', dramaIntensity: 'low',
    });
    // The wizard's scenario is untouched: Restart replays it without the overrides.
    expect(db.select({ c: worldState.setup_config }).from(worldState).get()!.c).toEqual({ rules: { dramaIntensity: 'high' } });
  });

  it('rejects unknown keys, unknown values and an empty patch', () => {
    expect(() => setRuleOverrides({ dramaIntensity: 'apocalypse' } as any)).toThrow();
    expect(() => setRuleOverrides({ llmModel: 'x' } as any)).toThrow();
    expect(() => setRuleOverrides({})).toThrow();
    expect(RuleOverridesSchema.safeParse({ deathEnabled: 'yes' }).success).toBe(false);
    expect(RuleOverridesSchema.safeParse({ sicknessRate: 'off', deathEnabled: false }).success).toBe(true);
    expect(getRules()).toEqual(DEFAULT_LIVE_RULES);
  });
});
