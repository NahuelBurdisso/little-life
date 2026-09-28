import { describe, it, expect } from 'vitest';
import { isCommonKnowledge } from '../gossipEngine';

const secret = (sensitivity: number, knownBy: number[]) => ({
  sensitivity,
  known_by: knownBy,
});

describe('isCommonKnowledge', () => {
  it('keeps a secret only two people share', () => {
    expect(isCommonKnowledge(secret(3, [1, 2]), 12)).toBe(false);
  });

  it('needs strictly more than half the town, not exactly half', () => {
    expect(isCommonKnowledge(secret(3, [1, 2, 3, 4, 5, 6]), 12)).toBe(false);
    expect(isCommonKnowledge(secret(3, [1, 2, 3, 4, 5, 6, 7]), 12)).toBe(true);
  });

  it('leaves mild facts alone however far they travel', () => {
    // Sensitivity 1 is already public knowledge by construction; announcing it
    // would just be noise.
    expect(isCommonKnowledge(secret(1, [1, 2, 3, 4, 5, 6, 7, 8]), 8)).toBe(false);
  });

  it('reveals a merely awkward fact too, not just a scandalous one', () => {
    expect(isCommonKnowledge(secret(2, [1, 2, 3]), 4)).toBe(true);
  });

  it('holds its answer when the town empties out', () => {
    expect(isCommonKnowledge(secret(3, []), 0)).toBe(false);
  });

  it('counts a secret everyone knows as common knowledge', () => {
    expect(isCommonKnowledge(secret(4, [1, 2, 3]), 3)).toBe(true);
  });
});
