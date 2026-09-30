import { describe, it, expect, beforeEach } from 'vitest';
import { findAvailableZone, zoneOccupancy, occupancyKey } from '../lib/interiorGrid';

describe('findAvailableZone', () => {
  beforeEach(() => {
    zoneOccupancy.clear();
  });

  it('returns zone for sleeping at home', () => {
    const zone = findAvailableZone('home', 'sleep');
    expect(zone).not.toBeNull();
    expect(zone!.id).toBe('bed');
  });

  it('returns null for action with no matching zone', () => {
    const zone = findAvailableZone('shop', 'sleep');
    expect(zone).toBeNull();
  });

  it('returns null for unknown building type', () => {
    const zone = findAvailableZone('unknown', 'work');
    expect(zone).toBeNull();
  });

  it('returns null for open areas with no zones', () => {
    const zone = findAvailableZone('farm', 'work');
    expect(zone).toBeNull();
  });

  it('returns working zone for shop', () => {
    const zone = findAvailableZone('shop', 'work');
    expect(zone).not.toBeNull();
  });

  it('returns socializing zone for tavern', () => {
    const zone = findAvailableZone('tavern', 'socialize');
    expect(zone).not.toBeNull();
  });

  it('returns null when all matching zones are full', () => {
    // bed in home has maxOccupants=2; fill it
    zoneOccupancy.enter(1, 'home', 'bed');
    zoneOccupancy.enter(2, 'home', 'bed');
    const zone = findAvailableZone('home', 'sleep');
    expect(zone).toBeNull();
  });

  it('skips full zones and returns first available zone', () => {
    // home:bed maxOccupants=2; home:kitchen maxOccupants=2 and allows 'eat'/'cook'; home:living allows 'idle'
    // Fill kitchen (maxOccupants=2) so that a second 'cook' request returns null since only kitchen allows cook
    zoneOccupancy.enter(1, 'home', 'kitchen');
    zoneOccupancy.enter(2, 'home', 'kitchen');
    const zone = findAvailableZone('home', 'cook');
    expect(zone).toBeNull();
  });

  it('does not count the requesting agent against its own zone', () => {
    // Agent 1 is already asleep in home #10's bed, which a second sleeper has filled
    // (maxOccupants 2). Re-deciding 'sleeping' must return that same bed, not null:
    // returning null made the decision engine route the agent to the building
    // entry_point, so agents spent the night lying on their own doorstep.
    zoneOccupancy.enter(1, occupancyKey('home', 10), 'bed');
    zoneOccupancy.enter(2, occupancyKey('home', 10), 'bed');
    const zone = findAvailableZone('home', 'sleeping', 10, 1);
    expect(zone).not.toBeNull();
    expect(zone!.id).toBe('bed');
  });

  it('still blocks a different agent from a zone that is full', () => {
    zoneOccupancy.enter(1, occupancyKey('home', 10), 'bed');
    zoneOccupancy.enter(2, occupancyKey('home', 10), 'bed');
    expect(findAvailableZone('home', 'sleeping', 10, 3)).toBeNull();
  });

  it('gives both residents of one home the bed, and a third finds no sleep zone', () => {
    // Married couples used to sleep one in the bed and one on the floor (capacity 1).
    const key = occupancyKey('home', 10);
    const first = findAvailableZone('home', 'sleeping', 10, 1);
    expect(first!.id).toBe('bed');
    zoneOccupancy.enter(1, key, first!.id);
    const second = findAvailableZone('home', 'sleeping', 10, 2);
    expect(second!.id).toBe('bed');
    zoneOccupancy.enter(2, key, second!.id);
    // A third sleeper (a lodger, a grown child) is not in the bed: there is no other sleep zone.
    expect(findAvailableZone('home', 'sleeping', 10, 3)).toBeNull();
  });

  it('tracks occupancy per building instance when a location id is given', () => {
    // Agents 1 and 2 sleep in home #10 — bed bucket for home #10 is full
    zoneOccupancy.enter(1, occupancyKey('home', 10), 'bed');
    zoneOccupancy.enter(2, occupancyKey('home', 10), 'bed');
    expect(findAvailableZone('home', 'sleeping', 10)).toBeNull();
    // But home #11's bed is a separate instance and stays available
    const zone = findAvailableZone('home', 'sleeping', 11);
    expect(zone).not.toBeNull();
    expect(zone!.id).toBe('bed');
  });

  it('uses fallback zone via ZONE_FALLBACKS when applicable', () => {
    // shop:shelves supports 'browse' with maxOccupants=2; 'browse' is also on display (maxOccupants=3)
    // shelves fallback is display — fill shelves and display so fallback returns null
    zoneOccupancy.enter(1, 'shop', 'shelves');
    zoneOccupancy.enter(2, 'shop', 'shelves');
    // shelves full, display still open — findAvailableZone should return display (primary match)
    const zone = findAvailableZone('shop', 'browse');
    expect(zone).not.toBeNull();
    expect(zone!.id).toBe('display');
  });
});
