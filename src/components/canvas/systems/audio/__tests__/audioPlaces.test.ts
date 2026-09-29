import { describe, it, expect } from 'vitest';
import { buildAudioPlaces } from '../audioPlaces';
import { computePlaceStates, type PlaceClimate } from '../../placeLife/placeState';

const climate = (over: Partial<PlaceClimate> = {}): PlaceClimate => ({
  hour: 10, dayPhase: 'morning', weather: 'sunny', season: 'summer', meeting: false, ...over,
});

const building = (id: number, type: string, x = 200 * id, y = 300, w = 160, h = 128) => ({
  id, type, name: type, position: { x, y, width: w, height: h }, entry_point: { x: x + 80, y: y + h },
});

const agent = (id: number, at: number | null, action: any = { type: 'idle' }, extra: any = {}) => ({
  id, current_location: at, current_action: action, activeStates: [], position: { x: 0, y: 0 }, ...extra,
});

function places(locations: any[], agents: any[], c = climate()) {
  return buildAudioPlaces(locations, computePlaceStates(locations, agents, c), c.dayPhase === 'night');
}

describe('buildAudioPlaces', () => {
  it('an empty town is silent', () => {
    expect(places([building(1, 'workshop'), building(2, 'tavern')], [])).toEqual([]);
  });

  it('the forge rings only while someone works it', () => {
    const shop = building(1, 'workshop');
    expect(places([shop], [agent(1, 1, { type: 'idle' })])).toEqual([]);
    const out = places([shop], [agent(1, 1, { type: 'working' })]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('forge');
    expect(out[0].busy).toBeGreaterThan(0.5);
    // Inside the building.
    expect(out[0].x).toBeGreaterThanOrEqual(shop.position.x);
    expect(out[0].x).toBeLessThanOrEqual(shop.position.x + shop.position.width);
  });

  it('a tavern murmurs from its door once three are awake inside', () => {
    const pub = building(2, 'tavern');
    expect(places([pub], [agent(1, 2), agent(2, 2)])).toEqual([]);
    const out = places([pub], [agent(1, 2), agent(2, 2), agent(3, 2)]);
    expect(out.map((p) => p.kind)).toEqual(['crowd']);
    expect(out[0].x).toBe(pub.entry_point.x);
    expect(out[0].y).toBe(pub.entry_point.y - 8);
  });

  it('sleepers are not a crowd', () => {
    const sleep = { type: 'sleeping' };
    expect(places([building(2, 'tavern')], [agent(1, 2, sleep), agent(2, 2, sleep), agent(3, 2, sleep)])).toEqual([]);
  });

  it('a fuller house is busier', () => {
    const pub = building(2, 'tavern');
    const few = places([pub], [1, 2, 3].map((i) => agent(i, 2)))[0].busy;
    const many = places([pub], [1, 2, 3, 4, 5, 6, 7].map((i) => agent(i, 2)))[0].busy;
    expect(many).toBeGreaterThan(few);
    expect(places([pub], Array.from({ length: 20 }, (_, i) => agent(i, 2)))[0].busy).toBe(1);
  });

  it('music: a full tavern at night, not by day, and never at the dive bar', () => {
    const five = [1, 2, 3, 4, 5].map((i) => agent(i, 2));
    const night = climate({ hour: 22, dayPhase: 'night' });
    expect(places([building(2, 'tavern')], five).map((p) => p.kind)).toEqual(['crowd']);
    expect(places([building(2, 'tavern')], five, night).map((p) => p.kind)).toEqual(['crowd', 'tavern']);
    const dive = places([building(2, 'divebar')], five.map((a) => ({ ...a })), night);
    expect(dive.map((p) => p.kind)).toEqual(['crowd']);
  });

  it('a performer brings the music at any hour', () => {
    const out = places([building(2, 'tavern')], [agent(1, 2, { type: 'idle', zoneActivity: 'play_music' })]);
    expect(out).toEqual([expect.objectContaining({ kind: 'tavern', busy: 1 })]);
  });

  it('people gathered on the square are a crowd at its middle', () => {
    const sq = building(3, 'town_square', 600, 300, 200, 200);
    const out = places([sq], [1, 2, 3, 4].map((i) => agent(i, 3)));
    expect(out).toEqual([expect.objectContaining({ kind: 'crowd', x: 700, y: 400 })]);
  });

  it('ignores places with no footprint and other building types', () => {
    const odd = { id: 9, type: 'workshop', position: { x: 0, y: 0, width: 0, height: 0 } };
    expect(places([odd, building(4, 'bakery')], [agent(1, 9, { type: 'working' }), agent(2, 4, { type: 'working' })])).toEqual([]);
  });
});
