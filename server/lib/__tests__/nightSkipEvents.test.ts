import { describe, it, expect } from 'vitest';
import { isWorldEventType } from '../../data/worldEventCatalog';
import { DISRUPTIVE_EVENT_TYPES } from '../nightSkip';

describe('DISRUPTIVE_EVENT_TYPES', () => {
  it('only names events that exist in the catalog (a renamed event would silently never stop a skip)', () => {
    for (const t of DISRUPTIVE_EVENT_TYPES) expect(isWorldEventType(t)).toBe(true);
  });

  it('leaves the ambient ones out', () => {
    for (const t of ['traveling_merchant', 'bountiful_catch', 'full_moon', 'starry_night', 'mysterious_stranger']) {
      expect(DISRUPTIVE_EVENT_TYPES).not.toContain(t);
    }
  });
});
