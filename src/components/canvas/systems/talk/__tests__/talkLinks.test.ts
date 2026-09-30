import { describe, it, expect } from 'vitest';
import {
  TALK_BLUE, TALK_GOLD, TALK_RED, TALK_ROSE, TALK_VIOLET,
  arcBow, groupAnchors, latestSpeaker, lineWidth, pulseT, talkTone, zoomFade,
} from '../talkLinks';
import type { Seg } from '../talkLinks';

const msgs = (...s: Array<number | undefined>) => s.map((sentiment, i) => ({ speakerId: 1 + (i % 2), text: 'x', sentiment }));
const rgb = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

describe('talkTone', () => {
  it('colours the line by what the two are talking about', () => {
    expect(talkTone({ topic: 'flirting at the well', messages: msgs(1, 1, 1) })).toBe(TALK_ROSE);
    expect(talkTone({ topic: 'a heated argument', messages: msgs(1, 1, 1) })).toBe(TALK_RED);
    expect(talkTone({ topic: 'confront about the debt', messages: msgs(1, 1, 1) })).toBe(TALK_RED);
    expect(talkTone({ topic: 'a clash over the fence', messages: msgs(1, 1, 1) })).toBe(TALK_RED);
    expect(talkTone({ topic: 'gossip about Mara', messages: msgs(1, 1, 1) })).toBe(TALK_VIOLET);
    expect(talkTone({ topic: 'a secret shared', messages: msgs(1, 1, 1) })).toBe(TALK_VIOLET);
    expect(talkTone({ topic: 'comfort after the funeral', messages: msgs(1, 1, 1) })).toBe(TALK_BLUE);
    expect(talkTone({ topic: 'condolences', messages: msgs(1, 1, 1) })).toBe(TALK_BLUE);
    expect(talkTone({ topic: 'the weather', messages: msgs(1, 1, 1) })).toBe(TALK_GOLD);
    expect(talkTone({ topic: null, messages: [] })).toBe(TALK_GOLD);
    expect(talkTone({})).toBe(TALK_GOLD);
  });

  it('a flat chat still leans toward its topic colour', () => {
    const rose = rgb(TALK_ROSE);
    const gold = rgb(TALK_GOLD);
    const flat = rgb(talkTone({ topic: 'flirt', messages: msgs(0, 0, 0) }));
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(dist(flat, rose)).toBeLessThan(dist(flat, gold));
  });

  it('a warm chat sits closer to the topic colour than a flat one', () => {
    const flat = rgb(talkTone({ topic: 'flirt', messages: msgs(0, 0, 0) }));
    const warm = rgb(talkTone({ topic: 'flirt', messages: msgs(0.9, 0.9, 0.9) }));
    const rose = rgb(TALK_ROSE);
    const dist = (c: number[]) => Math.hypot(c[0] - rose[0], c[1] - rose[1], c[2] - rose[2]);
    expect(dist(warm)).toBeLessThan(dist(flat));
  });

  it('reads red when the last words were bitter, whatever the topic', () => {
    expect(talkTone({ topic: 'the weather', messages: msgs(-1, -1, -1) })).toBe(TALK_RED);
    expect(talkTone({ topic: 'flirting', messages: msgs(-1, -1, -1) })).toBe(TALK_RED);
    const [r, g, b] = rgb(talkTone({ topic: 'the weather', messages: msgs(-0.5, -0.5, -0.5) }));
    expect(r).toBeGreaterThan(g * 1.5);
    expect(r).toBeGreaterThan(b * 2);
  });

  it('only looks at the last three messages', () => {
    expect(talkTone({ topic: 'the weather', messages: msgs(-1, -1, -1, 0, 0, 0) })).toBe(TALK_GOLD);
  });

  it('treats a missing sentiment as 0 and does not throw on odd rows', () => {
    expect(talkTone({ topic: 'flirt', messages: msgs(undefined, undefined) })).toBe(
      talkTone({ topic: 'flirt', messages: msgs(0, 0) }),
    );
    expect(talkTone({ topic: 'the weather', messages: [{ speakerId: 1 }, null, { sentiment: NaN }] })).toBe(TALK_GOLD);
  });
});

describe('latestSpeaker', () => {
  it('is the speaker of the newest message that has one', () => {
    expect(latestSpeaker({ messages: [{ speakerId: 3 }, { speakerId: 7 }] })).toBe(7);
    expect(latestSpeaker({ messages: [{ speakerId: 3 }, {}] })).toBe(3);
  });
  it('is null when nobody has spoken', () => {
    expect(latestSpeaker({ messages: [] })).toBeNull();
    expect(latestSpeaker({})).toBeNull();
  });
});

describe('groupAnchors', () => {
  it('gives one segment for two people', () => {
    const out: Seg[] = [];
    expect(groupAnchors([{ x: 0, y: 0 }, { x: 10, y: 20 }], out)).toBe(1);
    expect(out[0]).toEqual({ ax: 0, ay: 0, bx: 10, by: 20 });
  });

  it('gives a spoke from each of three or more to their centroid', () => {
    const out: Seg[] = [];
    expect(groupAnchors([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 0, y: 30 }], out)).toBe(3);
    for (const s of out.slice(0, 3)) {
      expect(s.bx).toBe(10);
      expect(s.by).toBe(10);
    }
    expect(out.slice(0, 3).map(s => [s.ax, s.ay])).toEqual([[0, 0], [30, 0], [0, 30]]);
  });

  it('gives nothing for fewer than two, and reuses its segment objects', () => {
    const out: Seg[] = [];
    expect(groupAnchors([{ x: 1, y: 1 }], out)).toBe(0);
    expect(groupAnchors([], out)).toBe(0);
    groupAnchors([{ x: 0, y: 0 }, { x: 1, y: 1 }], out);
    const first = out[0];
    groupAnchors([{ x: 5, y: 5 }, { x: 9, y: 9 }], out);
    expect(out[0]).toBe(first);
    expect(first.ax).toBe(5);
  });
});

describe('pulseT', () => {
  it('runs 0..1 over half a second and clamps', () => {
    expect(pulseT(1000, 1000)).toBe(0);
    expect(pulseT(1000, 1250)).toBeCloseTo(0.5);
    expect(pulseT(1000, 1500)).toBe(1);
    expect(pulseT(1000, 9000)).toBe(1);
    expect(pulseT(1000, 500)).toBe(0);
    expect(pulseT(0, 100, 200)).toBeCloseTo(0.5);
    expect(pulseT(0, 100, 0)).toBe(1);
  });
});

describe('lineWidth', () => {
  it('is heavier for deep chats than standard ones, and lightest for templates', () => {
    expect(lineWidth('llm_deep')).toBeGreaterThan(lineWidth('llm_standard'));
    expect(lineWidth('llm_standard')).toBeGreaterThan(lineWidth('template'));
  });
});

describe('zoomFade and arcBow', () => {
  it('is fully opaque at normal zoom and fades toward a floor when zoomed out', () => {
    expect(zoomFade(1)).toBe(1);
    expect(zoomFade(0.8)).toBe(1);
    expect(zoomFade(0.6)).toBeLessThan(1);
    expect(zoomFade(0.6)).toBeGreaterThan(zoomFade(0.4));
    expect(zoomFade(0.1)).toBeGreaterThan(0);
    expect(zoomFade(0.1)).toBe(zoomFade(0.4));
  });
  it('bows a short link by 8 px and a long one by at most 24', () => {
    expect(arcBow(10)).toBe(8);
    expect(arcBow(1000)).toBe(24);
  });
});
