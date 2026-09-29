import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js';
import { BEATS_FRAME_COUNT } from '../beatFrames';

// The atlas loader needs a browser; hand the system blank textures instead.
vi.mock('../../../stripAtlas', () => ({
  loadStrip: () => Promise.resolve(Array.from({ length: 48 }, () => PIXI.Texture.EMPTY)),
}));

import { createBeatSystem } from '../BeatSystem';
import { emitCanvasEvent } from '../../../../../lib/canvasBus';
import type { DataContext, FrameContext } from '../../types';

const view = { x: 0, y: 0, w: 1000, h: 1000, scale: 1 };
function frame(seconds: number, v = view): FrameContext {
  return { dt: seconds * 60, seconds, now: 0, view: v, data: {} as DataContext };
}

function setup() {
  const overAgents = new PIXI.Container();
  const ground = new PIXI.Container();
  const positions = new Map<string, { x: number; y: number }>();
  for (let i = 1; i <= 12; i++) positions.set(String(i), { x: i * 20, y: 100 });
  const removed: Array<{ id: string; name: string; x: number; y: number }> = [];
  const showEmote = vi.fn();
  const sys = createBeatSystem(
    { ground, overAgents },
    {
      sprites: { getSprite: (id: string) => positions.get(id), recentlyRemoved: removed } as any,
      bubbles: { showEmote } as any,
    },
  );
  const data = (activity: any[], agents: any[] = [...positions.keys()].map(id => ({ id: Number(id), position: positions.get(id) }))) =>
    ({ agents, world: null, events: [], locations: [], conversations: [], relationships: [], activity }) as DataContext;
  return { sys, overAgents, showEmote, data, removed };
}

const row = (id: number, description: string, a = 1, b = 2) => ({
  id, type: 'drama', initiator_id: a, target_id: b, agent_ids: [a, b],
  real_timestamp: Date.now(), template_data: { description },
});
const flush = () => new Promise(r => setTimeout(r, 0));

describe('BeatSystem', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('plays a fight between two agents: emotes on both, one effect, gone after its life', async () => {
    const { sys, overAgents, showEmote, data } = setup();
    await flush();
    sys.onData!(data([row(1, 'boot')]));            // history: nothing
    expect(showEmote).not.toHaveBeenCalled();
    sys.onData!(data([row(2, 'Ana started a fight with Bo'), row(1, 'boot')]));
    expect(showEmote).toHaveBeenCalledTimes(2);
    expect(showEmote.mock.calls.map(c => c[1])).toEqual(['anger', 'anger']);
    expect(overAgents.children).toHaveLength(1);
    const fx = overAgents.children[0] as PIXI.Sprite;
    sys.update(frame(0.1));
    // Midpoint of agents 1 and 2 (x 20 and 40), raised above their feet.
    expect(fx.visible).toBe(true);
    expect(fx.x).toBeCloseTo(30);
    expect(fx.y).toBeLessThan(100);
    for (let i = 0; i < 20; i++) sys.update(frame(0.1));
    expect(fx.visible).toBe(false);
  });

  it('hides an effect that is off screen but keeps its clock running', async () => {
    const { sys, overAgents, data } = setup();
    await flush();
    sys.onData!(data([row(1, 'boot')]));
    sys.onData!(data([row(2, 'Ana started a fight with Bo'), row(1, 'boot')]));
    const fx = overAgents.children[0] as PIXI.Sprite;
    sys.update(frame(0.1, { ...view, x: 5000 }));
    expect(fx.visible).toBe(false);
    sys.update(frame(0.1));
    expect(fx.visible).toBe(true);
  });

  it('caps live effects at 8, reusing the sprite pool', async () => {
    const { sys, overAgents, data } = setup();
    await flush();
    let id = 1;
    sys.onData!(data([row(id++, 'boot')]));
    const rows: any[] = [row(0, 'boot')];
    for (let pair = 0; pair < 12; pair += 1) {
      // Twelve distinct pairs (1-2, 2-3...) so the per-pair dedupe doesn't hide them.
      rows.unshift(row(id++, `x${pair} started a fight with y`, pair + 1, ((pair + 1) % 12) + 1));
    }
    sys.onData!(data(rows));
    expect(overAgents.children.length).toBeLessThanOrEqual(8);
    sys.update(frame(0.05));
    expect(overAgents.children.filter(c => c.visible).length).toBeLessThanOrEqual(8);
  });

  it('a gift flies from giver to receiver before it pops', async () => {
    const { sys, overAgents, data } = setup();
    await flush();
    sys.onData!(data([row(1, 'boot')]));
    sys.onData!(data([{ id: 2, type: 'gift', initiator_id: 1, target_id: 10, agent_ids: [1, 10], real_timestamp: Date.now(), template_data: { description: 'x gave a rose to y as a gift' } }, row(1, 'boot')]));
    const fx = overAgents.children[0] as PIXI.Sprite;
    sys.update(frame(0.01));
    const startX = fx.x;
    sys.update(frame(0.4));
    expect(fx.x).toBeGreaterThan(startX);
    sys.update(frame(0.45));                         // travel over: sitting on the receiver
    expect(fx.x).toBeCloseTo(200);
  });

  it('a player intervention pings the agent and shows an exclaim', async () => {
    const { sys, overAgents, showEmote } = setup();
    await flush();
    emitCanvasEvent({ type: 'intervention', kind: 'nudge', agentIds: [3] });
    expect(showEmote).toHaveBeenCalledWith('3', 'exclaim', { x: 60, y: 100 });
    expect(overAgents.children).toHaveLength(1);
    sys.destroy();
    expect(overAgents.children).toHaveLength(0);
    showEmote.mockClear();
    emitCanvasEvent({ type: 'intervention', kind: 'nudge', agentIds: [3] });
    expect(showEmote).not.toHaveBeenCalled();        // unsubscribed
  });

  it('a death needs the row and the sprite removal, then a ghost rises from the last spot', async () => {
    const { sys, overAgents, data, removed } = setup();
    await flush();
    sys.onData!(data([row(1, 'boot')]));
    sys.onData!(data([row(2, 'Ana has died. Died of natural causes. The town mourns.', 4, null as any), row(1, 'boot')]));
    expect(overAgents.children).toHaveLength(0);
    removed.push({ id: '4', name: 'Ana', x: 80, y: 100 });
    sys.onData!(data([row(2, 'x'), row(1, 'boot')], []));
    expect(overAgents.children).toHaveLength(1);
    const ghost = overAgents.children[0] as PIXI.Sprite;
    sys.update(frame(0.05));
    const y0 = ghost.y;
    for (let i = 0; i < 10; i++) sys.update(frame(0.1));
    expect(ghost.y).toBeLessThan(y0);
  });

  it('atlas frame count matches the strip it slices', () => {
    expect(BEATS_FRAME_COUNT).toBe(48);
  });
});
