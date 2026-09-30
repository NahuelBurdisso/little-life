import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '../../db';
import { worldState } from '../../db/schema';
import { maturityDirective } from '../contentRating';
import { setRuleOverrides } from '../../lib/worldRules';
import { buildGazettePrompt } from '../../lib/gazette';
import { buildAmbitionGenerationPrompt, buildGoalReviewPrompt, buildPivotPrompt } from '../../lib/goals/goalPrompts';
import { buildQuestionPrompt, buildSynthesisPrompt } from '../../lib/memory/reflectionPrompts';
import type { PersonalityProfile } from '../../lib/personality';

/**
 * Every prompt that turns what happened in town into new text carries the maturity line for the rule as
 * it stands (contentRating.ts): the paper, the goal review, the pivot, the ambition, and the reflection
 * that turns a memory of a night into an insight. Without it the model drifts frank on its own once a
 * memory says two people spent the night together; with the rule off it must be told romance stays chaste.
 */

const personality: PersonalityProfile = {
  honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
  curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
};

const prompts = (): Array<[string, string]> => [
  ['gazette', buildGazettePrompt({ items: ['Ada and Bruno wed'], events: [], arcs: [] }, 3, 'spring', 'sunny').system],
  ['goal review', buildGoalReviewPrompt({
    name: 'Ada', personality, traits: ['kind'], ambition: null, activeGoals: [], recentMemories: ['I kissed Bruno.'],
    relationshipHighlights: [], money: 10, job: null, dayNumber: 3, openSlots: 1, otherAgents: ['Bruno'],
  } as never).system],
  ['pivot', buildPivotPrompt({
    name: 'Ada', personality, goalDescription: 'win Bruno over', strategy: 'flirt', progress: 0.4, daysActive: 3, recentMemories: [],
  } as never).system],
  ['ambition', buildAmbitionGenerationPrompt({
    name: 'Ada', personality, traits: ['kind'], recentMemories: [], money: 10, job: null, relationshipHighlights: [],
  } as never).system],
  ['reflection questions', buildQuestionPrompt({
    name: 'Ada', age: 30, traits: ['kind'], personality, recentMemories: [{ description: 'I spent the night with Bruno.', importance: 9 }],
  }).system],
  ['reflection insights', buildSynthesisPrompt({
    name: 'Ada', personality, traits: ['kind'], questions: ['What now?'], evidence: [{ lineNum: 1, description: 'I spent the night with Bruno.' }],
  }).system],
];

describe('the maturity line reaches every story prompt', () => {
  beforeAll(() => {
    if (db.select().from(worldState).get()) return;
    db.insert(worldState).values({
      time: { day: 5, hour: 12, minute: 0, totalTicks: 7200, seasonDay: 5, season: 'spring' }, day_phase: 'afternoon',
      weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true, last_tick_completed: 0,
      current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30,
      collision_grid: '',
    }).run();
  });
  afterEach(() => setRuleOverrides({ adultContent: false }));

  it('with the rule on: adults, off-stage, never a minor', () => {
    setRuleOverrides({ adultContent: true });
    for (const [name, system] of prompts()) {
      expect(system, name).toContain(maturityDirective(true));
      expect(system, name).not.toContain(maturityDirective(false));
    }
  });

  it('with the rule off: chaste', () => {
    setRuleOverrides({ adultContent: false });
    for (const [name, system] of prompts()) {
      expect(system, name).toContain(maturityDirective(false));
      expect(system, name).not.toContain(maturityDirective(true));
    }
  });
});

describe('a child\'s reflection never gets the adult tone', () => {
  it('question and insight prompts fall back to the chaste line for anyone under 18, whatever the rule says', () => {
    setRuleOverrides({ adultContent: true });
    const q = buildQuestionPrompt({ name: 'Kid', age: 12, traits: [], personality, recentMemories: [{ description: 'I ran home.', importance: 3 }] }).system;
    const s = buildSynthesisPrompt({
      name: 'Kid', age: 12, personality, traits: [], questions: ['Why?'], evidence: [{ lineNum: 1, description: 'I ran home.' }],
    }).system;
    for (const system of [q, s]) {
      expect(system).toContain(maturityDirective(false));
      expect(system).not.toContain(maturityDirective(true));
    }
    setRuleOverrides({ adultContent: false });
  });
});
