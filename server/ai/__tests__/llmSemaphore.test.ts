import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The semaphore is module-level state, so each test gets a fresh copy.
 * MAX_CONCURRENT is 8: fill it, then watch who the freed slots go to.
 */
async function freshSemaphore() {
  vi.resetModules();
  return import('../llmSemaphore');
}

async function fill(acquire: (p: 'critical' | 'normal' | 'low') => Promise<() => void>) {
  const releases: Array<() => void> = [];
  for (let i = 0; i < 8; i++) releases.push(await acquire('normal'));
  return releases;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('llmSemaphore priority', () => {
  it('serves a newer higher-priority waiter before an older low one', async () => {
    const { acquireLLMSlot } = await freshSemaphore();
    const held = await fill(acquireLLMSlot);
    const order: string[] = [];

    void acquireLLMSlot('low').then(() => order.push('low'));
    void acquireLLMSlot('normal').then(() => order.push('normal'));

    held[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['normal']);
  });

  it('ages a starving low waiter past fresh normal traffic', async () => {
    // B12: memory-write embeddings are `low`; under sustained load strict
    // priority would hold them forever (and MemoryService's flush with them).
    const { acquireLLMSlot, PRIORITY_AGING_MS } = await freshSemaphore();
    const held = await fill(acquireLLMSlot);
    const order: string[] = [];

    void acquireLLMSlot('low').then(() => order.push('low'));
    await vi.advanceTimersByTimeAsync(PRIORITY_AGING_MS + 1); // low is now effectively normal
    void acquireLLMSlot('normal').then(() => order.push('fresh normal'));

    held[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['low']); // tie on level, earlier arrival wins
  });

  it('eventually lets an aged low waiter beat fresh critical traffic', async () => {
    const { acquireLLMSlot, PRIORITY_AGING_MS } = await freshSemaphore();
    const held = await fill(acquireLLMSlot);
    const order: string[] = [];

    void acquireLLMSlot('low').then(() => order.push('low'));
    await vi.advanceTimersByTimeAsync(2 * PRIORITY_AGING_MS + 1);
    void acquireLLMSlot('critical').then(() => order.push('critical'));

    held[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['low']);

    held[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['low', 'critical']);
  });
});
