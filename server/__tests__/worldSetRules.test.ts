import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { db } from '../db';
import { worldState } from '../db/schema';
import { worldRouter } from '../routers/world';
import { clearRulesCache, getRules, RuleOverridesSchema } from '../lib/worldRules';
import { DEFAULT_LIVE_RULES, STORYTELLERS, matchStoryteller } from '../data/rulesCatalog';

/** `world.setRules` and the Storyteller presets built on it. */

let createdWorld = false;
let saved: { setup_config: Record<string, any> | null; rule_overrides: Record<string, unknown> | null } | null = null;
const caller = worldRouter.createCaller({} as any);

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
  db.update(worldState).set({ setup_config: { rules: { dramaIntensity: 'high' } }, rule_overrides: null }).run();
  clearRulesCache();
});

describe('world.setRules', () => {
  it('applies a partial override on top of the wizard rules', async () => {
    const res = await caller.setRules({ sicknessRate: 'off' });
    expect(res).toEqual({ ok: true, rules: { ...DEFAULT_LIVE_RULES, dramaIntensity: 'high', sicknessRate: 'off' } });
    expect(await caller.getRules()).toEqual(res.ok && res.rules);
  });

  it('rejects unknown keys, bad values, wrong types and an empty patch', async () => {
    await expect(caller.setRules({ dramaIntensity: 'apocalypse' } as any)).rejects.toThrow();
    await expect(caller.setRules({ llmModel: 'gemma' } as any)).rejects.toThrow();
    await expect(caller.setRules({ deathEnabled: 'no' } as any)).rejects.toThrow();
    await expect(caller.setRules({})).rejects.toThrow();
    expect(getRules()).toEqual({ ...DEFAULT_LIVE_RULES, dramaIntensity: 'high' });
  });
});

describe('Storyteller presets', () => {
  it('are valid rule patches', () => {
    for (const p of STORYTELLERS) expect(RuleOverridesSchema.safeParse(p.rules).success, p.id).toBe(true);
  });

  it('each match themselves and nothing else', () => {
    for (const p of STORYTELLERS) {
      expect(matchStoryteller(p.rules, p.autoplay), p.id).toBe(p.id);
    }
  });

  it('reads a fresh world with default autoplay as Balanced', () => {
    // Autoplay ships on at 55 (AUTOPLAY_CONFIG), which is Balanced's storyteller.
    expect(matchStoryteller(DEFAULT_LIVE_RULES, { enabled: true, boredThreshold: 55 })).toBe('balanced');
    // Switched off, the default rules are a hand-tuned mix; whatever threshold was left.
    expect(matchStoryteller(DEFAULT_LIVE_RULES, { enabled: false, boredThreshold: 55 })).toBeNull();
    expect(matchStoryteller(DEFAULT_LIVE_RULES, { enabled: false, boredThreshold: 90 })).toBeNull();
  });

  it('reads a hand-tuned mix as custom', () => {
    expect(matchStoryteller({ ...DEFAULT_LIVE_RULES, dramaIntensity: 'chaos' }, { enabled: false, boredThreshold: 55 })).toBeNull();
    const chaos = STORYTELLERS.find((p) => p.id === 'chaos')!;
    expect(matchStoryteller(chaos.rules, { enabled: true, boredThreshold: 50 })).toBeNull();
  });
});
