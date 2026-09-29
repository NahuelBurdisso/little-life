import { describe, it, expect } from 'vitest';
import { taskThought, workDescription, GENERIC_WORK } from '../workText';

const locations = [
  { id: 1, type: 'bakery' },
  { id: 2, type: 'workshop' },
  { id: 3, type: 'park' },
];

describe('workDescription', () => {
  it('has a line for every workplace with a tool', () => {
    for (const t of ['bakery', 'workshop', 'shop', 'pawnshop', 'town_hall', 'clinic', 'tavern', 'divebar', 'farm', 'prison']) {
      expect(workDescription(t), t).toBeTruthy();
    }
  });
  it('is different per workplace', () => {
    expect(workDescription('bakery')).not.toBe(workDescription('workshop'));
  });
  it('varies with the pick but is stable for one agent', () => {
    const seen = new Set([0, 1, 2, 3].map(i => workDescription('bakery', i)));
    expect(seen.size).toBeGreaterThan(1);
    expect(workDescription('bakery', 7)).toBe(workDescription('bakery', 7));
    expect(workDescription('bakery', -4)).toBeTruthy();
  });
  it('is null for places with no line', () => {
    expect(workDescription('park')).toBeNull();
    expect(workDescription(null)).toBeNull();
    expect(workDescription(undefined)).toBeNull();
  });
});

describe('taskThought', () => {
  it('replaces the generic shift text with the workplace line', () => {
    const t = taskThought(GENERIC_WORK, { id: 1, workplace: 2 }, locations);
    expect(t).toBe(workDescription('workshop', 1));
    expect(t).not.toBe(GENERIC_WORK);
  });
  it('leaves other descriptions alone', () => {
    expect(taskThought('fixing the roof', { id: 1, workplace: 2 }, locations)).toBe('fixing the roof');
    expect(taskThought(undefined, { id: 1, workplace: 2 }, locations)).toBeUndefined();
  });
  it('falls back to the generic text when the workplace is unknown', () => {
    expect(taskThought(GENERIC_WORK, { id: 1, workplace: 99 }, locations)).toBe(GENERIC_WORK);
    expect(taskThought(GENERIC_WORK, { id: 1, workplace: 3 }, locations)).toBe(GENERIC_WORK);
    expect(taskThought(GENERIC_WORK, { id: 1, workplace: null }, locations)).toBe(GENERIC_WORK);
    expect(taskThought(GENERIC_WORK, { id: 1, workplace: 1 }, undefined)).toBe(GENERIC_WORK);
  });
});
