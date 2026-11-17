import { describe, it, expect, vi } from 'vitest';
import type { LocationLite } from '../../../../../lib/apiTypes';
import type { AgentLite } from '../../../SpritePool';
import { invalid } from '../../__tests__/kit';

// The real module drags in PixiJS; only its window layout is needed here (same maths).
vi.mock('../../../BuildingRenderer', () => ({
  WINDOW_CENTER_ABOVE_SOUTH_EDGE: 6,
  southWindowXs: (loc: { position: { x: number; width: number }; entry_point: { x: number } }) => {
    const { x, width } = loc.position;
    const doorW = 12;
    const xs = width < 70 ? [x + width / 2] : [x + width * 0.28, x + width * 0.72];
    return xs.filter((wx) => Math.abs(wx - loc.entry_point.x) >= doorW / 2 + 10);
  },
}));

import { bellSpot, chimneyCap, crossSpot, flagSpot, forgeSpot, ovenSpot, signSpot, stageSpot, windowCentres } from '../placeAnchors';
import { BELL_CROWD, buildPlacePlan, crowdInterval, laundrySpot, type PlaceItem, type PlanInput } from '../placePlan';
import { computePlaceStates, type PlaceClimate } from '../placeState';

const climate = (over: Partial<PlaceClimate> = {}): PlaceClimate => ({
  hour: 10, dayPhase: 'morning', weather: 'sunny', season: 'summer', meeting: false, ...over,
});

const building = (id: number, type: string, x = 200 * id, y = 300, w = 160, h = 128) => ({
  id, type, name: type, position: { x, y, width: w, height: h }, entry_point: { x: x + 80, y: y + h },
});

const agent = (id: number, at: number | null, action: AgentLite['current_action'] = { type: 'idle' }, extra: Record<string, unknown> = {}) => ({
  id, current_location: at, current_action: action, activeStates: [], position: { x: 0, y: 0 }, ...extra,
});

/** One member of the PlaceItem union, by its `kind`. */
type Item<K extends PlaceItem['kind']> = Extract<PlaceItem, { kind: K }>;
const isKind = <K extends PlaceItem['kind']>(kind: K) => (i: PlaceItem): i is Item<K> => i.kind === kind;

function plan(locations: LocationLite[], agents: AgentLite[], c = climate(), isFree?: PlanInput['isFree']): PlaceItem[] {
  return buildPlacePlan({ locations, states: computePlaceStates(locations, agents, c), agents, climate: c, isFree });
}
const kinds = (items: PlaceItem[]) => items.map(i => i.kind);
const keys = (items: PlaceItem[]) => items.map(i => i.key);

describe('anchors', () => {
  it('puts the chimney cap where BuildingRenderer draws it', () => {
    const out = { x: 0, y: 0 };
    expect(chimneyCap(building(1, 'workshop', 96, 200, 160), out)).toBe(true);
    // 4px chimney, 4px inset from the right edge, cap 8-2 above the top edge
    expect(out).toEqual({ x: 96 + 160 - 4 - 4 + 2, y: 200 - 8 + 2 });
    chimneyCap(building(1, 'bakery', 0, 100, 160), out);
    expect(out).toEqual({ x: 160 - 6 - 4 + 3, y: 100 - 10 + 2 });
    expect(chimneyCap(invalid({ type: 'home' }), out)).toBe(false);
  });

  it('finds the forge, the oven and the stage from the interior data', () => {
    const w = building(1, 'workshop', 96, 200);
    expect(forgeSpot(w)).toEqual({ x: 96 + 3 * 32 + 16, y: 200 + 2 * 32 + 16 });
    expect(ovenSpot(building(1, 'bakery', 0, 0))).toEqual({ x: 1 * 32 + 16, y: 1 * 32 + 16 });
    const s = stageSpot(building(1, 'tavern', 1000, 200, 192, 160))!;
    expect(s.x).toBeGreaterThan(1000 + 3 * 32);
    expect(s.x).toBeLessThan(1000 + 5 * 32);
    expect(stageSpot(building(1, 'shop'))).toBeNull();
  });

  it('hangs the sign beside the door, clear of the windows', () => {
    const shop = building(1, 'shop', 352, 300, 160, 128);
    const sign = signSpot(shop);
    const ex = shop.entry_point.x;
    expect(Math.abs(sign.x - ex)).toBeGreaterThanOrEqual(6 + 6);
    for (const w of windowCentres(shop)) expect(Math.abs(sign.x - w.x)).toBeGreaterThanOrEqual(11);
    expect(sign.y).toBe(shop.entry_point.y + 1);
    expect(sign.x).toBeGreaterThan(shop.position.x);
    expect(sign.x).toBeLessThan(shop.position.x + shop.position.width);
  });

  it('centres the clinic glow on the white cross the renderer draws', () => {
    const clinic = building(1, 'clinic', 1376, 300, 160, 128);
    expect(crossSpot(clinic)).toEqual({ x: clinic.entry_point.x - 1, y: 300 - 4 });
  });

  it('keeps the town hall flag and bell apart, on the north eave', () => {
    const hall = building(1, 'town_hall', 352, 300, 192, 160);
    const f = flagSpot(hall), b = bellSpot(hall);
    expect(b.x - f.x).toBeGreaterThan(64);
    expect(f.y).toBe(299);
  });

  it('places window centres on the drawn window rects', () => {
    const p = building(1, 'prison', 1088, 300, 160, 128);
    for (const w of windowCentres(p)) expect(w.y).toBe(300 + 128 - 6);
  });
});

describe('workplaces', () => {
  it('the forge glows and sparks only while somebody works the workshop', () => {
    const shop = building(1, 'workshop');
    expect(plan([shop], [agent(1, 1, { type: 'idle' })])).toEqual([]);
    const items = plan([shop], [agent(1, 1, { type: 'working' })]);
    expect(keys(items).sort()).toEqual(['forge:1', 'hammer:1', 'vent-sparks:1', 'vent:1']);
    const forge = items.find(i => i.key === 'forge:1')!;
    expect(forge).toMatchObject({ kind: 'glow', pulse: 'flicker' });
    expect(items.find(i => i.key === 'hammer:1')).toMatchObject({ mode: 'hammer', ...forgeSpot(shop)! });
  });

  it('the bakery glows at the oven and at its windows while the baker works', () => {
    const b = building(1, 'bakery');
    expect(kinds(plan([b], [])).filter(k => k === 'glow')).toEqual([]);
    const items = plan([b], [agent(1, 1, { type: 'working' })]);
    expect(keys(items)).toContain('oven:1');
    expect(keys(items).filter(k => k.startsWith('oven-window:1:')).length).toBe(windowCentres(b).length);
  });
});

describe('pubs', () => {
  it('a quiet tavern makes no noise; a busy one chatters at the door', () => {
    const tav = building(1, 'tavern', 1000, 200, 192, 160);
    expect(kinds(plan([tav], [agent(1, 1), agent(2, 1)]))).toEqual([]);
    const items = plan([tav], [agent(1, 1), agent(2, 1), agent(3, 1)]);
    const crowd = items.find(i => i.kind === 'crowd')!;
    expect(crowd).toMatchObject({ key: 'crowd:1', notes: 0, x: tav.entry_point.x, y: tav.entry_point.y - 8 });
  });

  it('gets livelier at night, with some music from a full house', () => {
    const tav = building(1, 'tavern', 1000, 200, 192, 160);
    const crowd = (c: PlaceClimate, n: number) => plan([tav], Array.from({ length: n }, (_, i) => agent(i + 1, 1)), c).find(isKind('crowd'))!;
    expect(crowd(climate({ dayPhase: 'night' }), 4).interval).toBeLessThan(crowd(climate(), 4).interval);
    expect(crowd(climate({ dayPhase: 'night' }), 6).notes).toBeGreaterThan(0);
    expect(crowd(climate({ dayPhase: 'night' }), 4).notes).toBe(0);
    expect(crowd(climate({ dayPhase: 'afternoon' }), 6).notes).toBe(0);
  });

  it('a performer lights the stage and fills the air with music, crowd or not', () => {
    const tav = building(1, 'tavern', 1000, 200, 192, 160);
    const items = plan([tav], [agent(1, 1, { type: 'idle', zoneActivity: 'perform' })]);
    expect(items.find(i => i.key === 'stage:1')).toMatchObject({ kind: 'glow', shape: 'wide' });
    expect(items.find(isKind('crowd'))!.notes).toBeGreaterThan(0.5);
  });

  it('the divebar has no stage to light', () => {
    const dive = building(1, 'divebar');
    const items = plan([dive], [agent(1, 1, { type: 'idle', zoneActivity: 'perform' }), agent(2, 1), agent(3, 1)]);
    expect(keys(items).filter(k => k.startsWith('stage'))).toEqual([]);
    expect(kinds(items)).toContain('crowd');
  });

  it('crowd interval shrinks with the crowd but never below 0.7s', () => {
    expect(crowdInterval(3, false)).toBeGreaterThan(crowdInterval(8, false));
    expect(crowdInterval(50, false)).toBeCloseTo(0.7);
    expect(crowdInterval(50, true)).toBeLessThan(crowdInterval(50, false));
  });
});

describe('signs', () => {
  it('shops, pawnshops, bakeries and clinics get one; homes and taverns do not', () => {
    const locs = ['shop', 'pawnshop', 'bakery', 'clinic', 'home', 'tavern'].map((t, i) => building(i + 1, t));
    const signs = plan(locs, []).filter(i => i.kind === 'sign');
    expect(signs.map(s => s.key).sort()).toEqual(['sign:1', 'sign:2', 'sign:3', 'sign:4']);
  });

  it('reads OPEN inside the hours with the staff in, CLOSED outside them or when they are out', () => {
    const shop = { ...building(1, 'shop'), operating_hours: { open: 8, close: 18 } };
    const sign = (c: PlaceClimate, agents: AgentLite[]) => (plan([shop], agents, c)[0] as Item<'sign'>).open;
    const clerk = (at: number | null) => agent(1, at, { type: 'working' }, { workplace: 1 });
    expect(sign(climate({ hour: 10 }), [clerk(1)])).toBe(true);
    expect(sign(climate({ hour: 10 }), [clerk(null)])).toBe(false); // clerk is late
    expect(sign(climate({ hour: 20 }), [clerk(1)])).toBe(false);   // after hours
    expect(sign(climate({ hour: 10 }), [])).toBe(true);            // nobody is employed: hours rule
  });

  it('a clinic with no hours is open around the clock while staffed', () => {
    const c = building(1, 'clinic');
    const doc = (at: number | null) => agent(1, at, { type: 'working' }, { workplace: 1 });
    expect((plan([c], [doc(1)], climate({ hour: 3 }))[0] as Item<'sign'>).open).toBe(true);
    expect((plan([c], [doc(null)], climate({ hour: 3 }))[0] as Item<'sign'>).open).toBe(false);
  });
});

describe('clinic, town hall, prison', () => {
  it('the cross pulses only while a sick agent is inside', () => {
    const c = building(1, 'clinic');
    const well = plan([c], [agent(1, 1)]);
    expect(keys(well)).toEqual(['sign:1']);
    const sick = plan([c], [agent(1, 1, { type: 'idle' }, { activeStates: [{ type: 'sick' }] })]);
    expect(sick.find(i => i.key === 'cross:1')).toMatchObject({ kind: 'glow', shape: 'cross', pulse: 'heartbeat' });
  });

  it('the flag always flies, streaming in wind; the bell rings for a crowd or a meeting', () => {
    const hall = building(1, 'town_hall', 352, 300, 192, 160);
    const get = (c: PlaceClimate, n: number) => {
      const items = plan([hall], Array.from({ length: n }, (_, i) => agent(i + 1, 1)), c);
      return { flag: items.find(isKind('flag'))!, bell: items.find(isKind('bell'))! };
    };
    expect(get(climate(), 0).flag.gust).toBe(false);
    expect(get(climate({ weather: 'windy' }), 0).flag.gust).toBe(true);
    expect(get(climate({ weather: 'stormy' }), 0).flag.gust).toBe(true);
    expect(get(climate(), BELL_CROWD - 1).bell.ringing).toBe(false);
    expect(get(climate(), BELL_CROWD).bell.ringing).toBe(true);
    expect(get(climate({ meeting: true }), 0).bell.ringing).toBe(true);
  });

  it('shows hands on the bars for each arrested inmate, one window each', () => {
    const p = building(1, 'prison', 1088, 300, 160, 128);
    const windows = windowCentres(p).length;
    const arrested = (id: number) => agent(id, 1, { type: 'idle' }, { activeStates: [{ type: 'arrested' }] });
    expect(kinds(plan([p], [agent(1, 1)]))).toEqual([]);
    expect(kinds(plan([p], [arrested(1)]))).toEqual(['hands']);
    expect(plan([p], [arrested(1), arrested(2), arrested(3), arrested(4)]).length).toBe(windows);
  });
});

describe('homes', () => {
  const home = building(2, 'home', 400, 300, 96, 96);
  const free = () => true;

  it('hang laundry on a dry day while somebody is home', () => {
    expect(kinds(plan([home], [agent(1, 2)], climate(), free))).toEqual(['laundry']);
  });

  it('not when it rains, at night, when nobody is home, or when there is nowhere to hang it', () => {
    expect(plan([home], [agent(1, 2)], climate({ weather: 'rainy' }), free)).toEqual([]);
    expect(plan([home], [agent(1, 2)], climate({ dayPhase: 'night' }), free)).toEqual([]);
    expect(plan([home], [], climate(), free)).toEqual([]);
    expect(plan([home], [agent(1, 2)], climate(), () => false)).toEqual([]);
  });

  it('windy days make it flap', () => {
    const item = plan([home], [agent(1, 2)], climate({ weather: 'windy' }), free)[0] as Item<'laundry'>;
    expect(item.windy).toBe(true);
  });

  it('picks the side that is free, east first for even ids', () => {
    const east = laundrySpot({ id: 2, position: home.position }, () => true)!;
    const west = laundrySpot({ id: 3, position: home.position }, () => true)!;
    expect(east.x).toBeGreaterThan(home.position.x + home.position.width);
    expect(west.x).toBeLessThan(home.position.x);
    const onlyWest = laundrySpot({ id: 2, position: home.position }, (b) => b.x < home.position.x)!;
    expect(onlyWest.x).toBeLessThan(home.position.x);
  });
});

describe('the farm', () => {
  const farm = building(1, 'farm', 640, 200, 320, 224);

  it('keeps chickens in the coop yard by day and puts them to bed at night', () => {
    const day = plan([farm], []).find(isKind('chickens'))!;
    expect(day.count).toBe(3);
    // the yard covers the coop tiles (0-1, 3) of the farm
    expect(day.rect.x).toBeLessThan(640 + 32);
    expect(day.rect.y).toBeLessThan(200 + 3 * 32 + 8);
    expect(plan([farm], [], climate({ dayPhase: 'night' })).find(i => i.kind === 'chickens')).toBeUndefined();
  });

  it('raises dust where a farmer works the rows, and not for one idling in them or at the coop', () => {
    const inRows = { x: 640 + 60, y: 200 + 40 };
    const items = plan([farm], [
      agent(1, 1, { type: 'working' }, { position: inRows }),
      agent(2, 1, { type: 'idle' }, { position: inRows }),
      agent(3, 1, { type: 'working' }, { position: { x: 640 + 40, y: 200 + 3 * 32 + 16 } }),
      agent(4, 7, { type: 'working' }, { position: inRows }),
      agent(5, 1, { type: 'idle', zoneActivity: 'garden' }, { position: inRows }),
    ]);
    expect(items.filter(i => i.kind === 'dust').map(i => i.key).sort()).toEqual(['dust:1', 'dust:5']);
  });

  it('a farmyard has two hens of its own', () => {
    const yard = building(4, 'farmyard', 300, 500, 96, 96);
    const item = plan([yard], []).find(isKind('chickens'))!;
    expect(item.count).toBe(2);
    expect(item.rect.x).toBeGreaterThanOrEqual(300);
    expect(item.rect.x + item.rect.width).toBeLessThanOrEqual(396);
  });
});

describe('plan keys', () => {
  it('are unique across a whole busy town', () => {
    const locs = [
      building(1, 'workshop'), building(2, 'bakery'), building(3, 'tavern', 1000, 200, 192, 160), building(4, 'clinic'),
      building(5, 'town_hall', 400, 500, 192, 160), building(6, 'prison'), building(7, 'home', 800, 800, 96, 96),
      building(8, 'farm', 1400, 200, 320, 224), building(9, 'shop'),
    ];
    const agents = [
      agent(1, 1, { type: 'working' }), agent(2, 2, { type: 'working' }), agent(3, 3), agent(4, 3), agent(5, 3),
      agent(6, 4, { type: 'idle' }, { activeStates: [{ type: 'sick' }] }), agent(7, 6, { type: 'idle' }, { activeStates: [{ type: 'arrested' }] }),
      agent(8, 7),
    ];
    const items = plan(locs, agents, climate(), () => true);
    const k = keys(items);
    expect(new Set(k).size).toBe(k.length);
    expect(items.length).toBeGreaterThan(15);
  });
});
