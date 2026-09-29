import { describe, it, expect } from 'vitest';
import { idString, pairKey } from '../idString';

describe('pairKey', () => {
  it('joins with a colon', () => {
    expect(pairKey('12', 'zzz')).toBe('12:zzz');
  });

  it('returns the identical string on repeat lookups and keeps pairs apart', () => {
    expect(pairKey('3', 'work')).toBe(pairKey('3', 'work'));
    expect(pairKey('3', 'work')).not.toBe(pairKey('3', 'zzz'));
    expect(pairKey('4', 'work')).toBe('4:work');
  });
});

describe('idString', () => {
  it('matches String() for numeric ids', () => {
    for (const id of [0, 7, 13, 1024, -1]) expect(idString(id)).toBe(String(id));
  });

  it('passes string ids through untouched', () => {
    const s = 'agent-9';
    expect(idString(s)).toBe(s);
    expect(idString('12')).toBe('12');
  });

  it('agrees for a number and its string form', () => {
    expect(idString(42)).toBe(idString('42'));
  });

  it('returns the identical string on repeat lookups', () => {
    expect(idString(311)).toBe(idString(311));
  });
});
