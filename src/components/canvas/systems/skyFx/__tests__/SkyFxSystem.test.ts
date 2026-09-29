// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js';

// Node has no canvas: hand the system plain empty textures, it only needs something to tint.
vi.mock('../skyTextures', () => ({
  createSkyTextures: () => ({ blob: PIXI.Texture.EMPTY, beam: PIXI.Texture.EMPTY, streak: PIXI.Texture.EMPTY }),
}));

import { SkyFxSystem } from '../SkyFxSystem';
import type { DataContext, FrameContext } from '../../types';

const square = { id: 1, type: 'town_square', position: { x: 640, y: 320, width: 384, height: 256 }, entry_point: { x: 832, y: 448 } };
const ev = (id: number, type: string) => ({ id, type });

const data = (events: any[], world: any = {}): DataContext => ({
  agents: [], world: { map_width: 60, map_height: 40, weather: 'sunny', day_phase: 'afternoon', ...world },
  events, locations: [square], conversations: [], relationships: [], activity: [],
});
const frame = (over: Partial<FrameContext> = {}): FrameContext => ({
  dt: 1, seconds: 0.5, now: 1000,
  view: { x: 0, y: 0, w: 2000, h: 1400, scale: 1 },
  data: data([]),
  ...over,
});

function setup() {
  const layers = { ground: new PIXI.Container(), overAgents: new PIXI.Container() };
  const sys = new SkyFxSystem(layers);
  const root = layers.overAgents.children[0] as PIXI.Container;
  return { layers, sys, root };
}
/** Run `seconds` of game time in 0.25 s frames. */
function run(sys: SkyFxSystem, seconds: number, over: Partial<FrameContext> = {}) {
  let now = over.now ?? 1000;
  for (let t = 0; t < seconds; t += 0.25) { now += 250; sys.update(frame({ ...over, seconds: 0.25, now })); }
}
const sprites = (root: PIXI.Container) =>
  root.children.flatMap(c => (c instanceof PIXI.Sprite ? [c] : (c as PIXI.Container).children)) as PIXI.Sprite[];
const visibleCount = (root: PIXI.Container) => sprites(root).filter(s => s.visible && s.parent?.visible !== false).length;

describe('SkyFxSystem', () => {
  it('draws nothing under a plain sunny sky', () => {
    const { sys, root } = setup();
    sys.onData(data([]));
    run(sys, 10);
    expect(visibleCount(root)).toBe(0);
    sys.destroy();
  });

  it('brings cloud shadows in under a cloudy afternoon and takes them out when it clears', () => {
    const { sys, root } = setup();
    sys.onData(data([], { weather: 'cloudy' }));
    run(sys, 15);
    const lobes = root.children.flatMap(c => (c instanceof PIXI.Container && !(c instanceof PIXI.Sprite) ? c.children : [])) as PIXI.Sprite[];
    expect(lobes.length).toBe(12);
    const shown = lobes.filter(l => l.parent!.visible);
    expect(shown.length).toBeGreaterThan(0);
    for (const l of shown) {
      expect(l.alpha).toBeGreaterThan(0.03);
      expect(l.alpha).toBeLessThan(0.15);            // low alpha: a hint of shade, not a curtain
    }
    sys.onData(data([], { weather: 'sunny' }));
    run(sys, 30);
    expect(lobes.filter(l => l.parent!.visible).length).toBe(0);
    sys.destroy();
  });

  it('casts no shadows at night even when cloudy', () => {
    const { sys, root } = setup();
    sys.onData(data([], { weather: 'cloudy', day_phase: 'night' }));
    run(sys, 15);
    expect(visibleCount(root)).toBe(0);
    sys.destroy();
  });

  it('moves the shadows over time', () => {
    const { sys, root } = setup();
    sys.onData(data([], { weather: 'cloudy' }));
    run(sys, 15);
    const boxes = root.children.filter(c => !(c instanceof PIXI.Sprite)) as PIXI.Container[];
    const before = boxes.map(b => b.x);
    run(sys, 5, { now: 100000 });
    expect(boxes.some((b, i) => b.x !== before[i])).toBe(true);
    sys.destroy();
  });

  it('lights the square for a full moon and puts it out afterwards', () => {
    const { sys, root } = setup();
    sys.onData(data([ev(1, 'full_moon')]));
    run(sys, 6);
    const glowing = sprites(root).filter(s => s.visible && s.blendMode === 'add' && s.alpha > 0.2);
    expect(glowing.length).toBe(1);
    expect(glowing[0].x).toBe(square.position.x + square.position.width / 2);
    sys.onData(data([]));
    run(sys, 20);
    expect(visibleCount(root)).toBe(0);
    sys.destroy();
  });

  it('shows slanted shafts of light for a blessing', () => {
    const { sys, root } = setup();
    sys.onData(data([ev(1, 'blessing')]));
    run(sys, 6);
    const beams = sprites(root).filter(s => s.visible && s.rotation !== 0);
    expect(beams.length).toBe(3);
    for (const b of beams) {
      expect(b.rotation).toBeLessThan(0);
      expect(b.alpha).toBeGreaterThan(0.02);
      expect(b.alpha).toBeLessThan(0.3);
    }
    sys.destroy();
  });

  it('gathers mist about the stranger, at the road entering the map', () => {
    const { sys, root } = setup();
    sys.onData(data([ev(1, 'mysterious_stranger')], { road_tiles: [{ x: 0, y: 9 }] }));
    run(sys, 8);
    const mist = sprites(root).filter(s => s.visible && s.parent!.visible);
    expect(mist.length).toBe(6);
    for (const m of mist) expect(Math.abs(m.x - 16)).toBeLessThan(260);
    sys.destroy();
  });

  it('sends shooting stars across the view only on a starry night', () => {
    const { sys, root } = setup();
    sys.onData(data([ev(1, 'starry_night')], { day_phase: 'night' }));
    let sawStar = false;
    let now = 1000;
    for (let i = 0; i < 400 && !sawStar; i++) {          // up to 100 s of frames
      now += 250;
      sys.update(frame({ seconds: 0.25, now }));
      sawStar = sprites(root).some(s => s.visible && s.blendMode === 'add' && s.anchor.x === 1);
    }
    expect(sawStar).toBe(true);
    sys.destroy();

    const other = setup();
    other.sys.onData(data([], { day_phase: 'night' }));
    run(other.sys, 60);
    expect(visibleCount(other.root)).toBe(0);
    other.sys.destroy();
  });

  it('skips everything that is off screen', () => {
    const { sys, root } = setup();
    sys.onData(data([ev(1, 'full_moon'), ev(2, 'blessing')]));
    run(sys, 6, { view: { x: 9000, y: 9000, w: 800, h: 600, scale: 1 } });
    expect(visibleCount(root)).toBe(0);
    sys.destroy();
  });

  it('cleans up on destroy and survives odd data', () => {
    const { sys, root } = setup();
    expect(() => sys.onData({ ...data([null as any]), world: null, locations: undefined as any })).not.toThrow();
    expect(() => sys.update(frame())).not.toThrow();
    sys.destroy();
    expect(root.destroyed).toBe(true);
  });
});
