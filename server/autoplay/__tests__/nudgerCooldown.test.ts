import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SmartNudger, NUDGE_COOLDOWN_MINUTES } from '../nudger';
import type { AnalysisWindow, Diagnosis } from '../types';
import { CONFIG } from '../../lib/constants';

/**
 * The auto-nudge cooldown was 120 TICKS: at 4x the storyteller could poke the
 * town every 30 game minutes. It is now 120 game minutes at every speed.
 */

const WINDOW_TICKS = 60;

/** An analysis window ending at game minute `endMinutes`, `WINDOW_TICKS` ticks long at `speed`. */
function windowAt(endMinutes: number, endTick: number, speed: number): AnalysisWindow {
  return {
    startTick: endTick - WINDOW_TICKS,
    endTick,
    startMinutes: endMinutes - WINDOW_TICKS * speed,
    endMinutes,
    startMs: 0,
    gameHour: 12,
    dayPhase: 'afternoon',
    day: 2,
    season: 'spring',
    agentCount: 10,
    activeEvents: [],
  };
}

// buildNudge answers this one without touching the DB (a festival).
const BORED: Diagnosis[] = [{
  type: 'spatial_monoculture', layer: 'engagement', severity: 'high', evidence: 'everyone at the tavern',
  suggestion: 'hold a festival', autoFixable: true, affectedAgents: [],
} as unknown as Diagnosis];

let nudger: SmartNudger;
let savedMax: number;

beforeEach(() => {
  nudger = new SmartNudger();
  // execute() starts a real world event; the cooldown is all that is under test.
  vi.spyOn(SmartNudger.prototype as any, 'execute').mockImplementation(() => {});
  savedMax = CONFIG.AUTOPLAY.MAX_NUDGES_PER_DAY;
  CONFIG.AUTOPLAY.MAX_NUDGES_PER_DAY = 100;
});

afterEach(() => {
  CONFIG.AUTOPLAY.MAX_NUDGES_PER_DAY = savedMax;
  vi.restoreAllMocks();
});

const nudges = async (w: AnalysisWindow) => (await nudger.applyNudges(BORED, w)).length;

describe('auto-nudge cooldown', () => {
  it('is measured in game minutes at tick_speed 4', async () => {
    const speed = 4;
    const t0 = 2 * 1440 + 600;
    expect(await nudges(windowAt(t0, 5_000, speed))).toBe(1);
    // 20 ticks later is 80 game minutes: still cooling down.
    expect(await nudges(windowAt(t0 + 20 * speed, 5_020, speed))).toBe(0);
    // The next 60-tick window is 240 game minutes on. The tick cooldown (120
    // ticks) refused it; two game hours have long passed.
    expect(await nudges(windowAt(t0 + WINDOW_TICKS * speed, 5_060, speed))).toBe(1);
  });

  it('lasts exactly NUDGE_COOLDOWN_MINUTES whatever the speed', async () => {
    const t0 = 2 * 1440 + 600;
    expect(await nudges(windowAt(t0, 1_000, 0.5))).toBe(1);
    expect(await nudges(windowAt(t0 + NUDGE_COOLDOWN_MINUTES - 1, 1_238, 0.5))).toBe(0);
    expect(await nudges(windowAt(t0 + NUDGE_COOLDOWN_MINUTES, 1_240, 0.5))).toBe(1);
  });

  it('lets the first nudge of a new world through after a reset', async () => {
    expect(await nudges(windowAt(9 * 1440, 9_000, 1))).toBe(1);
    nudger.reset();
    // The replaced world's clock starts back at day 1, before the old stamp.
    expect(await nudges(windowAt(1440 + 540, 60, 1))).toBe(1);
  });

  it('does not hold the cooldown shut when the clock went backwards without a reset', async () => {
    expect(await nudges(windowAt(9 * 1440, 9_000, 1))).toBe(1);
    expect(await nudges(windowAt(1440 + 540, 60, 1))).toBe(1);
  });
});
