import { describe, it, expect, vi } from 'vitest';
import { PrioritySemaphore } from '../llmSemaphore';

async function fill(sem: PrioritySemaphore, n: number) {
  const releases: Array<() => void> = [];
  for (let i = 0; i < n; i++) releases.push(await sem.acquire('normal'));
  return releases;
}

describe('PrioritySemaphore', () => {
  it('serves a newer higher-priority waiter before an older low one', async () => {
    const sem = new PrioritySemaphore(2);
    const held = await fill(sem, 2);
    const order: string[] = [];

    void sem.acquire('low').then(() => order.push('low'));
    void sem.acquire('normal').then(() => order.push('normal'));

    held[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['normal']);
  });

  it('keeps strict priority however long a low waiter has queued', async () => {
    // A review asked for aging to be removed from the chat pool: it let goal
    // review backlogs jump ahead of conversation turns during day-change spikes.
    vi.useFakeTimers();
    try {
      const sem = new PrioritySemaphore(1);
      const [held] = await fill(sem, 1);
      const order: string[] = [];

      void sem.acquire('low').then(() => order.push('low'));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      void sem.acquire('normal').then(() => order.push('normal'));

      held();
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(['normal']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a second release of the same slot', async () => {
    const sem = new PrioritySemaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.stats().active).toBe(0);
  });
});

describe('chat and embedding pools', () => {
  it('embedding slots never consume chat slots', async () => {
    vi.resetModules();
    const { acquireLLMSlot, acquireEmbeddingSlot, getLLMStats } = await import('../llmSemaphore');

    // Saturate the embedding pool and queue one more on it.
    const embedHeld = [
      await acquireEmbeddingSlot('low'),
      await acquireEmbeddingSlot('low'),
      await acquireEmbeddingSlot('low'),
    ];
    let queuedEmbed = false;
    void acquireEmbeddingSlot('normal').then(() => { queuedEmbed = true; });

    expect(getLLMStats().active).toBe(0);

    // Every chat slot (LLM_PARALLEL, default 4) is still granted immediately —
    // three to dialogue (its cap) and one to planning.
    const chat = await Promise.race([
      Promise.all([...Array.from({ length: 3 }, () => acquireLLMSlot('critical')), acquireLLMSlot('normal')]),
      new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 50)),
    ]);
    expect(chat).not.toBe('blocked');
    expect(getLLMStats()).toMatchObject({ active: 4, waiting: 0 });
    expect(queuedEmbed).toBe(false);

    // Freeing chat slots does not wake embedding waiters, and vice versa.
    for (const r of chat as Array<() => void>) r();
    await Promise.resolve();
    expect(queuedEmbed).toBe(false);
    embedHeld[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(queuedEmbed).toBe(true);
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PrioritySemaphore — slots reserved for critical callers', () => {
  it('keeps the reserved slot free of normal/low work', async () => {
    const sem = new PrioritySemaphore(3, 1);
    const held = await fill(sem, 2);
    let lowGot = false;
    void sem.acquire('low').then(() => { lowGot = true; });
    await flush();
    expect(lowGot).toBe(false);
    expect(sem.stats().active).toBe(2);

    // A critical caller still gets in immediately.
    const crit = await sem.acquire('critical');
    expect(sem.stats().active).toBe(3);

    // Freeing the critical slot does not hand it to the waiting low caller…
    crit();
    await flush();
    expect(lowGot).toBe(false);
    // …freeing a normal one does.
    held[0]();
    await flush();
    expect(lowGot).toBe(true);
  });

  it('serves a critical waiter first when the pool is full', async () => {
    const sem = new PrioritySemaphore(2, 1);
    const [n] = await fill(sem, 1);
    const c = await sem.acquire('critical');
    const order: string[] = [];
    void sem.acquire('normal').then(() => order.push('normal'));
    void sem.acquire('critical').then(() => order.push('critical'));
    c();
    await flush();
    expect(order).toEqual(['critical']);
    n();
    await flush();
    expect(order).toEqual(['critical', 'normal']);
  });
});

describe('PrioritySemaphore — critical callers cannot starve the rest', () => {
  it('leaves one slot to normal work however many turns queue', async () => {
    const sem = new PrioritySemaphore(4, 1);
    const turns = await Promise.all([sem.acquire('critical'), sem.acquire('critical'), sem.acquire('critical')]);
    let fourth = false;
    void sem.acquire('critical').then(() => { fourth = true; });
    await flush();
    expect(fourth).toBe(false);
    const plan = await sem.acquire('normal');
    expect(sem.stats().active).toBe(4);
    plan();
    turns[0]();
    await flush();
    expect(fourth).toBe(true);
  });
});
