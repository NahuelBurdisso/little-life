import { describe, it, expect } from 'vitest';
import { inView, detailLevel } from '../view';

describe('inView', () => {
  const v = { x: 100, y: 100, w: 200, h: 100, scale: 1 };
  it('accepts points inside the rect', () => expect(inView(v, 150, 150)).toBe(true));
  it('accepts points within the margin', () => expect(inView(v, 80, 150, 32)).toBe(true));
  it('rejects points past the margin', () => expect(inView(v, 60, 150, 32)).toBe(false));
});

describe('detailLevel', () => {
  it('bands the zoom', () => {
    expect(detailLevel(0.5)).toBe(0);
    expect(detailLevel(1)).toBe(1);
    expect(detailLevel(2)).toBe(2);
  });
});
