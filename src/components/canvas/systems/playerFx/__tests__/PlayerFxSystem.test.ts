import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js';
import { fakeServices } from '../../__tests__/kit';

// The atlas loader needs a browser; hand the system blank textures of the right count.
vi.mock('../../../stripAtlas', () => ({
  loadStrip: (_url: string, count: number) =>
    Promise.resolve(Array.from({ length: count }, () => PIXI.Texture.EMPTY)),
}));

import { createPlayerFxSystem } from '../PlayerFxSystem';
import { emitCanvasEvent, onCanvasEvent } from '../../../../../lib/canvasBus';
import type { DataContext, FrameContext } from '../../types';

const view = { x: 0, y: 0, w: 2000, h: 2000, scale: 1 };
const flush = () => new Promise(r => setTimeout(r, 0));

interface Fake { x: number; y: number; facingDir?: 1 | -1 }

function setup() {
  const ground = new PIXI.Container();
  const overAgents = new PIXI.Container();
  const agents = new Map<string, Fake>();
  for (let i = 1; i <= 6; i++) agents.set(String(i), { x: i * 100, y: 300 });
  const showEmote = vi.fn();
  const data = {
    agents: [1, 2, 3, 4, 5, 6].map(id => ({ id, current_location: null })),
    world: null, events: [],
    locations: [
      { id: 7, position: { x: 500, y: 500, width: 128, height: 96 }, entry_point: { x: 564, y: 596 } },
    ],
    conversations: [], relationships: [], activity: [],
  } as unknown as DataContext;
  const sys = createPlayerFxSystem(
    { ground, overAgents },
    fakeServices({ getSprite: (id: string) => agents.get(id), recentlyRemoved: [] }, { showEmote }),
  );
  const frame: FrameContext = { dt: 0, seconds: 0, now: 0, view, data };
  /** Advance `secs` of game time in 50 ms frames. */
  const run = (secs: number) => {
    for (let t = 0; t < secs - 1e-9; t += 0.05) { frame.seconds = 0.05; frame.dt = 3; sys.update(frame); }
  };
  sys.onData!(data);
  const visible = () => [...ground.children, ...overAgents.children].filter(c => c.visible).length;
  return { sys, ground, overAgents, agents, showEmote, data, run, visible };
}

const emit = (kind: string, agentIds: number[], extra: object = {}) =>
  emitCanvasEvent({ type: 'intervention', kind, agentIds, ...extra });

describe('PlayerFxSystem', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('suggest_talk: speech bubbles on both and an arc that lasts until they meet', async () => {
    const { sys, agents, run, visible } = setup();
    await flush();
    emit('suggest_talk', [1, 2]);
    run(0.5);
    expect(visible()).toBeGreaterThan(8);              // dots + heart + two bubbles
    run(4);                                            // the bubbles are gone, the arc is not
    const arcOnly = visible();
    expect(arcOnly).toBeGreaterThan(5);
    // 100 px apart: walk B next to A. Within 2 tiles ends the arc.
    agents.get('2')!.x = 130;
    run(1);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('suggest_talk: an active conversation between the pair ends the arc too, after the minimum', async () => {
    const { sys, data, run, visible } = setup();
    await flush();
    emit('suggest_talk', [1, 3]);
    data.conversations.push({ status: 'active', participants: [3, 1] });
    run(1);
    expect(visible()).toBeGreaterThan(0);              // still inside the 2 s minimum
    run(2);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('suggest_talk: gives up after a minute even if they never meet', async () => {
    const { sys, run, visible } = setup();
    await flush();
    emit('suggest_talk', [1, 6]);
    run(59);
    expect(visible()).toBeGreaterThan(0);
    run(2);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('suggest_go_to: a pin at the door stays until the agent is inside, then pops and goes', async () => {
    const { sys, overAgents, data, run, visible } = setup();
    await flush();
    emit('suggest_go_to', [1], { locationId: 7 });
    run(3);
    const pin = overAgents.children.find(c => c.visible && Math.round(c.x) === 564 && c.y <= 596 && c.y >= 590);
    expect(pin).toBeDefined();
    run(20);
    expect(visible()).toBeGreaterThan(2);              // still waiting
    data.agents[0].current_location = 7;
    run(0.2);
    run(1);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('suggest_go_to: without a known location it falls back to the generic ping', async () => {
    const { sys, overAgents, showEmote } = setup();
    await flush();
    emit('suggest_go_to', [2], { locationId: 999 });
    expect(showEmote).toHaveBeenCalledWith('2', 'exclaim', { x: 200, y: 300 });
    expect(overAgents.children.length).toBe(1);
    sys.destroy();
  });

  it('give_money: coins land on the agent and a +N label floats, then everything is released', async () => {
    const { sys, run, visible } = setup();
    await flush();
    emit('give_money', [3], { amount: 250 });
    run(0.3);
    expect(visible()).toBeGreaterThan(0);
    run(0.7);                                          // label is up by now: "+250" = 4 glyphs
    expect(visible()).toBeGreaterThanOrEqual(4);
    run(2);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('tell_secret: whisper emote on the teller, the swirl travels, "!" on the listener when it lands', async () => {
    const { sys, showEmote, run, visible } = setup();
    await flush();
    emit('tell_secret', [1, 4]);
    expect(showEmote).toHaveBeenCalledWith('1', 'whisper', { x: 100, y: 300 });
    expect(showEmote).not.toHaveBeenCalledWith('4', 'exclaim', expect.anything());
    run(0.5);
    expect(visible()).toBeGreaterThan(0);
    run(2);                                            // 300 px apart -> 2 s travel
    expect(showEmote).toHaveBeenCalledWith('4', 'exclaim', { x: 400, y: 300 });
    run(1);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('force_confront: an angry emote and crossed swords on each, briefly', async () => {
    const { sys, showEmote, run, visible } = setup();
    await flush();
    emit('force_confront', [2, 5]);
    expect(showEmote.mock.calls.map(c => [c[0], c[1]])).toEqual([['2', 'anger'], ['5', 'anger']]);
    run(0.3);
    expect(visible()).toBe(2);
    run(2);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('introduce_agent: waits for the sprite, then celebrates and points the camera at it, once', async () => {
    const { sys, agents, showEmote, run, visible } = setup();
    await flush();
    const focus = vi.fn();
    const off = onCanvasEvent(e => { if (e.type === 'focus') focus(e); });
    emit('introduce_agent', [42]);
    run(2);
    expect(visible()).toBe(0);
    expect(focus).not.toHaveBeenCalled();
    agents.set('42', { x: 640, y: 480 });
    run(0.1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ type: 'focus', x: 640, y: 480 });
    expect(showEmote).toHaveBeenCalledWith('42', 'wave', { x: 640, y: 480 });
    run(1);
    expect(visible()).toBeGreaterThanOrEqual(2);       // column + suitcase (+ confetti)
    run(3);
    expect(visible()).toBe(0);
    expect(focus).toHaveBeenCalledTimes(1);
    off();
    sys.destroy();
  });

  it('introduce_agent: a newcomer that never shows up is dropped after ~30 s', async () => {
    const { sys, agents, run, visible } = setup();
    await flush();
    const focus = vi.fn();
    const off = onCanvasEvent(e => { if (e.type === 'focus') focus(); });
    emit('introduce_agent', [42]);
    run(31);
    agents.set('42', { x: 1, y: 1 });
    run(2);
    expect(focus).not.toHaveBeenCalled();
    expect(visible()).toBe(0);
    off();
    sys.destroy();
  });

  it('remove_agent: waves, then poofs where they stood once the sprite is gone; the suitcase hops off', async () => {
    const { sys, agents, showEmote, run, visible } = setup();
    await flush();
    emit('remove_agent', [5]);
    expect(showEmote).toHaveBeenCalledWith('5', 'wave', { x: 500, y: 300 });
    run(0.3);
    expect(visible()).toBe(0);                         // nothing yet: the agent is still there
    agents.delete('5');                                // next poll: sprite gone
    run(0.2);
    expect(visible()).toBeGreaterThanOrEqual(1);       // poof
    run(0.5);
    expect(visible()).toBeGreaterThanOrEqual(1);       // suitcase
    run(3);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('remove_agent: uses the position from the event when the sprite is already gone', async () => {
    const { sys, overAgents, showEmote, run } = setup();
    await flush();
    emit('remove_agent', [77], { x: 900, y: 700 });
    expect(showEmote).not.toHaveBeenCalled();
    run(0.2);
    const near = overAgents.children.filter(c => c.visible && Math.abs(c.x - 900) < 40);
    expect(near.length).toBeGreaterThanOrEqual(1);
    sys.destroy();
  });

  it('remove_agent without any position does nothing', async () => {
    const { sys, overAgents, run } = setup();
    await flush();
    emit('remove_agent', [77]);
    run(1);
    expect(overAgents.children.filter(c => c.visible)).toHaveLength(0);
    sys.destroy();
  });

  it('event: a burst and sparks at the location, and nothing without one', async () => {
    const { sys, overAgents, run, visible } = setup();
    await flush();
    emit('event', []);
    run(0.3);
    expect(visible()).toBe(0);
    emit('event', [], { locationId: 7 });
    run(0.3);
    expect(visible()).toBeGreaterThanOrEqual(2);
    const burst = overAgents.children.find(c => c.visible && c.x === 564 && c.y === 548) as PIXI.Sprite;
    expect(burst).toBeDefined();
    expect(burst.scale.x).toBe(4);                     // 128 px wide -> 4x the 32 px cell
    run(2);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('weather: a full-view flash that fades out', async () => {
    const { sys, overAgents, run, visible } = setup();
    await flush();
    emit('weather', []);
    run(0.15);
    const flash = overAgents.children.find(c => c.visible) as PIXI.Sprite;
    expect(flash).toBeDefined();
    expect(flash.alpha).toBeGreaterThan(0);
    expect(flash.width).toBe(view.w);
    run(1);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('whisper_thought: a wisp falls into the head, then a "think" bubble', async () => {
    const { sys, overAgents, showEmote, run, visible } = setup();
    await flush();
    emit('whisper_thought', [2]);
    run(0.3);
    expect(visible()).toBeGreaterThan(0);
    // Early in the fall the wisp is well above the head (feet at y 300, head ~272).
    expect(overAgents.children.some(c => c.visible && c.y < 240)).toBe(true);
    expect(showEmote).not.toHaveBeenCalled();
    run(1);
    expect(showEmote).toHaveBeenCalledWith('2', 'think', { x: 200, y: 300 });
    run(0.5);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('send_letter: a tinted wisp falls into the head, then a "question" bubble (who sent it?)', async () => {
    const { sys, overAgents, showEmote, run, visible } = setup();
    await flush();
    emit('send_letter', [2]);
    run(0.3);
    expect(visible()).toBeGreaterThan(0);
    // A parchment tint apart from the whisper's plain wisp, so the two powers read differently.
    expect(overAgents.children.some(c => c.visible && (c as PIXI.Sprite).tint === 0xf2d98a)).toBe(true);
    expect(showEmote).not.toHaveBeenCalled();
    run(1);
    expect(showEmote).toHaveBeenCalledWith('2', 'question', { x: 200, y: 300 });
    run(0.5);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('send_letter: a repeat on the same agent replaces the effect instead of stacking', async () => {
    const { sys, run, visible } = setup();
    await flush();
    emit('send_letter', [2]);
    run(0.3);
    const one = visible();
    for (let i = 0; i < 4; i++) emit('send_letter', [2]);
    run(0.3);
    expect(visible()).toBeLessThanOrEqual(one);
    sys.destroy();
  });

  it('start_rumor: "shh" on the seeder and wisps drifting off them; nothing on the subject', async () => {
    const { sys, overAgents, showEmote, run, visible } = setup();
    await flush();
    emit('start_rumor', [3, 6]);
    expect(showEmote).toHaveBeenCalledWith('3', 'whisper', { x: 300, y: 300 });
    expect(showEmote).not.toHaveBeenCalledWith('6', expect.anything(), expect.anything());
    run(0.8);
    const wisps = overAgents.children.filter(c => c.visible);
    expect(wisps.length).toBeGreaterThanOrEqual(3);
    expect(wisps.every(c => Math.abs(c.x - 300) < 80)).toBe(true);   // around the seeder, not the subject
    run(2);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('stir_feeling: the state emote and particles rising around the agent', async () => {
    const { sys, overAgents, showEmote, run, visible } = setup();
    await flush();
    emit('stir_feeling', [4, 1], { feeling: 'jealous' });
    expect(showEmote).toHaveBeenCalledWith('4', 'fire', { x: 400, y: 300 });
    run(0.6);
    const parts = overAgents.children.filter(c => c.visible) as PIXI.Sprite[];
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.every(c => Math.abs(c.x - 400) < 30 && c.y < 300)).toBe(true);
    expect(parts[0].tint).not.toBe(0xffffff);          // jealousy is tinted sour green
    run(3);
    expect(visible()).toBe(0);
    sys.destroy();
  });

  it('stir_feeling: re-stirring the same agent replaces the effect', async () => {
    const { sys, ground, overAgents, run } = setup();
    await flush();
    emit('stir_feeling', [5], { feeling: 'confident' });
    run(0.1);
    const before = ground.children.length + overAgents.children.length;
    for (let i = 0; i < 4; i++) emit('stir_feeling', [5], { feeling: 'stressed' });
    run(0.1);
    expect(ground.children.length + overAgents.children.length).toBe(before);
    sys.destroy();
  });

  it('an unknown kind gets the generic ring and "!" on each agent', async () => {
    const { sys, overAgents, showEmote } = setup();
    await flush();
    emit('nudge', [3]);
    expect(showEmote).toHaveBeenCalledWith('3', 'exclaim', { x: 300, y: 300 });
    expect(overAgents.children).toHaveLength(1);
    sys.destroy();
  });

  it('repeating an action for the same pair replaces the old effect instead of piling up', async () => {
    const { sys, ground, overAgents, run } = setup();
    await flush();
    emit('suggest_talk', [1, 2]);
    run(0.1);
    const before = ground.children.length + overAgents.children.length;
    for (let i = 0; i < 5; i++) emit('suggest_talk', [2, 1]);
    run(0.1);
    expect(ground.children.length + overAgents.children.length).toBe(before);
    sys.destroy();
  });

  it('caps the number of live effects and the sprites they hold', async () => {
    const { sys, ground, overAgents, run } = setup();
    await flush();
    for (let i = 0; i < 60; i++) emit('give_money', [(i % 6) + 1], { amount: 999999 });
    run(0.1);
    expect(ground.children.length + overAgents.children.length).toBeLessThanOrEqual(140);
    run(4);
    expect([...ground.children, ...overAgents.children].filter(c => c.visible)).toHaveLength(0);
    sys.destroy();
  });

  it('acknowledges with the emote alone while the atlas is still loading', () => {
    const { sys, showEmote } = setup();                // no flush: textures not resolved yet
    emit('give_money', [3], { amount: 5 });
    expect(showEmote).toHaveBeenCalledWith('3', 'exclaim', { x: 300, y: 300 });
    sys.destroy();
  });

  it('destroy removes every sprite and unsubscribes', async () => {
    const { sys, ground, overAgents, showEmote } = setup();
    await flush();
    emit('force_confront', [1, 2]);
    expect(overAgents.children.length).toBeGreaterThan(0);
    sys.destroy();
    expect(ground.children).toHaveLength(0);
    expect(overAgents.children).toHaveLength(0);
    showEmote.mockClear();
    emit('force_confront', [1, 2]);
    expect(showEmote).not.toHaveBeenCalled();
  });

  it('ignores events that are not interventions', async () => {
    const { sys, overAgents, showEmote } = setup();
    await flush();
    emitCanvasEvent({ type: 'focus', x: 1, y: 2 });
    expect(showEmote).not.toHaveBeenCalled();
    expect(overAgents.children).toHaveLength(0);
    sys.destroy();
  });

  it('hides effects that are off screen', async () => {
    const { sys, overAgents, ground, run } = setup();
    await flush();
    emit('force_confront', [1, 2]);
    // Slide the view away: nothing near (100..200, 300) is visible any more.
    const far = { x: 5000, y: 5000, w: 100, h: 100, scale: 1 };
    const f: FrameContext = { dt: 3, seconds: 0.05, now: 0, view: far, data: {} as DataContext };
    sys.update(f);
    expect([...ground.children, ...overAgents.children].filter(c => c.visible)).toHaveLength(0);
    run(0);
    sys.destroy();
  });
});
