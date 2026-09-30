import { describe, it, expect } from 'vitest';
import { isNewcomer, NEWCOMER_DAYS } from '../newcomers';

describe('isNewcomer', () => {
  it('never counts a founder (created with the world)', () => {
    expect(isNewcomer(0, 10)).toBe(false);
    expect(isNewcomer(null, 10)).toBe(false);
  });

  it('counts a mid-game arrival for its first days only', () => {
    const arrived = 5000;
    expect(isNewcomer(arrived, arrived)).toBe(true);
    expect(isNewcomer(arrived, arrived + NEWCOMER_DAYS * 1440 - 1)).toBe(true);
    expect(isNewcomer(arrived, arrived + NEWCOMER_DAYS * 1440)).toBe(false);
  });

  it('does not trust a stamp from the future', () => {
    expect(isNewcomer(9000, 100)).toBe(false);
  });
});
