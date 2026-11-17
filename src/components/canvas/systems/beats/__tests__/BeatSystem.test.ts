import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js';
import { BEATS_FRAME_COUNT } from '../beatFrames';
import type { AgentLite } from '../../../SpritePool';
import { fakeServices } from '../../__tests__/kit';

// The atlas loader needs a browser; hand the system blank textures instead.
vi.mock('../../../stripAtlas', async () => {
  const { BEATS_FRAME_COUNT: n } = await import('../beatFrames');
  return { loadStrip: () => Promise.resolve(Array.from({ length: n }, () => PIXI.Texture.EMPTY)) };
});

import { createBeatSystem } from '../BeatSystem';
import { emitCanvasEvent } from '../../../../../lib/canvasBus';
import type { DataContext, FrameContext } from '../../types';

const view = { x: 0, y: 0, w: 1000, h: 1000, scale: 1 };
function frame(seconds: number, v = view): FrameContext {
  return { dt: seconds * 60, seconds, now: 0, view: v, data: {} as DataContext };
}

/** The slice of AgentSprite the kiss lean touches, with its calls recorded. */
function fakeSprite(x: number, y: number) {
  const s = {
    x, y, facing: 0, kind: 'none', tint: 0xffffff,
    setFacing: vi.fn((d: 1 | -1) => { s.facing = d; }),
    setActivityPose: vi.fn((k: string, t = 0xffffff) => { s.kind = k; s.tint = t; }),
    get activityPoseKind() { return s.kind; },
    get activityPoseTint() { return s.tint; },
  };
  return s;
}

function setup() {
  const overAgents = new PIXI.Container();
  const ground = new PIXI.Container();
  const positions = new Map<string, ReturnType<typeof fakeSprite>>();
  for (let i = 1; i <= 12; i++) positions.set(String(i), fakeSprite(i * 20, 100));
  const removed: Array<{ id: string; name: string; x: number; y: number }> = [];
  const showEmote = vi.fn();
  const sys = createBeatSystem(
    { ground, overAgents },
    fakeServices({ getSprite: (id: string) => positions.get(id), recentlyRemoved: removed }, { showEmote }),
  );
  const data = (activity: DataContext['activity'], agents: AgentLite[] = [...positions.keys()].map(id => ({ id: Number(id), position: positions.get(id) }))) =>
    ({ agents, world: null, events: [], locations: [], conversations: [], relationships: [], activity }) as DataContext;
  return { sys, overAgents, showEmote, data, removed, positions };
}

const row = (id: number, description: string, a = 1, b: number | null = 2) => ({
  id, type: 'drama', initiator_id: a, target_id: b, agent_ids: b == null ? [a] : [a, b],
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
    const rows = [row(0, 'boot')];
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

  it('leaves player interventions to systems/playerFx', async () => {
    const { sys, overAgents, showEmote } = setup();
    await flush();
    emitCanvasEvent({ type: 'intervention', kind: 'nudge', agentIds: [3] });
    expect(showEmote).not.toHaveBeenCalled();
    expect(overAgents.children).toHaveLength(0);
    sys.destroy();
  });

  it('a death needs the row and the sprite removal, then a ghost rises from the last spot', async () => {
    const { sys, overAgents, data, removed } = setup();
    await flush();
    sys.onData!(data([row(1, 'boot')]));
    sys.onData!(data([row(2, 'Ana has died. Died of natural causes. The town mourns.', 4, null), row(1, 'boot')]));
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
    expect(BEATS_FRAME_COUNT).toBe(53);
  });

  describe('the kiss beat', () => {
    const kissRow = (id: number, a = 1, b = 2) => ({
      id, type: 'kiss', initiator_id: a, target_id: b, agent_ids: [a, b],
      real_timestamp: Date.now(), template_data: { description: 'x kissed y' },
    });
    async function kiss(a = 1, b = 2) {
      const ctx = setup();
      await flush();
      ctx.sys.onData!(ctx.data([row(1, 'boot')]));
      ctx.sys.onData!(ctx.data([kissRow(2, a, b), row(1, 'boot')]));
      return ctx;
    }

    it('faces the pair toward each other, leans them, then gives the pose back', async () => {
      const { sys, positions, showEmote } = await kiss(1, 2);
      const p1 = positions.get('1')!, p2 = positions.get('2')!;
      expect(showEmote.mock.calls.map(c => c[1])).toEqual(['kiss', 'blush']);
      expect(p1.facing).toBe(1);   // agent 1 is left of agent 2
      expect(p2.facing).toBe(-1);
      expect(p1.kind).toBe('lean');
      expect(p2.kind).toBe('lean');
      sys.update(frame(0.5));
      expect(p1.kind).toBe('lean');
      sys.update(frame(0.8));      // 1.3 s in: past the 1.2 s lean
      expect(p1.kind).toBe('none');
      expect(p2.kind).toBe('none');
    });

    it('faces the other way round when the initiator stands to the right', async () => {
      const { positions } = await kiss(5, 3);
      expect(positions.get('5')!.facing).toBe(-1);
      expect(positions.get('3')!.facing).toBe(1);
    });

    it('does not stomp a pose that took over during the lean, nor touch a sprite that vanished', async () => {
      const { sys, positions } = await kiss(1, 2);
      const p1 = positions.get('1')!, p2 = positions.get('2')!;
      p1.kind = 'jog';             // someone else (ActivityFxSystem) moved agent 1 on
      const calls2 = p2.setActivityPose.mock.calls.length;
      positions.delete('2');       // agent 2's sprite is gone
      sys.update(frame(1.3));
      expect(p1.kind).toBe('jog');
      expect(p2.setActivityPose.mock.calls.length).toBe(calls2);
      // ...and the bookkeeping is empty: a later frame does not touch them again.
      const calls1 = p1.setActivityPose.mock.calls.length;
      sys.update(frame(1));
      expect(p1.setActivityPose.mock.calls.length).toBe(calls1);
    });

    it('an agent kissed again mid-lean has it extended, and gets back "none", not "lean"', async () => {
      const { sys, positions, data } = await kiss(1, 2);
      const p2 = positions.get('2')!, p3 = positions.get('3')!;
      sys.update(frame(0.9));
      // The per-pair dedupe is 20 s, so the second kiss has to be a different pair (2 and 3).
      sys.onData!(data([kissRow(3, 2, 3), row(1, 'boot')]));
      expect(p3.kind).toBe('lean');
      sys.update(frame(0.9));      // 0.9 s after the second kiss: the first lean would be over by now
      expect(positions.get('1')!.kind).toBe('none');
      expect(p2.kind).toBe('lean');
      sys.update(frame(0.5));
      expect(p2.kind).toBe('none');
      expect(p3.kind).toBe('none');
    });

    it('destroy hands the pose back', async () => {
      const { sys, positions } = await kiss(1, 2);
      sys.destroy();
      expect(positions.get('1')!.kind).toBe('none');
      expect(positions.get('2')!.kind).toBe('none');
    });
  });
});
