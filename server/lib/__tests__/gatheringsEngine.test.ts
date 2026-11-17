import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  attendanceOf, clearGatherings, gatheringAt, gatheringFor, gatheringRecords, gatheringTally, gatheringsPass,
  gatheringsSnapshotStore, invite, registerGatheringKind, scheduleGathering, type PassAgent,
} from '../gatherings/engine';
import type { Gathering, GatheringKind } from '../gatherings/types';

const START = 10_000;
const VENUE = 7;
const DOOR = { x: 500, y: 500 };

function kind(over: Partial<GatheringKind> = {}): GatheringKind {
  return {
    id: 'test_gathering',
    leadMin: 30,
    momentsAt: [60],
    invite: (g) => {
      invite(g, 1, 'must');
      invite(g, 2, 'should');
      invite(g, 3, 'may');
    },
    label: () => ({ walking: 'going', there: 'there' }),
    topic: () => 'a test',
    moment: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

function at(id: number, here: boolean, action = 'idle'): PassAgent {
  return { id, current_location: here ? VENUE : null, position: here ? DOOR : { x: 0, y: 0 }, action };
}

function pass(nowMin: number, agents: PassAgent[], storm = false): void {
  gatheringsPass({ nowMin, agents, venueDoor: () => DOOR, storm });
}

function schedule(): Gathering {
  return scheduleGathering({ kind: 'test_gathering', venueLocationId: VENUE, startMin: START, endMin: START + 120, subjectId: 99 })!;
}

describe('gatherings engine', () => {
  let def: GatheringKind;
  beforeEach(() => {
    clearGatherings();
    def = kind();
    registerGatheringKind(def);
  });

  it('sends the invitations at the lead time, not before, and only once per subject', () => {
    const g = schedule();
    expect(scheduleGathering({ kind: 'test_gathering', venueLocationId: VENUE, startMin: START, endMin: START + 60, subjectId: 99 })).toBeNull();
    pass(START - 40, []);
    expect(g.status).toBe('scheduled');
    expect(gatheringFor(1, START - 40)).toBeNull();
    pass(START - 30, []);
    expect(g.status).toBe('open');
    expect(gatheringFor(1, START - 30)?.inv.level).toBe('must');
    expect(gatheringAt(VENUE, START - 10)?.id).toBe(g.id);
    expect(gatheringAt(VENUE, START + 200)).toBeNull();
  });

  it('a storm puts it off (twice at most), keeping the window length', () => {
    registerGatheringKind(kind({ stormDelayMin: 180 }));
    const g = schedule();
    pass(START - 30, [], true);
    expect(g.status).toBe('scheduled');
    expect([g.startMin, g.endMin]).toEqual([START + 180, START + 300]);
    pass(START + 150, [], true);
    pass(START + 330, [], true);
    expect(g.status).toBe('open');
    expect(g.postponed).toBe(2);
  });

  it('notes who is there (inside, or standing at the door), runs the moment once, and judges at the end', () => {
    const g = schedule();
    pass(START - 30, []);
    pass(START + 10, [at(1, true), at(3, true), at(4, true), at(2, false)]);
    // At the door, not walking past: counts.
    pass(START + 20, [{ id: 5, current_location: null, position: { x: 520, y: 510 }, action: 'idle' }]);
    expect([...g.attended].sort()).toEqual([1, 3, 4, 5]);
    pass(START + 60, [at(1, true)]);
    pass(START + 70, [at(1, true)]);
    expect(def.moment).toHaveBeenCalledTimes(1);
    pass(START + 120, []);
    expect(def.onClose).toHaveBeenCalledTimes(1);
    const att = attendanceOf(g.id)!;
    expect(att.absent).toEqual([2]);
    expect(att.attended.has(4)).toBe(true);
    expect(gatheringRecords('test_gathering')).toHaveLength(1);
    expect(gatheringTally().test_gathering).toMatchObject({ held: 1, invited: 2, invitedCame: 1, attended: 4 });
  });

  it('an invitee who has stayed their time is free again', () => {
    registerGatheringKind(kind({ stayMin: { may: 30 } }));
    const g = schedule();
    pass(START - 30, []);
    pass(START, [at(3, true)]);
    expect(gatheringFor(3, START)).not.toBeNull();
    pass(START + 30, [at(3, true)]);
    expect(g.invited.get(3)!.doneAtMin).toBe(START + 30);
    expect(gatheringFor(3, START + 30)).toBeNull();
  });

  it('a stronger ask replaces a weaker one; the strongest gathering wins', () => {
    const g = schedule();
    pass(START - 30, []);
    invite(g, 3, 'must');
    invite(g, 1, 'may');
    expect(g.invited.get(3)!.level).toBe('must');
    expect(g.invited.get(1)!.level).toBe('must');
  });

  it('a kind that no longer applies is called off silently', () => {
    registerGatheringKind(kind({ stillRelevant: () => false }));
    const g = schedule();
    pass(START - 30, []);
    expect(gatheringFor(1, START)).toBeNull();
    expect(attendanceOf(g.id)).toBeNull();
    expect(gatheringTally().test_gathering.cancelled).toBe(1);
  });

  it('survives a checkpoint round trip', () => {
    const g = schedule();
    pass(START - 30, []);
    pass(START + 10, [at(1, true)]);
    const blob = JSON.parse(JSON.stringify(gatheringsSnapshotStore.serialize()));
    clearGatherings();
    gatheringsSnapshotStore.restore(blob);
    const back = gatheringFor(1, START + 20)!;
    expect(back.g.id).toBe(g.id);
    expect(back.g.attended.has(1)).toBe(true);
    expect(back.inv.arrivedAtMin).toBe(START + 10);
    expect(back.g.invited.get(2)!.level).toBe('should');
    expect(scheduleGathering({ kind: 'test_gathering', venueLocationId: VENUE, startMin: START, endMin: START + 60 })!.id).toBeGreaterThan(g.id);
  });
});
