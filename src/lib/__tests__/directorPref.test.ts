import { describe, it, expect } from 'vitest';
import { DIRECTOR_KEY, loadDirectorOn, saveDirectorOn } from '../directorPref';

const fake = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('directorPref', () => {
  it('defaults to on', () => {
    expect(loadDirectorOn(fake())).toBe(true);
    expect(loadDirectorOn(null)).toBe(true);
  });

  it('round-trips the choice', () => {
    const s = fake();
    saveDirectorOn(false, s);
    expect(s.getItem(DIRECTOR_KEY)).toBe('0');
    expect(loadDirectorOn(s)).toBe(false);
    saveDirectorOn(true, s);
    expect(loadDirectorOn(s)).toBe(true);
  });

  it('survives storage that throws', () => {
    const boom = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadDirectorOn(boom)).toBe(true);
    expect(() => saveDirectorOn(false, boom)).not.toThrow();
  });
});
