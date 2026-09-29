import { describe, it, expect } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog } from '../../db/schema';
import { pruneActivityLog } from '../activityLogger';
import { gameDayOfTickStamp, gameDaysToTicks } from '../gameClock';

/**
 * Memories and activity rows are still stamped in TICKS; their retention is
 * authored in GAME days. A flat 1440 ticks per day kept them four times as many
 * game days at 4x (and half as many at 0.5x).
 */

describe('game days over tick-stamped tables', () => {
  it('converts game days to ticks at the current speed', () => {
    expect(gameDaysToTicks(3, 1)).toBe(4320);
    expect(gameDaysToTicks(3, 4)).toBe(1080);
    expect(gameDaysToTicks(3, 0.5)).toBe(8640);
    expect(gameDaysToTicks(3, 0)).toBe(4320); // paused counts as 1x
  });

  it('dates a tick stamp to the game day it most likely fell on', () => {
    // Day 10, 06:00 after 5000 ticks at 4x.
    const clock = { nowTicks: 5000, nowMinutes: 10 * 1440 + 360, tickSpeed: 4 };
    expect(gameDayOfTickStamp(5000, clock)).toBe(10);
    expect(gameDayOfTickStamp(5000 - 90, clock)).toBe(10); // 360 minutes ago: 00:00
    expect(gameDayOfTickStamp(5000 - 91, clock)).toBe(9);
    expect(gameDayOfTickStamp(0, clock)).toBe(0); // never before day 0
  });
});

describe('pruneActivityLog', () => {
  it('keeps a short-tier row 3 GAME days, not 3 × 1440 ticks, at 4x', () => {
    const nowTick = 50_000_000; // far above any other test's rows' stamps
    const insert = (timestamp: number) => db.insert(activityLog).values({
      type: 'state_gained',
      category: 'state',
      importance: 0.3,
      agent_ids: [],
      template_key: 'state_gained',
      template_data: {},
      timestamp,
      real_timestamp: 0,
    }).returning({ id: activityLog.id }).get().id;

    const fresh = insert(nowTick - 1000); // 4000 game minutes ago at 4x: < 3 days
    const stale = insert(nowTick - 1100); // 4400 game minutes ago: > 3 days
    pruneActivityLog(nowTick, 4);

    const left = db.select({ id: activityLog.id }).from(activityLog)
      .where(inArray(activityLog.id, [fresh, stale])).all().map((r) => r.id);
    expect(left).toEqual([fresh]);
    db.delete(activityLog).where(inArray(activityLog.id, [fresh])).run();
  });
});
