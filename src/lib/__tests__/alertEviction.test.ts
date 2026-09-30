import { describe, it, expect } from 'vitest';
import { evictToasts } from '../alertEviction';

const t = (id: number, tier: 'player' | 'major' | 'minor') => ({ id, tier });
const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

describe('evictToasts', () => {
  it('keeps everything under the cap', () => {
    expect(ids(evictToasts([t(1, 'minor'), t(2, 'major')], 3))).toEqual([1, 2]);
  });

  it('drops the oldest within the same tier', () => {
    expect(ids(evictToasts([t(1, 'major'), t(2, 'major'), t(3, 'major'), t(4, 'major')], 3))).toEqual([2, 3, 4]);
  });

  it('drops a minor before an older major', () => {
    expect(ids(evictToasts([t(1, 'major'), t(2, 'minor'), t(3, 'major'), t(4, 'minor')], 3))).toEqual([1, 3, 4]);
  });

  it('drops majors before the player\'s own outcome, however old the major is', () => {
    expect(ids(evictToasts([t(1, 'player'), t(2, 'major'), t(3, 'player'), t(4, 'player')], 3))).toEqual([1, 3, 4]);
  });

  it('evicts several at once in tier order and keeps arrival order', () => {
    const out = evictToasts([t(1, 'major'), t(2, 'minor'), t(3, 'player'), t(4, 'minor'), t(5, 'major')], 2);
    expect(ids(out)).toEqual([3, 5]);
  });

  it('can evict the newcomer when it is the lowest tier', () => {
    expect(ids(evictToasts([t(1, 'major'), t(2, 'major'), t(3, 'player'), t(4, 'minor')], 3))).toEqual([1, 2, 3]);
  });
});
