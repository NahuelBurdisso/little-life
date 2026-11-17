import { describe, it, expect } from 'vitest';
import { observerQualifies } from '../perception/PerceptionSystem';
import { PERCEPTION_REGISTRY } from '../perception/perceptionRegistry';

/**
 * `constable_sees_criminal` had no job gate: whoever stood next to a debtor
 * "approached to investigate" them, the baker as much as the constable.
 */

const rule = (id: string) => PERCEPTION_REGISTRY.find((r) => r.id === id)!;

describe('perception rules for one trade', () => {
  it('only the constable investigates a debtor', () => {
    expect(observerQualifies(rule('constable_sees_criminal'), 'constable')).toBe(true);
    expect(observerQualifies(rule('constable_sees_criminal'), 'baker')).toBe(false);
    expect(observerQualifies(rule('constable_sees_criminal'), undefined)).toBe(false);
  });

  it('rules without a trade are for everyone', () => {
    expect(observerQualifies(rule('friend_grieving'), 'baker')).toBe(true);
    expect(observerQualifies(rule('friend_grieving'), undefined)).toBe(true);
  });
});
