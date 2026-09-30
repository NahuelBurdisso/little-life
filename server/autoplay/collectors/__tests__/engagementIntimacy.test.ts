import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../db';
import { activityLog } from '../../../db/schema';
import { EngagementCollector } from '../engagementCollector';
import type { AnalysisWindow } from '../../types';

/**
 * The boredom nudger reads "dramaEvents" as how much is happening. A first kiss and a
 * night together are exactly the beats a spectator watches for, but they are typed
 * `relationship` rows (a `drama` row would be gazette-worthy: activityRegistry.ts), so
 * counting category `drama` alone left a town full of lovers looking like a desert to the
 * storyteller. The routine repeat kiss stays texture and does not count.
 */

const WINDOW: AnalysisWindow = {
  startTick: 0, endTick: 100, startMinutes: 0, endMinutes: 100, startMs: 0,
  gameHour: 12, dayPhase: 'afternoon', day: 2, season: 'spring', agentCount: 10, activeEvents: [],
};

const log = (type: string, category: string) =>
  db.insert(activityLog).values({
    type, category, importance: 0.5, agent_ids: [], template_key: type,
    template_data: {}, timestamp: 50, real_timestamp: Date.now(),
  }).run();

describe('the engagement snapshot and intimacy', () => {
  beforeEach(() => { db.delete(activityLog).run(); });

  it('counts a first kiss, an evening together, a sighting and a scandal as drama; not a routine kiss', () => {
    log('first_kiss', 'relationship');
    log('tryst', 'relationship');
    log('caught', 'drama');
    log('scandal', 'drama');
    log('kiss_rebuffed', 'drama');
    log('kiss', 'relationship');
    log('purchase', 'economy');
    expect(new EngagementCollector().collect(WINDOW).dramaEvents).toBe(5);
  });
});
