import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../db';
import { agents, locations, shared_knowledge } from '../../db/schema';
import { getNegativeFactCount, countNegativeFactsBySubject } from '../gossip';

/**
 * The decisions phase counts negative facts per agent from the shared_knowledge
 * rows it already loaded (one Map) instead of one query per co-located agent.
 * The batch must agree with the per-agent query it replaces.
 */

let home: number;
const ids: number[] = [];

function insertAgent(name: string): number {
  return db.insert(agents).values({
    name, bio: 'test', traits: [], personality: null, age: 30, gender: 'male',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function fact(subject: number, type: string, active = true) {
  db.insert(shared_knowledge).values({
    type, subject_id: subject, target_id: null, content: `${type} about ${subject}`,
    sensitivity: 2, known_by: [subject], created_at: Date.now(), is_active: active, source: 'observed',
  }).run();
}

beforeAll(() => {
  home = db.insert(locations).values({
    name: 'Negcount Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 0, y: 0 }, capacity: 4, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  const [a, b, c] = ['Neg A', 'Neg B', 'Neg C'].map(insertAgent);
  ids.push(a, b, c);
  fact(a, 'theft'); fact(a, 'rumor'); fact(a, 'heroic'); fact(a, 'grudge', false);
  fact(b, 'affair'); fact(b, 'crush');
});

describe('countNegativeFactsBySubject', () => {
  it('matches getNegativeFactCount for every agent', () => {
    const rows = db.select().from(shared_knowledge).all();
    const counts = countNegativeFactsBySubject(rows);
    for (const id of ids) expect(counts.get(id) ?? 0).toBe(getNegativeFactCount(id));
    // theft + rumor count; heroic (positive) and the inactive grudge do not.
    expect(counts.get(ids[0])).toBe(2);
    expect(counts.get(ids[1])).toBe(1);
    expect(counts.has(ids[2])).toBe(false);
  });
});
