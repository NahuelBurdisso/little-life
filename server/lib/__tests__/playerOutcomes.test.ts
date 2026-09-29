import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  activityLog,
  agents,
  conversations,
  locations,
  relationshipEvents,
  relationships,
  shared_knowledge,
} from '../../db/schema';
import { simEvents } from '../simEvents';
import { tick as relationshipsTick } from '../../engine/systems/relationships';
import { clearPlayerOutcomes, describeExpired, describeOutcome, statusClause } from '../playerOutcomes';
import { gatherMaterial } from '../gazette';

/**
 * What the player hears back about a nudge. The report is written once per
 * conversation, only for player-caused ones, and only after the relationships
 * phase has applied the conversation's events — which is what lets it say
 * "now rivals".
 */

const WORLD = { time: { day: 3, hour: 10, minute: 0 }, tick_speed: 1, pending_transitions: [] };

let home: number;

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
    // Inactive: keeps the relationships phase's proximity pass off these rows.
    is_active: false,
  }).returning({ id: agents.id }).get().id;
}

function insertRelationship(a: number, b: number, friendship: number, status: string) {
  db.insert(relationships).values({
    agent_a: Math.min(a, b),
    agent_b: Math.max(a, b),
    friendship_ab: friendship,
    friendship_ba: friendship,
    romance_ab: 0,
    romance_ba: 0,
    trust_ab: 0,
    trust_ba: 0,
    familiarity: 20,
    interaction_count: 3,
    last_interaction: Date.now(),
    last_interaction_minute: 0,
    average_interaction_sentiment: 0,
    tags: [],
    status,
    created_at: 0,
    last_updated: 0,
  }).run();
}

/**
 * The shape `finishCompletedConversation` leaves behind at the moment it emits
 * `conversation:ended`: the row still open, its relationship event unprocessed.
 */
function stageConversation(a: number, b: number, trigger: string, sentiment: number, friendshipDelta: number): number {
  const now = Date.now();
  const id = db.insert(conversations).values({
    participants: [a, b],
    messages: [
      { speakerId: a, text: 'We need to talk.', sentiment },
      { speakerId: b, text: 'Do we.', sentiment },
    ],
    trigger_reason: trigger,
    topic: 'confrontation',
    status: 'active',
    started_at: now - 20_000,
    sentiment,
    max_turns: 2,
  }).returning({ id: conversations.id }).get().id;
  db.insert(relationshipEvents).values({
    agent_a: Math.min(a, b),
    agent_b: Math.max(a, b),
    event_type: 'conflict',
    description: 'Heated argument',
    friendship_delta_ab: friendshipDelta,
    friendship_delta_ba: friendshipDelta,
    romance_delta_ab: 0,
    romance_delta_ba: 0,
    trust_delta_ab: -6,
    trust_delta_ba: -6,
    sentiment,
    processed: false,
    timestamp: now,
  }).run();
  return id;
}

function endConversation(id: number, a: number, b: number) {
  // Once per participant, as the completion pipeline does.
  simEvents.emit('conversation:ended', { agentId: a, perpetratorId: b, conversationId: id, otherName: 'x' });
  simEvents.emit('conversation:ended', { agentId: b, perpetratorId: a, conversationId: id, otherName: 'x' });
  db.update(conversations).set({ status: 'ended', ended_at: Date.now() }).where(eq(conversations.id, id)).run();
}

function rowsOf(type: string, agentIds: number[]) {
  return db.select().from(activityLog).where(eq(activityLog.type, type)).all()
    .filter((r) => agentIds.every((id) => (r.agent_ids as number[]).includes(id)));
}

beforeAll(() => {
  home = db.insert(locations).values({
    name: 'Outcome Cottage',
    type: 'home',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 0, y: 0 },
    capacity: 4,
    current_occupants: [],
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
});

beforeEach(() => {
  clearPlayerOutcomes();
  // Other tests' leftovers must not be applied into these assertions.
  db.update(relationshipEvents).set({ processed: true }).where(eq(relationshipEvents.processed, false)).run();
});

describe('wording', () => {
  it('reads as a human sentence with deltas, status and a fact', () => {
    expect(describeOutcome({
      trigger: 'player_confront', names: ['Mara Quill', 'Jonas Brandt'],
      friendship: -18.4, romance: 0.2, trust: -6, sentiment: -0.7,
      status: { from: 'acquaintances', to: 'rivals' },
      fact: 'Jonas Brandt cheats at cards',
    })).toBe('Your confrontation: Mara & Jonas — it turned ugly (friendship −18, trust −6), now rivals. Word got out that Jonas Brandt cheats at cards.');
  });

  it('leaves out what did not move and names a template fallback for what it is', () => {
    expect(describeOutcome({
      trigger: 'player_nudge (template)', names: ['Ana Ruiz', 'Tom Hale'],
      friendship: 0.3, romance: 0, trust: 0, sentiment: 0.4, status: { from: 'friends', to: 'friends' },
    })).toBe('Your nudge: Ana & Tom — they only traded a few words.');
    expect(describeOutcome({
      trigger: 'player_confront', names: ['Ana Ruiz', 'Tom Hale'],
      friendship: 9, romance: 0, trust: 4, sentiment: 0.6,
    })).toBe('Your confrontation: Ana & Tom — they made peace (friendship +9, trust +4).');
  });

  it('phrases statuses and expiries', () => {
    expect(statusClause('partners')).toBe('now a couple');
    expect(statusClause('estranged')).toBe('estranged for good');
    expect(statusClause('some_new_status')).toBe('now some new status');
    expect(describeExpired('player_confront', ['Mara Quill', 'Jonas Brandt'], 'apart'))
      .toBe('Your confrontation never happened: Mara & Jonas never found each other.');
    expect(describeExpired('player_nudge', ['Mara Quill', 'Jonas Brandt'], 'busy'))
      .toBe("Your nudge came to nothing: Mara & Jonas couldn't break away from what they were doing.");
  });
});

describe('conversation outcomes', () => {
  it('waits for the relationships phase, then reports once with the status change', () => {
    const mara = insertAgent('Mara Quill');
    const jonas = insertAgent('Jonas Brandt');
    insertRelationship(mara, jonas, -30, 'acquaintances');
    const id = stageConversation(mara, jonas, 'player_confront', -0.7, -30);

    endConversation(id, mara, jonas);
    // The events are still unapplied: no report yet, or it could not know the status.
    expect(rowsOf('player_outcome', [mara, jonas])).toHaveLength(0);

    relationshipsTick(WORLD);
    const rows = rowsOf('player_outcome', [mara, jonas]);
    expect(rows).toHaveLength(1);
    const text = String((rows[0].template_data as Record<string, unknown>).description);
    expect(text).toMatch(/^Your confrontation: Mara & Jonas — it turned ugly \(friendship −\d+, trust −\d+\), now rivals\.$/);
    expect(rows[0].importance).toBeGreaterThanOrEqual(0.8);
    expect(rows[0].category).toBe('player');

    // A late duplicate emit (a second completion racing the first) changes nothing.
    endConversation(id, mara, jonas);
    relationshipsTick(WORLD);
    expect(rowsOf('player_outcome', [mara, jonas])).toHaveLength(1);
  });

  it('reports a nudge that fell back to a template chat', () => {
    const ana = insertAgent('Ana Ruiz');
    const tom = insertAgent('Tom Hale');
    const id = stageConversation(ana, tom, 'player_nudge (template)', 0.2, 2);
    endConversation(id, ana, tom);
    relationshipsTick(WORLD);
    const rows = rowsOf('player_outcome', [ana, tom]);
    expect(rows).toHaveLength(1);
    expect(String((rows[0].template_data as Record<string, unknown>).description))
      .toContain('Your nudge: Ana & Tom — they only traded a few words');
  });

  it('ignores conversations the player did not cause', () => {
    const a = insertAgent('Plain Pia');
    const b = insertAgent('Plain Paul');
    const id = stageConversation(a, b, 'proximity', -0.7, -30);
    endConversation(id, a, b);
    relationshipsTick(WORLD);
    expect(rowsOf('player_outcome', [a, b])).toHaveLength(0);
  });

  it('keeps player reports out of the town paper', () => {
    const a = insertAgent('Paper Pam');
    const b = insertAgent('Paper Pete');
    const id = stageConversation(a, b, 'player_confront', -0.7, -30);
    endConversation(id, a, b);
    relationshipsTick(WORLD);
    expect(rowsOf('player_outcome', [a, b])).toHaveLength(1);
    const material = gatherMaterial(-1);
    expect(material.items.some((line) => line.startsWith('Your confrontation'))).toBe(false);
  });
});

describe('nudges that never happened', () => {
  it('logs a dropped player entry and nothing for the town\'s own', () => {
    const a = insertAgent('Lena Moss');
    const b = insertAgent('Luis Pardo');
    simEvents.emit('conversation:queue_dropped', {
      entry: { participants: [a, b], trigger_reason: 'player_confront' },
      reason: 'apart',
    });
    simEvents.emit('conversation:queue_dropped', {
      entry: { participants: [a, b], trigger_reason: 'proximity' },
      reason: 'busy',
    });
    const rows = rowsOf('player_nudge_expired', [a, b]);
    expect(rows).toHaveLength(1);
    expect(String((rows[0].template_data as Record<string, unknown>).description))
      .toBe('Your confrontation never happened: Lena & Luis never found each other.');
    expect(rows[0].importance).toBeGreaterThanOrEqual(0.8);
  });
});

describe('planted rumors', () => {
  // source_id alone collides with the conversation reports' ids.
  const rumorRows = (factId: number) => db.select().from(activityLog).where(and(
    eq(activityLog.type, 'player_outcome'),
    eq(activityLog.source_type, 'shared_knowledge'),
    eq(activityLog.source_id, factId),
  )).all();

  it('reports once when the rumor reaches its subject', () => {
    const subject = insertAgent('Rosa Chen');
    const teller = insertAgent('Ray Dunn');
    const factId = db.insert(shared_knowledge).values({
      type: 'rumor', subject_id: subject, target_id: null, content: 'Rosa Chen is secretly broke',
      sensitivity: 3, known_by: [teller], created_at: Date.now(), source: 'fabricated', reliability: 'unverified',
    }).returning({ id: shared_knowledge.id }).get().id;

    simEvents.emit('rumor:reached_subject', { factId, subjectId: subject, tellerId: teller });
    simEvents.emit('rumor:reached_subject', { factId, subjectId: subject, tellerId: teller });

    const rows = rumorRows(factId);
    expect(rows).toHaveLength(1);
    expect(String((rows[0].template_data as Record<string, unknown>).description))
      .toBe('Your rumor reached Rosa — who is furious with Ray for repeating it.');
  });

  it('stays quiet for a rumor the player did not plant', () => {
    const subject = insertAgent('Quiet Quinn');
    const teller = insertAgent('Quiet Quade');
    const factId = db.insert(shared_knowledge).values({
      type: 'rumor', subject_id: subject, target_id: null, content: 'Quinn hoards buttons',
      sensitivity: 2, known_by: [teller], created_at: Date.now(), source: 'fabricated',
    }).returning({ id: shared_knowledge.id }).get().id;
    simEvents.emit('rumor:reached_subject', { factId, subjectId: subject, tellerId: teller });
    expect(rumorRows(factId)).toHaveLength(0);
  });
});
