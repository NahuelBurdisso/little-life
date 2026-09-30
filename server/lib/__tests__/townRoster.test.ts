import { describe, it, expect } from 'vitest';
import { formatRoster, ROSTER_MAX, type RosterRow } from '../townRoster';

/**
 * The model invented townsfolk ("Silas") because no prompt listed who lives
 * here. The roster is one line, built from rows, so the formatting is tested
 * without a database.
 */
const row = (id: number, name: string, job_title: string | null, over: Partial<RosterRow> = {}): RosterRow => ({
  id, name, age: 35, is_active: true, job_title, ...over,
});

describe('formatRoster', () => {
  it('lists residents with their trade and closes with the no-inventing sentence', () => {
    const line = formatRoster([row(1, 'Rosa Chen', 'Shopkeeper'), row(2, 'Omar Haddad', 'Baker')]);
    expect(line).toContain('People in town: Rosa Chen (Shopkeeper), Omar Haddad (Baker).');
    expect(line).toMatch(/Anyone not on this list is a stranger to town; never make up names for townsfolk\.$/);
  });

  it('leaves out the departed and the dead', () => {
    const line = formatRoster([row(1, 'Rosa Chen', 'Shopkeeper'), row(2, 'Gone Gus', 'Farmer', { is_active: false })]);
    expect(line).toContain('Rosa Chen');
    expect(line).not.toContain('Gone Gus');
  });

  it('leaves out the excluded ids (the speaker and listener)', () => {
    const rows = [row(1, 'Rosa Chen', 'Shopkeeper'), row(2, 'Omar Haddad', 'Baker'), row(3, 'Yuki Tanaka', 'Doctor')];
    const line = formatRoster(rows, [1, 3]);
    expect(line).toContain('Omar Haddad (Baker)');
    expect(line).not.toContain('Rosa');
    expect(line).not.toContain('Yuki');
  });

  it('sorts by id, whatever order the rows come in', () => {
    const line = formatRoster([row(9, 'Zed Last', null), row(2, 'Amy First', null), row(5, 'Mid Person', null)]);
    expect(line.indexOf('Amy First')).toBeLessThan(line.indexOf('Mid Person'));
    expect(line.indexOf('Mid Person')).toBeLessThan(line.indexOf('Zed Last'));
  });

  it('names a resident without a job plainly, and a minor by age group', () => {
    const line = formatRoster([
      row(1, 'Idle Adult', 'Unemployed'),
      row(2, 'No Economy', null),
      row(3, 'Tomas Reyes', 'unemployed', { age: 8 }),
      row(4, 'Lena Reyes', 'none', { age: 15 }),
      row(5, 'Paper Boy', 'Delivery Boy', { age: 14 }),
    ]);
    expect(line).toContain('Idle Adult,');
    expect(line).toContain('No Economy,');
    expect(line).toContain('Tomas Reyes (child)');
    expect(line).toContain('Lena Reyes (teen)');
    // A minor with a job is named by the job.
    expect(line).toContain('Paper Boy (Delivery Boy)');
  });

  it('caps at 32 residents, lowest ids first', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1, `Person${String(i + 1).padStart(2, '0')}`, null));
    const line = formatRoster(rows);
    expect(ROSTER_MAX).toBe(32);
    expect(line).toContain('Person32');
    expect(line).not.toContain('Person33');
    expect((line.match(/Person\d\d/g) ?? []).length).toBe(32);
  });

  it('is empty for an empty town, or when everyone is excluded', () => {
    expect(formatRoster([])).toBe('');
    expect(formatRoster([row(1, 'Only One', 'Baker')], [1])).toBe('');
    expect(formatRoster([row(1, 'Gone', 'Baker', { is_active: false })])).toBe('');
  });
});
