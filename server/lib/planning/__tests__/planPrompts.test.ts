import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildDailyPlanPrompt, buildDecompositionPrompt, buildReplanPrompt, describeNeeds } from '../planPrompts';
import type { PersonalityProfile } from '../../personality';
import { maturityDirective } from '../../../ai/contentRating';
import { TOWN_SETTING } from '../../../ai/setting';

// The `adultContent` rule, flipped per test without a world row.
const rules = vi.hoisted(() => ({ adult: false }));
vi.mock('../../worldRules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worldRules')>()),
  isAdultContent: () => rules.adult,
}));
beforeEach(() => { rules.adult = false; });

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
    expect(describeNeeds({ hunger: 95 })).toBe('hunger: well fed');
    expect(describeNeeds({ hunger: 45 })).toBe('hunger: could eat');
    expect(describeNeeds({ hunger: 5 })).toBe('hunger: starving');
  });

  it('the daily plan prompt calls a starving agent starving', () => {
    const { system, user } = buildDailyPlanPrompt({
      name: 'A', age: 30, traits: [], personality,
      needs: { hunger: 5, energy: 80, social: 80, mood: 50, stress: 20 },
      home: 'Home', workplace: null, workStart: 9, workEnd: 17, wakeTime: 7, sleepTime: 22,
      goals: [], reflections: [], yesterdayPlan: null, dayNumber: 1, validLocations: ['Home'],
    });
    expect(system + user).toContain('hunger: starving');
  });

  it('the replan prompt calls a fed agent well fed', () => {
    const { system, user } = buildReplanPrompt({
      name: 'A', age: 30, personality, traits: [], eventDescription: 'x', remainingBlocks: [],
      needs: { hunger: 90, energy: 80, social: 80 }, currentHour: 12, sleepTime: 22, validLocations: ['Home'],
    });
    expect(system + user).toContain('hunger: well fed');
  });
});

/**
 * The maturity line rides in every plan prompt right after the setting, once,
 * and follows the `adultContent` rule (a minor's daily plan stays chaste).
 */
describe('maturity directive in plan prompts', () => {
  const adultText = maturityDirective(true);
  const chasteText = maturityDirective(false);
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  const needs = { hunger: 50, energy: 80, social: 80, mood: 50, stress: 20 };

  const daily = (age = 30) => buildDailyPlanPrompt({
    name: 'A', age, traits: [], personality, needs,
    home: 'Home', workplace: null, workStart: 9, workEnd: 17, wakeTime: 7, sleepTime: 22,
    goals: [], reflections: [], yesterdayPlan: null, dayNumber: 1, validLocations: ['Home'],
  }).system;
  const decomposition = (age = 30) => buildDecompositionPrompt({
    name: 'A', age, personality, traits: [], blockAction: 'work', locationHint: 'Home',
    needs, startHour: 9, endHour: 11, validLocations: ['Home'], validAgents: [],
  }).system;
  const replan = (age = 30) => buildReplanPrompt({
    name: 'A', age, personality, traits: [], eventDescription: 'x', remainingBlocks: [],
    needs, currentHour: 12, sleepTime: 22, validLocations: ['Home'],
  }).system;

  it('rule off: the chaste line, once, in daily plan, decomposition and revise', () => {
    rules.adult = false;
    for (const system of [daily(), decomposition(), replan()]) {
      expect(count(system, chasteText)).toBe(1);
      expect(system).toContain(`${TOWN_SETTING} ${chasteText}`);
      expect(system).not.toContain(adultText);
    }
  });

  it('rule on: the adult line, once', () => {
    rules.adult = true;
    for (const system of [daily(), decomposition(), replan()]) {
      expect(count(system, adultText)).toBe(1);
      expect(system).not.toContain(chasteText);
    }
  });

  it('a minor\'s daily plan stays chaste even with the rule on', () => {
    rules.adult = true;
    expect(daily(15)).toContain(chasteText);
    expect(daily(15)).not.toContain(adultText);
  });

  it('decomposition and revise prompts for a minor stay chaste too, and a missing age fails closed', () => {
    rules.adult = true;
    for (const system of [decomposition(15), replan(15), decomposition(17), replan(17)]) {
      expect(system).toContain(chasteText);
      expect(system).not.toContain(adultText);
    }
    for (const system of [decomposition(18), replan(18)]) expect(system).toContain(adultText);
    expect(decomposition(null as never)).toContain(chasteText);
  });
});
