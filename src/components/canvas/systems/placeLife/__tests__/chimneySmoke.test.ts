import { describe, it, expect } from 'vitest';
import { ChimneySmokePlan } from '../chimneySmoke';
import type { DataContext } from '../../types';

const loc = (id: number, type: string) => ({
  id, type, position: { x: 100 * id, y: 100, width: 96, height: 96 }, entry_point: { x: 100 * id + 48, y: 196 },
});

const data = (over: Partial<DataContext> & { phase?: string } = {}): DataContext => ({
  agents: [],
  world: { day_phase: over.phase ?? 'afternoon', weather: 'sunny', time: { hour: 15, season: 'summer' } },
  events: [], locations: [loc(1, 'home'), loc(2, 'workshop')], conversations: [], relationships: [], activity: [],
  ...over,
});

describe('ChimneySmokePlan', () => {
  it('smokes the buildings whose people are busy, and only those', () => {
    const plan = new ChimneySmokePlan();
    plan.refresh(1000, data({
      agents: [
        { id: 1, current_location: 1, current_action: { type: 'eating' } },
        { id: 2, current_location: 2, current_action: { type: 'working' }, workplace: 2 },
      ] as any,
    }));
    expect(plan.smokes(1)).toBe(true);
    expect(plan.smokes(2)).toBe(true);
    expect(plan.smokes(99)).toBe(false);
  });

  it('keeps the last answer until the refresh timer runs out', () => {
    const plan = new ChimneySmokePlan();
    const busy = data({ agents: [{ id: 1, current_location: 1, current_action: { type: 'eating' } }] as any });
    plan.refresh(1000, busy);
    expect(plan.smokes(1)).toBe(true);
    plan.refresh(1200, data());               // everybody left, but too soon to notice
    expect(plan.smokes(1)).toBe(true);
    plan.refresh(1600, data());
    expect(plan.smokes(1)).toBe(false);
  });

  it('is quiet before any world has arrived', () => {
    const plan = new ChimneySmokePlan();
    plan.refresh(0, data({ world: null, locations: [] }));
    expect(plan.smokes(1)).toBe(false);
  });
});
