import { describe, it, expect, beforeEach } from 'vitest';
import { bannerKey, pickBanner, type HealthLike } from '../healthBanner';
import { getConnectionState, markSocketClosed, markSocketOpen, resetConnectionState } from '../connectionState';

const OK: HealthLike = {
  llm: { status: 'ok', reason: null },
  breakerOpen: false,
  embeddings: { ok: true, reason: null },
  tick: { lastTickOverrunMs: 0, slowTicksLastMinute: 0, lagging: false },
};

function health(over: Partial<HealthLike>): HealthLike {
  return { ...OK, ...over };
}

describe('pickBanner', () => {
  it('shows nothing when all is well, or before the first answer', () => {
    expect(pickBanner({ connection: 'open', health: OK })).toBeNull();
    expect(pickBanner({ connection: 'open', health: undefined })).toBeNull();
  });

  it('does not flash on page load (connecting is not down)', () => {
    expect(pickBanner({ connection: 'connecting', health: OK })).toBeNull();
  });

  it('says it is reconnecting when the socket is closed, and that cannot be dismissed', () => {
    const b = pickBanner({ connection: 'closed', health: OK });
    expect(b).toMatchObject({ id: 'offline', text: 'Reconnecting to the town…', dismissible: false, severity: 'critical' });
  });

  it('a dead socket outranks health, which is stale then', () => {
    const b = pickBanner({ connection: 'closed', health: health({ llm: { status: 'down', reason: 'x' } }) });
    expect(b?.id).toBe('offline');
  });

  it('names the reason when the LLM is offline', () => {
    const b = pickBanner({ connection: 'open', health: health({ llm: { status: 'down', reason: 'cannot reach Ollama - is it running?' } }) });
    expect(b).toMatchObject({ id: 'llm-down', text: 'LLM offline: cannot reach Ollama - is it running?', dismissible: false });
  });

  it('degraded LLM is dismissible and explains the fallback', () => {
    const b = pickBanner({ connection: 'open', health: health({ llm: { status: 'degraded', reason: 'timeouts' } }) });
    expect(b?.id).toBe('llm-degraded');
    expect(b?.dismissible).toBe(true);
    expect(b?.text).toContain('conversations use simple lines');
  });

  it('LLM problems outrank embeddings, which outrank lag', () => {
    const all = health({
      llm: { status: 'degraded', reason: null },
      embeddings: { ok: false, reason: 'r' },
      tick: { lastTickOverrunMs: 3000, slowTicksLastMinute: 9, lagging: true },
    });
    expect(pickBanner({ connection: 'open', health: all })?.id).toBe('llm-degraded');
    expect(pickBanner({ connection: 'open', health: { ...all, llm: OK.llm } })?.id).toBe('embeddings');
    expect(pickBanner({ connection: 'open', health: { ...all, llm: OK.llm, embeddings: OK.embeddings } })?.id).toBe('lagging');
  });

  it('reports the tick overrun in seconds', () => {
    const b = pickBanner({ connection: 'open', health: health({ tick: { lastTickOverrunMs: 2400, slowTicksLastMinute: 7, lagging: true } }) });
    expect(b?.text).toContain('2.4s');
  });
});

describe('bannerKey', () => {
  it('is null without a banner', () => {
    expect(bannerKey(null)).toBeNull();
  });

  it('re-arms a dismissal when the cause changes, but not when only the lag number jitters', () => {
    const a = pickBanner({ connection: 'open', health: health({ llm: { status: 'degraded', reason: 'timeouts' } }) });
    const same = pickBanner({ connection: 'open', health: health({ llm: { status: 'degraded', reason: 'other' } }) });
    expect(bannerKey(a)).toBe(bannerKey(same)); // same text: the reason lives in the tooltip

    const down1 = pickBanner({ connection: 'open', health: health({ llm: { status: 'down', reason: 'a' } }) });
    const down2 = pickBanner({ connection: 'open', health: health({ llm: { status: 'down', reason: 'b' } }) });
    expect(bannerKey(down1)).not.toBe(bannerKey(down2));

    const lag1 = pickBanner({ connection: 'open', health: health({ tick: { lastTickOverrunMs: 1500, slowTicksLastMinute: 6, lagging: true } }) });
    const lag2 = pickBanner({ connection: 'open', health: health({ tick: { lastTickOverrunMs: 2900, slowTicksLastMinute: 9, lagging: true } }) });
    expect(bannerKey(lag1)).toBe(bannerKey(lag2));
  });
});

describe('connection store', () => {
  beforeEach(() => resetConnectionState());

  it('starts as connecting and counts only recoveries, not the first open', () => {
    expect(getConnectionState()).toEqual({ status: 'connecting', reconnects: 0 });
    markSocketOpen();
    expect(getConnectionState()).toEqual({ status: 'open', reconnects: 0 });
    markSocketClosed();
    expect(getConnectionState().status).toBe('closed');
    markSocketOpen();
    expect(getConnectionState()).toEqual({ status: 'open', reconnects: 1 });
  });

  it('a failed first attempt then a success counts as a recovery (the page missed pushes)', () => {
    markSocketClosed();
    markSocketOpen();
    expect(getConnectionState().reconnects).toBe(1);
  });

  it('repeated closes and opens do not double count', () => {
    markSocketOpen();
    markSocketClosed();
    markSocketClosed();
    markSocketOpen();
    markSocketOpen();
    expect(getConnectionState().reconnects).toBe(1);
  });
});
