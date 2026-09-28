import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../../db';
import { agents, locations, shared_knowledge } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { gossipTick } from '../gossipEngine';

/**
 * B13: public-knowledge spread ran twice per tick, once from the states phase
 * (lib/gossip.ts `spreadPublicKnowledge`) and once from the gossip phase. The
 * states copy is gone; these pin down that the gossip phase alone still does
 * the whole job, in a single tick, with no randomness involved.
 */

function insertLocation(name: string): number {
  return db.insert(locations).values({
    name,
    type: 'tavern',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 1, y: 4 },
    owner: null,
    capacity: 10,
    current_occupants: [],
    operating_hours: null,
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, home: number, at: number | null): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    // No personality: sections 3 and 4 (gossip sharing, secret discovery) skip
    // personality-less agents, so only the deterministic spread can add knowers.
    personality: null,
    age: 30,
    gender: 'female',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 0, y: 0 },
    current_destination: null,
    current_location: at,
    current_action: { type: 'idle' },
    action_started: 0,
    action_duration: null,
    action_queue: [],
    current_path: null,
    schedule: {
      wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [],
    },
    home,
    workplace: null,
    created_at: Date.now(),
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function insertFact(subjectId: number, sensitivity: number, knownBy: number[]): number {
  return db.insert(shared_knowledge).values({
    type: 'test',
    subject_id: subjectId,
    target_id: null,
    content: `test fact ${sensitivity}`,
    sensitivity,
    known_by: knownBy,
    created_at: Date.now(),
    is_active: true,
    source: 'observed',
  }).returning({ id: shared_knowledge.id }).get().id;
}

function knownBy(factId: number): number[] {
  const row = db.select().from(shared_knowledge).where(eq(shared_knowledge.id, factId)).get()!;
  return [...(row.known_by as number[])].sort((a, b) => a - b);
}

describe('public knowledge spread (gossip phase)', () => {
  let tavern: number;
  let elsewhere: number;
  let subject: number;
  let bystander: number;
  let farAway: number;

  beforeAll(() => {
    tavern = insertLocation('B13 tavern');
    elsewhere = insertLocation('B13 elsewhere');
    subject = insertAgent('B13 subject', tavern, tavern);
    bystander = insertAgent('B13 bystander', tavern, tavern);
    farAway = insertAgent('B13 far away', elsewhere, elsewhere);
  });

  it('teaches a public fact to everyone co-located with its subject in one tick', () => {
    const fact = insertFact(subject, 1, [subject]);

    gossipTick(0);

    expect(knownBy(fact)).toEqual([subject, bystander].sort((a, b) => a - b));
    expect(knownBy(fact)).not.toContain(farAway);
  });

  it('does not spread secrets this way', () => {
    const secret = insertFact(subject, 3, [subject]);

    gossipTick(0);

    expect(knownBy(secret)).toEqual([subject]);
  });
});
