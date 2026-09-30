import { describe, it, expect } from 'vitest';
import { isVeiled, roofCutAway, veiledBuildingIds } from '../discretion';

const tryst = { type: 'idle', zoneActivity: 'tryst', partnerId: 2 };
const home = (id: number, current_location: number | null, current_action?: unknown) => ({
  id, current_location, current_action: current_action as never,
});

describe('veiledBuildingIds', () => {
  it('is empty when nobody is in a private evening', () => {
    expect(veiledBuildingIds([]).size).toBe(0);
    expect(veiledBuildingIds([home(1, 7, { type: 'idle' }), home(2, 7, 'sleeping'), home(3, null)]).size).toBe(0);
  });

  it('names the building that hosts a tryst', () => {
    const ids = veiledBuildingIds([home(1, 7, tryst), home(2, 7, tryst), home(3, 9, { type: 'idle' })]);
    expect([...ids]).toEqual([7]);
  });

  it('a single partner in the record is enough, and an empty location is not a building', () => {
    expect(veiledBuildingIds([home(1, 4, tryst)]).has(4)).toBe(true);
    expect(veiledBuildingIds([home(1, null, tryst)]).size).toBe(0);
    expect(veiledBuildingIds([home(1, undefined as never, tryst)]).size).toBe(0);
  });

  it('the dawn walk home is not private: they are on the road for the town to see', () => {
    expect(veiledBuildingIds([home(1, 7, { type: 'walking', zoneActivity: 'sneak_home' })]).size).toBe(0);
  });

  it('is over the moment the tryst ends, whoever is still inside', () => {
    const during = veiledBuildingIds([home(1, 7, tryst), home(2, 7, tryst)]);
    const after = veiledBuildingIds([home(1, 7, { type: 'sleeping' }), home(2, 7, { type: 'sleeping' })]);
    expect(during.has(7)).toBe(true);
    expect(after.has(7)).toBe(false);
  });
});

describe('isVeiled', () => {
  const veiled = new Set([7]);

  it('hides the couple themselves', () => {
    expect(isVeiled(home(1, 7, tryst), veiled)).toBe(true);
    // Even at a place with no roof to keep on (a grove, a barn's yard): the camera looks away.
    expect(isVeiled(home(1, 12, tryst), new Set())).toBe(true);
  });

  it('hides anyone else inside the house too, so nobody floats over its roof', () => {
    expect(isVeiled(home(3, 7, { type: 'sleeping' }), veiled)).toBe(true);
  });

  it('leaves everyone else on the map', () => {
    expect(isVeiled(home(4, 9, { type: 'idle' }), veiled)).toBe(false);
    expect(isVeiled(home(4, null, { type: 'walking' }), veiled)).toBe(false);
    expect(isVeiled(home(5, 7, { type: 'walking', zoneActivity: 'sneak_home' }), new Set())).toBe(false);
  });
});

describe('roofCutAway', () => {
  it('cuts the roof away while hovered or occupied, as before', () => {
    expect(roofCutAway(false, false, false)).toBe(false);
    expect(roofCutAway(true, false, false)).toBe(true);
    expect(roofCutAway(false, true, false)).toBe(true);
    expect(roofCutAway(true, true, false)).toBe(true);
  });

  it('keeps a veiled roof on however it is hovered or occupied', () => {
    expect(roofCutAway(false, true, true)).toBe(false);
    expect(roofCutAway(true, true, true)).toBe(false);
    expect(roofCutAway(true, false, true)).toBe(false);
  });
});
