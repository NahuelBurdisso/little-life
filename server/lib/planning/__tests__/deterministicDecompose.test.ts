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
    expect(classifyBlock(block(21, 22, 'Read in bed', 'Rosa Cottage'), ctx)).toBeNull();
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
