import { describe, it, expect } from 'vitest';
import { chimneySmokes, computePlaceStates, readClimate, type PlaceClimate, type PlaceState } from '../placeState';
import type { AgentLite } from '../../../SpritePool';

const climate = (over: Partial<PlaceClimate> = {}): PlaceClimate => ({
  hour: 10, dayPhase: 'morning', weather: 'sunny', season: 'summer', meeting: false, ...over,
});

const loc = (id: number, type: string, extra: Record<string, unknown> = {}) => ({
  id, type, position: { x: 100 * id, y: 100, width: 160, height: 128 }, entry_point: { x: 100 * id + 80, y: 228 }, ...extra,
});

const agent = (id: number, at: number | null, action: AgentLite['current_action'] = { type: 'idle' }, extra: Record<string, unknown> = {}) => ({
  id, current_location: at, current_action: action, activeStates: [], ...extra,
});

const state = (over: Partial<PlaceState>): PlaceState => ({
  id: 1, type: 'home', occupants: 0, awake: 0, working: 0, eating: 0, sick: 0, arrested: 0, performing: 0,
  staffAssigned: 0, staffInside: 0, open: true, ...over,
});

describe('readClimate', () => {
  it('reads the clock, weather and a running town meeting', () => {
    const c = readClimate(
      { day_phase: 'evening', weather: 'windy', time: { hour: 19, season: 'autumn' } },
      [{ type: 'festival' }, { type: 'town_meeting' }],
    );
    expect(c).toEqual({ hour: 19, dayPhase: 'evening', weather: 'windy', season: 'autumn', meeting: true });
  });

  it('falls back to a plain spring morning', () => {
    expect(readClimate(null, undefined)).toEqual({ hour: 12, dayPhase: 'morning', weather: 'sunny', season: 'spring', meeting: false });
  });
});

describe('computePlaceStates', () => {
  it('counts who is inside and what they are doing', () => {
    const [bakery] = computePlaceStates(
      [loc(1, 'bakery')],
      [
        agent(1, 1, { type: 'working' }, { workplace: 1 }),
        agent(2, 1, { type: 'eating' }),
        agent(3, 1, 'sleeping'),
        agent(4, 9, { type: 'working' }, { workplace: 1 }), // employed here, elsewhere right now
      ],
      climate(),
    );
    expect(bakery).toMatchObject({ occupants: 3, awake: 2, working: 1, eating: 1, staffAssigned: 2, staffInside: 1 });
  });

  it('reads sickness and arrest from the active states, as objects or strings', () => {
    const states = computePlaceStates(
      [loc(1, 'clinic'), loc(2, 'prison')],
      [
        agent(1, 1, { type: 'idle' }, { activeStates: [{ type: 'sick' }] }),
        agent(2, 1, { type: 'idle' }, { activeStates: ['angry'] }),
        agent(3, 2, { type: 'idle' }, { activeStates: [{ type: 'arrested' }, 'sick'] }),
      ],
      climate(),
    );
    expect(states[0]).toMatchObject({ occupants: 2, sick: 1, arrested: 0 });
    expect(states[1]).toMatchObject({ occupants: 1, sick: 1, arrested: 1 });
  });

  it('applies operating hours, including a place that closes past midnight', () => {
    const shop = loc(1, 'shop', { operating_hours: { open: 8, close: 18 } });
    const dive = loc(2, 'divebar', { operating_hours: { open: 18, close: 2 } });
    expect(computePlaceStates([shop, dive], [], climate({ hour: 10 })).map(s => s.open)).toEqual([true, false]);
    expect(computePlaceStates([shop, dive], [], climate({ hour: 23 })).map(s => s.open)).toEqual([false, true]);
    expect(computePlaceStates([shop, dive], [], climate({ hour: 1 })).map(s => s.open)).toEqual([false, true]);
  });

  it('a place with no hours is always open', () => {
    expect(computePlaceStates([loc(1, 'clinic')], [], climate({ hour: 3 }))[0].open).toBe(true);
  });

  it('counts a performer by activity or by standing on the tavern stage', () => {
    const tavern = loc(1, 'tavern', { position: { x: 1000, y: 200, width: 192, height: 160 }, entry_point: { x: 1096, y: 360 } });
    const onStage = { x: 1000 + 3 * 32 + 16, y: 200 + 32 + 16 }; // stage centre tile
    const atBar = { x: 1000 + 16, y: 200 + 32 + 16 };
    const [st] = computePlaceStates(
      [tavern],
      [
        agent(1, 1, { type: 'working' }, { position: onStage }),
        agent(2, 1, { type: 'idle', zoneActivity: 'perform' }, { position: atBar }),
        agent(3, 1, { type: 'working' }, { position: atBar }),
        agent(4, 1, { type: 'walking' }, { position: onStage }),
        agent(5, 1, { type: 'sleeping' }, { position: onStage }),
      ],
      climate(),
    );
    expect(st.performing).toBe(2);
    expect(st.occupants).toBe(5);
  });

  it('ignores agents in places that do not exist and agents in transit', () => {
    const [h] = computePlaceStates([loc(1, 'home')], [agent(1, 42), agent(2, null)], climate());
    expect(h.occupants).toBe(0);
  });
});

describe('chimneySmokes', () => {
  it('a home smokes for an awake resident who is cooking, or at the hearth hours', () => {
    expect(chimneySmokes(state({ awake: 1, eating: 1, occupants: 1 }), climate())).toBe(true);
    expect(chimneySmokes(state({ awake: 1, occupants: 1 }), climate({ dayPhase: 'evening' }))).toBe(true);
    expect(chimneySmokes(state({ awake: 1, occupants: 1 }), climate({ dayPhase: 'afternoon' }))).toBe(false);
  });

  it('a home is cold in winter or rain, so the hearth burns by day too', () => {
    const home = state({ awake: 1, occupants: 1 });
    expect(chimneySmokes(home, climate({ season: 'winter', dayPhase: 'afternoon' }))).toBe(true);
    expect(chimneySmokes(home, climate({ weather: 'rainy', dayPhase: 'afternoon' }))).toBe(true);
  });

  it('a sleeping or empty home banks the fire, whatever the hour', () => {
    expect(chimneySmokes(state({ occupants: 1, awake: 0 }), climate({ dayPhase: 'night', season: 'winter' }))).toBe(false);
    expect(chimneySmokes(state({}), climate({ dayPhase: 'evening' }))).toBe(false);
  });

  it('a tavern smokes when busy, or when anyone is in of an evening', () => {
    expect(chimneySmokes(state({ type: 'tavern', occupants: 3 }), climate())).toBe(true);
    expect(chimneySmokes(state({ type: 'tavern', occupants: 1 }), climate())).toBe(false);
    expect(chimneySmokes(state({ type: 'tavern', occupants: 1 }), climate({ dayPhase: 'night' }))).toBe(true);
    expect(chimneySmokes(state({ type: 'divebar', occupants: 0 }), climate({ dayPhase: 'night' }))).toBe(false);
  });

  it('the oven and the forge smoke while somebody works them', () => {
    expect(chimneySmokes(state({ type: 'bakery', working: 1, staffAssigned: 1 }), climate({ dayPhase: 'afternoon' }))).toBe(true);
    expect(chimneySmokes(state({ type: 'workshop', working: 1, staffAssigned: 1 }), climate({ dayPhase: 'night' }))).toBe(true);
  });

  it('a staffed bakery or workshop is cold when nobody is working, even at the old hours', () => {
    expect(chimneySmokes(state({ type: 'bakery', staffAssigned: 1 }), climate({ dayPhase: 'dawn' }))).toBe(false);
    expect(chimneySmokes(state({ type: 'workshop', staffAssigned: 2 }), climate({ dayPhase: 'morning' }))).toBe(false);
  });

  it('an unstaffed bakery or workshop keeps the old dawn/day schedule', () => {
    expect(chimneySmokes(state({ type: 'bakery' }), climate({ dayPhase: 'dawn' }))).toBe(true);
    expect(chimneySmokes(state({ type: 'bakery' }), climate({ dayPhase: 'evening' }))).toBe(false);
    expect(chimneySmokes(state({ type: 'workshop' }), climate({ dayPhase: 'afternoon' }))).toBe(true);
  });

  it('buildings without a chimney never smoke', () => {
    expect(chimneySmokes(state({ type: 'shop', occupants: 5, awake: 5, working: 2 }), climate({ dayPhase: 'evening' }))).toBe(false);
  });
});
