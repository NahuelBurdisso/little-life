import { describe, it, expect, beforeAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agents, locations, shared_knowledge } from '../../db/schema';
import {
  arrestableFactsBySubject, inPostReleaseCooldown, lastSentenceEnds, markFactsPaid,
  POST_RELEASE_COOLDOWN_MINUTES,
} from '../arrests';

/**
 * The serial-arrest loop: facts never expire and the arrest count included earlier arrests
 * and seduction rumors, so the constable re-jailed the same residents on every release
 * (29 arrests in 10 days at 32 residents). A sentence now pays for its facts, and a released
 * resident gets a cooldown.
 */

const f = (id: number, subject_id: number, type: string, over: { is_active?: boolean; paid_at?: number | null } = {}) =>
  ({ id, subject_id, type, is_active: true, paid_at: null, ...over });

describe('arrestableFactsBySubject (pure)', () => {
  it('counts crimes, not earlier arrests, seduction rumors, grudges or crushes', () => {
    const facts = [
      f(1, 7, 'theft'), f(2, 7, 'arrest'), f(3, 7, 'seduction'), f(4, 7, 'grudge'), f(5, 7, 'crush'),
      f(6, 7, 'drunk_incident'), f(7, 8, 'affair'),
    ];
    const by = arrestableFactsBySubject(facts);
    expect(by.get(7)!.map((x) => x.type)).toEqual(['theft', 'drunk_incident']);
    expect(by.get(8)!.map((x) => x.type)).toEqual(['affair']);
  });

  it('skips facts already paid for and inactive ones', () => {
    const by = arrestableFactsBySubject([
      f(1, 7, 'theft', { paid_at: 5000 }), f(2, 7, 'rumor', { is_active: false }), f(3, 7, 'work_issue'),
    ]);
    expect(by.get(7)!.map((x) => x.id)).toEqual([3]);
  });

  it('holds a released resident off for the cooldown after their latest sentence', () => {
    const ends = lastSentenceEnds([f(1, 7, 'theft', { paid_at: 1000 }), f(2, 7, 'rumor', { paid_at: 3000 }), f(3, 8, 'theft')]);
    expect(ends.get(7)).toBe(3000);
    expect(ends.has(8)).toBe(false);
    expect(inPostReleaseCooldown(ends, 7, 3000 + POST_RELEASE_COOLDOWN_MINUTES - 1)).toBe(true);
    expect(inPostReleaseCooldown(ends, 7, 3000 + POST_RELEASE_COOLDOWN_MINUTES)).toBe(false);
    expect(inPostReleaseCooldown(ends, 8, 0)).toBe(false);
  });
});

describe('markFactsPaid', () => {
  let subject: number;
  const ids: number[] = [];

  beforeAll(() => {
    const home = db.insert(locations).values({
      name: 'Jail Test Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 },
      entry_point: { x: 0, y: 0 }, capacity: 4, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    subject = db.insert(agents).values({
      name: 'Jail Bird', bio: 'test', traits: [], personality: null, age: 30, gender: 'male',
      sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
      current_action: { type: 'idle' }, action_started: 0, action_queue: [],
      schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
      home, created_at: 0, is_active: true,
    }).returning({ id: agents.id }).get().id;
    for (const type of ['theft', 'rumor', 'work_issue']) {
      ids.push(db.insert(shared_knowledge).values({
        type, subject_id: subject, target_id: null, content: `${type}`, sensitivity: 2, known_by: [subject],
        created_at: Date.now(), is_active: true, source: 'observed',
      }).returning({ id: shared_knowledge.id }).get().id);
    }
  });

  it('stamps the sentence end on exactly the facts it was for; the record then stops counting', () => {
    markFactsPaid(ids.slice(0, 2), 9000);
    const rows = db.select().from(shared_knowledge).where(inArray(shared_knowledge.id, ids)).all();
    expect(rows.map((r) => r.paid_at)).toEqual([9000, 9000, null]);
    const live = db.select().from(shared_knowledge).where(eq(shared_knowledge.subject_id, subject)).all();
    expect(arrestableFactsBySubject(live).get(subject)!.map((r) => r.type)).toEqual(['work_issue']);
  });
});
