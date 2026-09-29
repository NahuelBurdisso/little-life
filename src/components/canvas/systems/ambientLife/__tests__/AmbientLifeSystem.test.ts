import { describe, it, expect, vi, beforeEach } from 'vitest';

// A headless stand-in for the bits of PixiJS the system touches, so the pools, spawning
// and recycling can be exercised without a GPU or a DOM.
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
    eventMode = 'auto';
    texture: any;
    destroyed = false;
    scale = { x: 1, y: 1 };
    position = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
    anchor = { set() {} };
    constructor(t?: any) { this.texture = t; }
    destroy() { this.destroyed = true; this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  }
  return { Sprite: FakeSprite, Container: FakeContainer, Texture: { EMPTY: { empty: true } } };
});
vi.mock('../../../stripAtlas', () => ({
  loadStrip: (_url: string, n: number) => Promise.resolve(Array.from({ length: n }, (_, i) => ({ frame: i }))),
}));
vi.mock('../../../BuildingRenderer', () => ({
  WINDOW_CENTER_ABOVE_SOUTH_EDGE: 6,
  southWindowXs: (loc: any) => [loc.position.x + loc.position.width * 0.28, loc.position.x + loc.position.width * 0.72],
}));

import * as PIXI from 'pixi.js';
import { createAmbientLifeSystem } from '../AmbientLifeSystem';
import type { DataContext, FrameContext } from '../../types';
import { POOL_CAPS, MAX_CRITTERS } from '../ambientPlan';

const home = (id: number, x: number, y: number) => ({
  id, type: 'home', name: `Home ${id}`,
  position: { x, y, width: 96, height: 64 }, entry_point: { x: x + 48, y: y + 64 },
});
const locations = [
  ...Array.from({ length: 8 }, (_, i) => home(i + 1, 64 + (i % 4) * 160, 64 + Math.floor(i / 4) * 200)),
  { id: 50, type: 'town_square', name: 'Square', position: { x: 256, y: 420, width: 256, height: 160 }, entry_point: { x: 384, y: 420 } },
];
const terrain: any[] = [];
for (let i = 0; i < 300; i++) {
  terrain.push({ x: 1 + (i * 7) % 38, y: 1 + (i * 13) % 28, kind: ['grass_tuft', 'flowers', 'dirt_patch', 'tree', 'bush'][i % 5] });
}

const baseWorld = (over: any = {}) => ({
  day_phase: 'morning', weather: 'sunny', time: { season: 'spring', hour: 10 },
  map_width: 40, map_height: 30, terrain_tiles: terrain, road_tiles: [], ...over,
});

function setup(world = baseWorld(), agents: any[] = [], agentPos: Record<number, { x: number; y: number }> = {}) {
  const ground = new (PIXI.Container as any)();
  const over = new (PIXI.Container as any)();
  const services: any = {
    sprites: { getSprite: (id: string) => (agentPos[+id] ? { container: agentPos[+id] } : undefined) },
    bubbles: {},
  };
  const sys = createAmbientLifeSystem({ ground, overAgents: over }, services);
  const data: DataContext = {
    agents, world, events: [], locations, conversations: [], relationships: [], activity: [],
  };
  const frame = (scale = 1): FrameContext => ({
    dt: 1, seconds: 1 / 60, now: 0, data,
    view: { x: 0, y: 0, w: 1280, h: 960, scale },
  });
  return { sys, ground, over, data, frame, services };
}

const settle = () => new Promise(r => setTimeout(r, 0));
const visible = (c: any) => c.children.filter((s: any) => s.visible);
const run = (sys: any, f: () => FrameContext, seconds: number) => {
  const fr = f();
  for (let i = 0; i < seconds * 60; i++) sys.update(fr);
};

describe('AmbientLifeSystem', () => {
  beforeEach(() => vi.useRealTimers());

  it('builds a fixed pool of sprites, within the hard cap', () => {
    const { ground, over } = setup();
    const total = ground.children.length + over.children.length;
    expect(total).toBe(Object.values(POOL_CAPS).reduce((a, b) => a + b, 0) + 1);   // + fountain
    expect(total - 1).toBeLessThanOrEqual(MAX_CRITTERS);
    expect(visible(ground).length + visible(over).length).toBe(0);
  });

  it('does nothing until the atlas has loaded, and never throws', () => {
    const { sys, frame, data } = setup();
    sys.onData!(data);
    expect(() => sys.update(frame())).not.toThrow();
  });

  it('fills the town with daytime life around the view, then respects the plan', async () => {
    const { sys, ground, over, data, frame } = setup();
    await settle();
    sys.onData!(data);
    run(sys, frame, 20);
    const shown = visible(ground).length + visible(over).length;
    expect(shown).toBeGreaterThan(3);
    expect(shown).toBeLessThanOrEqual(POOL_CAPS.birds + POOL_CAPS.butterflies + POOL_CAPS.cats + 1);
    for (const s of [...visible(ground), ...visible(over)]) {
      expect(Number.isFinite(s.position.x) && Number.isFinite(s.position.y)).toBe(true);
    }
  });

  it('plays the fountain splash at the well even when zoomed far out — and nothing else', async () => {
    const { sys, ground, over, data, frame } = setup();
    await settle();
    sys.onData!(data);
    run(sys, () => frame(0.4), 5);
    expect(visible(over).length).toBe(0);
    const shown = visible(ground);
    expect(shown.length).toBe(1);
    // Well centre: square (256,420,256x160) -> (256+128, 420+64) + 16
    expect(shown[0].position.x).toBe(400);
    expect(shown[0].position.y).toBe(500);
  });

  it('keeps critters out of buildings', async () => {
    const { sys, ground, over, data, frame } = setup();
    await settle();
    sys.onData!(data);
    const fr = frame();
    for (let i = 0; i < 60 * 40; i++) {
      sys.update(fr);
      if (i % 6 !== 0) continue;
      for (const s of [...ground.children, ...over.children]) {
        if (!s.visible || s.position.x === 0) continue;
        // Butterflies and moths fly; only the walkers are held out of buildings.
        if (over.children.includes(s) && s.parent === over) continue;
        for (const l of locations) {
          if (l.type !== 'home') continue;
          const p = l.position;
          const inside = s.position.x > p.x + 2 && s.position.x < p.x + p.width - 2 && s.position.y > p.y + 2 && s.position.y < p.y + p.height - 2;
          expect(inside, `critter inside ${l.name}`).toBe(false);
        }
      }
    }
  });

  it('sends birds flying (up into the flyer layer) when a resident walks up', async () => {
    const pos: Record<number, { x: number; y: number }> = { 1: { x: -500, y: -500 } };
    const { sys, ground, over, data, frame } = setup(baseWorld(), [{ id: 1, current_location: null }], pos);
    await settle();
    sys.onData!(data);
    run(sys, frame, 12);
    const birds = ground.children.filter((s: any) => s.visible && s.texture && [0, 1, 2].includes(s.texture.frame));
    expect(birds.length).toBeGreaterThan(0);
    const b = birds[0];
    // The resident steps next to the first bird.
    pos[1].x = b.position.x - 10; pos[1].y = b.position.y;
    const before = over.children.filter((s: any) => s.visible).length;
    run(sys, frame, 0.3);
    expect(b.parent).toBe(over);
    expect(over.children.filter((s: any) => s.visible).length).toBeGreaterThan(before - 1);
    // ...and a moment later it is gone.
    run(sys, frame, 4);
    expect(b.visible === false || b.parent === ground).toBe(true);
  });

  it('brings moths to lit windows at night and sends the birds off', async () => {
    const agents = [{ id: 1, current_location: 1 }, { id: 2, current_location: 2 }, { id: 3, current_location: 3 }];
    const world = baseWorld({ day_phase: 'morning' });
    const { sys, ground, over, data, frame } = setup(world, agents);
    await settle();
    sys.onData!(data);
    run(sys, frame, 15);
    expect(visible(ground).some((s: any) => [0, 1, 2].includes(s.texture.frame))).toBe(true);

    data.world = baseWorld({ day_phase: 'night', time: { season: 'summer', hour: 23 } });
    sys.onData!(data);
    run(sys, frame, 12);
    const moths = visible(over).filter((s: any) => [7, 8].includes(s.texture.frame));
    expect(moths.length).toBeGreaterThan(0);
    expect(moths.length).toBeLessThanOrEqual(6);
    // No sparrow is left pecking at night.
    expect(visible(ground).filter((s: any) => [0, 1, 2].includes(s.texture.frame)).length).toBe(0);
    // Every moth hovers by one of the lit homes' windows.
    for (const m of moths) {
      const near = locations.slice(0, 3).some(l => Math.abs(m.position.x - (l.position.x + l.position.width * 0.5)) < 50
        && Math.abs(m.position.y - (l.position.y + l.position.height)) < 25);
      expect(near).toBe(true);
    }
  });

  it('clears the birds when it starts to rain', async () => {
    const { sys, ground, over, data, frame } = setup();
    await settle();
    sys.onData!(data);
    run(sys, frame, 10);
    data.world = baseWorld({ weather: 'rainy' });
    sys.onData!(data);
    run(sys, frame, 10);
    const all = [...visible(ground), ...visible(over)].filter((s: any) => s.texture && s.texture.frame <= 8);
    expect(all.length).toBe(0);
  });

  it('recycles critters when the camera moves away', async () => {
    const { sys, ground, over, data, frame } = setup();
    await settle();
    sys.onData!(data);
    run(sys, frame, 15);
    const far = (): FrameContext => ({ ...frame(), view: { x: 5000, y: 5000, w: 1280, h: 960, scale: 1 } });
    run(sys, far, 2);
    // Anything still shown is inside (or just beside) the new, empty stretch of map.
    expect(visible(ground).filter((s: any) => s.position.x < 4000).length).toBe(0);
    expect(visible(over).filter((s: any) => s.position.x < 4000).length).toBe(0);
  });

  it('frees its sprites on destroy', async () => {
    const { sys, ground, over } = setup();
    await settle();
    sys.destroy();
    expect(ground.children.length + over.children.length).toBe(0);
  });
});
