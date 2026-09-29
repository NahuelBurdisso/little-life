import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, relationshipEvents, relationships } from '../../../db/schema';
import { deriveStatus, tick as relationshipsTick } from '../relationships';
import { gameMinutes } from '../../../lib/gameClock';
import { CONFIG } from '../../../lib/constants';

/**
 * Life milestones need two things from the relationship phase: the game minute
 * a pair reached its status (`status_since_minute`, the proposal clock), and a
 * `married` pair that thresholds alone can't demote.
 */

const TIME = { day: 30, hour: 10, minute: 0 };
const NOW_MINUTES = gameMinutes(TIME);
const WORLD_NO_HOUR = { time: TIME, tick_speed: 1, pending_transitions: [] };
const WORLD_HOUR = { time: TIME, tick_speed: 1, pending_transitions: [{ type: 'hour_changed' }] };

let homeId: number;
let ids: number[] = [];

function insertAgent(name: string): number {
  return db.insert(agents).values({
    name, bio: 'test', traits: [], personality: null, age: 30, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, created_at: 0,
    // Inactive: keeps the proximity pass away from these rows.
    is_active: false,
  }).returning({ id: agents.id }).get().id;
}

function insertPair(a: number, b: number, over: Partial<typeof relationships.$inferInsert> = {}): number {
  return db.insert(relationships).values({
    agent_a: Math.min(a, b), agent_b: Math.max(a, b),
    friendship_ab: 60, friendship_ba: 60, romance_ab: 80, romance_ba: 80,
    trust_ab: 50, trust_ba: 50, familiarity: 60, interaction_count: 10,
    last_interaction: 0, last_interaction_minute: NOW_MINUTES,
    average_interaction_sentiment: 0.3, tags: ['partner'], status: 'partners',
    status_since_minute: NOW_MINUTES - 5000,
    created_at: 0, last_updated: 0, ...over,
  }).returning({ id: relationships.id }).get().id;
}

function hurt(a: number, b: number, romanceDelta: number): void {
  db.insert(relationshipEvents).values({
    agent_a: a, agent_b: b, event_type: 'conversation', description: 'test',
    friendship_delta_ab: 0, friendship_delta_ba: 0,
    romance_delta_ab: romanceDelta, romance_delta_ba: romanceDelta,
    trust_delta_ab: 0, trust_delta_ba: 0, sentiment: -0.2, processed: false, timestamp: Date.now(),
  }).run();
}

const row = (id: number) => db.select().from(relationships).where(eq(relationships.id, id)).get()!;

describe('relationship status clock and married stickiness', () => {
  beforeAll(() => {
    homeId = db.insert(locations).values({
      name: 'Clock Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 },
      entry_point: { x: 0, y: 0 }, capacity: 4, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    ids = ['Aurelia Quillfeather', 'Barnaby Thistlewood', 'Clementine Hartwell', 'Desmond Ravensworth',
      'Eulalia Brightwater', 'Fitzgerald Oakhollow'].map(insertAgent);
  });

  afterAll(() => {
    db.delete(relationshipEvents).where(inArray(relationshipEvents.agent_a, ids)).run();
    db.delete(relationships).where(inArray(relationships.agent_a, ids)).run();
    db.delete(agents).where(inArray(agents.id, ids)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
  });

  it('deriveStatus keeps a married pair at partners whatever the thresholds say', () => {
    expect(deriveStatus(10, 10, 5, 5, 0, 50)).toBe('acquaintances');
    expect(deriveStatus(10, 10, 5, 5, 0, 50, false, true)).toBe('partners');
    expect(deriveStatus(-60, -60, 0, 0, 0, 50, false, true)).toBe('partners');
    // Estrangement is the one thing that still outranks it.
    expect(deriveStatus(-90, -90, 0, 0, 0, 50, true, true)).toBe('estranged');
  });

  it('stamps status_since_minute when the status changes, and only then', () => {
    const since = NOW_MINUTES - 5000;
    const steady = insertPair(ids[0], ids[1]);
    const falling = insertPair(ids[2], ids[3]);
    hurt(ids[0], ids[1], -1);   // still partners
    hurt(ids[2], ids[3], -40);  // below the partners line
    relationshipsTick(WORLD_NO_HOUR);
    expect(row(steady).status).toBe('partners');
    expect(row(steady).status_since_minute).toBe(since);
    expect(row(falling).status).toBe('romantic_interest');
    expect(row(falling).status_since_minute).toBe(NOW_MINUTES);
  });

  it('a married couple stays partners through a romance slump and through decay', () => {
    const id = insertPair(ids[4], ids[5], {
      tags: ['partner', 'married'],
      last_interaction_minute: NOW_MINUTES - CONFIG.RELATIONSHIPS.DECAY_GRACE_PERIOD_DAYS * 1440 - 20 * 1440,
    });
    hurt(ids[4], ids[5], -60);
    relationshipsTick(WORLD_HOUR);
    const r = row(id);
    expect(Math.min(r.romance_ab, r.romance_ba)).toBeLessThan(70);
    expect(r.status).toBe('partners');
    expect(r.tags).toContain('married');
  });
});
