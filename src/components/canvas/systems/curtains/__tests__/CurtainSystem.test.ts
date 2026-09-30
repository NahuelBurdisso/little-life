import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js';
import { createCurtainSystem } from '../CurtainSystem';
import { WINDOW_GLASS } from '../../../BuildingRenderer';
import type { DataContext, FrameContext } from '../../types';

const DT = 0.1;
const bigView = { x: 0, y: 0, w: 4000, h: 4000, scale: 1 };
const home = (id: number) => ({
  id, type: 'home', position: { x: 100 * id, y: 100, width: 96, height: 64 }, entry_point: { x: 100 * id + 48, y: 164 },
});

function setup() {
  const ground = new PIXI.Container();
  const sys = createCurtainSystem({ ground, overAgents: new PIXI.Container() }, {} as any);
  const step = (seconds: number, view = bigView) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      sys.update({ dt: DT * 60, seconds: DT, now: 0, view, data: null as any } as FrameContext);
    }
  };
  const data = (agents: any[], locations: any[]) =>
    ({ agents, world: null, events: [], locations, conversations: [], relationships: [], activity: [] }) as DataContext;
  const shown = () => ground.children.filter(c => c.visible) as PIXI.Sprite[];
  return { sys, ground, step, data, shown };
}

const tryst = (id: number, at: number | null, zone = 'tryst') => ({
  id, name: `a${id}`, position: { x: 0, y: 0 }, current_location: at,
  current_action: { type: 'idle', zoneActivity: zone, partnerId: 99 },
});

describe('CurtainSystem', () => {
  it('draws nothing until a home hosts a tryst', () => {
    const t = setup();
    t.sys.onData!(t.data([{ id: 1, name: 'a', position: { x: 0, y: 0 }, current_location: 1, current_action: { type: 'idle' } }], [home(1)]));
    t.step(2);
    expect(t.ground.children).toHaveLength(0);
  });

  it('closes two panels over the south windows from the sides in about a second', () => {
    const t = setup();
    const h = home(1);
    t.sys.onData!(t.data([tryst(1, 1), tryst(2, 1)], [h]));
    t.step(0.5);
    const half = t.shown();
    expect(half.length).toBeGreaterThan(0);
    const halfWidth = Math.max(...half.filter(s => s.height === WINDOW_GLASS.h).map(s => s.width));
    expect(halfWidth).toBeLessThan(4);

    t.step(1);
    const drawn = t.shown().filter(s => s.height === WINDOW_GLASS.h);
    // Two panels and two folds per window; a 96 px wide home has two windows.
    expect(drawn.length).toBe(8);
    const panels = drawn.filter(s => s.width === 4);
    expect(panels).toHaveLength(4);
    // Every panel sits on the pane, at its south-edge height.
    for (const s of panels) expect(s.y).toBe(h.position.y + h.position.height - WINDOW_GLASS.above);
    // Left and right panels of one window meet in the middle: together they cover the whole pane.
    const xs = panels.map(s => s.x).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBe(WINDOW_GLASS.w - 4);
  });

  it('opens again when the evening ends, and gives its sprites back', () => {
    const t = setup();
    t.sys.onData!(t.data([tryst(1, 1)], [home(1)]));
    t.step(1.5);
    expect(t.shown().length).toBeGreaterThan(0);
    t.sys.onData!(t.data([tryst(1, 1, 'sneak_home')], [home(1)]));
    t.step(1.5);
    expect(t.shown()).toHaveLength(0);
    // A second evening reuses the pooled sprites instead of growing the layer.
    const before = t.ground.children.length;
    t.sys.onData!(t.data([tryst(1, 1)], [home(1)]));
    t.step(1.5);
    expect(t.ground.children.length).toBe(before);
    expect(t.shown().length).toBeGreaterThan(0);
  });

  it('ignores a tryst that is not in a home, or an agent on the road', () => {
    const t = setup();
    const barn = { ...home(2), type: 'farm' };
    t.sys.onData!(t.data([tryst(1, 2), tryst(2, null)], [barn]));
    t.step(2);
    expect(t.ground.children).toHaveLength(0);
  });

  it('keeps a house off screen hidden but still runs its clock', () => {
    const t = setup();
    const far = { x: 5000, y: 5000, w: 100, h: 100, scale: 1 };
    t.sys.onData!(t.data([tryst(1, 1)], [home(1)]));
    t.step(2, far);
    expect(t.shown()).toHaveLength(0);
    t.step(0.1);
    expect(t.shown().length).toBeGreaterThan(0);
  });

  it('drops its curtains at once when the world is replaced and the same ids name other houses', () => {
    const t = setup();
    t.sys.onData!(t.data([tryst(1, 1)], [home(1)]));
    t.step(1.5);
    expect(t.shown().length).toBeGreaterThan(0);

    // A new world: location 1 is a different house elsewhere, and nobody is in a private evening.
    const moved = { ...home(1), position: { x: 700, y: 500, width: 96, height: 64 } };
    t.sys.onData!(t.data([{ id: 9, name: 'n', position: { x: 0, y: 0 }, current_location: 1, current_action: { type: 'idle' } }], [moved]));
    t.step(DT);
    expect(t.shown()).toHaveLength(0);

    // ... and a world whose locations are gone altogether.
    t.sys.onData!(t.data([tryst(1, 1)], [home(1)]));
    t.step(1.5);
    expect(t.shown().length).toBeGreaterThan(0);
    t.sys.onData!(t.data([], []));
    t.step(DT);
    expect(t.shown()).toHaveLength(0);
  });

  it('is cleaned up by destroy', () => {
    const t = setup();
    t.sys.onData!(t.data([tryst(1, 1)], [home(1)]));
    t.step(1);
    t.sys.destroy();
    expect(t.ground.children).toHaveLength(0);
  });
});
