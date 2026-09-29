import { describe, it, expect, vi, beforeEach } from 'vitest';
import { itemPhrase, itemCountPhrase, ITEM_REGISTRY } from '../../data/economyData';
import { initMemoryObserver, describeGiftForGiver } from '../memory/MemoryObserver';
import type { MemoryService } from '../memory/MemoryService';
import { simEvents } from '../simEvents';

/**
 * G9: inventory ids reached the prose the player and the agents read — "gave
 * food_raw to Rosa as a gift", "I produced 2 food_raw at work today", "was
 * caught stealing food_raw".
 */
describe('item prose', () => {
  it('names every registered item without its id', () => {
    for (const id of Object.keys(ITEM_REGISTRY)) {
      expect(itemPhrase(id)).not.toContain('_');
      expect(itemPhrase(id)).not.toBe(id);
      expect(itemCountPhrase(id, 3)).not.toContain('_');
    }
    expect(itemPhrase('food_raw')).toBe('some raw food');
    expect(itemPhrase('bread')).toBe('a loaf of bread');
  });

  it('counts in the right number', () => {
    expect(itemCountPhrase('bread', 1)).toBe('1 loaf of bread');
    expect(itemCountPhrase('bread', 2)).toBe('2 loaves of bread');
    expect(itemCountPhrase('drink', 4)).toBe('4 drinks');
  });

  it('falls back to readable words for an unknown id, and leaves prose alone', () => {
    expect(itemPhrase('fresh_flowers')).toBe('fresh flowers');
    expect(itemPhrase('$12')).toBe('$12');
    expect(itemPhrase('a drink')).toBe('a drink');
  });
});

describe('item memories', () => {
  const record = vi.fn();
  initMemoryObserver({ record } as unknown as MemoryService);
  beforeEach(() => record.mockClear());
  const lastLine = () => record.mock.calls.at(-1)?.[2] as string;

  it('production and theft name the item', () => {
    simEvents.emit('economy:production', { agentId: 5, item: 'food_raw', quantity: 2 });
    expect(lastLine()).toBe('I produced 2 portions of raw food at work today.');
    simEvents.emit('economy:theft_caught', { agentId: 5, item: 'bread', locationName: 'the bakery' });
    expect(lastLine()).toBe('I got caught stealing a loaf of bread from the bakery. Humiliating.');
  });

  it('a gift of an item names it', () => {
    expect(describeGiftForGiver('Ana', { giverId: 1, receiverId: 2, item: 'drink', reason: 'euphoric_gift' }))
      .toBe('I was in such a great mood that I gave Ana a drink, just because.');
  });
});
