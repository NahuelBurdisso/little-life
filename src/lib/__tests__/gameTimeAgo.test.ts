import { describe, it, expect } from 'vitest';
import { formatGameMinute, gameTimeAgo } from '../formatters';

describe('gameTimeAgo', () => {
  const NOW = 12 * 1440 + 14 * 60; // day 12, 14:00

  it('counts game minutes, hours and whole game days', () => {
    expect(gameTimeAgo(NOW, NOW)).toBe('now');
    expect(gameTimeAgo(NOW - 25, NOW)).toBe('25m ago');
    expect(gameTimeAgo(NOW - 5 * 60, NOW)).toBe('5h ago');
    expect(gameTimeAgo(NOW - 2 * 1440, NOW)).toBe('2d ago');
    // 1.9 game days is still "1d": a beat from yesterday evening isn't two days old.
    expect(gameTimeAgo(NOW - Math.floor(1.9 * 1440), NOW)).toBe('1d ago');
  });

  it('never shows a negative age', () => {
    expect(gameTimeAgo(NOW + 30, NOW)).toBe('now');
  });
});

describe('formatGameMinute', () => {
  it('renders day and zero-padded clock', () => {
    expect(formatGameMinute(12 * 1440 + 9 * 60 + 5)).toBe('Day 12, 09:05');
  });
});
