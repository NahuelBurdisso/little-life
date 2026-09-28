import { describe, it, expect } from 'vitest';
import { parsePlanBlocks, parseDecomposedActions, inferActionType, isUnparsedDecomposition } from '../planParser.js';

const LOCATIONS = ['Home', 'Bakery', 'Town Square', 'Park', 'Market', 'Library'];
const AGENTS = ['Alice', 'Bob', 'Charlie'];

// ---------------------------------------------------------------------------
// parsePlanBlocks
// ---------------------------------------------------------------------------
describe('parsePlanBlocks', () => {
  it('parses standard pipe-separated lines', () => {
    const raw = `08:00-10:00 | Have breakfast | Home
10:00-12:00 | Work on project | Library
12:00-13:00 | Eat lunch | Bakery
13:00-15:00 | Read book | Park`;

    const blocks = parsePlanBlocks(raw, LOCATIONS);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({
      id: 'block_0',
      start_hour: 8,
      end_hour: 10,
      broad_action: 'Have breakfast',
      location_hint: 'Home',
      status: 'pending',
    });
    expect(blocks[1].id).toBe('block_1');
    expect(blocks[2].location_hint).toBe('Bakery');
  });

  it('handles single-digit hour formats (H:00-H:00)', () => {
    const raw = `7:00-9:00 | Morning routine | Home
9:00-11:00 | Shopping | Market
11:00-13:00 | Lunch | Bakery`;

    const blocks = parsePlanBlocks(raw, LOCATIONS);
    expect(blocks[0].start_hour).toBe(7);
    expect(blocks[0].end_hour).toBe(9);
  });

  it('handles bare hour format (H-H)', () => {
    const raw = `8-10 | Morning walk | Park
10-12 | Work | Library
12-14 | Lunch | Bakery`;

    const blocks = parsePlanBlocks(raw, LOCATIONS);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].start_hour).toBe(8);
    expect(blocks[0].end_hour).toBe(10);
  });

  it('does fuzzy location matching via substring (hint contained in valid name)', () => {
    const raw = `08:00-10:00 | Read | town square
10:00-12:00 | Work | lib
12:00-14:00 | Eat | baker`;

    const blocks = parsePlanBlocks(raw, LOCATIONS);
    expect(blocks[0].location_hint).toBe('Town Square');
    expect(blocks[1].location_hint).toBe('Library');
    expect(blocks[2].location_hint).toBe('Bakery');
  });

  it('does fuzzy location matching when valid name is substring of hint', () => {
    const raw = `08:00-10:00 | Hang out | near the Park area
10:00-12:00 | Work | the big Market place
12:00-14:00 | Eat | inside the Home building`;

    const blocks = parsePlanBlocks(raw, LOCATIONS);
    expect(blocks[0].location_hint).toBe('Park');
    expect(blocks[1].location_hint).toBe('Market');
    expect(blocks[2].location_hint).toBe('Home');
  });

  it('returns empty array when fewer than 3 valid blocks are found', () => {
    const raw = `08:00-10:00 | Breakfast | Home
10:00-12:00 | Work | Library`;

    const blocks = parsePlanBlocks(raw, LOCATIONS);
    expect(blocks).toEqual([]);
  });

  it('strips preamble lines starting with "here", "my plan", "today"', () => {
    const raw = `Here is my daily plan:
My plan for the day:
Today I will do the following things.
08:00-10:00 | Breakfast | Home
10:00-12:00 | Work | Library
12:00-14:00 | Lunch | Bakery`;

    const blocks = parsePlanBlocks(raw, LOCATIONS);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].broad_action).toBe('Breakfast');
  });

  it('strips numbered and bullet prefixes', () => {
    const raw = `1. 08:00-10:00 | Breakfast | Home
2) 10:00-12:00 | Work | Library
- 12:00-14:00 | Lunch | Bakery`;

    const blocks = parsePlanBlocks(raw, LOCATIONS);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].start_hour).toBe(8);
    expect(blocks[1].start_hour).toBe(10);
    expect(blocks[2].start_hour).toBe(12);
  });

  it('returns empty array for empty input', () => {
    expect(parsePlanBlocks('', LOCATIONS)).toEqual([]);
    expect(parsePlanBlocks('   ', LOCATIONS)).toEqual([]);
  });

  it('assigns sequential block ids', () => {
    const raw = `08:00-10:00 | A | Home
10:00-12:00 | B | Library
12:00-14:00 | C | Bakery
14:00-16:00 | D | Park`;

    const blocks = parsePlanBlocks(raw, LOCATIONS);
    expect(blocks.map(b => b.id)).toEqual(['block_0', 'block_1', 'block_2', 'block_3']);
  });

  it('ignores lines without pipes', () => {
    const raw = `Some random text without pipes
08:00-10:00 | Breakfast | Home
Another line without pipes
10:00-12:00 | Work | Library
12:00-14:00 | Lunch | Bakery`;

    const blocks = parsePlanBlocks(raw, LOCATIONS);
    expect(blocks).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// parseDecomposedActions
// ---------------------------------------------------------------------------
describe('parseDecomposedActions', () => {
  it('parses standard pipe-separated actions', () => {
    const raw = `Walk to bakery | Bakery | 15 minutes
Buy bread | Bakery | 10 minutes
Walk home | Home | 15 minutes`;

    const actions = parseDecomposedActions(raw, LOCATIONS, AGENTS);
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({
      description: 'Walk to bakery',
      action_type: 'walking',
      target_location: 'Bakery',
      duration_minutes: 15,
    });
  });

  it('extracts duration from "30 minutes" text', () => {
    const raw = `Eat lunch | Bakery | 30 minutes
Work on tasks | Library | 60 minutes
Take a nap | Home | 45 minutes`;

    const actions = parseDecomposedActions(raw, LOCATIONS, AGENTS);
    expect(actions[0].duration_minutes).toBe(30);
    expect(actions[1].duration_minutes).toBe(60);
    expect(actions[2].duration_minutes).toBe(45);
  });

  it('extracts duration from "about N" text', () => {
    const raw = `Chat with Alice | Town Square | about 20
Read books | Library | about 45
Buy groceries | Market | about 15`;

    const actions = parseDecomposedActions(raw, LOCATIONS, AGENTS);
    expect(actions[0].duration_minutes).toBe(20);
    expect(actions[1].duration_minutes).toBe(45);
    expect(actions[2].duration_minutes).toBe(15);
  });

  it('clamps duration to 5-120 minutes', () => {
    const raw = `Quick look | Home | 2 minutes
Long work | Library | 200 minutes
Short break | Park | 3 minutes`;

    const actions = parseDecomposedActions(raw, LOCATIONS, AGENTS);
    expect(actions[0].duration_minutes).toBe(5);
    expect(actions[1].duration_minutes).toBe(120);
    expect(actions[2].duration_minutes).toBe(5);
  });

  it('matches agent names in description text', () => {
    const raw = `Chat with Alice about life | Town Square | 30 minutes
Meet Bob at the park | Park | 20 minutes
Work alone | Library | 60 minutes`;

    const actions = parseDecomposedActions(raw, LOCATIONS, AGENTS);
    expect(actions[0].target_agent).toBe('Alice');
    expect(actions[1].target_agent).toBe('Bob');
    expect(actions[2].target_agent).toBeUndefined();
  });

  it('returns idle fallback for empty input', () => {
    const result = parseDecomposedActions('', LOCATIONS, AGENTS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      description: 'idle',
      action_type: 'idle',
      duration_minutes: 60,
    });
  });

  it('returns idle fallback when no valid lines parsed', () => {
    const raw = `no pipes here at all
just random text
nothing parseable`;

    const result = parseDecomposedActions(raw, LOCATIONS, AGENTS);
    expect(result).toHaveLength(1);
    expect(result[0].action_type).toBe('idle');
  });

  it('fuzzy matches locations in decomposed actions', () => {
    const raw = `Walk to the bakery area | baker | 15 minutes
Sit in park | the Park area | 30 minutes
Read | lib | 45 minutes`;

    const actions = parseDecomposedActions(raw, LOCATIONS, AGENTS);
    expect(actions[0].target_location).toBe('Bakery');
    expect(actions[1].target_location).toBe('Park');
    expect(actions[2].target_location).toBe('Library');
  });
});

// ---------------------------------------------------------------------------
// inferActionType
// ---------------------------------------------------------------------------
describe('inferActionType', () => {
  it('returns "eating" for eat/lunch/breakfast/dinner/food keywords', () => {
    expect(inferActionType('eat some food')).toBe('eating');
    expect(inferActionType('have lunch at noon')).toBe('eating');
    expect(inferActionType('make breakfast')).toBe('eating');
    expect(inferActionType('cook dinner')).toBe('eating');
    expect(inferActionType('grab some food from market')).toBe('eating');
    expect(inferActionType('have a meal')).toBe('eating');
    expect(inferActionType('eat a snack')).toBe('eating');
  });

  it('returns "working" for work/task/shift/job keywords', () => {
    expect(inferActionType('work on the project')).toBe('working');
    expect(inferActionType('complete task')).toBe('working');
    expect(inferActionType('start my shift')).toBe('working');
    expect(inferActionType('do the job')).toBe('working');
    expect(inferActionType('hard labor')).toBe('working');
  });

  it('returns "socializing" for talk/chat/visit/socialize/meet keywords', () => {
    expect(inferActionType('talk with Alice')).toBe('socializing');
    expect(inferActionType('have a chat')).toBe('socializing');
    expect(inferActionType('visit the neighbors')).toBe('socializing');
    expect(inferActionType('socialize at the square')).toBe('socializing');
    expect(inferActionType('meet Bob downtown')).toBe('socializing');
  });

  it('returns "sleeping" for sleep/rest/nap/bed keywords', () => {
    expect(inferActionType('sleep for a while')).toBe('sleeping');
    expect(inferActionType('rest at home')).toBe('sleeping');
    expect(inferActionType('take a nap')).toBe('sleeping');
    expect(inferActionType('go to bed')).toBe('sleeping');
  });

  it('returns "walking" for walk/go to/head to keywords', () => {
    expect(inferActionType('walk to the park')).toBe('walking');
    expect(inferActionType('go to the library')).toBe('walking');
    expect(inferActionType('head to market')).toBe('walking');
    expect(inferActionType('travel across town')).toBe('walking');
  });

  it('returns "shopping" for shop/buy/purchase keywords', () => {
    expect(inferActionType('shop for groceries')).toBe('shopping');
    expect(inferActionType('buy some bread')).toBe('shopping');
    expect(inferActionType('purchase supplies')).toBe('shopping');
  });

  it('returns "idle" for unmatched descriptions', () => {
    expect(inferActionType('think about things')).toBe('idle');
    expect(inferActionType('random activity')).toBe('idle');
    expect(inferActionType('')).toBe('idle');
    expect(inferActionType('observe the sky')).toBe('idle');
  });

  it('uses word boundaries to avoid false positives', () => {
    // "workbench" should NOT match "work"
    expect(inferActionType('sit at workbench')).toBe('idle');
    // "bedrock" should NOT match "bed"
    expect(inferActionType('stand on bedrock')).toBe('idle');
  });
});

describe('parsePlanBlocks minBlocks', () => {
  const one = '20:00-22:00 | Stew on it | Home';

  it('rejects a one-block answer for a daily plan (default minimum 3)', () => {
    expect(parsePlanBlocks(one, LOCATIONS)).toEqual([]);
  });

  it('accepts it when the caller allows a single block (replans)', () => {
    expect(parsePlanBlocks(one, LOCATIONS, 1)).toHaveLength(1);
  });
});

describe('isUnparsedDecomposition', () => {
  it('flags the parser idle fallback for empty or unreadable output', () => {
    expect(isUnparsedDecomposition(parseDecomposedActions('', LOCATIONS, AGENTS))).toBe(true);
    expect(isUnparsedDecomposition(parseDecomposedActions('no pipes here at all', LOCATIONS, AGENTS))).toBe(true);
    expect(isUnparsedDecomposition([])).toBe(true);
  });

  it('does not flag real actions, even a parsed idle one', () => {
    expect(isUnparsedDecomposition(parseDecomposedActions('Buy bread | Bakery | 10 minutes', LOCATIONS, AGENTS))).toBe(false);
    expect(isUnparsedDecomposition(parseDecomposedActions('Stand on bedrock | Park | 30 minutes', LOCATIONS, AGENTS))).toBe(false);
  });
});
