import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, locations, simSnapshots, worldState } from '../../db/schema';
import { simEvents } from '../simEvents';
import { clearPersonalityBaselines, initPersonalityDrift } from '../personalityDrift';
import { restoreWorldCaches } from '../../engine/worldCaches';
import type { PersonalityProfile } from '../personality';

/**
 * B9: the ±15 drift cap was measured against a baseline captured lazily, in
 * memory, from the agents row — the same row the drift is written to. After a
 * restart the first drift captured the already-drifted value as the new
 * original, so every restart granted another 15 points. The baseline is now
 * checkpointed (written through the moment it is captured) and restored at boot.
 */

const BASE: PersonalityProfile = {
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50,
};

function honesty(id: number): number {
  const row = db.select({ personality: agents.personality }).from(agents).where(eq(agents.id, id)).get();
  return (row!.personality as PersonalityProfile).honesty;
}

/** 'secret:shared' drifts the sharer's honesty by +1. */
function shareSecrets(id: number, times: number): void {
  for (let i = 0; i < times; i++) simEvents.emit('secret:shared', { sharerId: id });
}

describe('personality drift cap across a restart', () => {
  let locId = 0;
  let agentId = 0;

  beforeAll(() => {
    if (!db.select().from(worldState).get()) {
      db.insert(worldState).values({
        time: { day: 2, hour: 9, minute: 0, totalTicks: 2000, seasonDay: 2, season: 'spring' },
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
    }
    db.delete(simSnapshots).run();
    locId = db.insert(locations).values({
      name: 'Drift Test House',
      type: 'house',
      position: { x: 0, y: 0, width: 4, height: 4 },
      entry_point: { x: 0, y: 0 },
      capacity: 4,
      current_occupants: [],
      services: [],
      description: 'test',
    }).returning({ id: locations.id }).get().id;
    agentId = db.insert(agents).values({
      name: 'Drifter',
      bio: 'test',
      traits: [],
      personality: { ...BASE },
      age: 30,
      gender: 'female',
      sprite_sheet: 'x',
      portrait_sprite: 'x',
      position: { x: 0, y: 0 },
      current_location: locId,
      current_action: { type: 'idle' },
      action_started: 0,
      action_queue: [],
      schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
      home: locId,
      created_at: 0,
      is_active: true,
    }).returning({ id: agents.id }).get().id;
    initPersonalityDrift();
  });

  afterAll(() => {
    db.delete(simSnapshots).run();
    db.delete(agents).where(eq(agents.id, agentId)).run();
    db.delete(locations).where(eq(locations.id, locId)).run();
  });

  it('caps at +15 within one process', () => {
    shareSecrets(agentId, 20);
    expect(honesty(agentId)).toBe(65);
  });

  it('writes the baseline through on capture, without waiting for the hourly checkpoint', () => {
    const row = db.select().from(simSnapshots).where(eq(simSnapshots.key, 'personalityBaselines')).get();
    expect(row).toBeDefined();
    expect((row!.data as Record<string, PersonalityProfile>)[agentId].honesty).toBe(50);
  });

  it('keeps the cap anchored to the original personality after a restart', () => {
    // A fresh process: the in-memory baseline is gone, the drifted row stays.
    clearPersonalityBaselines();
    restoreWorldCaches();
    shareSecrets(agentId, 10);
    // Before the fix this read 75: the first drift re-baselined at 65.
    expect(honesty(agentId)).toBe(65);
  });
});
