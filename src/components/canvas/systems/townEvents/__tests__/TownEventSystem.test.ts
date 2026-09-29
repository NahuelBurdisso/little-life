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

  it('cleans up its display objects on destroy', async () => {
    const { layers, sys } = setup();
    await flush();
    sys.onData(data([ev(1, 'festival'), ev(2, 'fire_outbreak')]));
    sys.destroy();
    expect(DECOR_FRAME_COUNT).toBe(39);
    for (const g of [...layers.ground.children, ...layers.overAgents.children]) {
      expect((g as PIXI.Container).destroyed).toBe(true);
    }
  });
});
