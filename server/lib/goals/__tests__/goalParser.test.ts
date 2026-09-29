import { describe, it, expect } from 'vitest';
import {
  parseGoalReview,
  parsePivotResult,
  parseAmbitionGeneration,
} from '../goalParser';

describe('parseGoalReview', () => {
  it('parses valid JSON with keep ambition', () => {
    const raw = JSON.stringify({
      ambition: 'keep',
      reviews: [{ goal_id: 1, action: 'continue', reason: 'making progress' }],
      new_goals: [{ description: 'Save money', target_agent: null, category_hint: 'economic', strategy: 'work extra', priority: 0.6 }],
    });
    const result = parseGoalReview(raw);
    expect(result).not.toBeNull();
    expect(result!.ambition).toBe('keep');
    expect(result!.reviews).toHaveLength(1);
    expect(result!.reviews[0].action).toBe('continue');
    expect(result!.new_goals).toHaveLength(1);
    expect(result!.new_goals[0].priority).toBe(0.6);
  });

  it('parses ambition shift', () => {
    const raw = JSON.stringify({
      ambition: { shift: 'Find inner peace', category: 'freedom', reason: 'tired of chasing money' },
      reviews: [],
      new_goals: [],
    });
    const result = parseGoalReview(raw);
    expect(result).not.toBeNull();
    expect(result!.ambition).not.toBe('keep');
    const shift = result!.ambition as { shift: string; category: string; reason: string };
    expect(shift.shift).toBe('Find inner peace');
    expect(shift.category).toBe('freedom');
  });

  it('handles malformed JSON gracefully', () => {
    expect(parseGoalReview('not json at all')).toBeNull();
    expect(parseGoalReview('{ broken')).toBeNull();
    expect(parseGoalReview('')).toBeNull();
  });

  it('handles JSON wrapped in markdown code block', () => {
    const raw = '```json\n{"ambition":"keep","reviews":[],"new_goals":[]}\n```';
    const result = parseGoalReview(raw);
    expect(result).not.toBeNull();
    expect(result!.ambition).toBe('keep');
  });

  it('clamps priority to 0-1 range', () => {
    const raw = JSON.stringify({
      ambition: 'keep',
      reviews: [],
      new_goals: [{ description: 'Test', target_agent: null, category_hint: 'social', strategy: 'try', priority: 1.5 }],
    });
    const result = parseGoalReview(raw);
    expect(result!.new_goals[0].priority).toBe(1.0);
  });

  it('defaults missing priority to 0.5', () => {
    const raw = JSON.stringify({
      ambition: 'keep',
      reviews: [],
      new_goals: [{ description: 'Test', target_agent: null, category_hint: 'social', strategy: 'try' }],
    });
    const result = parseGoalReview(raw);
    expect(result!.new_goals[0].priority).toBe(0.5);
  });

  it('filters invalid review actions', () => {
    const raw = JSON.stringify({
      ambition: 'keep',
      reviews: [
        { goal_id: 1, action: 'continue', reason: 'ok' },
        { goal_id: 2, action: 'invalid_action', reason: 'bad' },
        { goal_id: 3, action: 'abandon', reason: 'done' },
      ],
      new_goals: [],
    });
    const result = parseGoalReview(raw);
    expect(result!.reviews).toHaveLength(2);
  });
});

describe('parsePivotResult', () => {
  it('parses valid pivot', () => {
    const raw = JSON.stringify({ new_strategy: 'Try a different approach', new_category_hint: 'social' });
    const result = parsePivotResult(raw);
    expect(result).not.toBeNull();
    expect(result!.new_strategy).toBe('Try a different approach');
  });

  it('returns null for missing strategy', () => {
    expect(parsePivotResult(JSON.stringify({ new_category_hint: 'social' }))).toBeNull();
    expect(parsePivotResult('garbage')).toBeNull();
  });
});

describe('parseAmbitionGeneration', () => {
  it('parses valid ambition', () => {
    const raw = JSON.stringify({ description: 'Become wealthy', category: 'wealth', reason: 'grew up poor' });
    const result = parseAmbitionGeneration(raw);
    expect(result).not.toBeNull();
    expect(result!.description).toBe('Become wealthy');
  });

  it('returns null for missing fields', () => {
    expect(parseAmbitionGeneration(JSON.stringify({ description: 'Only desc' }))).toBeNull();
  });
});

describe('parseGoalReview — tolerant reading', () => {
  it('accepts a sentence around the object and "ID:12"-style goal ids', () => {
    const raw = 'Here is my review: {"ambition":"keep","reviews":[{"goal_id":"ID:12","action":"continue","reason":"going well"}],"new_goals":[]} Hope that helps.';
    const r = parseGoalReview(raw);
    expect(r?.ambition).toBe('keep');
    expect(r?.reviews).toEqual([{ goal_id: 12, action: 'continue', reason: 'going well', new_strategy: undefined }]);
  });
});
