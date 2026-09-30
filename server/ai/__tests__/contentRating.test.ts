import { describe, it, expect } from 'vitest';
import { maturityDirective } from '../contentRating';

describe('maturityDirective', () => {
  it('adult: desire may be spoken, intimacy stays off-stage, minors are never involved', () => {
    const text = maturityDirective(true);
    expect(text).toContain('story for adults');
    expect(text).toContain('desire, jealousy and temptation');
    expect(text).toContain('folk of 1900');
    expect(text).toContain('Physical intimacy always happens off-stage: never describe it.');
    expect(text).toContain('Nothing romantic or sexual ever involves anyone under 18.');
  });

  it('off: romance stays chaste, a kiss at most', () => {
    const text = maturityDirective(false);
    expect(text).toBe('Romance stays chaste: glances, courting, holding hands, a kiss at most.');
    expect(text).not.toMatch(/desire|temptation|adults/);
  });

  it('the two texts differ and stay short (they ride in every prompt)', () => {
    expect(maturityDirective(true)).not.toBe(maturityDirective(false));
    expect(maturityDirective(true).length).toBeLessThan(400);
    expect(maturityDirective(false).length).toBeLessThan(120);
  });
});
