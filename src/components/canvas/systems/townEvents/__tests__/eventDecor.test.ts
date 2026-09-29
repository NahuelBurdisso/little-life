import { describe, it, expect } from 'vitest';
import {
  planEventDecor, planEvent, wellBox, DECOR_FRAME_COUNT, DECOR_FRAMES,
  type DecorPlacement,
} from '../eventDecor';

const square = { id: 1, type: 'town_square', position: { x: 640, y: 320, width: 384, height: 256 }, entry_point: { x: 832, y: 448 } };
const market = { id: 2, type: 'market_square', position: { x: 96, y: 96, width: 320, height: 160 }, entry_point: { x: 250, y: 176 } };
const clinic = { id: 3, type: 'clinic', position: { x: 128, y: 640, width: 128, height: 96 }, entry_point: { x: 192, y: 736 } };
const home = { id: 4, type: 'home', position: { x: 448, y: 640, width: 96, height: 96 }, entry_point: { x: 496, y: 736 } };
const bakery = { id: 5, type: 'bakery', position: { x: 576, y: 640, width: 128, height: 96 }, entry_point: { x: 640, y: 736 } };
const prison = { id: 6, type: 'prison', position: { x: 736, y: 640, width: 128, height: 96 }, entry_point: { x: 800, y: 736 } };
const LOCS = [square, market, clinic, home, bakery, prison];
const MAP = { w: 1920, h: 1280 };

const ev = (id: number, type: string, extra: object = {}) =>
  ({ id, type, name: type, started_at: 0, duration: 60, location_id: null, triggered_by: null, ...extra });

const inside = (p: DecorPlacement, r: { x: number; y: number; width: number; height: number }) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

const ALL_TYPES = [
  'festival', 'market_day', 'traveling_merchant', 'wedding', 'funeral', 'harvest', 'competition',
  'town_meeting', 'scandal', 'blessing', 'starry_night', 'full_moon', 'sickness', 'fire_outbreak',
];

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
    for (const type of ALL_TYPES) {
      for (const p of planEvent(ev(9, type), LOCS, MAP)) {
        expect(Number.isInteger(p.frame)).toBe(true);
        expect(p.frame).toBeGreaterThanOrEqual(0);
        expect(p.frame + p.frames).toBeLessThanOrEqual(DECOR_FRAME_COUNT);
        expect(p.frames).toBeGreaterThanOrEqual(1);
        if (p.frames > 1) expect(p.fps).toBeGreaterThan(0);
        expect(p.phase).toBeGreaterThanOrEqual(0);
        expect(p.phase).toBeLessThan(1);
        expect(['ground', 'over']).toContain(p.layer);
      }
    }
  });

  it('yields nothing for unknown or undecorated types', () => {
    for (const t of ['storm', 'heatwave', 'mysterious_stranger', 'new_arrival', 'bountiful_catch', 'nonsense', '']) {
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

  it('decorates the clinic for sickness and nothing without one', () => {
    const ps = planEvent(ev(1, 'sickness'), LOCS, MAP);
    expect(ps.map(p => p.frame)).toContain(DECOR_FRAMES.closedSign);
    expect(ps.map(p => p.frame)).toContain(DECOR_FRAMES.herbs);
    expect(planEvent(ev(1, 'sickness'), [square], MAP)).toEqual([]);
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
  });

  it('copes with empty and malformed input', () => {
    expect(planEventDecor([], LOCS, MAP)).toEqual([]);
    expect(planEventDecor([ev(1, 'festival')], [], null)).toEqual([]);
    expect(planEventDecor([null, undefined, {}] as any, LOCS, MAP)).toEqual([]);
  });
});
