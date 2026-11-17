import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, gazetteIssues, worldState } from '../../db/schema';
import { logActivity } from '../activityLogger';
import { getTimeline, seasonOfDay } from '../timeline';
import { activityRouter } from '../../routers/activity';

/**
 * The town timeline: game_minute stamping, day grouping, the resident filter
 * (which must include what happened TO a resident), and cursor paging.
 */

const DAY = 1440;
const at = (day: number, hour = 12, minute = 0) => day * DAY + hour * 60 + minute;

type WorldTime = typeof worldState.$inferInsert['time'];
let originalTime: WorldTime | null = null;
let insertedWorld = false;

function setClock(time: Partial<WorldTime>): void {
  const row = db.select({ id: worldState.id }).from(worldState).limit(1).get()!;
  db.update(worldState)
    .set({ time: { day: 1, hour: 9, minute: 0, totalTicks: 540, seasonDay: 1, season: 'spring', ...time } })
    .where(eq(worldState.id, row.id))
    .run();
}

beforeAll(() => {
  const existing = db.select().from(worldState).limit(1).get();
  if (existing) {
    originalTime = existing.time;
    return;
  }
  insertedWorld = true;
  db.insert(worldState).values({
    time: { day: 1, hour: 9, minute: 0, totalTicks: 540, seasonDay: 1, season: 'spring' },
    day_phase: 'morning',
    weather: 'sunny',
    weather_duration: 120,
    tick_speed: 1,
    is_paused: true,
    last_tick_completed: 0,
    current_tick_phase: 0,
    tick_id: 'test',
    pending_transitions: [],
    tax_pool: 0,
    map_width: 40,
    map_height: 30,
    collision_grid: '',
  }).run();
});

afterAll(() => {
  db.delete(activityLog).run();
  db.delete(gazetteIssues).run();
  if (insertedWorld) db.delete(worldState).run();
  else if (originalTime) db.update(worldState).set({ time: originalTime }).run();
});

beforeEach(() => {
  db.delete(activityLog).run();
  db.delete(gazetteIssues).run();
});

/** A row with a chosen clock stamp, bypassing logActivity's world read. */
function row(opts: {
  minute: number | null;
  importance?: number;
  category?: string;
  initiator?: number | null;
  target?: number | null;
  agents?: number[];
  type?: string;
}): number {
  return db.insert(activityLog).values({
    type: opts.type ?? 'drama',
    category: opts.category ?? 'drama',
    importance: opts.importance ?? 0.8,
    initiator_id: opts.initiator ?? null,
    target_id: opts.target ?? null,
    agent_ids: opts.agents ?? [],
    template_key: opts.type ?? 'drama',
    template_data: { description: `event@${opts.minute}` },
    timestamp: 1,
    game_minute: opts.minute,
    real_timestamp: Date.now(),
  }).returning({ id: activityLog.id }).get().id;
}

describe('activity_log.game_minute stamping', () => {
  it('logActivity copies the world clock into the row', () => {
    setClock({ day: 4, hour: 15, minute: 30, totalTicks: 9999 });
    logActivity({ type: 'drama', initiator: 1, templateData: { description: 'a scene' } });
    const stored = db.select().from(activityLog).get()!;
    expect(stored.game_minute).toBe(4 * DAY + 15 * 60 + 30);
    // ... while `timestamp` stays the tick count the retention pass reads.
    expect(stored.timestamp).toBe(9999);
  });

  it('floors the fractional minute of a 0.5x clock', () => {
    setClock({ day: 2, hour: 0, minute: 12.5, totalTicks: 5 });
    logActivity({ type: 'drama', templateData: { description: 'x' } });
    expect(db.select().from(activityLog).get()!.game_minute).toBe(2 * DAY + 12);
  });
});

describe('getTimeline', () => {
  it('groups by game day, newest day first, with the season', () => {
    row({ minute: at(2, 9) });
    row({ minute: at(3, 8) });
    row({ minute: at(3, 20) });
    const { days } = getTimeline();
    expect(days.map((d) => d.day)).toEqual([3, 2]);
    expect(days[0].events.map((e) => e.game_minute)).toEqual([at(3, 8), at(3, 20)]);
    expect(days[0].season).toBe('spring');
    expect(seasonOfDay(28)).toBe('summer');
    expect(seasonOfDay(28 * 4)).toBe('spring');
  });

  it('drops rows under minImportance and rows with no clock stamp', () => {
    row({ minute: at(1), importance: 0.9 });
    row({ minute: at(1), importance: 0.3 });
    row({ minute: null, importance: 0.9 });
    expect(getTimeline().days[0].events).toHaveLength(1);
    expect(getTimeline({ minImportance: 0 }).days[0].events).toHaveLength(2);
  });

  it('alwaysCategories shows low-importance rows of those categories only', () => {
    // A whisper is 0.4 by design: under the 0.6 "Notable" bar, still part of the resident's story.
    const whisper = row({ minute: at(1, 9), importance: 0.4, category: 'player', type: 'player_whisper', initiator: 7, agents: [7] });
    row({ minute: at(1, 10), importance: 0.4, category: 'routine', initiator: 7, agents: [7] });
    const big = row({ minute: at(1, 11), importance: 0.9, initiator: 7, agents: [7] });
    const plain = getTimeline({ agentId: 7 }).days.flatMap((d) => d.events.map((e) => e.id));
    expect(plain).toEqual([big]);
    const withPlayer = getTimeline({ agentId: 7, alwaysCategories: ['player'] }).days.flatMap((d) => d.events.map((e) => e.id));
    expect(withPlayer.sort()).toEqual([whisper, big].sort());
    // Still scoped to the resident: another resident's player row stays out.
    row({ minute: at(1, 12), importance: 0.4, category: 'player', initiator: 8, agents: [8] });
    expect(getTimeline({ agentId: 7, alwaysCategories: ['player'] }).days.flatMap((d) => d.events)).toHaveLength(2);
  });

  it('filters by category and by day', () => {
    row({ minute: at(1), category: 'drama' });
    row({ minute: at(1), category: 'goal' });
    row({ minute: at(2), category: 'drama' });
    expect(getTimeline({ categories: ['goal'] }).days.flatMap((d) => d.events)).toHaveLength(1);
    const only = getTimeline({ day: 2 });
    expect(only.days.map((d) => d.day)).toEqual([2]);
  });

  it('attaches the Town Crier headline for that day (newest edition wins)', () => {
    row({ minute: at(5) });
    row({ minute: at(6) });
    const base = { season: 'spring', articles: [], covers_to_tick: 0, created_at: 0 };
    db.insert(gazetteIssues).values([
      { ...base, day: 5, headline: 'First draft' },
      { ...base, day: 5, headline: 'Baker Weds Smith' },
    ]).run();
    const { days } = getTimeline();
    expect(days.find((d) => d.day === 5)!.headline).toBe('Baker Weds Smith');
    expect(days.find((d) => d.day === 6)!.headline).toBeNull();
  });

  describe('resident filter', () => {
    it('finds what happened TO the resident, not only what they did', () => {
      const did = row({ minute: at(1), initiator: 7, agents: [7] });
      const targeted = row({ minute: at(1), initiator: 8, target: 7, agents: [8] });
      const listed = row({ minute: at(1), initiator: 8, agents: [8, 9, 7] });
      row({ minute: at(1), initiator: 8, target: 9, agents: [8, 9] });
      const ids = getTimeline({ agentId: 7 }).days.flatMap((d) => d.events.map((e) => e.id));
      expect(ids.sort()).toEqual([did, targeted, listed].sort());
    });

    it('does not confuse ids that share digits', () => {
      row({ minute: at(1), agents: [17, 70] });
      expect(getTimeline({ agentId: 7 }).days).toHaveLength(0);
    });

    it('activity.getRecent uses the same involvement filter', async () => {
      row({ minute: at(1), initiator: 8, agents: [8, 7] });
      row({ minute: at(1), initiator: 8, agents: [8] });
      const caller = activityRouter.createCaller({});
      const rows = await caller.getRecent({ agentId: 7 });
      expect(rows).toHaveLength(1);
    });
  });

  it('orders a day by importance for the Story tab', () => {
    row({ minute: at(1, 8), importance: 0.7 });
    row({ minute: at(1, 9), importance: 0.95 });
    row({ minute: at(1, 10), importance: 0.7 });
    const events = getTimeline({ order: 'importance' }).days[0].events;
    expect(events.map((e) => e.importance)).toEqual([0.95, 0.7, 0.7]);
    // Ties fall back to time.
    expect(events[1].game_minute!).toBeLessThan(events[2].game_minute!);
  });

  describe('paging', () => {
    it('walks back through the log with the cursor, no gaps or repeats', () => {
      for (let day = 1; day <= 6; day++) {
        row({ minute: at(day, 8) });
        row({ minute: at(day, 18) });
      }
      const seen: number[] = [];
      let cursor: number | undefined;
      let pages = 0;
      do {
        const page = getTimeline({ limit: 4, cursor });
        seen.push(...page.days.flatMap((d) => d.events.map((e) => e.id)));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor != null && pages < 10);
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
      expect(pages).toBe(3);
    });

    it('finishes the oldest day it touched instead of splitting it', () => {
      row({ minute: at(1, 8) });
      for (let i = 0; i < 5; i++) row({ minute: at(2, 8 + i) });
      const page = getTimeline({ limit: 3 });
      // limit 3 lands mid-day-2; the page still carries all five of its rows.
      expect(page.days).toHaveLength(1);
      expect(page.days[0].events).toHaveLength(5);
      const next = getTimeline({ limit: 3, cursor: page.nextCursor! });
      expect(next.days.map((d) => d.day)).toEqual([1]);
      expect(next.nextCursor).toBeNull();
    });

    it('returns a null cursor when the log is exhausted', () => {
      row({ minute: at(1) });
      expect(getTimeline({ limit: 5 }).nextCursor).toBeNull();
      expect(getTimeline({ limit: 1 }).nextCursor).toBeNull();
    });

    it('keeps the resident filter across pages', () => {
      for (let day = 1; day <= 4; day++) {
        row({ minute: at(day), initiator: 3, agents: [3] });
        row({ minute: at(day), initiator: 4, target: 5, agents: [4, 5] });
      }
      const first = getTimeline({ agentId: 5, limit: 2 });
      const second = getTimeline({ agentId: 5, limit: 2, cursor: first.nextCursor! });
      const ids = [...first.days, ...second.days].flatMap((d) => d.events);
      expect(ids.every((e) => e.target_id === 5)).toBe(true);
      expect(new Set([...first.days, ...second.days].map((d) => d.day)).size).toBe(4);
    });
  });

  it('is reachable through the router', async () => {
    row({ minute: at(3) });
    const caller = activityRouter.createCaller({});
    const page = await caller.getTimeline({ limit: 10 });
    expect(page.days[0].day).toBe(3);
    // Input defaults: no input at all is valid.
    expect((await caller.getTimeline()).days).toHaveLength(1);
  });
});
