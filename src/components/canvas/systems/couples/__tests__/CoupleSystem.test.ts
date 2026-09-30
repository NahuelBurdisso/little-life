import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { createCoupleSystem } from '../CoupleSystem';
import type { DataContext, FrameContext } from '../../types';

const view = { x: 0, y: 0, w: 4000, h: 4000, scale: 1 };
const DT = 0.05;

/** Just enough of an AgentSprite: a container, a position, a facing. */
function fakeSprite(x: number, y: number) {
  const container = new PIXI.Container();
  container.position.set(x, y);
  return {
    container,
    get x() { return container.x; },
    get y() { return container.y; },
    lyingBlend: 0,
    facingDir: 1 as 1 | -1,
    setFacing: vi.fn(function (this: any, d: 1 | -1) { this.facingDir = d; }),
  };
}

function setup() {
  const ground = new PIXI.Container();
  const sprites = new Map<string, ReturnType<typeof fakeSprite>>();
  const showEmote = vi.fn();
  const sys = createCoupleSystem(
    { ground, overAgents: new PIXI.Container() },
    { sprites: { getSprite: (id: string) => sprites.get(id) } as any, bubbles: { showEmote } as any },
  );
  let now = 1000;
  const frame = (): FrameContext => ({ dt: DT * 60, seconds: DT, now, view, data: null as any });
  const step = (n: number, move?: (i: number) => void) => {
    for (let i = 0; i < n; i++) {
      move?.(i);
      now += DT * 1000;
      sys.update(frame());
    }
  };
  const data = (agents: any[], relationships: any[]) =>
    ({ agents, world: null, events: [], locations: [], conversations: [], relationships, activity: [] }) as DataContext;
  const agent = (id: number, age: number | undefined, extra: any = {}) => ({ id, name: `a${id}`, position: { x: 0, y: 0 }, age, ...extra });
  return { sys, ground, sprites, showEmote, step, data, agent, add: (id: number, x: number, y: number) => { const s = fakeSprite(x, y); sprites.set(String(id), s); return s; } };
}

const married = [{ agent_a: 1, agent_b: 2, tags: ['married'] }];

describe('CoupleSystem', () => {
  it('pulls a walking couple together and joins their hands, then lets go when they stop', () => {
    const t = setup();
    const a = t.add(1, 100, 100);
    const b = t.add(2, 130, 100);
    t.sys.onData!(t.data([t.agent(1, 30), t.agent(2, 28)], married));
    t.step(40, () => { a.container.x += 1.5; b.container.x += 1.5; });

    // Logical positions are untouched: only the drawing is pulled (a right, b left).
    expect(a.container.pivot.x).toBeLessThan(-1);
    expect(b.container.pivot.x).toBeGreaterThan(1);
    const link = t.ground.children[0] as PIXI.Sprite;
    expect(link.visible).toBe(true);
    expect(link.scale.y).toBe(2);
    expect(link.scale.x).toBeGreaterThan(10);

    t.step(60);
    expect(a.container.pivot.x).toBe(0);
    expect(b.container.pivot.x).toBe(0);
    expect(link.visible).toBe(false);
  });

  it('leaves secret lovers alone, and anyone under 18 or with no known age', () => {
    for (const [tags, ageB] of [[['lovers'], 28], [['married'], 16], [['married'], undefined]] as const) {
      const t = setup();
      const a = t.add(1, 100, 100);
      const b = t.add(2, 130, 100);
      t.sys.onData!(t.data([t.agent(1, 30), t.agent(2, ageB)], [{ agent_a: 1, agent_b: 2, tags: [...tags] }]));
      t.step(200, () => { a.container.x += 1.5; b.container.x += 1.5; });
      expect(a.container.pivot.x).toBe(0);
      expect(t.ground.children).toHaveLength(0);
      expect(a.setFacing).not.toHaveBeenCalled();
      expect(t.showEmote).not.toHaveBeenCalled();
    }
  });

  it('turns an idle couple to face each other and shows at most one heart per 25 s', () => {
    const t = setup();
    const a = t.add(1, 100, 100);
    const b = t.add(2, 125, 100);
    a.facingDir = -1;
    b.facingDir = 1;
    t.sys.onData!(t.data([t.agent(1, 30), t.agent(2, 28)], married));
    t.step(20);
    expect(a.facingDir).toBe(1);
    expect(b.facingDir).toBe(-1);

    // 60 s standing together: a first heart within seconds, then at most one per 25 s.
    t.step(60 / DT);
    expect(t.showEmote.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(t.showEmote.mock.calls.length).toBeLessThanOrEqual(3);
    expect(t.showEmote.mock.calls.every(c => c[1] === 'heart')).toBe(true);
    // The position object is reused (no per-call allocation).
    expect(t.showEmote.mock.calls[0][2]).toBe(t.showEmote.mock.calls[1][2]);
  });

  it('stays hushed for the private evening and while lying down', () => {
    const t = setup();
    const a = t.add(1, 100, 100);
    t.add(2, 125, 100);
    a.facingDir = -1;
    t.sys.onData!(t.data(
      [t.agent(1, 30, { current_action: { type: 'idle', zoneActivity: 'tryst' } }), t.agent(2, 28)],
      married,
    ));
    t.step(400);
    expect(a.setFacing).not.toHaveBeenCalled();
    expect(t.showEmote).not.toHaveBeenCalled();

    const t2 = setup();
    const c = t2.add(1, 100, 100);
    const d = t2.add(2, 125, 100);
    c.lyingBlend = 1;
    d.lyingBlend = 1;
    t2.sys.onData!(t2.data([t2.agent(1, 30), t2.agent(2, 28)], married));
    t2.step(400);
    expect(t2.showEmote).not.toHaveBeenCalled();
  });

  it('lets an infatuated adult glance at a nearby crush and look away again', () => {
    const t = setup();
    const a = t.add(1, 100, 100);
    t.add(2, 140, 100);
    a.facingDir = -1;
    t.sys.onData!(t.data(
      [t.agent(1, 25, { activeStates: [{ type: 'infatuated', target_agent_id: 2 }] }), t.agent(2, 27)],
      [],
    ));
    let sawGlance = false;
    let sawBack = false;
    t.step(12 / DT, () => {
      if (a.facingDir === 1) sawGlance = true;
      else if (sawGlance) sawBack = true;
    });
    expect(sawGlance).toBe(true);
    expect(sawBack).toBe(true);
    // Never more often than every 4 s: 12 s allows at most 3.
    expect(a.setFacing.mock.calls.filter(c => c[0] === 1).length).toBeLessThanOrEqual(3);
  });

  it('samples the new target when an existing crush moves on to somebody else', () => {
    const t = setup();
    const a = t.add(1, 100, 100);
    t.add(2, 900, 900); // the old crush, far away
    t.add(3, 140, 100); // the new one, close
    a.facingDir = -1;
    // Agent 4 keeps crushing on 2, so 2's track survives and nothing else changes the frame lists.
    const crushOn = (target: number) => t.data(
      [
        t.agent(1, 25, { activeStates: [{ type: 'infatuated', target_agent_id: target }] }),
        t.agent(2, 27), t.agent(3, 27),
        t.agent(4, 25, { activeStates: [{ type: 'infatuated', target_agent_id: 2 }] }),
      ],
      [],
    );
    t.sys.onData!(crushOn(2));
    t.step(20);
    expect(a.setFacing).not.toHaveBeenCalled();

    // Same glancer, new target: agent 3's track is created without any glancer or pair being new, so
    // the frame lists must still be rebuilt or 3 is never sampled and the glance never happens.
    t.sys.onData!(crushOn(3));
    let sawGlance = false;
    t.step(12 / DT, () => { if (a.facingDir === 1) sawGlance = true; });
    expect(sawGlance).toBe(true);
  });

  it('never glances when either is a minor or the crush is far', () => {
    for (const [ageA, ageB, far] of [[17, 27, false], [25, 17, false], [25, undefined, false], [25, 27, true]] as const) {
      const t = setup();
      const a = t.add(1, 100, 100);
      t.add(2, far ? 400 : 140, 100);
      t.sys.onData!(t.data(
        [t.agent(1, ageA, { activeStates: [{ type: 'infatuated', target_agent_id: 2 }] }), t.agent(2, ageB)],
        [],
      ));
      t.step(20 / DT);
      expect(a.setFacing).not.toHaveBeenCalled();
    }
  });

  it('clears the pull and the link when the couple splits or the system is destroyed', () => {
    const t = setup();
    const a = t.add(1, 100, 100);
    const b = t.add(2, 130, 100);
    t.sys.onData!(t.data([t.agent(1, 30), t.agent(2, 28)], married));
    t.step(40, () => { a.container.x += 1.5; b.container.x += 1.5; });
    expect(a.container.pivot.x).toBeLessThan(0);

    t.sys.onData!(t.data([t.agent(1, 30), t.agent(2, 28)], []));
    expect(a.container.pivot.x).toBe(0);
    expect(b.container.pivot.x).toBe(0);

    t.sys.onData!(t.data([t.agent(1, 30), t.agent(2, 28)], married));
    t.step(40, () => { a.container.x += 1.5; b.container.x += 1.5; });
    expect(a.container.pivot.x).toBeLessThan(0);
    t.sys.destroy();
    expect(a.container.pivot.x).toBe(0);
  });

  it('survives a destroyed sprite without throwing', () => {
    const t = setup();
    const a = t.add(1, 100, 100);
    t.add(2, 130, 100);
    t.sys.onData!(t.data([t.agent(1, 30), t.agent(2, 28)], married));
    t.step(5);
    a.container.destroy();
    expect(() => t.step(5)).not.toThrow();
  });
});
