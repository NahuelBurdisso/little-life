import { describe, it, expect } from 'vitest';
import {
  MINUTES_PER_DAY, type Challenge, type ChallengeKind, type SnapAgent, type SnapPair, type TownSnapshot,
} from '../catalog';
import { beginChallenge, evaluateChallenge } from '../evaluate';

/**
 * Every evaluator on hand-built snapshots: the checks are pure functions of
 * the town's state, so each case is "the town before" → begin → "the town
 * after" → verdict. Success, failure and running out the clock for each kind.
 */

const DAY = MINUTES_PER_DAY;
const START = 10 * DAY + 9 * 60;

function agent(id: number, o: Partial<SnapAgent> = {}): SnapAgent {
  return { id, name: `Name${id} Surname`, age: 30, active: true, dead: false, social: 50, ...o };
}

function pair(a: number, b: number, o: Partial<SnapPair> = {}): SnapPair {
  return {
    a: Math.min(a, b), b: Math.max(a, b), friendship: 0, romanceMax: 0, romanceMin: 0,
    status: 'acquaintances', tags: [], ...o,
  };
}

function town(o: Partial<TownSnapshot> = {}): TownSnapshot {
  return {
    nowMinute: START,
    day: Math.floor(START / DAY),
    season: 'spring',
    seasonEndMinute: 28 * DAY,
    nextSeasonEndMinute: 56 * DAY,
    agents: [agent(1), agent(2), agent(3), agent(4)],
    pairs: [],
    publicSecretIds: [],
    hiddenSecretCount: 0,
    lastPlayerActionId: 0,
    handsOnCount: 0,
    deathEnabled: true,
    ...o,
  };
}

function offer(kind: ChallengeKind, o: Partial<Challenge> = {}): Challenge {
  return {
    id: 'c1', kind, difficulty: 'medium', goal: 'test', agentIds: [], durationDays: 5,
    status: 'offered', offeredAt: START, ...o,
  };
}

/** `snap` at `days` game days after START. */
function later(snap: TownSnapshot, days: number, o: Partial<TownSnapshot> = {}): TownSnapshot {
  return { ...snap, nowMinute: START + days * DAY, ...o };
}

describe('matchmaker', () => {
  const before = town({ pairs: [pair(1, 2, { romanceMax: 35, romanceMin: 25, friendship: 30, status: 'romantic_interest' })] });
  const c = beginChallenge(offer('matchmaker', { agentIds: [1, 2], durationDays: 14 }), before);

  it('starts with a deadline and romance progress', () => {
    expect(c.status).toBe('active');
    expect(c.deadline).toBe(START + 14 * DAY);
    expect(c.progress?.label).toMatch(/romance 25/);
  });

  it('completes on the married tag', () => {
    const v = evaluateChallenge(c, later(before, 9, {
      pairs: [pair(1, 2, { romanceMin: 80, romanceMax: 85, status: 'partners', tags: ['married'] })],
    }));
    expect(v.status).toBe('completed');
    expect(v.outcome).toMatch(/Name1 and Name2 are married/);
  });

  it('shows the engagement stage', () => {
    const v = evaluateChallenge(c, later(before, 5, {
      pairs: [pair(1, 2, { romanceMin: 80, status: 'partners', tags: ['engaged'] })],
    }));
    expect(v.status).toBe('active');
    expect(v.progress.value).toBe(80);
  });

  it('fails when one of them dies', () => {
    const v = evaluateChallenge(c, later(before, 2, { agents: [agent(1), agent(2, { active: false, dead: true })] }));
    expect(v.status).toBe('failed');
    expect(v.outcome).toBe('Name2 died.');
  });

  it('expires at the deadline', () => {
    expect(evaluateChallenge(c, later(before, 14)).status).toBe('expired');
    expect(evaluateChallenge(c, later(before, 13.9)).status).toBe('active');
  });
});

describe('peacemaker', () => {
  const before = town({ pairs: [pair(1, 2, { friendship: -75, status: 'enemies' })] });
  const c = beginChallenge(offer('peacemaker', { agentIds: [1, 2], durationDays: 8 }), before);

  it('completes once they are friends', () => {
    const v = evaluateChallenge(c, later(before, 3, { pairs: [pair(1, 2, { friendship: 41, status: 'friends' })] }));
    expect(v.status).toBe('completed');
    expect(v.progress.value).toBe(v.progress.target);
  });

  it('fails when one leaves town', () => {
    const v = evaluateChallenge(c, later(before, 1, { agents: [agent(1, { active: false }), agent(2)] }));
    expect(v.status).toBe('failed');
    expect(v.outcome).toBe('Name1 left town.');
  });

  it('expires still enemies', () => {
    expect(evaluateChallenge(c, later(before, 8)).status).toBe('expired');
  });
});

describe('guardian', () => {
  // One resident was already dead before the challenge: that is not a failure.
  const before = town({ agents: [agent(1), agent(2), agent(3, { active: false, dead: true })] });
  const c = beginChallenge(offer('guardian'), before);

  it('runs to the end of the season', () => {
    expect(c.deadline).toBe(28 * DAY);
    expect(c.baseline?.deadIds).toEqual([3]);
  });

  it('runs to the next season when this one is nearly over', () => {
    const late = town({ nowMinute: 27 * DAY });
    expect(beginChallenge(offer('guardian'), late).deadline).toBe(56 * DAY);
  });

  it('fails on a new death', () => {
    const v = evaluateChallenge(c, later(before, 4, {
      agents: [agent(1, { active: false, dead: true }), agent(2), agent(3, { active: false, dead: true })],
    }));
    expect(v.status).toBe('failed');
    expect(v.outcome).toBe('Name1 died.');
  });

  it('a resident leaving is not a death', () => {
    const v = evaluateChallenge(c, later(before, 4, { agents: [agent(1, { active: false }), agent(2), agent(3, { active: false, dead: true })] }));
    expect(v.status).toBe('active');
  });

  it('completes when the season ends with nobody lost', () => {
    const v = evaluateChallenge(c, { ...before, nowMinute: 28 * DAY });
    expect(v.status).toBe('completed');
    expect(v.progress.value).toBe(v.progress.target);
  });
});

describe('scandal', () => {
  const before = town({ publicSecretIds: [7] });
  let c = beginChallenge(offer('scandal', { durationDays: 5 }), before);

  it('counts only secrets that come out after the start, within one day', () => {
    // Two new ones on day 1...
    let v = evaluateChallenge(c, later(before, 1, { publicSecretIds: [7, 8, 9] }));
    expect(v.status).toBe('active');
    expect(v.progress.value).toBe(2);
    c = { ...c, baseline: v.baseline };
    // ...the third a day and a half later: the first two fell out of the window.
    v = evaluateChallenge(c, later(before, 2.5, { publicSecretIds: [7, 8, 9, 10] }));
    expect(v.status).toBe('active');
    expect(v.progress.value).toBe(1);
    c = { ...c, baseline: v.baseline };
    // Two more the same afternoon: three inside one day.
    v = evaluateChallenge(c, later(before, 2.7, { publicSecretIds: [7, 8, 9, 10, 11, 12] }));
    expect(v.status).toBe('completed');
  });

  it('expires without three in a day', () => {
    const fresh = beginChallenge(offer('scandal', { durationDays: 5 }), before);
    expect(evaluateChallenge(fresh, later(before, 5, { publicSecretIds: [7, 8] })).status).toBe('expired');
  });
});

describe('hands off', () => {
  const before = town({ lastPlayerActionId: 40, handsOnCount: 2 });
  const c = beginChallenge(offer('hands_off', { durationDays: 2 }), before);

  it('fails on a player row, even inside the same game minute', () => {
    expect(evaluateChallenge(c, { ...before, lastPlayerActionId: 41 }).status).toBe('failed');
  });

  it('fails on an autoplay nudge or a weather change', () => {
    expect(evaluateChallenge(c, later(before, 1, { handsOnCount: 3 })).status).toBe('failed');
  });

  it('completes after two quiet days', () => {
    expect(evaluateChallenge(c, later(before, 1)).status).toBe('active');
    const v = evaluateChallenge(c, later(before, 2));
    expect(v.status).toBe('completed');
    expect(v.outcome).toMatch(/Two whole days/);
  });
});

describe('full house', () => {
  const before = town();
  const c = beginChallenge(offer('full_house', { target: 6, durationDays: 5 }), before);

  it('completes at the target population', () => {
    const v = evaluateChallenge(c, later(before, 1, { agents: [...before.agents, agent(5), agent(6)] }));
    expect(v.status).toBe('completed');
  });

  it('does not count the departed', () => {
    const v = evaluateChallenge(c, later(before, 1, { agents: [...before.agents, agent(5), agent(6, { active: false })] }));
    expect(v.status).toBe('active');
    expect(v.progress.label).toBe('5 of 6 residents');
  });

  it('expires short of it', () => {
    expect(evaluateChallenge(c, later(before, 5)).status).toBe('expired');
  });
});

describe('first engagement', () => {
  const before = town({ pairs: [pair(3, 4, { tags: ['married'], status: 'partners' }), pair(1, 2, { status: 'partners' })] });
  const c = beginChallenge(offer('first_engagement', { durationDays: 10 }), before);

  it('an existing marriage does not count', () => {
    const v = evaluateChallenge(c, later(before, 1));
    expect(v.status).toBe('active');
    expect(v.progress.label).toBe('1 couple could propose');
  });

  it('completes on a new engagement', () => {
    const v = evaluateChallenge(c, later(before, 3, {
      pairs: [pair(3, 4, { tags: ['married'] }), pair(1, 2, { status: 'partners', tags: ['engaged'] })],
    }));
    expect(v.status).toBe('completed');
    expect(v.outcome).toBe('Name1 and Name2 are engaged.');
  });

  it('expires without one', () => {
    expect(evaluateChallenge(c, later(before, 10)).status).toBe('expired');
  });
});

describe('feud', () => {
  const before = town({ pairs: [pair(1, 2, { friendship: 55, status: 'friends' }), pair(3, 4, { friendship: 10 })] });
  const c = beginChallenge(offer('feud', { durationDays: 6 }), before);

  it('remembers who were friends', () => {
    expect(c.baseline?.friendPairs).toEqual([[1, 2]]);
  });

  it('a pair that was never friends falling out does not count', () => {
    const v = evaluateChallenge(c, later(before, 1, { pairs: [pair(1, 2, { friendship: 20 }), pair(3, 4, { friendship: -80, status: 'enemies' })] }));
    expect(v.status).toBe('active');
    expect(v.progress.label).toMatch(/Name1 & Name2 at 20/);
  });

  it('completes when the friends become rivals', () => {
    const v = evaluateChallenge(c, later(before, 2, { pairs: [pair(1, 2, { friendship: -45, status: 'rivals' })] }));
    expect(v.status).toBe('completed');
  });

  it('expires while they are still on speaking terms', () => {
    expect(evaluateChallenge(c, later(before, 6)).status).toBe('expired');
  });
});

describe('recluse', () => {
  const before = town({ pairs: [pair(1, 2, { friendship: 20 })] });
  const c = beginChallenge(offer('recluse', { agentIds: [1], durationDays: 7 }), before);

  it('completes on a close friendship', () => {
    const v = evaluateChallenge(c, later(before, 3, { pairs: [pair(1, 2, { friendship: 20 }), pair(1, 3, { friendship: 72 })] }));
    expect(v.status).toBe('completed');
    expect(v.outcome).toBe('Name1 has a best friend: Name3.');
  });

  it('a friendship with someone gone does not count', () => {
    const v = evaluateChallenge(c, later(before, 3, {
      agents: [agent(1), agent(2), agent(3, { active: false, dead: true })],
      pairs: [pair(1, 3, { friendship: 90 })],
    }));
    expect(v.status).toBe('active');
  });

  it('fails when they leave', () => {
    expect(evaluateChallenge(c, later(before, 1, { agents: [agent(1, { active: false })] })).status).toBe('failed');
  });

  it('expires still alone', () => {
    expect(evaluateChallenge(c, later(before, 7)).status).toBe('expired');
  });
});
