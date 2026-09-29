import { describe, it, expect } from 'vitest';
import { isFood, foodCount } from '../economyEngine';
import { ITEM_REGISTRY } from '../../data/economyData';

/**
 * states.ts decided "has no food" (in_debt trigger, alcoholic rock bottom) from
 * a hardcoded ['food_raw', 'food_prepared'] list, so an agent holding bread
 * counted as having none. Food is whatever ITEM_REGISTRY says satisfies hunger.
 */
describe('isFood / foodCount', () => {
  it('every hunger-satisfying item is food, bread included; drinks and medicine are not', () => {
    for (const item of Object.values(ITEM_REGISTRY)) {
      expect(isFood(item.id)).toBe(item.satisfies?.need === 'hunger');
    }
    expect(isFood('bread')).toBe(true);
    expect(isFood('drink')).toBe(false);
    expect(isFood('medicine')).toBe(false);
    expect(isFood('no_such_item')).toBe(false);
  });

  it('counts all food units together', () => {
    const inv = [
      { itemId: 'bread', quantity: 2 },
      { itemId: 'food_raw', quantity: 1 },
      { itemId: 'drink', quantity: 5 },
    ];
    expect(foodCount(inv)).toBe(3);
    expect(foodCount([{ itemId: 'bread', quantity: 1 }])).toBe(1);
    expect(foodCount([{ itemId: 'drink', quantity: 1 }])).toBe(0);
  });
});
