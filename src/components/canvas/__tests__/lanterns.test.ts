import { describe, it, expect } from 'vitest';
import { carriesLantern } from '../lanterns';

describe('carriesLantern', () => {
  it('lights agents on the street (no location)', () => {
    expect(carriesLantern(null)).toBe(true);
  });

  it('lights agents in open areas, including the derived open-ground types', () => {
    for (const t of ['town_square', 'park', 'alley', 'mainstreet', 'market_square', 'farmyard']) {
      expect(carriesLantern(t), t).toBe(true);
    }
  });

  it('does not light agents inside enclosed buildings', () => {
    for (const t of ['home', 'tavern', 'shop', 'clinic', 'bakery', 'workshop', 'prison']) {
      expect(carriesLantern(t), t).toBe(false);
    }
  });

  it('treats a location missing from the client list as indoors', () => {
    expect(carriesLantern(undefined)).toBe(false);
  });
});
