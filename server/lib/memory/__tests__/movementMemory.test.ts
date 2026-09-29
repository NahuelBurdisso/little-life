import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initMemoryObserver, clearPerceptionDedup } from '../MemoryObserver';
import type { MemoryService } from '../MemoryService';
import { simEvents } from '../../simEvents';

/**
 * B21 made `agent:arrived`/`agent:departed` fire for the first time. Every walk
 * that changes place is one of each, a dozen or more a day per agent, and each
 * stored memory costs an embedding and feeds the reflection trigger. Only the
 * arrival is kept (it says where the agent went; the departure adds nothing the
 * previous arrival didn't), at low importance, and once per place per window.
 */
describe('MemoryObserver — movement', () => {
  const record = vi.fn();
  initMemoryObserver({ record } as unknown as MemoryService);

  beforeEach(() => {
    record.mockClear();
    clearPerceptionDedup();
  });

  const movementCalls = () => record.mock.calls.filter((c) => (c[3] as { subtype?: string })?.subtype === 'movement');

  it('remembers an arrival once, at low importance', () => {
    simEvents.emit('agent:arrived', { agentId: 41, locationName: 'The Rusty Anchor' });
    simEvents.emit('agent:arrived', { agentId: 41, locationName: 'The Rusty Anchor' });
    const calls = movementCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toContain('The Rusty Anchor');
    expect(calls[0][5]).toBeLessThanOrEqual(2);
  });

  it('keeps arrivals at different places', () => {
    simEvents.emit('agent:arrived', { agentId: 41, locationName: 'The Rusty Anchor' });
    simEvents.emit('agent:arrived', { agentId: 41, locationName: 'Town Square' });
    simEvents.emit('agent:arrived', { agentId: 42, locationName: 'The Rusty Anchor' });
    expect(movementCalls()).toHaveLength(3);
  });

  it('remembers work output once per item per window, not every tick (playtest #3)', () => {
    const production = () => record.mock.calls.filter((c) => String(c[2]).startsWith('I produced'));
    for (let i = 0; i < 5; i++) simEvents.emit('economy:production', { agentId: 41, item: 'food_raw', quantity: 1 });
    expect(production()).toHaveLength(1);
    simEvents.emit('economy:production', { agentId: 41, item: 'bread', quantity: 2 });
    simEvents.emit('economy:production', { agentId: 42, item: 'food_raw', quantity: 1 });
    expect(production()).toHaveLength(3);
  });

  it('does not store departures', () => {
    simEvents.emit('agent:departed', { agentId: 41, locationName: 'Home' });
    expect(movementCalls()).toHaveLength(0);
  });
});
