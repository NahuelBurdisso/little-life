import { describe, it, expect } from 'vitest';
import { HOTKEYS, VERBS } from '../helpContent';

describe('helpContent', () => {
  it('lists every hotkey once', () => {
    const keys = HOTKEYS.flatMap((h) => h.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['Space', '1', '2', '3', '4', 'Esc', '?']));
  });

  it('teaches right-click to meddle', () => {
    expect(VERBS.some((v) => /right-click/i.test(v.how))).toBe(true);
  });
});
