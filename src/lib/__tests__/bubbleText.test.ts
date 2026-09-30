import { describe, it, expect } from 'vitest';
import { bubbleOffsetX, bubbleText, speakerSentiment } from '../bubbleText';

describe('bubbleText', () => {
  it('keeps short lines whole', () => {
    expect(bubbleText('Not today, Elena.', 90)).toBe('Not today, Elena.');
  });

  it('shows whole sentences while they fit', () => {
    const line = 'Good morning, Yuki. That blue sweater makes your eyes look particularly bright today.';
    expect(bubbleText(line, 60)).toBe('Good morning, Yuki.');
    expect(bubbleText(line, 90)).toBe(line);
  });

  it('cuts a long first sentence at a word boundary', () => {
    const line = 'I suspect he is playing games with that charm of his, but I will be looking for him at the market.';
    const out = bubbleText(line, 60);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toBe('I suspect he is playing games with that charm of his, but…');
  });
});

describe('bubbleOffsetX', () => {
  it('leaves a lone speaker centred', () => {
    expect(bubbleOffsetX(0, 1)).toBe(0);
    expect(bubbleOffsetX(0, 0)).toBe(0);
    expect(bubbleOffsetX(-1, 3)).toBe(0);
  });

  it('spreads two speakers 24 px apart around the middle', () => {
    expect(bubbleOffsetX(0, 2)).toBe(-12);
    expect(bubbleOffsetX(1, 2)).toBe(12);
  });

  it('gives a third speaker a slot of their own', () => {
    expect([0, 1, 2].map(i => bubbleOffsetX(i, 3))).toEqual([-24, 0, 24]);
    expect(new Set([0, 1, 2, 3].map(i => bubbleOffsetX(i, 4))).size).toBe(4);
  });
});

describe('speakerSentiment', () => {
  const msgs = [
    { speakerId: 1, sentiment: 0.6 },
    { speakerId: 2, sentiment: -0.7 },
    { speakerId: 1, sentiment: -0.4 },
  ];
  it("is the speaker's own newest message, not the other person's", () => {
    expect(speakerSentiment(msgs, 1, 0)).toBe(-0.4);
    expect(speakerSentiment(msgs, 2, 0)).toBe(-0.7);
  });
  it('falls back to the conversation sentiment when the speaker has none', () => {
    expect(speakerSentiment(msgs, 3, 0.5)).toBe(0.5);
    expect(speakerSentiment([{ speakerId: 1 }], 1, 0.3)).toBe(0.3);
    expect(speakerSentiment(undefined, 1, 0.2)).toBe(0.2);
    expect(speakerSentiment([], 1, undefined)).toBe(0);
  });
});
