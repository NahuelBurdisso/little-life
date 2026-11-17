import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { FX_CELL_COUNT } from '../activityFrames';
import { NO_DATA, fakeServices } from '../../__tests__/kit';

// The particle atlas is a network load; the roofline behaviour does not depend on its pixels.
vi.mock('../../../stripAtlas', () => ({
  loadStrip: () => Promise.resolve(Array.from({ length: FX_CELL_COUNT }, () => PIXI.Texture.EMPTY)),
}));

import { createActivityFxSystem } from '../ActivityFxSystem';
import type { DataContext } from '../../types';

const view = { x: 0, y: 0, w: 4000, h: 4000, scale: 1 };

function fakeSprite(x: number, y: number, over: { lyingBlend?: number; isWalking?: boolean } = {}) {
  return {
    x, y, facingDir: 1 as 1 | -1, lyingBlend: over.lyingBlend ?? 0, isWalking: over.isWalking ?? false,
    workStroke: 0, rig: { x: 0, y: 0 }, container: new PIXI.Container(),
    setActivityPose: vi.fn(), setFacing: vi.fn(),
  };
}

async function setup(sprite: ReturnType<typeof fakeSprite>) {
  const ground = new PIXI.Container();
  const over = new PIXI.Container();
  const showEmote = vi.fn();
  const sys = createActivityFxSystem(
    { ground, overAgents: over },
    fakeServices({ getSprite: () => sprite }, { showEmote }),
  );
  await Promise.resolve();
  await Promise.resolve();
  const hearts = () => over.children.filter(c => c.visible);
  const seen: Array<{ x: number; y: number }> = [];
  let now = 100_000;
  /** Frames for `seconds`; returns the most particles showing at once (they live only a couple of seconds). */
  const run = (seconds: number) => {
    let most = 0;
    for (let t = 0; t < seconds; t += 0.25) {
      now += 250;
      sys.update({ dt: 15, seconds: 0.25, now, view, data: NO_DATA });
      most = Math.max(most, hearts().length);
      for (const h of hearts()) seen.push({ x: h.x, y: h.y });
    }
    return most;
  };
  const data = (zone: string, at: number | null, loc: object) => ({
    agents: [{ id: 1, name: 'a', position: { x: 150, y: 180 }, current_location: at, current_action: { type: 'idle', zoneActivity: zone } }],
    world: null, events: [], locations: [loc], conversations: [], relationships: [], activity: [],
  }) as unknown as DataContext;
  return { sys, run, data, hearts, over, seen };
}

const house = { id: 7, type: 'home', position: { x: 100, y: 100, width: 96, height: 64 }, entry_point: { x: 148, y: 164 } };

describe('ActivityFxSystem — the private evening over a house', () => {
  it('sends hearts up off the roofline even though the body is lying in bed', async () => {
    const s = await setup(fakeSprite(150, 150, { lyingBlend: 1 }));
    s.sys.onData!(s.data('tryst', 7, house));
    const most = s.run(30);
    expect(most).toBeGreaterThan(0);
    // Above the house's top edge, over the middle of its width, and never on the sprite itself.
    expect(s.seen.length).toBeGreaterThan(0);
    for (const h of s.seen) {
      expect(h.x).toBeGreaterThan(house.position.x + 20);
      expect(h.x).toBeLessThan(house.position.x + house.position.width - 20);
      expect(h.y).toBeLessThan(house.position.y);
    }
    // A hint, not a shower.
    expect(most).toBeLessThanOrEqual(3);
    s.sys.destroy();
  });

  it('draws nothing for an evening out of doors (no roof to anchor to)', async () => {
    const s = await setup(fakeSprite(150, 150, { lyingBlend: 1 }));
    s.sys.onData!(s.data('tryst', 7, { ...house, type: 'farm' }));
    expect(s.run(30)).toBe(0);
    s.sys.destroy();
  });

  it('still draws no body effects on a lying agent doing anything else', async () => {
    const s = await setup(fakeSprite(150, 150, { lyingBlend: 1 }));
    s.sys.onData!(s.data('cook', 7, house));
    expect(s.run(30)).toBe(0);
    s.sys.destroy();
  });

  it('gives the dawn walk home no particles at all', async () => {
    const s = await setup(fakeSprite(150, 150));
    s.sys.onData!(s.data('sneak_home', null, house));
    expect(s.run(30)).toBe(0);
    s.sys.destroy();
  });
});
