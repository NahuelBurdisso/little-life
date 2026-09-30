import { describe, it, expect } from 'vitest';
import type { Challenge } from '../../../server/lib/challenges/catalog';
import { AIM_OPTIONS, goalForPair } from '../pairGoal';

function challenge(id: string, agentIds: number[]): Challenge {
  return {
    id, kind: 'matchmaker', difficulty: 'hard', goal: 'g', agentIds, durationDays: 14, status: 'active', offeredAt: 0,
  };
}

describe('goalForPair', () => {
  const active = [challenge('c1', []), challenge('c2', [3]), challenge('c3', [4, 7])];

  it('finds the challenge about exactly this pair, in either order', () => {
    expect(goalForPair(active, 4, 7)?.id).toBe('c3');
    expect(goalForPair(active, 7, 4)?.id).toBe('c3');
  });

  it('ignores challenges about someone else, one resident, or nobody', () => {
    expect(goalForPair(active, 3, 4)).toBeNull();
    expect(goalForPair(active, 3, 3)).toBeNull();
    expect(goalForPair([], 4, 7)).toBeNull();
  });
});

describe('AIM_OPTIONS', () => {
  it('offers the three aims and warns only about marriage', () => {
    expect(AIM_OPTIONS.map((o) => o.aim)).toEqual(['marry', 'befriend', 'sunder']);
    expect(AIM_OPTIONS.filter((o) => o.hint).map((o) => o.aim)).toEqual(['marry']);
  });
});
