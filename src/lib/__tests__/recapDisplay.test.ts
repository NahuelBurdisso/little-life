import { describe, it, expect } from 'vitest';
import { recapAutoDismissMs, recapVisible, RECAP_AUTO_DISMISS_MS } from '../recapDisplay';

describe('recap card next to the Director (playtest #3)', () => {
  it('dismisses itself after ~20 s only while the Director is on', () => {
    expect(recapAutoDismissMs(true)).toBe(RECAP_AUTO_DISMISS_MS);
    expect(RECAP_AUTO_DISMISS_MS).toBe(20_000);
    expect(recapAutoDismissMs(false)).toBeNull();
  });

  it('steps aside while a Director caption is on screen', () => {
    expect(recapVisible({ directorOn: true, captionShown: true })).toBe(false);
    expect(recapVisible({ directorOn: true, captionShown: false })).toBe(true);
    expect(recapVisible({ directorOn: false, captionShown: false })).toBe(true);
  });
});
