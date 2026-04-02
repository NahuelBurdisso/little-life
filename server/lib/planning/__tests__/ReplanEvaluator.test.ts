import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplanEvaluator } from '../ReplanEvaluator.js';
import type { ReplanEvent, PlanBlock } from '../types.js';
import type { PersonalityProfile } from '../../personality.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the DB module so ReplanEvaluator can be imported without a real DB
vi.mock('../../../db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      }),
    }),
  },
}));

vi.mock('../../simEvents', () => ({
  simEvents: {
    on: vi.fn(),
    emit: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PERSONALITY: PersonalityProfile = {
  honesty: 50,
  aggression: 50,
  warmth: 50,
  impulsiveness: 50,
  vanity: 50,
  curiosity: 50,
  loyalty: 50,
  morality: 50,
  sensuality: 50,
  neuroticism: 50,
};

function makeBlock(overrides: Partial<PlanBlock> = {}): PlanBlock {
  return {
    id: 'block_0',
    start_hour: 9,
    end_hour: 11,
    broad_action: 'work',
    location_hint: 'Bakery',
    status: 'active',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ReplanEvent> = {}): ReplanEvent {
  return {
    agentId: 1,
    type: 'conversation',
    description: 'had a chat',
    sentiment: 0,
    isDramatic: false,
    ...overrides,
  };
}

// Build an evaluator whose shouldReplan we can call directly
function makeEvaluator(): ReplanEvaluator {
  const mockCache = { get: vi.fn().mockReturnValue(null) };
  const mockGenerator = { queueReplan: vi.fn() } as any;
  return new ReplanEvaluator(mockCache, mockGenerator, () => 10, () => 100);
}

// ---------------------------------------------------------------------------
// shouldReplan heuristic tests
// ---------------------------------------------------------------------------

describe('ReplanEvaluator.shouldReplan', () => {
  let evaluator: ReplanEvaluator;

  beforeEach(() => {
    evaluator = makeEvaluator();
  });

  it('dramatic events always trigger replan, even with no active block', () => {
    const event = makeEvent({ isDramatic: true, sentiment: 0 });
    expect(evaluator.shouldReplan(event, null, DEFAULT_PERSONALITY)).toBe(true);
  });

  it('dramatic events always trigger replan when there IS an active block', () => {
    const event = makeEvent({ isDramatic: true, sentiment: -0.1 });
    expect(evaluator.shouldReplan(event, makeBlock(), DEFAULT_PERSONALITY)).toBe(true);
  });

  it('no active block = no replan for non-dramatic events', () => {
    const event = makeEvent({ isDramatic: false, sentiment: 0.9 });
    expect(evaluator.shouldReplan(event, null, DEFAULT_PERSONALITY)).toBe(false);
  });

  it('high sentiment with default personality triggers replan', () => {
    // threshold = 0.5 - (50/100)*0.15 - (50/100)*0.1 = 0.5 - 0.075 - 0.05 = 0.375
    // |0.8| > 0.375 → true
    const event = makeEvent({ sentiment: 0.8, isDramatic: false });
    expect(evaluator.shouldReplan(event, makeBlock(), DEFAULT_PERSONALITY)).toBe(true);
  });

  it('low sentiment with default personality does not trigger replan', () => {
    // |0.1| < 0.375 → false
    const event = makeEvent({ sentiment: 0.1, isDramatic: false });
    expect(evaluator.shouldReplan(event, makeBlock(), DEFAULT_PERSONALITY)).toBe(false);
  });

  it('neurotic agents replan on lower sentiment', () => {
    // threshold = 0.5 - (100/100)*0.15 - (50/100)*0.1 = 0.5 - 0.15 - 0.05 = 0.3
    const neurotic: PersonalityProfile = { ...DEFAULT_PERSONALITY, neuroticism: 100 };
    const event = makeEvent({ sentiment: 0.35, isDramatic: false });
    // |0.35| > 0.3 → true
    expect(evaluator.shouldReplan(event, makeBlock(), neurotic)).toBe(true);
  });

  it('low-neuroticism agent does NOT replan on same sentiment that moves neurotic', () => {
    // threshold = 0.5 - (0/100)*0.15 - (50/100)*0.1 = 0.5 - 0 - 0.05 = 0.45
    const calm: PersonalityProfile = { ...DEFAULT_PERSONALITY, neuroticism: 0 };
    const event = makeEvent({ sentiment: 0.35, isDramatic: false });
    // |0.35| < 0.45 → false
    expect(evaluator.shouldReplan(event, makeBlock(), calm)).toBe(false);
  });

  it('impulsive agents replan more easily', () => {
    // threshold = 0.5 - (50/100)*0.15 - (100/100)*0.1 = 0.5 - 0.075 - 0.1 = 0.325
    const impulsive: PersonalityProfile = { ...DEFAULT_PERSONALITY, impulsiveness: 100 };
    const event = makeEvent({ sentiment: 0.34, isDramatic: false });
    // |0.34| > 0.325 → true
    expect(evaluator.shouldReplan(event, makeBlock(), impulsive)).toBe(true);
  });

  it('non-impulsive agent does NOT replan on same sentiment that moves impulsive', () => {
    // threshold = 0.5 - (50/100)*0.15 - (0/100)*0.1 = 0.5 - 0.075 - 0 = 0.425
    const nonImpulsive: PersonalityProfile = { ...DEFAULT_PERSONALITY, impulsiveness: 0 };
    const event = makeEvent({ sentiment: 0.34, isDramatic: false });
    // |0.34| < 0.425 → false
    expect(evaluator.shouldReplan(event, makeBlock(), nonImpulsive)).toBe(false);
  });

  it('negative sentiment magnitude is evaluated correctly', () => {
    // sentiment = -0.8, |−0.8| = 0.8 > 0.375 → true
    const event = makeEvent({ sentiment: -0.8, isDramatic: false });
    expect(evaluator.shouldReplan(event, makeBlock(), DEFAULT_PERSONALITY)).toBe(true);
  });
});
