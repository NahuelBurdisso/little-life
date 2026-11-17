import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js';
import { createTalkSystem } from '../TalkSystem';
import { TALK_RED } from '../talkLinks';
import type { DataContext, FrameContext } from '../../types';
import { NO_DATA, fakeServices } from '../../__tests__/kit';
import type { ConversationLite } from '../../../../../lib/apiTypes';

const view = { x: 0, y: 0, w: 4000, h: 4000, scale: 1 };
const DT = 0.05;

/** Just enough of an AgentSprite: a position and whether it is veiled. */
function fakeSprite(x: number, y: number) {
  const container = new PIXI.Container();
  container.position.set(x, y);
  return {
    container,
    get x() { return container.x; },
    get y() { return container.y; },
    get isVeiled() { return !container.visible; },
  };
}

function setup() {
  const overAgents = new PIXI.Container();
  const sprites = new Map<string, ReturnType<typeof fakeSprite>>();
  const sys = createTalkSystem(
    { ground: new PIXI.Container(), overAgents },
    fakeServices({ getSprite: (id: string) => sprites.get(id) }, {}),
  );
  const g = overAgents.children[0] as PIXI.Graphics;
  let now = 1000;
  const step = (n: number, v = view) => {
    for (let i = 0; i < n; i++) {
      now += DT * 1000;
      sys.update({ dt: DT * 60, seconds: DT, now, view: v, data: NO_DATA } as FrameContext);
    }
  };
  const data = (conversations: ConversationLite[]) =>
    ({ agents: [], world: null, events: [], locations: [], conversations, relationships: [], activity: [] }) as DataContext;
  const add = (id: number, x: number, y: number) => { const s = fakeSprite(x, y); sprites.set(String(id), s); return s; };
  /** What the frame drew: one entry per stroked path (colour, alpha, width) and per filled dot. */
  const drawn = () => {
    const ins = drawInstructions(g);
    const strokes = ins.filter(i => i.action === 'stroke').map(i => i.data.style);
    const fills = ins.filter(i => i.action === 'fill');
    const paths = ins.filter(i => i.action === 'stroke').map(i => i.data.path.instructions.length);
    return { strokes, fills, paths };
  };
  return { sys, g, sprites, step, data, add, drawn, tick: () => now };
}

/**
 * What a Graphics has been told to draw. `context.instructions` is Pixi's internal list,
 * not part of its public types, so its shape is spelled out here once.
 */
interface DrawInstruction {
  action: string;
  data: {
    style: { color: number; alpha: number; width: number };
    path: { instructions: Array<{ action: string; data: number[] }> };
  };
}
const drawInstructions = (g: PIXI.Graphics) =>
  (g.context as unknown as { instructions: DrawInstruction[] }).instructions;

const talk = (id: number, participants: number[], messages: Array<{ speakerId: number; text: string; sentiment: number }> = [], extra: Record<string, unknown> = {}) =>
  ({ id, participants, messages, status: 'active', topic: null, trigger_reason: 'chat', max_turns: 4, ...extra });
const line = (speakerId: number, sentiment = 0) => ({ speakerId, text: 'hi', sentiment });

describe('TalkSystem', () => {
  it('does not throw with no conversations, before any data, or after destroy', () => {
    const t = setup();
    expect(() => t.step(2)).not.toThrow();
    t.sys.onData!(t.data([]));
    expect(() => t.step(2)).not.toThrow();
    expect(t.drawn().strokes).toHaveLength(0);
    t.sys.onData!(t.data([talk(1, [1, 2])]));
    t.sys.destroy();
    expect(t.g.destroyed).toBe(true);
  });

  it('draws one tinted line between two talkers, and no dot until somebody speaks', () => {
    const t = setup();
    t.add(1, 100, 100);
    t.add(2, 160, 100);
    t.sys.onData!(t.data([talk(1, [1, 2], [line(1, 1), line(2, 1)], { topic: 'a clash' })]));
    t.step(1);
    const d = t.drawn();
    expect(d.strokes).toHaveLength(1);
    expect(d.strokes[0].color).toBe(TALK_RED);
    expect(d.fills).toHaveLength(0);
  });

  it('starts a half-second pulse when messages grow, and ends it', () => {
    const t = setup();
    t.add(1, 100, 100);
    t.add(2, 160, 100);
    t.sys.onData!(t.data([talk(1, [1, 2], [line(1)])]));
    t.step(2);
    // A chat first seen with messages already in it does not fire a pulse.
    expect(t.drawn().fills).toHaveLength(0);

    t.sys.onData!(t.data([talk(1, [1, 2], [line(1), line(2)])]));
    t.step(3);
    expect(t.drawn().fills.length).toBeGreaterThan(0);

    t.step(20);
    expect(t.drawn().fills).toHaveLength(0);
  });

  it('sends the dot from the speaker toward the listener', () => {
    const t = setup();
    t.add(1, 100, 100);
    t.add(2, 300, 100);
    t.sys.onData!(t.data([talk(1, [1, 2], [line(1)])]));
    t.step(1);
    const dotX = () => {
      const ins = drawInstructions(t.g);
      const circle = ins.find(i => i.action === 'fill')!;
      return circle.data.path.instructions.find((i) => i.action === 'circle')!.data[0];
    };
    t.sys.onData!(t.data([talk(1, [1, 2], [line(1), line(2)])]));
    t.step(1);
    const early = dotX();
    t.step(6);
    const later = dotX();
    // Participant 2 (x = 300) spoke: the dot travels from 300 back toward 100.
    expect(early).toBeGreaterThan(200);
    expect(later).toBeLessThan(early);
  });

  it('skips a conversation where a participant is veiled', () => {
    const t = setup();
    const a = t.add(1, 100, 100);
    t.add(2, 160, 100);
    t.sys.onData!(t.data([talk(1, [1, 2], [line(1)])]));
    t.step(1);
    expect(t.drawn().strokes).toHaveLength(1);

    a.container.visible = false;
    t.sys.onData!(t.data([talk(1, [1, 2], [line(1), line(2)])]));
    t.step(3);
    expect(t.drawn().strokes).toHaveLength(0);
    expect(t.drawn().fills).toHaveLength(0);
  });

  it('skips a talker with no sprite, and an ended conversation', () => {
    const t = setup();
    t.add(1, 100, 100);
    t.sys.onData!(t.data([talk(1, [1, 2]), talk(2, [1, 3], [], { status: 'ended' })]));
    t.step(1);
    expect(t.drawn().strokes).toHaveLength(0);
  });

  it('draws a spoke from each of three talkers to their middle', () => {
    const t = setup();
    t.add(1, 100, 100);
    t.add(2, 160, 100);
    t.add(3, 130, 160);
    t.sys.onData!(t.data([talk(1, [1, 2, 3])]));
    t.step(1);
    const d = t.drawn();
    // One stroked path holding three moveTo + lineTo pairs.
    expect(d.strokes).toHaveLength(1);
    expect(d.paths[0]).toBe(6);
  });

  it('uses a heavier line for a deep chat than a passing one', () => {
    const t = setup();
    t.add(1, 100, 100);
    t.add(2, 160, 100);
    t.add(3, 100, 300);
    t.add(4, 160, 300);
    t.sys.onData!(t.data([
      talk(1, [1, 2], [], { topic: 'a confrontation', max_turns: 6 }),
      talk(2, [3, 4], [], { topic: 'nothing much', max_turns: 3 }),
    ]));
    t.step(1);
    const [deep, standard] = t.drawn().strokes;
    expect(deep.width).toBeGreaterThan(standard.width);
  });

  it('fades when zoomed out and draws nothing for a chat off screen', () => {
    const t = setup();
    t.add(1, 100, 100);
    t.add(2, 160, 100);
    t.sys.onData!(t.data([talk(1, [1, 2])]));
    t.step(1);
    const near = t.drawn().strokes[0].alpha;
    t.step(1, { ...view, scale: 0.5 });
    expect(t.drawn().strokes[0].alpha).toBeLessThan(near);

    t.step(1, { x: 2000, y: 2000, w: 300, h: 300, scale: 1 });
    expect(t.drawn().strokes).toHaveLength(0);
  });

  it('forgets a conversation once it is gone from the data', () => {
    const t = setup();
    t.add(1, 100, 100);
    t.add(2, 160, 100);
    t.sys.onData!(t.data([talk(1, [1, 2], [line(1)])]));
    t.sys.onData!(t.data([]));
    t.step(1);
    expect(t.drawn().strokes).toHaveLength(0);
    // The same id coming back later is a new chat: no pulse for its old messages.
    t.sys.onData!(t.data([talk(1, [1, 2], [line(1), line(2)])]));
    t.step(1);
    expect(t.drawn().fills).toHaveLength(0);
  });
});
