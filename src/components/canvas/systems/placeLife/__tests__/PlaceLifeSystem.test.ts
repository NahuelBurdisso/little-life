import { describe, it, expect, vi, beforeEach } from 'vitest';

// A headless stand-in for the bits of PixiJS the system touches, so pools, fades and
// emitters can be exercised without a GPU or a DOM (same approach as the ambient tests).
vi.mock('pixi.js', () => {
  class FakeContainer {
    children: any[] = [];
    addChild(c: any) {
      if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
      c.parent = this;
      this.children.push(c);
      return c;
    }
  }
  class FakeSprite {
    parent: FakeContainer | null = null;
    visible = true;
    alpha = 1;
    tint = 0xffffff;
    blendMode = 'normal';
    eventMode = 'auto';
    texture: any;
    destroyed = false;
    scale = { x: 1, y: 1, set(v: number) { this.x = v; this.y = v; } };
    position = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
    anchor = { x: 0, y: 0, set(x: number, y?: number) { this.x = x; this.y = y ?? x; } };
    constructor(t?: any) { this.texture = t; }
    destroy() { this.destroyed = true; this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  }
  return { Sprite: FakeSprite, Container: FakeContainer, Texture: { EMPTY: { empty: true } } };
});
vi.mock('../../../stripAtlas', () => ({
  loadStrip: (url: string, n: number) => Promise.resolve(Array.from({ length: n }, (_, i) => ({ url, frame: i }))),
}));
vi.mock('../../../BuildingRenderer', () => ({
  WINDOW_CENTER_ABOVE_SOUTH_EDGE: 6,
  southWindowXs: (loc: any) => {
    const { x, width } = loc.position;
    return [x + width * 0.28, x + width * 0.72].filter((wx) => Math.abs(wx - loc.entry_point.x) >= 16);
  },
}));

import * as PIXI from 'pixi.js';
import { createPlaceLifeSystem } from '../PlaceLifeSystem';
import { PLACE_FRAMES } from '../placeFrames';
import type { DataContext, FrameContext } from '../../types';

const building = (id: number, type: string, x: number, y: number, w = 160, h = 128, extra: any = {}) => ({
  id, type, name: type, position: { x, y, width: w, height: h }, entry_point: { x: x + 80, y: y + h }, ...extra,
});
const agent = (id: number, at: number | null, action: any = { type: 'idle' }, extra: any = {}) => ({
  id, current_location: at, current_action: action, activeStates: [], position: { x: 0, y: 0 }, ...extra,
});

const baseWorld = (over: any = {}) => ({
  day_phase: 'morning', weather: 'sunny', time: { season: 'summer', hour: 10 },
  map_width: 60, map_height: 40, terrain_tiles: [], road_tiles: [], ...over,
});

function setup(locations: any[], agents: any[], world = baseWorld()) {
  const ground = new (PIXI.Container as any)();
  const over = new (PIXI.Container as any)();
  const positions: Record<number, { x: number; y: number }> = {};
  const services: any = {
    sprites: { getSprite: (id: string) => (positions[+id] ? { container: positions[+id] } : undefined) },
    bubbles: {},
  };
  const sys = createPlaceLifeSystem({ ground, overAgents: over }, services);
  const data: DataContext = { agents, world, events: [], locations, conversations: [], relationships: [], activity: [] };
  const frame = (scale = 1, view = { x: 0, y: 0, w: 1600, h: 1000 }): FrameContext => ({
    dt: 1, seconds: 1 / 60, now: 0, data, view: { ...view, scale },
  });
  return { sys, ground, over, data, frame, positions };
}

const settle = () => new Promise(r => setTimeout(r, 0));
const visible = (c: any) => c.children.filter((s: any) => s.visible);
const run = (sys: any, f: () => FrameContext, seconds: number) => {
  const fr = f();
  for (let i = 0; i < seconds * 60; i++) sys.update(fr);
};
const glows = (ground: any) => visible(ground).filter((s: any) => s.blendMode === 'add');

describe('PlaceLifeSystem', () => {
  beforeEach(() => vi.useRealTimers());

  it('does nothing until the atlases have loaded, and never throws', () => {
    const { sys, frame, data, ground, over } = setup([building(1, 'workshop', 96, 200)], [agent(1, 1, { type: 'working' })]);
    sys.onData!(data);
    expect(() => sys.update(frame())).not.toThrow();
    expect(visible(ground).length + visible(over).length).toBe(0);
  });

  it('lights the forge and throws sparks while somebody works, then cools down', async () => {
    const loc = building(1, 'workshop', 96, 200);
    const { sys, ground, over, data, frame } = setup([loc], [agent(1, 1, { type: 'working' })]);
    await settle();
    sys.onData!(data);
    const fr = frame();
    const sparkFrames = new Set<number>();
    for (let i = 0; i < 60 * 8; i++) {
      sys.update(fr);
      for (const s of visible(over)) {
        sparkFrames.add(s.texture.frame);
        expect(Number.isFinite(s.position.x) && Number.isFinite(s.position.y)).toBe(true);
      }
    }
    const lit = glows(ground);
    expect(lit.length).toBe(2); // the furnace and the vent
    // the furnace glow sits on the forge tile and is tinted orange
    const furnace = lit.find((g: any) => g.position.x === 96 + 3 * 32 + 16)!;
    expect(furnace.position.y).toBe(200 + 2 * 32 + 16);
    expect(furnace.tint).toBe(0xff7a2a);
    expect(furnace.alpha).toBeGreaterThan(0.1);
    expect(sparkFrames.size).toBeGreaterThan(0);
    for (const f of sparkFrames) expect(PLACE_FRAMES.spark as readonly number[]).toContain(f);

    // the smith goes home
    data.agents = [agent(1, 9, { type: 'walking' })];
    sys.onData!(data);
    run(sys, frame, 4);
    expect(glows(ground).length).toBe(0);
    expect(visible(over).length).toBe(0);
  });

  it('a full tavern puffs chatter and notes above its door, drifting upward', async () => {
    const tav = building(1, 'tavern', 1000, 200, 192, 160);
    const crowd = [1, 2, 3, 4, 5, 6].map(i => agent(i, 1));
    const { sys, over, data, frame } = setup([tav], crowd, baseWorld({ day_phase: 'night' }));
    await settle();
    sys.onData!(data);
    const fr = frame(1, { x: 800, y: 0, w: 1600, h: 1000 });
    const seen = new Set<number>();
    let minY = Infinity;
    for (let i = 0; i < 60 * 12; i++) {
      sys.update(fr);
      for (const s of visible(over)) {
        seen.add(s.texture.frame);
        minY = Math.min(minY, s.position.y);
      }
    }
    const allowed = new Set<number>([...PLACE_FRAMES.puff, ...PLACE_FRAMES.note]);
    expect(seen.size).toBeGreaterThan(0);
    for (const f of seen) expect(allowed.has(f)).toBe(true);
    // started at the door (y = 360 - 8) and floated up
    expect(minY).toBeLessThan(tav.entry_point.y - 8 - 8);
  });

  it('shows the OPEN sign inside hours and flips it to CLOSED after them', async () => {
    const shop = building(1, 'shop', 300, 300, 160, 128, { operating_hours: { open: 8, close: 18 } });
    const { sys, ground, data, frame } = setup([shop], []);
    await settle();
    sys.onData!(data);
    run(sys, frame, 1);
    const frames = () => visible(ground).map((s: any) => s.texture.frame);
    expect(frames().length).toBe(1);
    expect(PLACE_FRAMES.signOpen as readonly number[]).toContain(frames()[0]);
    data.world = baseWorld({ time: { season: 'summer', hour: 21 }, day_phase: 'evening' });
    sys.onData!(data);
    run(sys, frame, 1);
    expect(PLACE_FRAMES.signClosed as readonly number[]).toContain(frames()[0]);
  });

  it('skips what is off screen, and at far zoom keeps only glows and the flag', async () => {
    const hall = building(1, 'town_hall', 400, 400, 192, 160);
    const work = building(2, 'workshop', 96, 200);
    const { sys, ground, over, data, frame } = setup([hall, work], [agent(1, 2, { type: 'working' })]);
    await settle();
    sys.onData!(data);
    run(sys, () => frame(1, { x: 5000, y: 5000, w: 800, h: 600 }), 3);
    expect(visible(ground).length + visible(over).length).toBe(0);
    run(sys, () => frame(0.4), 3);
    const shown = visible(ground);
    expect(shown.length).toBeGreaterThan(0);
    for (const s of shown) {
      const isGlow = s.blendMode === 'add';
      const isFlag = s.texture?.frame >= PLACE_FRAMES.flag.hang && s.texture?.frame <= PLACE_FRAMES.flag.gust[1];
      expect(isGlow || isFlag).toBe(true);
    }
    expect(visible(over).length).toBe(0);
  });

  it('rings the town hall bell for a crowd, then lets it rest', async () => {
    const hall = building(1, 'town_hall', 400, 400, 192, 160);
    const { sys, ground, data, frame } = setup([hall], [1, 2, 3].map(i => agent(i, 1)));
    await settle();
    sys.onData!(data);
    const bellFrames = new Set<number>();
    const fr = frame();
    for (let i = 0; i < 60 * 3; i++) {
      sys.update(fr);
      for (const s of visible(ground)) {
        const f = s.texture.frame;
        if (f >= PLACE_FRAMES.bell.rest && f <= PLACE_FRAMES.bell.right) bellFrames.add(f);
      }
    }
    expect(bellFrames).toEqual(new Set([PLACE_FRAMES.bell.rest, PLACE_FRAMES.bell.left, PLACE_FRAMES.bell.right]));
    data.agents = [];
    sys.onData!(data);
    bellFrames.clear();
    for (let i = 0; i < 60 * 10; i++) sys.update(fr);   // past the after-swing
    for (let i = 0; i < 60; i++) {
      sys.update(fr);
      for (const s of visible(ground)) {
        const f = s.texture.frame;
        if (f >= PLACE_FRAMES.bell.rest && f <= PLACE_FRAMES.bell.right) bellFrames.add(f);
      }
    }
    expect(bellFrames).toEqual(new Set([PLACE_FRAMES.bell.rest]));
  });

  it('lets hens roam inside the coop yard and puts them away at night', async () => {
    const farm = building(1, 'farm', 640, 200, 320, 224);
    const { sys, ground, data, frame } = setup([farm], []);
    await settle();
    sys.onData!(data);
    run(sys, frame, 30);
    const hens = visible(ground);
    expect(hens.length).toBe(3);
    for (const h of hens) {
      expect(h.position.x).toBeGreaterThan(640 - 20);
      expect(h.position.x).toBeLessThan(640 + 96);
      expect(h.position.y).toBeGreaterThan(200 + 3 * 32 - 20);
      expect(h.position.y).toBeLessThan(200 + 5 * 32 + 20);
    }
    data.world = baseWorld({ day_phase: 'night' });
    sys.onData!(data);
    run(sys, frame, 3);
    expect(visible(ground).length).toBe(0);
  });

  it('follows a working farmer with dust', async () => {
    const farm = building(1, 'farm', 640, 200, 320, 224);
    const farmer = agent(1, 1, { type: 'working' }, { position: { x: 700, y: 240 } });
    const { sys, ground, data, frame, positions } = setup([farm], [farmer]);
    positions[1] = { x: 700, y: 240 };
    await settle();
    sys.onData!(data);
    const fr = frame();
    let dust = 0;
    for (let i = 0; i < 60 * 6; i++) {
      sys.update(fr);
      dust += visible(ground).filter((s: any) => (PLACE_FRAMES.dust as readonly number[]).includes(s.texture.frame)).length;
    }
    expect(dust).toBeGreaterThan(0);
  });

  it('stays within its sprite budget across many polls and a heavy town', async () => {
    const locs: any[] = [];
    const agents: any[] = [];
    for (let i = 0; i < 40; i++) {
      const type = ['shop', 'clinic', 'bakery', 'workshop', 'tavern', 'home', 'pawnshop', 'prison'][i % 8];
      locs.push(building(i + 1, type, 100 + (i % 8) * 220, 100 + Math.floor(i / 8) * 220, 160, 128));
      for (let k = 0; k < 4; k++) agents.push(agent(i * 4 + k + 1, i + 1, { type: 'working' }, { activeStates: [{ type: i % 2 ? 'sick' : 'arrested' }] }));
    }
    const { sys, ground, over, data, frame } = setup(locs, agents);
    await settle();
    for (let poll = 0; poll < 20; poll++) {
      data.world = baseWorld({ time: { season: 'summer', hour: (poll * 3) % 24 } });
      sys.onData!(data);
      run(sys, frame, 1);
    }
    expect(ground.children.length).toBeLessThanOrEqual(96);
    expect(over.children.length).toBe(56);
  });

  it('destroys every sprite it made', async () => {
    const { sys, ground, over, data, frame } = setup([building(1, 'workshop', 96, 200)], [agent(1, 1, { type: 'working' })]);
    await settle();
    sys.onData!(data);
    run(sys, frame, 2);
    sys.destroy();
    expect(ground.children.length).toBe(0);
    expect(over.children.length).toBe(0);
  });
});
