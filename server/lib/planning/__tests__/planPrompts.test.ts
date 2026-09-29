import { describe, it, expect } from 'vitest';
import { buildDailyPlanPrompt, buildReplanPrompt, hungerLabel } from '../planPrompts';
import type { PersonalityProfile } from '../../personality';

/**
 * Hunger is a fullness meter (100 = fed). Both plan prompts labelled > 70
 * "very hungry" and a starving agent "(satisfied)".
 */
const personality: PersonalityProfile = {
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50,
};

describe('hunger labels in plan prompts', () => {
  it('reads 100 as fed and 0 as starving', () => {
    expect(hungerLabel(95)).toBe('satisfied');
    expect(hungerLabel(45)).toBe('peckish');
    expect(hungerLabel(5)).toBe('very hungry');
  });

  it('the daily plan prompt calls a starving agent very hungry', () => {
    const { system, user } = buildDailyPlanPrompt({
      name: 'A', age: 30, traits: [], personality,
      needs: { hunger: 5, energy: 80, social: 80, mood: 50, stress: 20 },
      home: 'Home', workplace: null, workStart: 9, workEnd: 17, wakeTime: 7, sleepTime: 22,
      goals: [], reflections: [], yesterdayPlan: null, dayNumber: 1, validLocations: ['Home'],
    });
    expect(system + user).toContain('Hunger: 5/100 (very hungry)');
  });

  it('the replan prompt calls a fed agent satisfied', () => {
    const { system, user } = buildReplanPrompt({
      name: 'A', personality, traits: [], eventDescription: 'x', remainingBlocks: [],
      needs: { hunger: 90, energy: 80, social: 80 }, currentHour: 12, sleepTime: 22, validLocations: ['Home'],
    } as any);
    expect(system + user).toContain('Hunger: 90/100 (satisfied)');
  });
});
