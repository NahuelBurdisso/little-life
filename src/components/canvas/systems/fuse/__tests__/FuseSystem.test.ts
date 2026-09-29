import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js';
import { createFuseSystem } from '../FuseSystem';
import { fuseTargets, FUSE_HEAT } from '../fuseTargets';
import type { DataContext, FrameContext } from '../../types';

const view = { x: 0, y: 0, w: 2000, h: 2000, scale: 1 };
const frame = (seconds: number) => ({ dt: seconds * 60, seconds, now: 0, view, data: null as any }) as FrameContext;

const snap = (id: number, heat: number) => ({ kind: 'snap', agentIds: [id], heat });

describe('fuseTargets', () => {
  it('picks only snap rows at 85% of the threshold or more', () => {
    const out = fuseTargets([
      snap(1, FUSE_HEAT - 0.01),
      snap(2, FUSE_HEAT),
      snap(3, 1),
      { kind: 'secret', agentIds: [4], heat: 0.99 },
      { kind: 'confrontation', agentIds: [5, 6], heat: 0.9 },
    ], new Set());
    expect([...out].sort()).toEqual([2, 3]);
  });

  it('clears the reused set and tolerates missing data', () => {
    const out = new Set([9]);
    expect(fuseTargets(undefined, out).size).toBe(0);
    expect(fuseTargets([snap(1, 0.9)], out).has(9)).toBe(false);
  });
});

describe('FuseSystem', () => {
  function setup() {
    const overAgents = new PIXI.Container();
    const positions = new Map<string, { x: number; y: number }>([['1', { x: 100, y: 200 }], ['2', { x: 300, y: 200 }]]);
    const sys = createFuseSystem(
      { ground: new PIXI.Container(), overAgents },
      { sprites: { getSprite: (id: string) => positions.get(id) } as any, bubbles: {} as any },
    );
    const data = (brewing: any[]) =>
      ({ agents: [], world: null, events: [], locations: [], conversations: [], relationships: [], activity: [], brewing }) as DataContext;
    return { sys, overAgents, positions, data };
  }

  it('lights a fuse above a resident about to snap and puts it out when they cool down', () => {
    const { sys, overAgents, data } = setup();
    sys.onData!(data([snap(1, 0.9)]));
    sys.update(frame(0.016));
    expect(overAgents.children).toHaveLength(1);
    const fuse = overAgents.children[0] as PIXI.Container;
    expect(fuse.visible).toBe(true);
    expect(fuse.x).toBeGreaterThan(100);
    expect(fuse.y).toBeLessThan(200);

    sys.onData!(data([snap(1, 0.5)]));
    expect(fuse.visible).toBe(false);
  });

  it('reuses a released slot instead of growing the pool', () => {
    const { sys, overAgents, data } = setup();
    sys.onData!(data([snap(1, 0.9)]));
    sys.onData!(data([]));
    sys.onData!(data([snap(2, 0.95)]));
    expect(overAgents.children).toHaveLength(1);
  });

  it('hides the fuse when the resident is off screen or gone', () => {
    const { sys, overAgents, positions, data } = setup();
    sys.onData!(data([snap(1, 0.9)]));
    positions.delete('1');
    sys.update(frame(0.016));
    expect((overAgents.children[0] as PIXI.Container).visible).toBe(false);
  });

  it('destroys its display objects', () => {
    const { sys, overAgents, data } = setup();
    sys.onData!(data([snap(1, 0.9), snap(2, 0.9)]));
    sys.destroy();
    expect(overAgents.children).toHaveLength(0);
  });
});
