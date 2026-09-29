import { describe, it, expect } from 'vitest';
import { workplaceForJob } from '../jobWorkplace';

// Procedural towns name buildings per seed; only the types are stable.
const PLACES = [
  { id: 1, type: 'town_square', name: 'Town Square' },
  { id: 2, type: 'farm', name: 'Hollow Brook Farm' },
  { id: 3, type: 'tavern', name: 'The Crooked Kettle' },
  { id: 4, type: 'shop', name: "Mabel's Store" },
  { id: 5, type: 'clinic', name: 'Doctor Hale' },
  { id: 6, type: 'workshop', name: 'Forge' },
  { id: 7, type: 'bakery', name: 'Crumbs' },
];

describe('workplaceForJob', () => {
  it.each([
    ['farmer', 2], ['musician', 3], ['bartender', 3], ['shopkeeper', 4],
    ['doctor', 5], ['handyperson', 6], ['baker', 7],
  ])('%s works at the matching building type', (job, id) => {
    expect(workplaceForJob(job, PLACES)?.id).toBe(id);
  });

  it('gives the jobless no workplace instead of the town square', () => {
    expect(workplaceForJob('unemployed', PLACES)).toBeNull();
    expect(workplaceForJob('retired', PLACES)).toBeNull();
  });

  it('returns null when the town has no such building', () => {
    expect(workplaceForJob('constable', PLACES)).toBeNull();
  });
});
