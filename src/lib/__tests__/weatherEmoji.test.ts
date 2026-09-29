import { describe, it, expect } from 'vitest';
import { isNightHour, weatherEmoji } from '../formatters';

describe('weatherEmoji', () => {
  it('shows the sun by day and a moon at night for clear skies', () => {
    expect(weatherEmoji('sunny', 14)).toBe('☀️');
    expect(weatherEmoji('sunny', 21)).toBe('🌙');
    expect(weatherEmoji('sunny', 3)).toBe('🌙');
  });

  it('keeps the sun when there is no time of day (weather choice buttons)', () => {
    expect(weatherEmoji('sunny')).toBe('☀️');
  });

  it('leaves weather that hides the sky alone at night', () => {
    expect(weatherEmoji('rainy', 22)).toBe(weatherEmoji('rainy', 12));
    expect(weatherEmoji('stormy', 22)).toBe(weatherEmoji('stormy', 12));
  });

  it('matches the server night (20:00-05:00)', () => {
    expect(isNightHour(19)).toBe(false);
    expect(isNightHour(20)).toBe(true);
    expect(isNightHour(4)).toBe(true);
    expect(isNightHour(5)).toBe(false);
  });
});
