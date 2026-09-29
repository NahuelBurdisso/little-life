import { describe, it, expect } from 'vitest';
import { describeAction } from '../actionText';

describe('describeAction', () => {
  it('prefers the zone activity over the coarse type', () => {
    expect(describeAction({ type: 'idle', zoneActivity: 'fish' })).toBe('Fishing by the river');
    expect(describeAction({ type: 'comfort', zoneActivity: 'comfort' })).toBe('Looking for comfort');
  });

  it('names the place for place-bound types', () => {
    expect(describeAction({ type: 'working' }, "Rosa's Bakery")).toBe("Working at Rosa's Bakery");
    expect(describeAction({ type: 'working' })).toBe('Working');
    expect(describeAction({ type: 'sleeping' })).toBe('Sleeping');
  });

  it('never leaks a raw type token', () => {
    expect(describeAction({ type: 'idle' })).toBe('Taking a moment');
    expect(describeAction({ type: 'some_new_action' })).toBe('Some new action');
    expect(describeAction({ type: 'idle', zoneActivity: 'moon_walk' })).toBe('Moon walk');
    // Decision sources share the field with real activities.
    expect(describeAction({ type: 'idle', zoneActivity: 'plan:decomposed' })).toBe('Taking a moment');
    expect(describeAction({ type: 'idle', zoneActivity: 'goal:seek_target' }, 'the Tavern')).toBe('Spending time at the Tavern');
  });

  it('honours an explicit description and tolerates junk', () => {
    expect(describeAction({ type: 'idle', description: 'waiting for a friend' })).toBe('Waiting for a friend');
    expect(describeAction(null)).toBe('Taking a moment');
    expect(describeAction('sleeping')).toBe('Sleeping');
  });
});
