import { describe, it, expect, beforeEach } from 'vitest';
import { findAvailableZone, resolveZoneForAction, zoneOccupancy, occupancyKey } from '../lib/interiorGrid';

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
    // bed in home has maxOccupants=1; fill it
    zoneOccupancy.enter(1, 'home', 'bed');
    const zone = findAvailableZone('home', 'sleep');
    expect(zone).toBeNull();
  });

  it('skips full zones and returns first available zone', () => {
    // home:bed maxOccupants=1; home:kitchen maxOccupants=2 and allows 'eat'/'cook'; home:living allows 'idle'
    // Fill kitchen (maxOccupants=2) so that a second 'cook' request returns null since only kitchen allows cook
    zoneOccupancy.enter(1, 'home', 'kitchen');
    zoneOccupancy.enter(2, 'home', 'kitchen');
    const zone = findAvailableZone('home', 'cook');
    expect(zone).toBeNull();
  });

  it('tracks occupancy per building instance when a location id is given', () => {
    // Agent 1 sleeps in home #10 — bed bucket for home #10 is full
    zoneOccupancy.enter(1, occupancyKey('home', 10), 'bed');
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

describe('resolveZoneForAction', () => {
  beforeEach(() => {
    zoneOccupancy.clear();
  });

  it('delegates to findAvailableZone', () => {
    const zone = resolveZoneForAction('sleep', 'home');
    expect(zone).not.toBeNull();
    expect(zone!.id).toBe('bed');
  });
});
