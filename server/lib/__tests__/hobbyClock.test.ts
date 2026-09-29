import { describe, it, expect, afterEach } from 'vitest';
import { clearHobbySkills, getHobbyLevel, practiceHobby } from '../hobbyEngine';

// No such agent: the level-1 activity log looks the name up and skips it.
const AGENT = 987_654;

/** Practice `times` times, `gapMinutes` game minutes apart; returns the level after each. */
function practise(times: number, gapMinutes: number, start = 100): number[] {
  const levels: number[] = [];
  for (let i = 0; i < times; i++) levels.push(practiceHobby(AGENT, 'fish', start + i * gapMinutes));
  return levels;
}

describe('hobby consistency bonus runs on game minutes', () => {
  afterEach(() => clearHobbySkills());

  it('rewards practice within one game day (1440 game minutes)', () => {
    // Level 1 needs 10 XP: 1 for the first session, then 1.5 each.
    const levels = practise(7, 1439);
    expect(levels.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(levels[6]).toBe(1);
  });

  it('gives no bonus to sessions more than a game day apart', () => {
    const levels = practise(10, 1440);
    expect(levels[8]).toBe(0);
    expect(levels[9]).toBe(1);
    expect(getHobbyLevel(AGENT, 'fish')).toBe(1);
  });
});
