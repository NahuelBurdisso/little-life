import { describe, it, expect } from 'vitest';
import { bubbleText } from '../bubbleText';

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
