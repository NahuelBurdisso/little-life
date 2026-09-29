import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../db';
import { agents, conversations, locations, relationshipEvents, shared_knowledge } from '../../db/schema';
import { computeConversationImpact } from '../conversationImpact';

/**
 * The conversation impact numbers (ConversationDetail panel, player outcome
 * reports). Nothing links an event or a fact to its conversation, so the
 * matching is by time window and participants — these tests pin what is in
 * and what is out.
 */

const T0 = 1_900_000_000_000;

let home: number;
const ids: number[] = [];

function insertAgent(name: string): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality: null,
    age: 30,
    gender: 'female',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 0, y: 0 },
    current_action: { type: 'idle' },
    action_started: 0,
    action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home,
    created_at: 0,
    is_active: false,
  }).returning({ id: agents.id }).get().id;
}

function insertEvent(a: number, b: number, f: [number, number], t: [number, number], timestamp: number) {
  db.insert(relationshipEvents).values({
    agent_a: Math.min(a, b),
    agent_b: Math.max(a, b),
    event_type: 'conflict',
    description: 'Heated argument',
    friendship_delta_ab: f[0],
    friendship_delta_ba: f[1],
    romance_delta_ab: 0,
    romance_delta_ba: 0,
    trust_delta_ab: t[0],
    trust_delta_ba: t[1],
    sentiment: -0.6,
    processed: true,
    timestamp,
  }).run();
}

function insertFact(subject: number, content: string, createdAt: number) {
  db.insert(shared_knowledge).values({
    type: 'rumor',
    subject_id: subject,
    target_id: null,
    content,
    sensitivity: 2,
    known_by: [subject],
    created_at: createdAt,
    source: 'witnessed',
  }).run();
}

beforeAll(() => {
  home = db.insert(locations).values({
    name: 'Impact Cottage',
    type: 'home',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 0, y: 0 },
    capacity: 4,
    current_occupants: [],
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
  ids.push(insertAgent('Mara Quill'), insertAgent('Jonas Brandt'), insertAgent('Outside Olga'));
});

describe('computeConversationImpact', () => {
  it('returns null for an unknown conversation', () => {
    expect(computeConversationImpact(987654321)).toBeNull();
  });

  it('sums the pair events and facts inside the window, and nothing else', () => {
    const [mara, jonas, olga] = ids;
    const convoId = db.insert(conversations).values({
      participants: [mara, jonas],
      messages: [{ speakerId: mara, text: 'You lied to me.', sentiment: -0.7 }, { speakerId: jonas, text: 'So?', sentiment: -0.5 }],
      trigger_reason: 'player_confront',
      topic: 'confrontation',
      status: 'ended',
      started_at: T0,
      ended_at: T0 + 60_000,
      sentiment: -0.6,
      max_turns: 2,
    }).returning({ id: conversations.id }).get().id;

    insertEvent(mara, jonas, [-20, -16], [-8, -4], T0 + 60_000); // the conversation's own
    insertEvent(mara, jonas, [-10, -10], [0, 0], T0 + 63_000); // within the 5 s slack
    insertEvent(mara, jonas, [50, 50], [50, 50], T0 + 3_600_000); // an hour later: out
    insertEvent(mara, olga, [-40, -40], [0, 0], T0 + 60_000); // not this pair: out
    insertFact(jonas, 'Jonas Brandt cheats at cards', T0 + 60_000);
    insertFact(olga, 'Outside Olga hoards buttons', T0 + 60_000);

    const impact = computeConversationImpact(convoId)!;
    expect(impact.names).toEqual({ [mara]: 'Mara Quill', [jonas]: 'Jonas Brandt' });
    expect(impact.relationshipEvents).toHaveLength(2);
    expect(impact.relationshipEvents.every((e) => typeof e.id === 'number')).toBe(true);
    // Each event contributes the mean of its two directions.
    expect(impact.totals.friendship).toBe(-28);
    expect(impact.totals.trust).toBe(-6);
    expect(impact.totals.romance).toBe(0);
    expect(impact.totals.turns).toBe(2);
    expect(impact.totals.sentiment).toBe(-0.6);
    expect(impact.createdFacts.map((f) => f.content)).toEqual(['Jonas Brandt cheats at cards']);
  });

  it('uses now as the end of a conversation that is still being closed', () => {
    const [mara, jonas] = ids;
    const now = Date.now();
    const convoId = db.insert(conversations).values({
      participants: [mara, jonas],
      messages: [],
      trigger_reason: 'player_nudge',
      status: 'active',
      started_at: now - 30_000,
      ended_at: null,
      sentiment: 0,
      max_turns: 4,
    }).returning({ id: conversations.id }).get().id;
    insertEvent(mara, jonas, [6, 4], [2, 2], now);
    const impact = computeConversationImpact(convoId)!;
    expect(impact.totals.friendship).toBe(5);
    expect(impact.totals.trust).toBe(2);
  });
});
