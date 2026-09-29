import { describe, it, expect } from 'vitest';
import { PROP_FRAMES, PROP_FRAME_COUNT, propFrame } from '../propFrames';

describe('propFrame', () => {
  it('always picks a cell of the requested kind', () => {
    for (const kind of Object.keys(PROP_FRAMES) as Array<keyof typeof PROP_FRAMES>) {
      for (let h = 0; h < 2000; h += 37) {
        expect(PROP_FRAMES[kind]).toContain(propFrame(kind, h * 7919));
      }
    }
  });

  it('is deterministic per tile hash', () => {
    expect(propFrame('tree', 123456789)).toBe(propFrame('tree', 123456789));
  });

  it('uses every variant across a field of tiles', () => {
    const seen = new Set<number>();
    for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) {
      seen.add(propFrame('tree', (x * 73856093) ^ (y * 19349663)));
    }
    expect([...seen].sort()).toEqual([...PROP_FRAMES.tree]);
  });

  it('keeps every cell index inside the atlas', () => {
    const all = Object.values(PROP_FRAMES).flat();
    expect(Math.max(...all)).toBe(PROP_FRAME_COUNT - 1);
    expect(new Set(all).size).toBe(PROP_FRAME_COUNT);
  });
});
