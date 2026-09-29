import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkDeathTriggers } from '../lifeEventsEngine';

const healthy = { mood: 70, hunger: 70, energy: 70 };
const DAY_200 = 200 * 1440;

function deathAt(age: number) {
  return checkDeathTriggers(
    { id: 9001, name: 'Elder', age }, DAY_200, [], healthy, '', 'idle', false, 'spring',
  );
}

describe('old-age death', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the sim age from agents.age, not age + game days', () => {
    // Every roll would succeed; only the age gate stands in the way. The old
    // simAge added the game day (200) to the age, so a 30-year-old counted as 230.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(deathAt(30)).not.toBe('old_age');
  });

  it('still applies past 80', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(deathAt(85)).toBe('old_age');
  });
});
