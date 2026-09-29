import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initMemoryObserver } from '../MemoryObserver';
import type { MemoryService } from '../MemoryService';
import { simEvents } from '../../simEvents';

/**
 * G9: the world-event memory spliced "<name>: <description>" into "There's
 * {event} happening in town." — "There's Heavy Storm: A heavy storm is
 * battering the town. Best stay indoors! happening in town."
 */
describe('MemoryObserver — world events', () => {
  const record = vi.fn();
  initMemoryObserver({ record } as unknown as MemoryService);
  beforeEach(() => record.mockClear());
  const line = () => record.mock.calls.at(-1)?.[2] as string;

  it('names the event and keeps its description a sentence of its own', () => {
    simEvents.emit('event:world', {
      agentId: 3, name: 'Heavy Storm', description: 'A heavy storm is battering the town. Best stay indoors!',
    });
    expect(line()).toMatch(/Heavy Storm\. A heavy storm is battering the town\. Best stay indoors!$/);
    expect(line()).not.toContain('happening in town');
    expect(line()).not.toContain(': A heavy');
  });

  it('ends a player-written description that has no full stop', () => {
    simEvents.emit('event:world', { agentId: 3, name: 'Barn Dance', description: 'Everyone to the farm tonight' });
    expect(line()).toMatch(/Barn Dance\. Everyone to the farm tonight\.$/);
  });

  it('keeps the event name in the metadata', () => {
    simEvents.emit('event:world', { agentId: 3, name: 'Market Day', description: 'Stalls everywhere.' });
    expect(record.mock.calls.at(-1)?.[3]).toMatchObject({ subtype: 'event', event: 'Market Day' });
  });
});
