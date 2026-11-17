import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addWatch, callOf, callsMadeTo, clearSocialCalls, dropCallsInvolving, finishCall, lingerOf, pendingCallsFor,
  registerSocialCallKind, runDueWatches, scheduleCall, socialCallsSnapshotStore, startLinger,
} from '../socialCalls/engine';
import { pickCallers, staggerOffsets, willingness, type CallerCandidate } from '../socialCalls/pickCallers';
import type { SocialCallKind } from '../socialCalls/types';

const DAY = 24 * 60;

function kind(over: Partial<SocialCallKind> = {}): SocialCallKind {
  return {
    id: 'test_visit',
    maxPendingPerTarget: 2,
    pairCooldownMin: 3 * DAY,
    windowMin: 600,
    topic: () => 'a test visit',
    label: (_c, n) => ({ walking: `Going to ${n}`, there: `With ${n}` }),
    consequence: () => {},
    ...over,
  };
}

describe('social call engine: the rules a schedule must pass', () => {
  beforeEach(() => {
    clearSocialCalls();
    registerSocialCallKind(kind());
    registerSocialCallKind(kind({ id: 'test_urgent', urgent: true, maxPendingPerTarget: 3 }));
  });

  it('schedules a call with its window, and hands it back by caller and by target', () => {
    const c = scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 1000, notBeforeMin: 1100 })!;
    expect(c).toMatchObject({ callerId: 1, targetId: 9, notBeforeMin: 1100, expiresAtMin: 1700, urgent: false, seatedAtMin: null });
    expect(callOf(1)?.id).toBe(c.id);
    expect(pendingCallsFor(9).map((x) => x.id)).toEqual([c.id]);
  });

  it('refuses unknown kinds, calling on oneself and the same promise twice', () => {
    expect(scheduleCall({ kind: 'nope', callerId: 1, targetId: 9, nowMin: 0 })).toBeNull();
    expect(scheduleCall({ kind: 'test_visit', callerId: 9, targetId: 9, nowMin: 0 })).toBeNull();
    scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 0 });
    expect(scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 0 })).toBeNull();
  });

  it('caps the callers coming to one target for one kind (not the whole town at a sickbed)', () => {
    expect(scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 0 })).not.toBeNull();
    expect(scheduleCall({ kind: 'test_visit', callerId: 2, targetId: 9, nowMin: 0 })).not.toBeNull();
    expect(scheduleCall({ kind: 'test_visit', callerId: 3, targetId: 9, nowMin: 0 })).toBeNull();
  });

  it('keeps one call at a time per caller, but an urgent call bumps an ordinary one', () => {
    const first = scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 0 })!;
    expect(scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 8, nowMin: 0 })).toBeNull();
    const urgent = scheduleCall({ kind: 'test_urgent', callerId: 1, targetId: 7, nowMin: 5 })!;
    expect(urgent.urgent).toBe(true);
    expect(callOf(1)?.id).toBe(urgent.id);
    expect(pendingCallsFor(9)).toHaveLength(0);
    expect(callsMadeTo(9)).toHaveLength(0); // dropped, not made
    expect(first.id).not.toBe(urgent.id);
    // ...and nothing bumps an urgent one.
    expect(scheduleCall({ kind: 'test_urgent', callerId: 1, targetId: 6, nowMin: 5 })).toBeNull();
  });

  it('holds the per-pair cooldown after a made call, not after a missed one', () => {
    const c = scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 0 })!;
    finishCall(c.id, 'made', 100, true);
    expect(callsMadeTo(9, 'test_visit')).toHaveLength(1);
    expect(scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 100 + DAY })).toBeNull();
    expect(scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 101 + 3 * DAY })).not.toBeNull();

    clearSocialCalls();
    const missed = scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 0 })!;
    finishCall(missed.id, 'expired', 700);
    expect(scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 800 })).not.toBeNull();
  });

  it('runs the kind\'s onMissed when a call expires, and only then', () => {
    const onMissed = vi.fn();
    registerSocialCallKind(kind({ id: 'test_missable', onMissed }));
    const a = scheduleCall({ kind: 'test_missable', callerId: 1, targetId: 9, nowMin: 0 })!;
    const b = scheduleCall({ kind: 'test_missable', callerId: 2, targetId: 9, nowMin: 0 })!;
    finishCall(a.id, 'dropped', 10);
    finishCall(b.id, 'expired', 10);
    expect(onMissed).toHaveBeenCalledTimes(1);
    expect(onMissed.mock.calls[0][0].callerId).toBe(2);
  });

  it('drops every call to or from someone who died, and their bedside stays', () => {
    scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 0 });
    scheduleCall({ kind: 'test_visit', callerId: 9, targetId: 4, nowMin: 0 });
    startLinger(2, 9, 500, 99);
    dropCallsInvolving(9, 10);
    expect(callOf(1)).toBeNull();
    expect(callOf(9)).toBeNull();
    expect(lingerOf(2, 20)).toBeNull();
  });

  it('forgets a bedside stay once it is over', () => {
    startLinger(2, 9, 500, 1);
    expect(lingerOf(2, 499)).toMatchObject({ targetId: 9 });
    expect(lingerOf(2, 500)).toBeNull();
  });

  it('hands a due watch to its kind once', () => {
    const onWatchDue = vi.fn();
    registerSocialCallKind(kind({ id: 'test_watch', onWatchDue }));
    addWatch({ kind: 'test_watch', targetId: 9, sinceMin: 0, dueMin: 100 });
    runDueWatches(99);
    expect(onWatchDue).not.toHaveBeenCalled();
    runDueWatches(100);
    runDueWatches(200);
    expect(onWatchDue).toHaveBeenCalledTimes(1);
  });

  it('survives a restart: pending calls, records, stays and watches round-trip the snapshot', () => {
    const c = scheduleCall({ kind: 'test_visit', callerId: 1, targetId: 9, nowMin: 0, payload: { deceased: 'Tom', n: 2 } })!;
    const made = scheduleCall({ kind: 'test_visit', callerId: 2, targetId: 9, nowMin: 0 })!;
    finishCall(made.id, 'made', 50, false);
    startLinger(3, 9, 500, 7);
    addWatch({ kind: 'test_visit', targetId: 9, sinceMin: 0, dueMin: 900 });
    const blob = JSON.parse(JSON.stringify(socialCallsSnapshotStore.serialize()));
    clearSocialCalls();
    socialCallsSnapshotStore.restore(blob);
    expect(callOf(1)).toMatchObject({ id: c.id, payload: { deceased: 'Tom', n: 2 } });
    expect(callsMadeTo(9)).toEqual([expect.objectContaining({ callerId: 2, good: false })]);
    expect(lingerOf(3, 100)).toMatchObject({ targetId: 9 });
    // New ids never collide with restored ones.
    const next = scheduleCall({ kind: 'test_visit', callerId: 4, targetId: 8, nowMin: 0 })!;
    expect(next.id).toBeGreaterThan(made.id);
  });

  it('restores tolerantly: junk entries are skipped, never thrown on', () => {
    expect(() => socialCallsSnapshotStore.restore({ pending: [{ id: 'x' }, null, 3], history: 'no', lingers: [{}], watches: [{ kind: 1 }] })).not.toThrow();
    expect(() => socialCallsSnapshotStore.restore(null)).not.toThrow();
  });
});

describe('pickCallers: who bothers to come', () => {
  const cand = (id: number, over: Partial<CallerCandidate> = {}): CallerCandidate => ({
    id, ties: ['friend'], friendship: 50, hostile: false, unavailable: false, busy: false,
    warmth: 60, loyalty: 50, morality: 50, curiosity: 50, money: 50, age: 35, ...over,
  });

  it('takes the closest tie first, and only the ties the kind allows', () => {
    const cands = [cand(1), cand(2, { ties: ['spouse'] }), cand(3, { ties: ['coworker'] })];
    expect(pickCallers(cands, { ties: ['spouse', 'friend'], max: 3 }, () => 0)).toEqual([2, 1]);
  });

  it('never sends rivals, the unavailable, the busy or children', () => {
    const cands = [cand(1, { hostile: true }), cand(2, { unavailable: true }), cand(3, { busy: true }), cand(4, { age: 9 }), cand(5)];
    expect(pickCallers(cands, { ties: ['friend'], max: 5 }, () => 0)).toEqual([5]);
  });

  it('a cold friend may not bother where a warm one does: the roll is at their willingness', () => {
    const cold = cand(1, { warmth: 5 });
    const warm = cand(2, { warmth: 95 });
    // 0.6 * willingness: cold ~0.14, warm ~0.58. A roll of 0.3 brings only the warm one.
    expect(pickCallers([cold, warm], { ties: ['friend'], max: 2 }, () => 0.3)).toEqual([2]);
    expect(willingness(cold)).toBeLessThan(willingness(warm));
  });

  it('duty brings a cold but loyal spouse', () => {
    const spouse = { ties: ['spouse' as const], warmth: 10, loyalty: 90, curiosity: 50 };
    expect(willingness(spouse)).toBeGreaterThan(0.8);
  });

  it('stops at the maximum and honours the exclusions', () => {
    const cands = [cand(1), cand(2), cand(3), cand(4)];
    expect(pickCallers(cands, { ties: ['friend'], max: 2, exclude: new Set([1]) }, () => 0)).toEqual([2, 3]);
  });

  it('staggers the callers over time', () => {
    expect(staggerOffsets(3, 60, 600, 0, () => 0.5)).toEqual([60, 660, 1260]);
    expect(staggerOffsets(2, 0, 100, 40, () => 0.5)).toEqual([20, 120]);
  });
});
