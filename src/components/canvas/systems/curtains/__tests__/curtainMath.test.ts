import { describe, it, expect } from 'vitest';
import { CURTAIN_SECONDS, PANEL_MAX_PX, panelPx, stepCurtain } from '../curtainMath';

describe('stepCurtain', () => {
  it('closes over about a second and stays closed', () => {
    let p = 0;
    for (let i = 0; i < 10; i++) p = stepCurtain(p, true, CURTAIN_SECONDS / 10);
    expect(p).toBeCloseTo(1, 6);
    expect(stepCurtain(1, true, 5)).toBe(1);
  });

  it('opens again the same way and never goes below open', () => {
    expect(stepCurtain(1, false, CURTAIN_SECONDS / 2)).toBeCloseTo(0.5, 6);
    expect(stepCurtain(0.1, false, 5)).toBe(0);
  });
});

describe('panelPx', () => {
  it('grows from nothing to the panel width in whole pixels', () => {
    expect(panelPx(0)).toBe(0);
    expect(panelPx(1)).toBe(PANEL_MAX_PX);
    expect(panelPx(0.5)).toBe(2);
    for (let p = 0; p <= 1; p += 0.05) expect(Number.isInteger(panelPx(p))).toBe(true);
  });

  it('clamps out-of-range progress', () => {
    expect(panelPx(-1)).toBe(0);
    expect(panelPx(3)).toBe(PANEL_MAX_PX);
  });
});
