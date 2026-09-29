import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CONFIG } from '../constants';
import {
  conversationBudgetGameMinutes,
  effectiveSleepWindow,
  isPastBedtime,
  latencyProbeDue,
  markLatencyProbe,
  needsWrapUpReason,
  planConversation,
  queueDeadlineGameMin,
  queueMaxWait,
  recordTurnLatency,
  resetConversationPacing,
  turnLatencyEstimateMs,
} from '../conversationPacing';

const C = CONFIG.CONVERSATIONS;
const STANDARD = C.MAX_TURNS_STANDARD;
const DEEP = C.MAX_TURNS_DEEP;

function plan(p: Partial<Parameters<typeof planConversation>[0]> = {}) {
  return planConversation({
    tierMaxTurns: STANDARD,
    tickSpeed: 1,
    isProtected: false,
    observedLatencyMs: null,
    probeDue: false,
    ...p,
  });
}

describe('conversation budgets', () => {
  it('are the old 15 s per turn, read as game minutes at one tick per second', () => {
    expect(C.GAME_MINUTES_PER_TURN).toBe(15);
    expect(conversationBudgetGameMinutes(STANDARD)).toBe(90);
    expect(conversationBudgetGameMinutes(DEEP)).toBe(150);
  });
});

describe('planConversation', () => {
  // These cases describe a slow model (a 20 s prior); the shipped prior is
  // checked on its own below.
  const shippedPrior = C.TURN_LATENCY_PRIOR_MS;
  const pacing = C as { TURN_LATENCY_PRIOR_MS: number };
  beforeEach(() => { pacing.TURN_LATENCY_PRIOR_MS = 20_000; });
  afterEach(() => { pacing.TURN_LATENCY_PRIOR_MS = shippedPrior; });

  it('with the shipped prior, an unmeasured 4x conversation still runs on the LLM', () => {
    pacing.TURN_LATENCY_PRIOR_MS = shippedPrior;
    expect(plan({ tickSpeed: 4 }).tier).toBe('llm');
  });

  it('leaves 1x alone without measurements (no guessing at the tuned speed)', () => {
    expect(plan()).toEqual({ tier: 'llm', maxTurns: STANDARD, budgetGameMin: 90, graceGameMin: 15, probe: false });
    expect(plan({ tierMaxTurns: DEEP })).toMatchObject({ maxTurns: DEEP, budgetGameMin: 150 });
  });

  it('keeps full length at 1x while measured turns fit (15 s × 6 = 90)', () => {
    expect(plan({ observedLatencyMs: 15_000 }).maxTurns).toBe(STANDARD);
    expect(plan({ tierMaxTurns: DEEP, observedLatencyMs: 15_000 }).maxTurns).toBe(DEEP);
  });

  it('shortens at 1x only when the measured model truly cannot fit the turns', () => {
    expect(plan({ observedLatencyMs: 20_000 }).maxTurns).toBe(4); // 90 / 20
  });

  it('sizes by the prior above 1x before anything is measured', () => {
    // 20 s × 4x = 80 game min a turn: one turn of a 90-minute budget → template.
    expect(plan({ tickSpeed: 4 }).tier).toBe('template');
    // 5 s measured × 4x = 20 min a turn → 4 turns fit.
    expect(plan({ tickSpeed: 4, observedLatencyMs: 5000 })).toMatchObject({ tier: 'llm', maxTurns: 4, graceGameMin: 20 });
  });

  it('runs a due probe as a minimal LLM conversation with room for both lines', () => {
    expect(plan({ tickSpeed: 4, probeDue: true })).toEqual({
      tier: 'llm', maxTurns: 2, budgetGameMin: 160, graceGameMin: 80, probe: true,
    });
  });

  it('stretches a protected conversation to fit an exchange, up to the cap', () => {
    expect(plan({ tickSpeed: 4, isProtected: true, tierMaxTurns: DEEP, observedLatencyMs: 20_000 })).toEqual({
      tier: 'llm', maxTurns: 2, budgetGameMin: 160, graceGameMin: 80, probe: false,
    });
    // 60 s × 4x = 240 a turn: capped budget and grace.
    expect(plan({ tickSpeed: 4, isProtected: true, observedLatencyMs: 60_000 })).toMatchObject({
      budgetGameMin: C.EXTENDED_BUDGET_CAP_GAME_MINUTES,
      graceGameMin: C.MAX_WRAP_UP_GRACE_GAME_MINUTES,
    });
  });
});

describe('turn latency window', () => {
  beforeEach(() => resetConversationPacing());

  it('estimates with the median, so one stalled call does not flip the town', () => {
    for (const ms of [4000, 5000, 6000, 90_000]) recordTurnLatency(ms, 100);
    expect(turnLatencyEstimateMs(100)).toBe(5500);
    recordTurnLatency(5000, 100);
    expect(turnLatencyEstimateMs(100)).toBe(5000);
  });

  it('keeps only the last TURN_LATENCY_WINDOW samples', () => {
    for (let i = 0; i < C.TURN_LATENCY_WINDOW; i++) recordTurnLatency(1000, 100);
    for (let i = 0; i < C.TURN_LATENCY_WINDOW; i++) recordTurnLatency(3000, 100);
    expect(turnLatencyEstimateMs(100)).toBe(3000);
  });

  it('expires samples by GAME minutes (and ignores ones from a clock ahead of this one)', () => {
    recordTurnLatency(20_000, 1000);
    expect(turnLatencyEstimateMs(1000 + C.TURN_LATENCY_MAX_AGE_GAME_MINUTES)).toBe(20_000);
    expect(turnLatencyEstimateMs(1001 + C.TURN_LATENCY_MAX_AGE_GAME_MINUTES)).toBeNull();
    expect(turnLatencyEstimateMs(999)).toBeNull();
  });

  it('allows one probe per expiry period while nothing is measured', () => {
    expect(latencyProbeDue(1000)).toBe(true);
    markLatencyProbe(1000);
    expect(latencyProbeDue(1100)).toBe(false);
    expect(latencyProbeDue(1001 + C.TURN_LATENCY_MAX_AGE_GAME_MINUTES)).toBe(true);
    // A fresh measurement is trusted instead.
    recordTurnLatency(20_000, 2000);
    expect(latencyProbeDue(2000)).toBe(false);
  });
});

describe('sleep window', () => {
  it('matches decisions.ts checkSchedule', () => {
    // TODO(decisions): compare against decisions' own function once it exports
    // one; these cases pin the copied formula meanwhile.
    const sched = { wakeTime: 6, sleepTime: 22 };
    expect(effectiveSleepWindow(sched, null)).toEqual({ sleepHour: 22, wakeHour: 6 });
    expect(isPastBedtime(sched, null, 21)).toBe(false);
    expect(isPastBedtime(sched, null, 22)).toBe(true);
    expect(isPastBedtime(sched, null, 3)).toBe(true);
    expect(isPastBedtime(sched, null, 6)).toBe(false);
    // Night owl: +2 h (impulsiveness 100 → +1, sensuality 100 → +0.5, morality 0 → +0.75 → round 2).
    const owl = { impulsiveness: 100, sensuality: 100, morality: 0, neuroticism: 0 };
    expect(effectiveSleepWindow(sched, owl)).toEqual({ sleepHour: 24, wakeHour: 8 });
    expect(isPastBedtime(sched, owl, 23)).toBe(false);
    expect(isPastBedtime(sched, owl, 0)).toBe(true);
    // Inverted window: a 25:00 bedtime wraps to 01:00 → asleep 01:00–10:00.
    const late = { wakeTime: 10, sleepTime: 25 };
    expect(effectiveSleepWindow(late, null)).toEqual({ sleepHour: 1, wakeHour: 10 });
    expect(isPastBedtime(late, null, 0)).toBe(false);
    expect(isPastBedtime(late, null, 1)).toBe(true);
    expect(isPastBedtime(late, null, 10)).toBe(false);
  });

  it('ranks the needs that end a conversation', () => {
    expect(needsWrapUpReason({ hunger: 50, energy: 50, critical: 15 }, false)).toBeNull();
    expect(needsWrapUpReason({ hunger: 5, energy: 5, critical: 15 }, true)).toBe('energy');
    expect(needsWrapUpReason({ hunger: 5, energy: 50, critical: 15 }, true)).toBe('sleep');
    expect(needsWrapUpReason({ hunger: 5, energy: 50, critical: 15 }, false)).toBe('hunger');
  });
});

describe('queue waits', () => {
  it('keep the old 1x waits as game minutes', () => {
    // decisions.ts still writes a literal 10000: that is the default wait.
    expect(queueMaxWait(C.QUEUE_MAX_WAIT_GAME_MINUTES)).toBe(10_000);
    expect(queueMaxWait(C.PLAYER_NUDGE_MAX_WAIT_GAME_MINUTES)).toBe(30_000);
  });

  it('count from when the scheduler first sees the entry, never from wall-clock age', () => {
    expect(queueDeadlineGameMin({ max_wait: 10_000 }, 500)).toBe(510);
  });
});
