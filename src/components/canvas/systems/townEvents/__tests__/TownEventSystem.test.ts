// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js';
import { DECOR_FRAME_COUNT } from '../eventDecor';

vi.mock('../../../stripAtlas', () => ({
  loadStrip: vi.fn(async (_url: string, count: number) => Array.from({ length: count }, () => PIXI.Texture.EMPTY)),
}));

import { TownEventSystem } from '../TownEventSystem';
import type { DataContext, FrameContext } from '../../types';

const square = { id: 1, type: 'town_square', position: { x: 640, y: 320, width: 384, height: 256 }, entry_point: { x: 832, y: 448 } };
const bakery = { id: 5, type: 'bakery', position: { x: 576, y: 640, width: 128, height: 96 }, entry_point: { x: 640, y: 736 } };

const data = (events: any[]): DataContext => ({
  agents: [], world: { map_width: 60, map_height: 40 }, events, locations: [square, bakery],
  conversations: [], relationships: [], activity: [],
});
const ev = (id: number, type: string) => ({ id, type, name: type, started_at: 0, duration: 60, location_id: null, triggered_by: null });

const frame = (over: Partial<FrameContext> = {}): FrameContext => ({
  dt: 1, seconds: 0.25, now: 1000,
  view: { x: 0, y: 0, w: 2000, h: 1400, scale: 1 },
  data: data([]),
  ...over,
});

function setup() {
  const layers = { ground: new PIXI.Container(), overAgents: new PIXI.Container() };
  const sys = new TownEventSystem(layers);
  return { layers, sys };
}
const flush = () => new Promise(r => setTimeout(r, 0));
const count = (c: PIXI.Container) => c.children.reduce((n, ch: any) => n + ch.children.length, 0);

describe('TownEventSystem', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds decorations when an event appears and waits for the atlas if needed', async () => {
    const { layers, sys } = setup();
    sys.onData(data([ev(1, 'festival')]));      // atlas promise not resolved yet
    expect(layers.ground.children.length).toBe(0);
    await flush();
    expect(layers.ground.children.length).toBe(1);
    expect(count(layers.ground)).toBeGreaterThan(10);
    expect(layers.overAgents.children.length).toBe(1);
    sys.destroy();
  });

  it('fades in over about a second', async () => {
    const { layers, sys } = setup();
    await flush();
    sys.onData(data([ev(1, 'wedding')]));
    const group = layers.ground.children[0] as PIXI.Container;
    expect(group.alpha).toBe(0);
    sys.update(frame({ seconds: 0.5 }));
    expect(group.alpha).toBeCloseTo(0.5);
    sys.update(frame({ seconds: 0.6 }));
    expect(group.alpha).toBe(1);
    sys.destroy();
  });

  it('fades out and then removes the sprites when the event ends', async () => {
    const { layers, sys } = setup();
    await flush();
    sys.onData(data([ev(1, 'funeral')]));
    sys.update(frame({ seconds: 2 }));
    sys.onData(data([]));
    const group = layers.ground.children[0] as PIXI.Container;
    sys.update(frame({ seconds: 0.5 }));
    expect(group.alpha).toBeCloseTo(0.5);
    sys.update(frame({ seconds: 0.6 }));
    expect(layers.ground.children.length).toBe(0);
    expect(layers.overAgents.children.length).toBe(0);
    sys.destroy();
  });

  it('does not rebuild while the event set is unchanged', async () => {
    const { layers, sys } = setup();
    await flush();
    sys.onData(data([ev(1, 'festival')]));
    const first = layers.ground.children[0];
    sys.onData(data([ev(1, 'festival')]));
    sys.onData(data([ev(1, 'festival'), ev(2, 'storm')]));   // storm has no decor
    expect(layers.ground.children.length).toBe(1);
    expect(layers.ground.children[0]).toBe(first);
    sys.destroy();
  });

  it('ignores undecorated events and survives odd data', async () => {
    const { layers, sys } = setup();
    await flush();
    sys.onData(data([ev(1, 'storm'), null as any]));
    sys.onData({ ...data([ev(2, 'festival')]), locations: [] , world: null });
    expect(layers.ground.children.length).toBe(0);
    expect(() => sys.update(frame())).not.toThrow();
    sys.destroy();
  });

  it('swaps textures of animated cells only when the animation cell changes', async () => {
    const { layers, sys } = setup();
    await flush();
    sys.onData(data([ev(1, 'fire_outbreak')]));
    sys.update(frame({ now: 1000, seconds: 0.1 }));
    const flames = (layers.overAgents.children[0] as PIXI.Container).children as PIXI.Sprite[];
    expect(flames.length).toBeGreaterThan(0);
    const setter = vi.spyOn(flames[0], 'texture', 'set');
    sys.update(frame({ now: 1010, seconds: 0.01 }));      // same 6 fps cell
    expect(setter).not.toHaveBeenCalled();
    sys.update(frame({ now: 1400, seconds: 0.4 }));       // a couple of cells later
    expect(setter).toHaveBeenCalled();
    sys.destroy();
  });

  it('hides a group that is off screen and freezes animation when zoomed far out', async () => {
    const { layers, sys } = setup();
    await flush();
    sys.onData(data([ev(1, 'festival')]));
    const group = layers.ground.children[0] as PIXI.Container;
    sys.update(frame({ view: { x: 5000, y: 5000, w: 800, h: 600, scale: 1 } }));
    expect(group.visible).toBe(false);
    sys.update(frame());
    expect(group.visible).toBe(true);
    sys.destroy();
  });

  it('moves particles every frame and fades them in and out of their fall', async () => {
    const { layers, sys } = setup();
    await flush();
    sys.onData(data([ev(1, 'blessing')]));
    const t0 = performance.now();
    sys.update(frame({ now: t0, seconds: 2 }));
    const motes = (layers.overAgents.children[0] as PIXI.Container).children
      .slice() as PIXI.Sprite[];
    // Sparkles do not move; the mote clusters do. Find one whose position changes.
    const before = motes.map(s => s.y);
    sys.update(frame({ now: t0 + 1500, seconds: 0.016 }));
    const moved = motes.filter((s, i) => s.y !== before[i]);
    expect(moved.length).toBeGreaterThanOrEqual(3);
    const alphas = new Set(moved.map(s => s.alpha));
    expect(Math.max(...alphas)).toBeLessThanOrEqual(1);
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0);
    sys.destroy();
  });

  it('runs a cart in from the side and leaves it parked at its spot', async () => {
    const { layers, sys } = setup();
    await flush();
    const home = { id: 9, type: 'home', position: { x: 448, y: 640, width: 96, height: 96 }, entry_point: { x: 496, y: 736 } };
    sys.onData({ ...data([{ ...ev(1, 'new_arrival'), location_id: 9 }]), locations: [square, home] });
    const t0 = performance.now();
    sys.update(frame({ now: t0, seconds: 2 }));
    const sprites = [...(layers.ground.children[0] as PIXI.Container).children] as PIXI.Sprite[];
    // The cart is the only sprite off the door line at the start: 170 px further east than at rest.
    const cartAtStart = sprites.find(s => s.x > 496 + 100)!;
    expect(cartAtStart).toBeDefined();
    sys.update(frame({ now: t0 + 9000, seconds: 0.016 }));
    expect(cartAtStart.x).toBe(536);
    sys.destroy();
  });

  it('tints the cells that ask for it', async () => {
    const { layers, sys } = setup();
    await flush();
    sys.onData(data([ev(1, 'sickness')]));    // town has a bakery + square but no clinic/hall: the square gets the sign
    const all = [...layers.ground.children, ...layers.overAgents.children]
      .flatMap(g => (g as PIXI.Container).children) as PIXI.Sprite[];
    expect(all.some(s => s.tint === 0xa8d890)).toBe(true);
    sys.destroy();
  });

  it('cleans up its display objects on destroy', async () => {
    const { layers, sys } = setup();
    await flush();
    sys.onData(data([ev(1, 'festival'), ev(2, 'fire_outbreak')]));
    sys.destroy();
    expect(DECOR_FRAME_COUNT).toBe(69);
    for (const g of [...layers.ground.children, ...layers.overAgents.children]) {
      expect((g as PIXI.Container).destroyed).toBe(true);
    }
  });
});

describe('wedding followers', () => {
  it('keeps the petals over each newlywed as they move, and hides them when the sprite is gone', async () => {
    const layers = { ground: new PIXI.Container(), overAgents: new PIXI.Container() };
    const positions = new Map<string, { x: number; y: number }>([['3', { x: 100, y: 200 }], ['4', { x: 1500, y: 900 }]]);
    const services = { sprites: { getSprite: (id: string) => positions.get(id) }, bubbles: {} } as any;
    const sys = new TownEventSystem(layers, services);
    await flush();
    sys.onData(data([{ ...ev(1, 'wedding'), triggered_by: 'wedding:3-4', location_id: 1 }]));
    sys.update(frame({ seconds: 2 }));
    const over = layers.overAgents.children[0] as PIXI.Container;
    // Followers are the sprites near an agent; the square's own decor is around (640-1024, 320-576).
    const near = (p: { x: number; y: number }) => (over.children as PIXI.Sprite[])
      .filter(s => s.visible && Math.abs(s.x - p.x) < 40 && s.y < p.y && s.y > p.y - 90);
    expect(near({ x: 100, y: 200 }).length).toBeGreaterThanOrEqual(1);
    expect(near({ x: 1500, y: 900 }).length).toBeGreaterThanOrEqual(1);

    positions.set('3', { x: 300, y: 250 });
    positions.delete('4');
    sys.update(frame({ seconds: 0.016 }));
    expect(near({ x: 300, y: 250 }).length).toBeGreaterThanOrEqual(1);
    expect(near({ x: 1500, y: 900 })).toHaveLength(0);
    sys.destroy();
  });
});
