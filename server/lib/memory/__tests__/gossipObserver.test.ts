import { describe, it, expect, vi, beforeEach } from 'vitest';
import { simEvents } from '../../simEvents';

// The observer looks the owner's name up to write "I" instead of their own name; a stub keeps
// this off the shared test DB.
const names = vi.hoisted(() => new Map<number, string>());
vi.mock('../../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ get: () => ({ name: names.get(currentAgent.id), age: 30 }) }),
      }),
    }),
  },
}));
const currentAgent = vi.hoisted(() => ({ id: 0 }));

import { initMemoryObserver } from '../MemoryObserver';
import type { MemoryService } from '../MemoryService';

/**
 * Gossip memories were broken text: spreadGossip emitted `otherName` while the observer read
 * `targetName` ("I told undefined that …"), smallMisdeeds' witnesses "were told by their own
 * eyes", and the teller's own name stayed in the third person. All of these lines are fed back
 * into LLM prompts as the agent's memory.
 */
describe('MemoryObserver — gossip memories', () => {
  const record = vi.fn();
  initMemoryObserver({ record } as unknown as MemoryService);
  beforeEach(() => {
    record.mockClear();
    names.clear();
    names.set(1, 'Ray Ortiz');
    names.set(2, 'Ana Ruiz');
  });
  const line = () => record.mock.calls.at(-1)?.[2] as string;

  // Exactly the payload gossip.ts spreadGossip emits.
  const shared = (content: string) => {
    currentAgent.id = 1;
    simEvents.emit('gossip:shared', { agentId: 1, targetId: 2, targetName: 'Ana Ruiz', content });
  };

  it('names the listener the teller told', () => {
    shared('Tom Park stole a loaf from Bram Cole.');
    expect(line()).not.toContain('undefined');
    expect(line()).toContain('Ana Ruiz');
    expect(line()).toMatch(/^I (told|shared with) Ana Ruiz that Tom Park stole a loaf from Bram Cole\.$/);
  });

  it('keeps the listener in the metadata', () => {
    shared('Tom Park stole a loaf from Bram Cole.');
    expect(record.mock.calls.at(-1)?.[3]).toMatchObject({ subtype: 'gossip', targetName: 'Ana Ruiz' });
  });

  it('writes the teller as "I" inside the fact they pass on', () => {
    shared('Ray Ortiz saw Bram Cole at a secret meeting.');
    expect(line()).toMatch(/that I saw Bram Cole at a secret meeting\.$/);
    expect(line()).not.toContain('Ray');
  });

  it('writes the owner as "me" / "my" in what they learned', () => {
    currentAgent.id = 2;
    simEvents.emit('gossip:learned', { agentId: 2, sourceId: 1, sourceName: 'Ray Ortiz', content: "Tom Park stole Ana Ruiz's bike." });
    expect(line()).toContain('stole my bike');
    expect(line()).not.toContain('undefined');
  });

  it('does not say a witness was told by "their own eyes"', () => {
    currentAgent.id = 2;
    simEvents.emit('gossip:learned', { agentId: 2, sourceName: 'their own eyes', witnessed: true, content: 'Tom Park stole a loaf.' });
    expect(line()).not.toContain('told me');
    expect(line()).not.toContain('their own eyes');
    expect(line()).toMatch(/^I saw (with my own eyes|for myself) that Tom Park stole a loaf\.$/);
  });

  it('still says who told a listener when the fact was not witnessed', () => {
    currentAgent.id = 2;
    simEvents.emit('gossip:learned', { agentId: 2, sourceName: 'Ray Ortiz', content: 'Tom Park stole a loaf.' });
    expect(line()).toMatch(/Ray Ortiz/);
  });

  it('falls back to the raw fact when the owner cannot be found', () => {
    names.delete(1);
    shared('Ray Ortiz saw Bram Cole.');
    expect(line()).toContain('Ray Ortiz saw Bram Cole');
  });
});
