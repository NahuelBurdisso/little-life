import { describe, it, expect, vi } from 'vitest';

let version = 0;
vi.mock('../../db', () => ({ getTableWriteVersion: () => version }));

import { emitter } from '../emitter';
import { RELATIONSHIPS_CHANNEL } from '../relationshipsChannel';

describe('relationships.all channel', () => {
  it('fires on a flush only after the relationships table was written', () => {
    const seen: number[] = [];
    const unsub = emitter.subscribe(RELATIONSHIPS_CHANNEL, (d) => seen.push(d.timestamp));
    emitter.flush(); // first flush: nothing seen yet → announces the current state
    const afterFirst = seen.length;
    emitter.markDirty('agents.all');
    emitter.flush();
    emitter.flush();
    // agents.all flushes (every tick) do not refetch the graph any more.
    expect(seen.length).toBe(afterFirst);
    version++;
    emitter.flush();
    expect(seen.length).toBe(afterFirst + 1);
    unsub();
  });
});
