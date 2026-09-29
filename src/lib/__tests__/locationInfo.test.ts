import { describe, expect, it } from 'vitest';
import { hoursSummary, locationAt, locationIcon, prettyLocationType } from '../locationInfo';
import { eventFocusLocation, formatTimeLeft, EVENT_UI } from '../eventUi';
import { WORLD_EVENTS } from '../../../server/data/worldEventCatalog';

const street = { id: 1, name: 'Main Street', type: 'mainstreet', position: { x: 0, y: 100, width: 1000, height: 64 } };
const shop = { id: 2, name: 'Shop', type: 'shop', position: { x: 200, y: 90, width: 160, height: 128 } };
const square = { id: 3, name: 'Square', type: 'town_square', position: { x: 600, y: 400, width: 288, height: 256 } };

describe('locationAt', () => {
  it('returns the smallest footprint when areas overlap', () => {
    expect(locationAt(250, 120, [street, shop])?.id).toBe(2);
    expect(locationAt(500, 120, [street, shop])?.id).toBe(1);
  });
  it('is null on bare ground', () => {
    expect(locationAt(50, 800, [street, shop, square])).toBeNull();
  });
  it('treats the far edge as outside', () => {
    expect(locationAt(360, 120, [shop])).toBeNull();
    expect(locationAt(200, 90, [shop])?.id).toBe(2);
  });
});

describe('hoursSummary', () => {
  it('handles overnight ranges', () => {
    const dive = { open: 18, close: 2 };
    expect(hoursSummary(dive, 23)).toEqual({ range: '18:00–02:00', open: true });
    expect(hoursSummary(dive, 12).open).toBe(false);
  });
  it('is always open without hours', () => {
    expect(hoursSummary(null, 3)).toEqual({ range: 'Open all day', open: true });
  });
});

describe('labels', () => {
  it('prettifies types and falls back on unknown icons', () => {
    expect(prettyLocationType('town_hall')).toBe('Town Hall');
    expect(locationIcon('nope')).toBe('📍');
  });
});

describe('event ui', () => {
  it('covers every catalog event', () => {
    for (const k of Object.keys(WORLD_EVENTS)) expect(EVENT_UI).toHaveProperty(k);
  });
  it('formats time left', () => {
    expect(formatTimeLeft(40)).toBe('40 min left');
    expect(formatTimeLeft(120)).toBe('2h left');
    expect(formatTimeLeft(135)).toBe('2h 15m left');
  });
  it('focuses the event-specific place, else the square, else nothing', () => {
    const locs = [square, { id: 9, type: 'farm' }];
    expect(eventFocusLocation('harvest', locs)).toBe(9);
    expect(eventFocusLocation('festival', locs)).toBe(3);
    expect(eventFocusLocation('festival', [])).toBeNull();
  });
});
