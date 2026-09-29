import { describe, it, expect } from 'vitest';
import { isInfatuatedWith } from '../perception/PerceptionSystem';

// Elena (1) has a crush on James (2); Rosa (3) is jealous of Elena.
const ELENA = 1, JAMES = 2, ROSA = 3;

describe('isInfatuatedWith (infatuated_sees_target)', () => {
  it('fires for the smitten observer looking at their crush', () => {
    const elenaStates = [{ agent_id: ELENA, type: 'infatuated', target_agent_id: JAMES }];
    expect(isInfatuatedWith(elenaStates, JAMES)).toBe(true);
  });

  it('does not fire for the crush looking back at the smitten one', () => {
    // James has no states of his own; Elena's crush must not send HIM to flirt.
    expect(isInfatuatedWith([], ELENA)).toBe(false);
  });

  it('ignores other targeted states', () => {
    const rosaStates = [{ agent_id: ROSA, type: 'jealous', target_agent_id: ELENA }];
    expect(isInfatuatedWith(rosaStates, ELENA)).toBe(false);
  });

  it('ignores an infatuation aimed at someone else', () => {
    const elenaStates = [{ agent_id: ELENA, type: 'infatuated', target_agent_id: JAMES }];
    expect(isInfatuatedWith(elenaStates, ROSA)).toBe(false);
  });
});
