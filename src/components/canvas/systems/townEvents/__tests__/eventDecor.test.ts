import { describe, it, expect } from 'vitest';
import {
  planEventDecor, planEvent, wellBox, eventAnchorRect, strangerSpot, riverRect, DECOR_FRAME_COUNT, DECOR_FRAMES,
  type DecorPlacement,
} from '../eventDecor';

const square = { id: 1, type: 'town_square', position: { x: 640, y: 320, width: 384, height: 256 }, entry_point: { x: 832, y: 448 } };
const market = { id: 2, type: 'market_square', position: { x: 96, y: 96, width: 320, height: 160 }, entry_point: { x: 250, y: 176 } };
const clinic = { id: 3, type: 'clinic', position: { x: 128, y: 640, width: 128, height: 96 }, entry_point: { x: 192, y: 736 } };
const home = { id: 4, type: 'home', position: { x: 448, y: 640, width: 96, height: 96 }, entry_point: { x: 496, y: 736 } };
const bakery = { id: 5, type: 'bakery', position: { x: 576, y: 640, width: 128, height: 96 }, entry_point: { x: 640, y: 736 } };
const prison = { id: 6, type: 'prison', position: { x: 736, y: 640, width: 128, height: 96 }, entry_point: { x: 800, y: 736 } };
const park = { id: 7, type: 'park', position: { x: 1100, y: 640, width: 288, height: 192 }, entry_point: { x: 1240, y: 832 } };
const hall = { id: 8, type: 'town_hall', position: { x: 300, y: 640, width: 128, height: 96 }, entry_point: { x: 364, y: 736 } };
const LOCS = [square, market, clinic, home, bakery, prison];
const LOCS_WITH_PARK = [...LOCS, park];
/** A road entering from the west edge at row 10, and another that ends short of the border. */
const ROADS = [{ x: 0, y: 10 }, { x: 1, y: 10 }, { x: 2, y: 10 }, { x: 20, y: 5 }, { x: 20, y: 6 }];
const MAP = { w: 1920, h: 1280 };

const ev = (id: number, type: string, extra: object = {}) =>
  ({ id, type, name: type, started_at: 0, duration: 60, location_id: null, triggered_by: null, ...extra });

const inside = (p: DecorPlacement, r: { x: number; y: number; width: number; height: number }) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

const ALL_TYPES = [
  'festival', 'market_day', 'traveling_merchant', 'wedding', 'funeral', 'harvest', 'competition',
  'town_meeting', 'scandal', 'blessing', 'starry_night', 'full_moon', 'heatwave', 'sickness', 'fire_outbreak',
];
/** Events anchored to something other than an open area, each with its own describe below. */
const SPECIAL_TYPES = ['mysterious_stranger', 'bountiful_catch', 'new_arrival'];

describe('planEvent', () => {
  it('gives every decorated type placements inside its anchor', () => {
    const anchors: Record<string, typeof square> = {
      market_day: market, traveling_merchant: market, sickness: clinic,
    };
    for (const type of ALL_TYPES) {
      if (type === 'fire_outbreak') continue;
      const ps = planEvent(ev(7, type), LOCS, MAP);
      expect(ps.length, type).toBeGreaterThan(0);
      const anchor = anchors[type] ?? square;
      for (const p of ps) expect(inside(p, anchor.position), `${type} ${JSON.stringify(p)}`).toBe(true);
    }
  });

  it('only uses frames that exist in the atlas, with sane animation fields', () => {
    for (const type of [...ALL_TYPES, ...SPECIAL_TYPES]) {
      for (const p of planEvent(ev(9, type, { location_id: home.id }), [...LOCS_WITH_PARK, hall], MAP, ROADS)) {
        expect(Number.isInteger(p.frame)).toBe(true);
        expect(p.frame).toBeGreaterThanOrEqual(0);
        expect(p.frame + p.frames).toBeLessThanOrEqual(DECOR_FRAME_COUNT);
        expect(p.frames).toBeGreaterThanOrEqual(1);
        if (p.frames > 1) expect(p.fps).toBeGreaterThan(0);
        expect(p.phase).toBeGreaterThanOrEqual(0);
        expect(p.phase).toBeLessThan(1);
        expect(['ground', 'over']).toContain(p.layer);
        if (p.motion) {
          expect(['fall', 'wander', 'arrive']).toContain(p.motion.kind);
          expect(p.motion.period).toBeGreaterThan(0);
        }
      }
    }
  });

  it('yields nothing for unknown or undecorated types', () => {
    for (const t of ['storm', 'nonsense', '']) {
      expect(planEvent(ev(1, t), LOCS, MAP), t).toEqual([]);
    }
  });

  it('is stable across calls and does not depend on input order', () => {
    for (const type of ALL_TYPES) {
      const a = planEvent(ev(3, type), LOCS, MAP);
      const b = planEvent(ev(3, type), [...LOCS].reverse(), MAP);
      expect(b, type).toEqual(a);
    }
  });

  it('keeps solid props off the town square well and its benches', () => {
    const box = wellBox(square.position, 'town_square')!;
    const solid = new Set<number>([
      DECOR_FRAMES.stallRed, DECOR_FRAMES.stallBlue, DECOR_FRAMES.crate, DECOR_FRAMES.arch,
      DECOR_FRAMES.wreath, DECOR_FRAMES.pumpkin, DECOR_FRAMES.hay, DECOR_FRAMES.basket,
      DECOR_FRAMES.flag, DECOR_FRAMES.podium, DECOR_FRAMES.bench, DECOR_FRAMES.lectern,
      DECOR_FRAMES.board,
    ]);
    for (const type of ALL_TYPES) {
      for (const p of planEvent(ev(5, type), [square], MAP)) {
        if (!solid.has(p.frame)) continue;
        const hit = p.x + 12 > box.x0 && p.x - 12 < box.x1 && p.y > box.y0 && p.y - 8 < box.y1;
        expect(hit, `${type} frame ${p.frame} at ${p.x},${p.y}`).toBe(false);
      }
    }
  });

  it('places bunting along the square edges for a festival', () => {
    const ps = planEvent(ev(1, 'festival'), [square], MAP);
    const bunting = ps.filter(p => p.frame === DECOR_FRAMES.bunting);
    expect(bunting.length).toBeGreaterThanOrEqual(12);
    const ys = new Set(bunting.map(p => p.y));
    expect(ys.size).toBe(2);
    expect(Math.min(...ys)).toBeLessThan(square.position.y + 64);
    expect(Math.max(...ys)).toBeGreaterThan(square.position.y + 192);
    expect(ps.some(p => p.frame === DECOR_FRAMES.lantern)).toBe(true);
    expect(ps.some(p => p.frame === DECOR_FRAMES.stallRed || p.frame === DECOR_FRAMES.stallBlue)).toBe(true);
  });

  it('uses white bunting and an arch for a wedding, dark bunting and a wreath for a funeral', () => {
    const w = planEvent(ev(1, 'wedding'), [square], MAP).map(p => p.frame);
    expect(w).toContain(DECOR_FRAMES.arch);
    expect(w).toContain(DECOR_FRAMES.buntingWhite);
    expect(w).not.toContain(DECOR_FRAMES.buntingDark);
    const f = planEvent(ev(1, 'funeral'), [square], MAP).map(p => p.frame);
    expect(f).toContain(DECOR_FRAMES.wreath);
    expect(f).toContain(DECOR_FRAMES.candle);
    expect(f).toContain(DECOR_FRAMES.buntingDark);
    expect(f).not.toContain(DECOR_FRAMES.bunting);
  });

  it('falls back to the market square, then to the map centre', () => {
    const noSquare = LOCS.filter(l => l.type !== 'town_square');
    for (const p of planEvent(ev(1, 'festival'), noSquare, MAP)) expect(inside(p, market.position)).toBe(true);
    const bare = LOCS.filter(l => l.type !== 'town_square' && l.type !== 'market_square');
    const ps = planEvent(ev(1, 'festival'), bare, MAP);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      expect(Math.abs(p.x - MAP.w / 2)).toBeLessThanOrEqual(200);
      expect(Math.abs(p.y - MAP.h / 2)).toBeLessThanOrEqual(140);
    }
  });

  it('honours an open-area location_id but ignores a building one for square events', () => {
    const atMarket = planEvent(ev(1, 'festival', { location_id: market.id }), LOCS, MAP);
    expect(atMarket.length).toBeGreaterThan(0);
    for (const p of atMarket) expect(inside(p, market.position)).toBe(true);
    const atHome = planEvent(ev(1, 'festival', { location_id: home.id }), LOCS, MAP);
    for (const p of atHome) expect(inside(p, square.position)).toBe(true);
  });

  it('drops the well exclusion when the anchor is not a town square', () => {
    expect(wellBox(market.position, 'market_square')).toBeNull();
    expect(wellBox(square.position, 'town_square')).not.toBeNull();
  });

  it('puts the flames on a roof, seeded by the event id, never on the prison or open ground', () => {
    const seen = new Set<number>();
    for (let id = 1; id <= 40; id++) {
      const ps = planEvent(ev(id, 'fire_outbreak'), LOCS, MAP);
      expect(ps.length).toBeGreaterThan(0);
      const host = [clinic, home, bakery].find(b => inside(ps[0], b.position));
      expect(host, `event ${id}`).toBeDefined();
      for (const p of ps) expect(inside(p, host!.position)).toBe(true);
      seen.add(host!.id);
      expect(planEvent(ev(id, 'fire_outbreak'), LOCS, MAP)).toEqual(ps);
      expect(ps.some(p => p.frame === DECOR_FRAMES.fire && p.frames === 4)).toBe(true);
      expect(ps.every(p => p.layer === 'over')).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('burns the building named by location_id', () => {
    const ps = planEvent(ev(2, 'fire_outbreak', { location_id: bakery.id }), LOCS, MAP);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) expect(inside(p, bakery.position)).toBe(true);
  });

  it('has no fire when there is no building to burn', () => {
    expect(planEvent(ev(1, 'fire_outbreak'), [square, market], MAP)).toEqual([]);
  });

  it('decorates the clinic for sickness', () => {
    const ps = planEvent(ev(1, 'sickness'), LOCS, MAP);
    expect(ps.map(p => p.frame)).toContain(DECOR_FRAMES.closedSign);
    expect(ps.map(p => p.frame)).toContain(DECOR_FRAMES.herbs);
    for (const p of ps) expect(inside(p, clinic.position)).toBe(true);
  });

  it('falls back to the town hall, then the square, when the map has no clinic', () => {
    const noClinic = LOCS.filter(l => l.type !== 'clinic');
    const atHall = planEvent(ev(1, 'sickness'), [...noClinic, hall], MAP);
    expect(atHall.map(p => p.frame)).toContain(DECOR_FRAMES.closedSign);
    for (const p of atHall) expect(inside(p, hall.position)).toBe(true);

    const atSquare = planEvent(ev(1, 'sickness'), noClinic, MAP);
    expect(atSquare.map(p => p.frame)).toContain(DECOR_FRAMES.closedSign);
    for (const p of atSquare) expect(inside(p, square.position)).toBe(true);

    expect(planEvent(ev(1, 'sickness'), [], null)).toEqual([]);
  });

  it('prefers the clinic even when a town hall exists', () => {
    for (const p of planEvent(ev(1, 'sickness'), [...LOCS, hall], MAP)) expect(inside(p, clinic.position)).toBe(true);
  });

  it('adapts to a small square without leaving it', () => {
    const tiny = { ...square, position: { x: 100, y: 100, width: 96, height: 96 } };
    for (const type of ALL_TYPES) {
      if (type === 'fire_outbreak' || type === 'sickness') continue;
      for (const p of planEvent(ev(1, type), [tiny], MAP)) expect(inside(p, tiny.position), type).toBe(true);
    }
  });

  it('sorts placements back to front', () => {
    const ps = planEvent(ev(1, 'festival'), [square], MAP);
    for (let i = 1; i < ps.length; i++) expect(ps[i].y).toBeGreaterThanOrEqual(ps[i - 1].y);
  });
});

describe('planEventDecor', () => {
  it('returns one plan per decorated event, skipping the rest', () => {
    const plans = planEventDecor([ev(1, 'festival'), ev(2, 'storm'), ev(3, 'wedding')], LOCS, MAP);
    expect(plans.map(p => p.eventId)).toEqual([1, 3]);
    expect(plans.every(p => p.placements.length > 0)).toBe(true);
  });

  it('decorates a type once even if the server has two of them, except fires', () => {
    expect(planEventDecor([ev(1, 'festival'), ev(2, 'festival')], LOCS, MAP).map(p => p.eventId)).toEqual([1]);
    expect(planEventDecor([ev(1, 'fire_outbreak'), ev(2, 'fire_outbreak')], LOCS, MAP)).toHaveLength(2);
    const homes = [{ ...home, id: 40 }, { ...home, id: 41, position: { ...home.position, x: 900 }, entry_point: { x: 948, y: 736 } }];
    const arrivals = [ev(3, 'new_arrival', { location_id: 40 }), ev(4, 'new_arrival', { location_id: 41 })];
    expect(planEventDecor(arrivals, homes, MAP).map(p => p.eventId)).toEqual([3, 4]);
  });

  it('copes with empty and malformed input', () => {
    expect(planEventDecor([], LOCS, MAP)).toEqual([]);
    expect(planEventDecor([ev(1, 'festival')], [], null)).toEqual([]);
    expect(planEventDecor([null, undefined, {}] as any, LOCS, MAP)).toEqual([]);
  });
});

const framesOf = (ps: DecorPlacement[]) => ps.map(p => p.frame);

describe('events that used to have no decor', () => {
  it('gives the heatwave shade and water on the square, off the well', () => {
    const ps = planEvent(ev(1, 'heatwave'), [square], MAP);
    expect(framesOf(ps)).toContain(DECOR_FRAMES.parasol);
    expect(framesOf(ps)).toContain(DECOR_FRAMES.waterBarrel);
    const box = wellBox(square.position, 'town_square')!;
    for (const p of ps.filter(q => q.frame === DECOR_FRAMES.parasol || q.frame === DECOR_FRAMES.waterBarrel)) {
      expect(p.x + 12 > box.x0 && p.x - 12 < box.x1 && p.y > box.y0 && p.y - 8 < box.y1, `${p.frame}`).toBe(false);
    }
  });

  it('lets the heat rise and the sickness haze green', () => {
    const heat = planEvent(ev(1, 'heatwave'), [square], MAP).filter(p => p.frame === DECOR_FRAMES.heatHaze);
    expect(heat.length).toBeGreaterThanOrEqual(3);
    for (const h of heat) expect(h.motion).toMatchObject({ kind: 'fall' });
    for (const h of heat) expect((h.motion as { dy: number }).dy).toBeLessThan(0);
    expect(heat.every(h => h.tint === undefined)).toBe(true);
    const sick = planEvent(ev(1, 'sickness'), LOCS, MAP).filter(p => p.frame === DECOR_FRAMES.heatHaze);
    expect(sick.length).toBeGreaterThanOrEqual(2);
    expect(sick.every(h => typeof h.tint === 'number')).toBe(true);
  });

  it('puts the stranger on the road tile nearest the map edge, standing on that tile', () => {
    const ps = planEvent(ev(1, 'mysterious_stranger'), LOCS, MAP, ROADS);
    expect(ps).toHaveLength(1);
    expect(ps[0].frame).toBe(DECOR_FRAMES.stranger);
    expect(ps[0].frames).toBe(2);
    // Road tile (0,10) is on the border; of the border tiles the lowest one wins.
    expect(ps[0].x).toBe(16);
    expect(Math.floor(ps[0].y / 32)).toBe(10);
  });

  it('breaks ties between border road tiles the same way whatever the order', () => {
    const roads = [{ x: 0, y: 12 }, { x: 5, y: 0 }, { x: 0, y: 3 }];
    const a = strangerSpot(LOCS, MAP, roads);
    const b = strangerSpot(LOCS, MAP, [...roads].reverse());
    expect(a).toEqual(b);
    expect(a).toEqual({ x: 176, y: 29 });      // (5,0): lowest y among the distance-0 tiles
  });

  it('falls back to the square edge without roads, and to nothing without anywhere to stand', () => {
    const spot = strangerSpot(LOCS, MAP, []);
    expect(spot).not.toBeNull();
    expect(spot!.x).toBeLessThan(square.position.x);
    expect(planEvent(ev(1, 'mysterious_stranger'), LOCS, MAP, undefined)).toHaveLength(1);
    expect(planEvent(ev(1, 'mysterious_stranger'), [], null, [])).toEqual([]);
  });

  it('lets fish jump on the park river, with the catch landed on the bank', () => {
    const ps = planEvent(ev(1, 'bountiful_catch'), LOCS_WITH_PARK, MAP);
    const river = riverRect(park)!;
    const jumps = ps.filter(p => p.frame === DECOR_FRAMES.fishJump);
    expect(jumps.length).toBeGreaterThanOrEqual(2);
    for (const j of jumps) {
      expect(j.frames).toBe(6);
      // The water line of the jump cell sits 8 px above its foot: that must be inside the river.
      expect(j.x).toBeGreaterThanOrEqual(river.x);
      expect(j.x).toBeLessThanOrEqual(river.x + river.width);
      expect(j.y - 8).toBeGreaterThanOrEqual(river.y);
      expect(j.y - 8).toBeLessThanOrEqual(river.y + river.height);
    }
    // Jumps must not all leap on the same beat.
    expect(new Set(jumps.map(j => j.fps)).size).toBe(jumps.length);
    expect(framesOf(ps)).toContain(DECOR_FRAMES.fishCrate);
    expect(framesOf(ps)).toContain(DECOR_FRAMES.netRack);
    for (const p of ps) expect(inside(p, park.position)).toBe(true);
    // Crates and nets stand on the bank, below the water.
    for (const p of ps.filter(q => q.frame === DECOR_FRAMES.fishCrate || q.frame === DECOR_FRAMES.netRack)) {
      expect(p.y).toBeGreaterThan(river.y + river.height);
    }
  });

  it('sells the catch from the square when there is no park, with no jumping fish', () => {
    const ps = planEvent(ev(1, 'bountiful_catch'), LOCS, MAP);
    expect(framesOf(ps)).toContain(DECOR_FRAMES.fishCrate);
    expect(framesOf(ps)).not.toContain(DECOR_FRAMES.fishJump);
    for (const p of ps) expect(inside(p, square.position)).toBe(true);
  });

  it("pulls a cart up to the new home's door with luggage and a welcome banner", () => {
    const ps = planEvent(ev(1, 'new_arrival', { location_id: home.id }), LOCS, MAP);
    expect(framesOf(ps)).toEqual(expect.arrayContaining([DECOR_FRAMES.cart, DECOR_FRAMES.luggage, DECOR_FRAMES.welcome]));
    const cart = ps.find(p => p.frame === DECOR_FRAMES.cart)!;
    expect(cart.motion).toMatchObject({ kind: 'arrive' });
    // Everything stands by the door (496,736), not on some other building.
    for (const p of ps.filter(q => !q.motion)) {
      expect(Math.abs(p.x - home.entry_point.x)).toBeLessThanOrEqual(90);
      expect(Math.abs(p.y - home.entry_point.y)).toBeLessThanOrEqual(80);
    }
  });

  it('draws nothing for a new arrival whose home is unknown', () => {
    expect(planEvent(ev(1, 'new_arrival'), LOCS, MAP)).toEqual([]);
    expect(planEvent(ev(1, 'new_arrival', { location_id: 999 }), LOCS, MAP)).toEqual([]);
  });
});

describe('the sparkle events are no longer one picture', () => {
  const kinds = (type: string) => {
    const ps = planEvent(ev(1, type), [square], MAP);
    return new Set(ps.map(p => p.frame));
  };

  it('blessing rains gold motes, full moon has fireflies and an owl, starry night is bare sparkles', () => {
    const blessing = planEvent(ev(1, 'blessing'), [square], MAP);
    expect(blessing.filter(p => p.frame === DECOR_FRAMES.moteFall && p.motion?.kind === 'fall').length).toBeGreaterThanOrEqual(3);

    const moon = planEvent(ev(1, 'full_moon'), [square], MAP);
    expect(moon.filter(p => p.frame === DECOR_FRAMES.firefly && p.motion?.kind === 'wander').length).toBeGreaterThanOrEqual(3);
    expect(framesOf(moon)).toContain(DECOR_FRAMES.owl);
    expect(kinds('full_moon').has(DECOR_FRAMES.sparkle)).toBe(false);

    expect([...kinds('starry_night')]).toEqual([DECOR_FRAMES.sparkle]);
    expect(kinds('blessing')).not.toEqual(kinds('full_moon'));
    expect(kinds('blessing')).not.toEqual(kinds('starry_night'));
  });

  it('staggers falling clusters so they never fall in step', () => {
    const falls = planEvent(ev(1, 'blessing'), [square], MAP).filter(p => p.motion?.kind === 'fall');
    expect(new Set(falls.map(p => p.phase)).size).toBe(falls.length);
  });
});

describe('every decorated event has some motion', () => {
  it('animates or moves at least one placement', () => {
    for (const type of [...ALL_TYPES, ...SPECIAL_TYPES]) {
      const ps = planEvent(ev(2, type, { location_id: home.id }), [...LOCS_WITH_PARK, hall], MAP, ROADS);
      expect(ps.some(p => p.frames > 1 || p.motion), type).toBe(true);
    }
  });
});

describe('eventAnchorRect', () => {
  it('returns the area an anchored event decorates, and null for the rest', () => {
    expect(eventAnchorRect(ev(1, 'blessing'), LOCS, MAP)).toEqual(square.position);
    expect(eventAnchorRect(ev(1, 'market_day'), LOCS, MAP)).toEqual(market.position);
    expect(eventAnchorRect(ev(1, 'storm'), LOCS, MAP)).toBeNull();
    expect(eventAnchorRect(null, LOCS, MAP)).toBeNull();
  });
});
