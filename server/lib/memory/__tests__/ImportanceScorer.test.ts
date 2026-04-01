import { describe, it, expect } from 'vitest';
import { getImportance, getTypePriority } from '../ImportanceScorer';

describe('getImportance', () => {
  it('returns 2 for moved_to_location', () => {
    expect(getImportance('moved_to_location')).toBe(2);
  });

  it('returns 1 for idle_at_location', () => {
    expect(getImportance('idle_at_location')).toBe(1);
  });

  it('returns 5 for started_conversation', () => {
    expect(getImportance('started_conversation')).toBe(5);
  });

  it('returns 8 for created_secret', () => {
    expect(getImportance('created_secret')).toBe(8);
  });

  it('returns 8 for reflection', () => {
    expect(getImportance('reflection')).toBe(8);
  });

  it('returns 7 for relationship_changed', () => {
    expect(getImportance('relationship_changed')).toBe(7);
  });

  it('returns 7 for interaction_completed', () => {
    expect(getImportance('interaction_completed')).toBe(7);
  });

  it('returns 6 for need_critical', () => {
    expect(getImportance('need_critical')).toBe(6);
  });

  it('falls back to 3 for unknown event types', () => {
    expect(getImportance('completely_unknown_event')).toBe(3);
    expect(getImportance('')).toBe(3);
    expect(getImportance('foo_bar_baz')).toBe(3);
  });
});

describe('getTypePriority', () => {
  it('returns priority 3 for conversation', () => {
    expect(getTypePriority('conversation')).toBe(3);
  });

  it('returns priority 3 for secret', () => {
    expect(getTypePriority('secret')).toBe(3);
  });

  it('returns priority 3 for reflection', () => {
    expect(getTypePriority('reflection')).toBe(3);
  });

  it('returns priority 2 for observation', () => {
    expect(getTypePriority('observation')).toBe(2);
  });

  it('returns priority 2 for gossip', () => {
    expect(getTypePriority('gossip')).toBe(2);
  });

  it('returns priority 2 for plan', () => {
    expect(getTypePriority('plan')).toBe(2);
  });

  it('returns priority 1 for experience', () => {
    expect(getTypePriority('experience')).toBe(1);
  });

  it('returns priority 1 for opinion', () => {
    expect(getTypePriority('opinion')).toBe(1);
  });

  it('defaults to 1 for unknown memory types', () => {
    expect(getTypePriority('unknown_type')).toBe(1);
    expect(getTypePriority('')).toBe(1);
  });
});
