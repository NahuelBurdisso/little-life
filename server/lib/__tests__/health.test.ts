import { describe, it, expect, beforeEach, vi } from 'vitest';
import { emitter } from '../../engine/emitter';
import { llmHealth } from '../../ai/llmHealth';
import { tickHealth } from '../../engine/tickHealth';
import { getHealthSnapshot, healthSignature, refreshHealth, HEALTH_CHANNEL } from '../health';

describe('health snapshot', () => {
  beforeEach(() => {
    llmHealth.reset();
    tickHealth.reset();
    refreshHealth(); // settle the module's remembered signature
  });

  it('is all clear on a fresh server', () => {
    const h = getHealthSnapshot();
    expect(h.llm.status).toBe('ok');
    expect(h.breakerOpen).toBe(false);
    expect(h.embeddings.ok).toBe(true);
    expect(h.tick.lagging).toBe(false);
  });

  it('marks the channel dirty on a change, and only on a change', () => {
    const seen = vi.fn();
    const unsub = emitter.subscribe(HEALTH_CHANNEL, seen);

    // Refreshing with nothing new is silent (no traffic for the client).
    refreshHealth();
    expect(seen).not.toHaveBeenCalled();

    // A model reported missing moves the verdict.
    llmHealth.noteModelMissing('chat', 'gemma4');
    expect(refreshHealth()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(getHealthSnapshot().llm.status).toBe('down');

    // Same verdict again: silent.
    expect(refreshHealth()).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);

    // First good call clears it, and that is announced.
    llmHealth.noteChat(true, 'gemma4');
    expect(refreshHealth()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(2);
    unsub();
  });

  it('signature ignores jittering numbers', () => {
    const a = getHealthSnapshot();
    const b = { ...a, tick: { ...a.tick, lastTickOverrunMs: 1234, slowTicksLastMinute: 2 } };
    expect(healthSignature(b)).toBe(healthSignature(a));
  });
});
