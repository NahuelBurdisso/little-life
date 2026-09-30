import { describe, it, expect } from 'vitest';
import { classifyBlock, decomposeDeterministically, type DeterministicContext } from '../deterministicDecompose';
import { parseDecomposedActions } from '../planParser';
import type { PlanBlock } from '../types';

const HOME = 1;
const SHOP = 2;
const TAVERN = 3;

const ctx: DeterministicContext = {
  homeId: HOME,
  workplaceId: SHOP,
  locations: [
    { id: HOME, name: 'Rosa Cottage' },
    { id: SHOP, name: 'General Store' },
    { id: TAVERN, name: 'Old Tavern' },
  ],
  otherAgentNames: ['Marco Rivera', 'Yuki Tanaka'],
  workStart: 9,
  workEnd: 17,
};

const block = (start: number, end: number, action: string, location: string): PlanBlock => ({
  id: 'block_0',
  start_hour: start,
  end_hour: end,
  broad_action: action,
  location_hint: location,
  status: 'pending',
});

describe('classifyBlock', () => {
  it('recognises sleep at home', () => {
    expect(classifyBlock(block(22, 24, 'Go to bed and sleep', 'Rosa Cottage'), ctx)).toBe('sleep');
    expect(classifyBlock(block(14, 15, 'Afternoon nap', 'Rosa Cottage'), ctx)).toBe('sleep');
    expect(classifyBlock(block(22, 24, 'Sleep', 'Home'), ctx)).toBe('sleep');
  });

  it('leaves bedtime routines and company to the LLM', () => {
    expect(classifyBlock(block(21, 22, 'Prepare for bed', 'Rosa Cottage'), ctx)).toBeNull();
    expect(classifyBlock(block(21, 22, 'Wind down for bed', 'Rosa Cottage'), ctx)).toBeNull();
    // Not sleep — but since L2 a plain home routine (an idle at home), no LLM.
    expect(classifyBlock(block(21, 22, 'Read in bed', 'Rosa Cottage'), ctx)).toBe('home');
    expect(classifyBlock(block(21, 22, 'Sleep over at Marco Rivera', 'Rosa Cottage'), ctx)).toBeNull();
  });

  it('does not treat sleep away from home as sleep', () => {
    expect(classifyBlock(block(14, 15, 'Nap on a bench', 'Old Tavern'), ctx)).toBeNull();
  });

  it('recognises a shift at the own workplace, with or without a work verb', () => {
    expect(classifyBlock(block(9, 12, 'Open the shop and restock shelves', 'General Store'), ctx)).toBe('work');
    expect(classifyBlock(block(13, 17, 'Afternoon shift', 'General Store'), ctx)).toBe('work');
  });

  it('does not treat other places, off-shift hours or breaks as work', () => {
    expect(classifyBlock(block(9, 12, 'Open the shop', 'Old Tavern'), ctx)).toBeNull();
    expect(classifyBlock(block(18, 19, 'Restock shelves', 'General Store'), ctx)).toBeNull();
    expect(classifyBlock(block(8, 10, 'Restock shelves', 'General Store'), ctx)).toBeNull(); // starts before the shift
    expect(classifyBlock(block(12, 13, 'Lunch break', 'General Store'), ctx)).toBeNull();
    expect(classifyBlock(block(12, 13, 'Chat with customers', 'General Store'), ctx)).toBeNull();
    expect(classifyBlock(block(12, 13, 'Meet Marco Rivera', 'General Store'), ctx)).toBeNull();
  });

  it('needs a workplace and a shift window to call anything work', () => {
    const jobless = { ...ctx, workplaceId: null };
    expect(classifyBlock(block(9, 12, 'Open the shop', 'General Store'), jobless)).toBeNull();
    const noShift = { ...ctx, workStart: undefined, workEnd: undefined };
    expect(classifyBlock(block(9, 12, 'Open the shop', 'General Store'), noShift)).toBeNull();
  });

  it('recognises a plain meal at home', () => {
    expect(classifyBlock(block(7, 8, 'Breakfast at home', 'Rosa Cottage'), ctx)).toBe('meal');
    expect(classifyBlock(block(19, 21, 'Eat dinner', 'Home'), ctx)).toBe('meal');
  });

  it('leaves company, cooking projects, long blocks and other places to the LLM', () => {
    expect(classifyBlock(block(19, 20, 'Dinner with Marco Rivera', 'Rosa Cottage'), ctx)).toBeNull();
    expect(classifyBlock(block(19, 20, 'Dinner with the neighbours', 'Rosa Cottage'), ctx)).toBeNull();
    expect(classifyBlock(block(19, 20, 'Host a dinner party', 'Rosa Cottage'), ctx)).toBeNull();
    expect(classifyBlock(block(18, 20, 'Cook a big dinner', 'Rosa Cottage'), ctx)).toBeNull();
    expect(classifyBlock(block(17, 21, 'Dinner and an evening in', 'Rosa Cottage'), ctx)).toBeNull(); // 4 h
    expect(classifyBlock(block(12, 13, 'Lunch', 'Old Tavern'), ctx)).toBeNull();
  });

  it('is null for empty text and inverted hours', () => {
    expect(classifyBlock(block(9, 12, '  ', 'General Store'), ctx)).toBeNull();
    expect(classifyBlock(block(12, 9, 'Open the shop', 'General Store'), ctx)).toBeNull();
  });

  it('prefers sleep/meal over work when home and workplace are the same place', () => {
    const farm = { ...ctx, workplaceId: HOME };
    expect(classifyBlock(block(22, 24, 'Sleep', 'Rosa Cottage'), farm)).toBe('sleep');
    expect(classifyBlock(block(12, 13, 'Lunch', 'Rosa Cottage'), farm)).toBe('meal');
    expect(classifyBlock(block(9, 12, 'Tend the accounts', 'Rosa Cottage'), farm)).toBe('work');
  });
});

describe('classifyBlock — widened routine kinds (L2)', () => {
  const STREET = 4;
  const PARK = 5;
  const OTHER_HOME = 6;
  const CHURCH = 7;
  const typed: DeterministicContext = {
    ...ctx,
    otherAgentNames: ['Marco Rivera', 'Yuki Tanaka', 'Rosa Chen'],
    locations: [
      { id: HOME, name: 'Rosa Cottage', type: 'home' },
      { id: SHOP, name: "Rosa's General Store", type: 'shop' },
      { id: TAVERN, name: 'Old Tavern', type: 'tavern' },
      { id: STREET, name: 'Main Street', type: 'mainstreet' },
      { id: PARK, name: 'Riverside Park', type: 'park' },
      { id: OTHER_HOME, name: "Marco's cottage", type: 'home' },
      { id: CHURCH, name: 'St. Anne', type: 'church' },
    ],
  };
  const kind = (s: number, e: number, a: string, l: string) => classifyBlock(block(s, e, a, l), typed);

  it('takes home routines, alone or as a meal plus a routine', () => {
    expect(kind(6, 7, 'Wake up and dress quietly', 'Rosa Cottage')).toBe('home');
    expect(kind(20, 21, 'Read by oil lamp', 'Rosa Cottage')).toBe('home');
    expect(kind(20, 21, 'Eat supper and rest', 'Rosa Cottage')).toBe('home');
    expect(kind(21, 22, 'Eat quietly and go to bed', 'Rosa Cottage')).toBe('home');
    expect(kind(8, 9, 'Tidy the kitchen and sweep', 'Rosa Cottage')).toBe('home');
  });

  it('leaves scenes at home to the LLM', () => {
    expect(kind(19, 20, 'Prepare thoughts for mill meeting', 'Rosa Cottage')).toBeNull();
    expect(kind(21, 22, 'Take a drink from flask', 'Rosa Cottage')).toBeNull();
    expect(kind(20, 21, 'Bring tea to Yuki', 'Rosa Cottage')).toBeNull();
    expect(kind(20, 21, 'Nap and then cook', 'Rosa Cottage')).toBeNull(); // sleep not last
    expect(kind(18, 22, 'Read by oil lamp', 'Rosa Cottage')).toBeNull(); // 4 h
  });

  it('takes meals out anywhere but someone else\'s house', () => {
    expect(kind(12, 13, 'Eat lunch alone', 'Old Tavern')).toBe('meal_out');
    expect(kind(12, 13, 'Eat bread by the river', 'Riverside Park')).toBe('meal_out');
    expect(kind(12, 13, 'Quick lunch at the store', "Rosa's General Store")).toBe('meal_out');
    expect(kind(19, 20, 'Eat supper', "Marco's cottage")).toBeNull();
    expect(kind(19, 20, 'Eat supper and watch people', 'Old Tavern')).toBeNull();
    expect(kind(12, 13, 'Lunch with Marco', 'Old Tavern')).toBeNull();
  });

  it('takes errands at shops, walks on streets and rest outdoors', () => {
    expect(kind(17, 18, "Buy supplies at Rosa's", "Rosa's General Store")).toBe('errand');
    expect(kind(17, 18, 'Buy bread and tea', 'Old Tavern')).toBe('errand');
    expect(kind(8, 9, 'Walk slowly to Town Hall', 'Main Street')).toBe('walk');
    expect(kind(14, 15, 'Walk toward work', 'Main Street')).toBe('walk');
    expect(kind(16, 17, 'Sit alone by the river', 'Riverside Park')).toBe('outdoors');
    expect(kind(9, 10, 'Attend the morning service', 'St. Anne')).toBe('worship');
  });

  it('leaves named people (first names too), snooping and drink to the LLM', () => {
    expect(kind(13, 14, 'Ask Rosa about the gossip', "Rosa's General Store")).toBeNull();
    expect(kind(13, 14, 'Buy bread and flirt', "Rosa's General Store")).toBeNull();
    expect(kind(15, 16, 'Walk to find Marco', 'Main Street')).toBeNull();
    expect(kind(15, 16, 'Walk home and rest', 'Main Street')).toBeNull();
    expect(kind(13, 15, 'Eavesdrop on fishermen', 'Riverside Park')).toBeNull();
    expect(kind(22, 23, 'Drink ale alone', 'Old Tavern')).toBeNull();
    expect(kind(9, 10, 'Buy a ribbon', 'Main Street')).toBeNull(); // not a shop
    expect(kind(9, 10, 'Walk the aisles', 'Old Tavern')).toBeNull(); // walks are outdoors
  });

  it('decomposes a home block into one action per clause, summing to the block', () => {
    const actions = decomposeDeterministically(block(20, 22, 'Eat supper and read the paper', 'Rosa Cottage'), typed)!;
    expect(actions.map((a) => [a.action_type, a.duration_minutes])).toEqual([['eating', 60], ['idle', 60]]);
    expect(actions.every((a) => a.resolved_location_id === HOME)).toBe(true);
    const [walk] = decomposeDeterministically(block(8, 9, 'Walk to Town Hall', 'Main Street'), typed)!;
    expect(walk).toMatchObject({ action_type: 'walking', resolved_location_id: STREET, duration_minutes: 60 });
    const [buy] = decomposeDeterministically(block(17, 18, "Buy supplies at Rosa's", "Rosa's General Store"), typed)!;
    expect(buy).toMatchObject({ action_type: 'shopping', resolved_location_id: SHOP });
  });
});

describe('decomposeDeterministically', () => {
  it('returns null for blocks that need the LLM', () => {
    expect(decomposeDeterministically(block(9, 12, 'Wander the market', 'Old Tavern'), ctx)).toBeNull();
  });

  it('sleep: one sleeping action at home covering the block', () => {
    expect(decomposeDeterministically(block(22, 24, 'Go to bed and sleep', 'Rosa Cottage'), ctx)).toEqual([
      {
        description: 'Go to bed and sleep',
        action_type: 'sleeping',
        target_location: 'Rosa Cottage',
        resolved_location_id: HOME,
        duration_minutes: 120,
      },
    ]);
  });

  it('work: working at the workplace, with the shift split into <= 240 minute actions', () => {
    const one = decomposeDeterministically(block(9, 13, 'Serve customers', 'General Store'), ctx)!;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ action_type: 'working', resolved_location_id: SHOP, target_location: 'General Store', duration_minutes: 240 });

    const wide = { ...ctx, workStart: 8, workEnd: 18 };
    const two = decomposeDeterministically(block(8, 17, 'Run the store', 'General Store'), wide)!;
    // 9 h = 540 min: three even parts rather than 240 + 240 + 60.
    expect(two.map((a) => a.duration_minutes)).toEqual([180, 180, 180]);
  });

  it('meal: an eating action at home', () => {
    const [a] = decomposeDeterministically(block(12, 13, 'Lunch at home', 'Home'), ctx)!;
    expect(a).toMatchObject({ action_type: 'eating', resolved_location_id: HOME, target_location: 'Rosa Cottage', duration_minutes: 60 });
  });

  it('keeps every action within the 5-240 minute bounds and sums to the block', () => {
    for (const hours of [1, 3, 4, 5, 8, 9, 10]) {
      const c = { ...ctx, workStart: 0, workEnd: 24 };
      const actions = decomposeDeterministically(block(0, hours, 'Run the store', 'General Store'), c)!;
      expect(actions.reduce((s, a) => s + a.duration_minutes, 0)).toBe(hours * 60);
      for (const a of actions) {
        expect(a.duration_minutes).toBeGreaterThanOrEqual(5);
        expect(a.duration_minutes).toBeLessThanOrEqual(240);
      }
    }
  });

  it('has the same keys as an LLM-parsed action once its location is resolved', () => {
    // parseDecomposedActions + PlanDecomposer's resolution step give these
    // keys; consumers (PlanExecutor._actionToScored, the UI) read no others.
    const [llm] = parseDecomposedActions(
      JSON.stringify({ actions: [{ action: 'Go to bed and sleep', location: 'Rosa Cottage', minutes: 120 }] }),
      ['Rosa Cottage'],
      [],
    );
    llm.resolved_location_id = HOME;
    const [det] = decomposeDeterministically(block(22, 24, 'Go to bed and sleep', 'Rosa Cottage'), ctx)!;
    const defined = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k]) => k).sort();
    expect(defined(det)).toEqual(defined(llm));
    expect(det).toEqual(llm);
  });
});
