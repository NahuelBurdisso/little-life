import { describe, it, expect } from 'vitest';
import {
  AUTO_COLLAPSE_BELOW,
  TOOLBAR_COLLAPSED_KEY,
  readToolbarPref,
  resolveToolbarCollapsed,
  toolbarClearance,
  writeToolbarPref,
} from '../toolbarLayout';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v; },
  };
}

describe('resolveToolbarCollapsed', () => {
  it('folds on small screens and opens on wide ones when nothing was chosen', () => {
    expect(resolveToolbarCollapsed(null, 1024)).toBe(true);
    expect(resolveToolbarCollapsed(null, 1280)).toBe(true);
    expect(resolveToolbarCollapsed(null, AUTO_COLLAPSE_BELOW - 1)).toBe(true);
    expect(resolveToolbarCollapsed(null, AUTO_COLLAPSE_BELOW)).toBe(false);
    expect(resolveToolbarCollapsed(null, 1920)).toBe(false);
  });

  it('lets the player override the width either way', () => {
    expect(resolveToolbarCollapsed(false, 800)).toBe(false);
    expect(resolveToolbarCollapsed(true, 2560)).toBe(true);
  });
});

describe('toolbar preference storage', () => {
  it('round-trips and reads unset as null', () => {
    const s = memoryStorage();
    expect(readToolbarPref(s)).toBeNull();
    writeToolbarPref(true, s);
    expect(s.data[TOOLBAR_COLLAPSED_KEY]).toBe('1');
    expect(readToolbarPref(s)).toBe(true);
    writeToolbarPref(false, s);
    expect(readToolbarPref(s)).toBe(false);
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(readToolbarPref(broken)).toBeNull();
    expect(() => writeToolbarPref(true, broken)).not.toThrow();
  });

  it('ignores junk values', () => {
    expect(readToolbarPref(memoryStorage({ [TOOLBAR_COLLAPSED_KEY]: 'maybe' }))).toBeNull();
  });
});

describe('toolbarClearance', () => {
  it('leaves less room for the rail than for the open strip', () => {
    expect(toolbarClearance(true)).toBeLessThan(toolbarClearance(false));
  });
});
