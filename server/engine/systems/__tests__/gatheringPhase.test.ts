import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, agentStates, conversationQueue } from '../../../db/schema';
import { gameMinutes } from '../../../lib/gameClock';
import '../../../lib/gatherings';
import { clearGatheringState } from '../../../lib/gatherings';
import { gatheringsPass, invite, registerGatheringKind, scheduleGathering } from '../../../lib/gatherings/engine';
import { setGatheringRng } from '../../../lib/gatherings/common';
import type { GatheringKind } from '../../../lib/gatherings/types';
import { loadDecisionContext } from '../decisions/context';
import {
  gatheringPhase, queueGatheringEncounters, GATHERING_MUST_SCORE, GATHERING_SHOULD_SCORE, GATHERING_MAY_SCORE,
} from '../decisions/gathering';
import { freshTown, insertResident } from '../../../lib/__tests__/populationFixtures';

const EVENING = { day: 20, hour: 18, minute: 0, totalTicks: 28_800, seasonDay: 5, season: 'spring' };
const MIDDAY = { ...EVENING, hour: 11 };
const NIGHT = { ...EVENING, hour: 2 };

function ctx(time = EVENING) {
  return loadDecisionContext({ time, tick_speed: 1 });
}

function row(id: number) {
  return db.select().from(agents).where(eq(agents.id, id)).get()!;
}

const PROBE: GatheringKind = {
  id: 'probe',
  leadMin: 30,
  mayChancePerMin: 0.5,
  encounterPerMin: 1,
  invite: () => {},
  label: (_g, venue) => ({ walking: `Off to ${venue}`, there: `At ${venue}` }),
  topic: () => 'the probe',
  onClose: () => {},
};

describe('gatheringPhase: the pull to a gathering and the hold once there', () => {
  let town: ReturnType<typeof freshTown>;
  let a: number;
  let b: number;
  beforeEach(() => {
    town = freshTown();
    clearGatheringState();
    registerGatheringKind(PROBE);
    a = insertResident('Ana Gil', town.homes[0], { workplace: town.bakery });
    b = insertResident('Bea Ros', town.homes[1]);
    setGatheringRng(() => 0);
  });
  afterEach(() => setGatheringRng(null));

  function open(time = EVENING, over: Partial<GatheringKind> = {}) {
    registerGatheringKind({ ...PROBE, ...over });
    const now = gameMinutes(time);
    const g = scheduleGathering({ kind: 'probe', venueLocationId: town.square, startMin: now, endMin: now + 120, subjectId: 1 })!;
    gatheringsPass({ nowMin: now - 30, agents: [], venueDoor: () => null, storm: false });
    return g;
  }

  it('a `must` comes off a work shift, with the label for the walk and the stay', () => {
    const g = open(MIDDAY);
    invite(g, a, 'must');
    const d = gatheringPhase(row(a), ctx(MIDDAY), 'must');
    expect(d).toMatchObject({ action: 'socializing', score: GATHERING_MUST_SCORE, targetLocationId: town.square, source: 'gathering' });
    expect(d!.walkDescription).toBe('Off to Town Square');
    expect(d!.description).toBe('At Town Square');
    expect(gatheringPhase(row(a), ctx(MIDDAY), 'should')).toBeNull();
  });

  it('a `should` beats the plan in free time but never leaves a shift', () => {
    const g = open(MIDDAY);
    invite(g, a, 'should');
    expect(gatheringPhase(row(a), ctx(MIDDAY), 'should')).toBeNull();
    clearGatheringState();
    const g2 = open(EVENING);
    invite(g2, a, 'should');
    expect(gatheringPhase(row(a), ctx(EVENING), 'should')).toMatchObject({ score: GATHERING_SHOULD_SCORE });
  });

  it('a fire may take people off a shift and out of bed; nothing else wakes anyone', () => {
    const g = open(NIGHT);
    invite(g, b, 'must');
    expect(gatheringPhase(row(b), ctx(NIGHT), 'must')).toBeNull();
    clearGatheringState();
    const g2 = open(NIGHT, { wakes: true, leavesShift: ['must', 'should'] });
    invite(g2, b, 'should');
    expect(gatheringPhase(row(b), ctx(NIGHT), 'should')).toMatchObject({ score: GATHERING_SHOULD_SCORE });
  });

  it('a `may` is a crowd pull with a chance; once there they are held above the plan', () => {
    const g = open(EVENING);
    invite(g, b, 'may');
    expect(gatheringPhase(row(b), ctx(EVENING), 'should')).toBeNull();
    expect(gatheringPhase(row(b), ctx(EVENING), 'may')).toMatchObject({ score: GATHERING_MAY_SCORE });
    setGatheringRng(() => 0.999);
    expect(gatheringPhase(row(b), ctx(EVENING), 'may')).toBeNull();
    db.update(agents).set({ current_location: town.square }).where(eq(agents.id, b)).run();
    expect(gatheringPhase(row(b), ctx(EVENING), 'should')).toMatchObject({ score: GATHERING_SHOULD_SCORE, targetLocationId: town.square });
    expect(g.invited.get(b)!.arrivedAtMin).toBe(gameMinutes(EVENING));
  });

  it('nobody ill or jailed is pulled', () => {
    const g = open(EVENING);
    invite(g, b, 'must');
    db.insert(agentStates).values({ agent_id: b, type: 'sick', severity: 0.6, started_at: 0, duration: 9999, source: 'test', metadata: null }).run();
    expect(gatheringPhase(row(b), ctx(EVENING), 'must')).toBeNull();
  });

  it('two free people at the venue get a gathering chat, with its trigger and topic', () => {
    open(EVENING);
    db.update(agents).set({ current_location: town.square }).where(eq(agents.id, a)).run();
    db.update(agents).set({ current_location: town.square }).where(eq(agents.id, b)).run();
    queueGatheringEncounters(ctx(EVENING));
    const q = db.select().from(conversationQueue).all();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ trigger_reason: 'gathering:probe', topic: 'the probe' });
    expect([...(q[0].participants as number[])].sort()).toEqual([a, b].sort());
  });
});
