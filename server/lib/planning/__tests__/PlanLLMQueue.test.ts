import { describe, it, expect, vi } from 'vitest';
import { PlanLLMQueue, replanPriority } from '../PlanLLMQueue';
import { clearSpotlight, setSpotlight } from '../../spotlight';

/** A job whose completion the test controls. */
function deferredJob() {
  let release!: () => void;
  let fail!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const run = vi.fn(() => done);
  return { run, release, fail };
}

/** Let the queue's promise chain advance past a settled job. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PlanLLMQueue dedupe', () => {
  it('drops a second keyed request while the first is in flight', async () => {
    const q = new PlanLLMQueue();
    const first = deferredJob();
    const second = vi.fn(async () => {});

    expect(q.enqueue(1, first.run, 'generate')).toBe(true);
    expect(q.enqueue(1, second, 'generate')).toBe(false);
    expect(q.enqueue(1, second, 'generate')).toBe(false);
    expect(q.isPending(1, 'generate')).toBe(true);

    first.release();
    await flush();

    expect(first.run).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(q.isPending(1, 'generate')).toBe(false);
  });

  it('drops a keyed request that is still waiting behind another job', async () => {
    const q = new PlanLLMQueue();
    const blocker = deferredJob();
    const plan = vi.fn(async () => {});

    q.enqueue(1, blocker.run); // e.g. a decomposition, unkeyed
    expect(q.enqueue(1, plan, 'generate')).toBe(true);
    expect(q.enqueue(1, plan, 'generate')).toBe(false);

    blocker.release();
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    await flush();
    expect(q.isPending(1, 'generate')).toBe(false);
  });

  it('accepts the key again once the job settles, even if it failed', async () => {
    const q = new PlanLLMQueue();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = deferredJob();

    q.enqueue(1, failing.run, 'generate');
    failing.fail(new Error('ollama down'));
    await flush();

    expect(q.isPending(1, 'generate')).toBe(false);
    expect(q.enqueue(1, async () => {}, 'generate')).toBe(true);
    warn.mockRestore();
  });

  it('dedupes per agent, not globally', () => {
    const q = new PlanLLMQueue();
    expect(q.enqueue(1, deferredJob().run, 'generate')).toBe(true);
    expect(q.enqueue(2, deferredJob().run, 'generate')).toBe(true);
  });

  it('never dedupes unkeyed jobs', async () => {
    const q = new PlanLLMQueue();
    const job = vi.fn(async () => {});
    expect(q.enqueue(1, job)).toBe(true);
    expect(q.enqueue(1, job)).toBe(true);
    // Jobs are spaced 300 ms apart within one agent's queue.
    await vi.waitFor(() => expect(job).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it('releases the keys of jobs dropped by clear', () => {
    const q = new PlanLLMQueue();
    q.enqueue(1, deferredJob().run); // in flight, keeps the queue busy
    q.enqueue(1, async () => {}, 'generate'); // queued behind it
    q.clear();
    expect(q.isPending(1, 'generate')).toBe(false);
    expect(q.enqueue(1, async () => {}, 'generate')).toBe(true);

    q.enqueue(2, deferredJob().run, 'generate'); // in flight when the world is replaced
    q.clear();
    expect(q.isPending(2, 'generate')).toBe(false);
    expect(q.enqueue(2, async () => {}, 'generate')).toBe(true);
  });

  it('does not let a job from before clear() release a key reserved after it', async () => {
    const q = new PlanLLMQueue();
    const old = deferredJob();
    q.enqueue(1, old.run, 'generate');
    q.clear();
    const fresh = deferredJob();
    q.enqueue(1, fresh.run, 'generate'); // queued behind the old in-flight job

    old.release();
    await flush();
    expect(q.isPending(1, 'generate')).toBe(true);
    fresh.release();
  });
});

describe('replanPriority', () => {
  it('an unwatched, non-dramatic replan waits at low priority', () => {
    clearSpotlight();
    expect(replanPriority({ agentId: 3, isDramatic: false })).toBe('low');
  });

  it('a dramatic replan keeps normal priority on or off screen', () => {
    clearSpotlight();
    expect(replanPriority({ agentId: 3, isDramatic: true })).toBe('normal');
  });

  it('a watched resident keeps normal priority until the spotlight expires', () => {
    setSpotlight([3], 1_000);
    expect(replanPriority({ agentId: 3, isDramatic: false }, 2_000)).toBe('normal');
    expect(replanPriority({ agentId: 4, isDramatic: false }, 2_000)).toBe('low');
    expect(replanPriority({ agentId: 3, isDramatic: false }, 1_000 + 60_000)).toBe('low');
    clearSpotlight();
  });
});
