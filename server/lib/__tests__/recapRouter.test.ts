import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, gazetteIssues, worldState } from '../../db/schema';
import { chronicleRouter } from '../../routers/chronicle';

/** `chronicle.getRecap`: the SQL window (since < minute <= now) and the headlines it hands the builder. */

const DAY = 1440;
type WorldTime = typeof worldState.$inferInsert['time'];
let originalTime: WorldTime | null = null;
let insertedWorld = false;

beforeAll(() => {
  const existing = db.select().from(worldState).limit(1).get();
  const time = { day: 3, hour: 12, minute: 0, totalTicks: 5000, seasonDay: 3, season: 'spring' };
  if (existing) {
    originalTime = existing.time;
    db.update(worldState).set({ time }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  insertedWorld = true;
  db.insert(worldState).values({
    time, day_phase: 'morning', weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true,
    last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
    map_width: 40, map_height: 30, collision_grid: '',
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

function row(minute: number, description: string, importance = 0.85, agents: number[] = []): void {
  db.insert(activityLog).values({
    type: 'confrontation', category: 'drama', importance, agent_ids: agents, template_key: 'confrontation',
    template_data: { description }, timestamp: 1, game_minute: minute, real_timestamp: Date.now(),
  }).run();
}

describe('chronicle.getRecap', () => {
  it('reads the span since the given minute up to now, with the paper', async () => {
    row(2 * DAY + 100, 'Too early', 0.9, [1, 2]);
    row(2 * DAY + 600, 'Mid-span fight', 0.9, [3, 4]);
    row(2 * DAY + 700, 'Too small', 0.3, [5, 6]);
    row(3 * DAY + 13 * 60, 'In the future', 0.9, [7, 8]);
    db.insert(gazetteIssues).values({
      day: 2, season: 'spring', headline: 'Fists at the Mill', articles: [], covers_to_tick: 0, created_at: 0,
    }).run();

    const caller = chronicleRouter.createCaller({});
    const recap = await caller.getRecap({ sinceMinute: 2 * DAY + 200 });
    expect(recap.untilMinute).toBe(3 * DAY + 12 * 60);
    expect(recap.bullets.map((b) => b.text)).toEqual([
      'The Town Crier, day 2: “Fists at the Mill”',
      'Mid-span fight.',
    ]);
  });

  it('is empty for a quiet span', async () => {
    const caller = chronicleRouter.createCaller({});
    expect((await caller.getRecap({ sinceMinute: 3 * DAY })).bullets).toEqual([]);
  });
});
