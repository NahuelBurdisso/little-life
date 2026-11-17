import { describe, expect, it } from 'vitest';
import { WS_RETRY_MAX_MS, wsRetryDelayMs } from '../wsRetry';

describe('wsRetryDelayMs', () => {
  it('starts quick and doubles', () => {
    expect([0, 1, 2, 3].map(wsRetryDelayMs)).toEqual([500, 1000, 2000, 4000]);
  });

  it('settles at the cap', () => {
    expect(wsRetryDelayMs(4)).toBe(WS_RETRY_MAX_MS);
    expect(wsRetryDelayMs(500)).toBe(WS_RETRY_MAX_MS);
  });

  it('treats a nonsense attempt as the first', () => {
    expect(wsRetryDelayMs(-3)).toBe(500);
    expect(wsRetryDelayMs(Number.NaN)).toBe(500);
  });
});
