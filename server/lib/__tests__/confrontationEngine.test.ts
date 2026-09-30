import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agentStates, agents, locations, relationshipEvents, relationships, shared_knowledge } from '../../db/schema';
import {
  COOLDOWN_MINUTES, FEUD_FRIENDSHIP, PENDING_WAIT_MINUTES,
  clearConfrontationCooldowns, confrontationCast, confrontationChance, confrontationCheck,
  handleCascadeConfrontation, pendingConfrontationPairs,
} from '../confrontationEngine';

/**
 * The confrontation engine: who qualifies for the hourly roll (a pair at -20 or with a
 * grudge/rival tag), the game-minute cooldown, and the cascade's confrontation requests
 * turned into scenes — now when the pair shares a room, at their next meeting otherwise.
 */

let tavern: number;
let square: number;
let ids: number[] = [];
let [ada, bram, cleo, kid] = [0, 0, 0, 0];

function insertAgent(name: string, at: number, age = 30): number {
  return db.insert(agents).values({
    name, bio: 'test', traits: [], personality: null, age, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: at, current_location: at, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function insertLocation(name: string): number {
  return db.insert(locations).values({
    name, type: 'tavern', position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 0, y: 0 }, capacity: 20, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function moveTo(agentId: number, locationId: number): void {
  db.update(agents).set({ current_location: locationId }).where(eq(agents.id, agentId)).run();
}

function eventsBetween(x: number, y: number) {
  return db.select().from(relationshipEvents).where(or(
    and(eq(relationshipEvents.agent_a, x), eq(relationshipEvents.agent_b, y)),
    and(eq(relationshipEvents.agent_a, y), eq(relationshipEvents.agent_b, x)),
  )).all();
}

const cascade = { chainId: 'test', chainDepth: 1, parentRuleId: 'jealousy_confrontation' };

function cleanup(): void {
  db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, ids), inArray(relationshipEvents.agent_b, ids))).run();
  db.delete(activityLog).where(or(inArray(activityLog.initiator_id, ids), inArray(activityLog.target_id, ids))).run();
  db.delete(agentStates).where(inArray(agentStates.agent_id, ids)).run();
  db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, ids), inArray(shared_knowledge.target_id, ids))).run();
  db.delete(relationships).where(or(inArray(relationships.agent_a, ids), inArray(relationships.agent_b, ids))).run();
}

beforeAll(() => {
  tavern = insertLocation('Confrontation Test Tavern');
  square = insertLocation('Confrontation Test Square');
  ada = insertAgent('Ada Confront', tavern);
  bram = insertAgent('Bram Confront', tavern);
  cleo = insertAgent('Cleo Confront', tavern);
  kid = insertAgent('Kit Confront', tavern, 12);
  ids = [ada, bram, cleo, kid];
});

afterAll(() => {
  cleanup();
  db.delete(agents).where(inArray(agents.id, ids)).run();
  db.delete(locations).where(inArray(locations.id, [tavern, square])).run();
});

beforeEach(() => {
  cleanup();
  clearConfrontationCooldowns();
  for (const id of ids) moveTo(id, tavern);
  // 0.5: an escalation (0.3..0.7), and above any hourly roll other seeded pairs could make.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('confrontationChance', () => {
  it('a pair above the feud line with no tag never rolls', () => {
    expect(confrontationChance({ avgFriendship: FEUD_FRIENDSHIP + 1, tags: [] })).toBe(0);
    expect(confrontationChance({ avgFriendship: 30, tags: ['friend'] })).toBe(0);
  });

  it('starts at the 3% base on the line and scales to 15% at -100', () => {
    expect(confrontationChance({ avgFriendship: -20, tags: [] })).toBeCloseTo(0.03);
    expect(confrontationChance({ avgFriendship: -40, tags: [] })).toBeCloseTo(0.06);
    expect(confrontationChance({ avgFriendship: -100, tags: [] })).toBeCloseTo(0.15);
  });

  it('a grudge or rival tag qualifies a pair whatever the numbers, at the base', () => {
    expect(confrontationChance({ avgFriendship: 10, tags: ['grudge'] })).toBeCloseTo(0.03);
    expect(confrontationChance({ avgFriendship: 0, tags: ['rival'] })).toBeCloseTo(0.03);
  });

  it('aggression and drink raise it', () => {
    const base = confrontationChance({ avgFriendship: -20, tags: [] });
    expect(confrontationChance({ avgFriendship: -20, tags: [], aggressionA: 80 })).toBeCloseTo(base + 0.05);
    expect(confrontationChance({ avgFriendship: -20, tags: [], drunkA: true, drunkB: true })).toBeCloseTo(base + 0.2);
  });
});

describe('confrontationCast', () => {
  it('a ripple rule: the agent confronts the other party', () => {
    expect(confrontationCast({ agentId: 1, perpetratorId: 1, victimId: 2 })).toEqual({ initiatorId: 1, targetId: 2 });
  });

  it('a witness stepping in confronts the perpetrator', () => {
    expect(confrontationCast({ agentId: 3, perpetratorId: 1, victimId: 2 })).toEqual({ initiatorId: 3, targetId: 1 });
  });

  it('nobody else named: nothing to stage', () => {
    expect(confrontationCast({ agentId: 1 })).toBeNull();
    expect(confrontationCast({ agentId: 1, perpetratorId: 1 })).toBeNull();
    expect(confrontationCast({})).toBeNull();
  });
});

describe('handleCascadeConfrontation', () => {
  const request = (from: number, to: number) => ({
    agentId: from, perpetratorId: from, victimId: to, action: 'confrontation', _cascade: cascade,
  });

  it('together: stages the scene now — a feed row and a relationship event', () => {
    expect(handleCascadeConfrontation(request(ada, bram), 10_000)).toBe('resolved');
    const events = eventsBetween(ada, bram);
    expect(events.map((e) => e.event_type)).toEqual(['confrontation_escalated']);
    const feed = db.select().from(activityLog)
      .where(and(eq(activityLog.initiator_id, ada), eq(activityLog.target_id, bram))).all();
    expect(feed.length).toBe(1);
  });

  it('ignores a conversation beat (no _cascade) and non-confrontation actions', () => {
    expect(handleCascadeConfrontation({ agentId: ada, perpetratorId: ada, victimId: bram, action: 'confrontation' }, 10_000)).toBe('skipped');
    expect(handleCascadeConfrontation({ ...request(ada, bram), action: 'insult' }, 10_000)).toBe('skipped');
    expect(eventsBetween(ada, bram)).toEqual([]);
  });

  it('the pair cooldown runs on game minutes, and a chain cannot drag either back in', () => {
    expect(handleCascadeConfrontation(request(ada, bram), 10_000)).toBe('resolved');
    expect(handleCascadeConfrontation(request(bram, ada), 10_000 + 60)).toBe('cooldown');
    // A witness intervening against the perpetrator of the scene just staged.
    expect(handleCascadeConfrontation({ agentId: cleo, perpetratorId: ada, victimId: bram, action: 'confrontation', _cascade: cascade }, 10_000 + 60)).toBe('cooldown');
    expect(handleCascadeConfrontation(request(bram, ada), 10_000 + COOLDOWN_MINUTES)).toBe('resolved');
    expect(eventsBetween(ada, bram).length).toBe(2);
  });

  it('apart: waits for their next meeting, then the hourly check stages it', () => {
    moveTo(bram, square);
    expect(handleCascadeConfrontation(request(ada, bram), 10_000)).toBe('pending');
    expect(pendingConfrontationPairs()).toEqual([{ initiatorId: ada, targetId: bram, until: 10_000 + PENDING_WAIT_MINUTES }]);

    confrontationCheck(10_060); // still apart
    expect(eventsBetween(ada, bram)).toEqual([]);

    moveTo(bram, tavern);
    confrontationCheck(10_120);
    expect(eventsBetween(ada, bram).map((e) => e.event_type)).toEqual(['confrontation_escalated']);
    expect(pendingConfrontationPairs()).toEqual([]);
  });

  it('a pending scene lapses if they never meet in time', () => {
    moveTo(bram, square);
    handleCascadeConfrontation(request(ada, bram), 10_000);
    confrontationCheck(10_000 + PENDING_WAIT_MINUTES + 1);
    moveTo(bram, tavern);
    confrontationCheck(10_000 + PENDING_WAIT_MINUTES + 61);
    expect(eventsBetween(ada, bram)).toEqual([]);
  });

  it('never a physical fight with a minor: the worst is a shouting match', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.95);
    expect(handleCascadeConfrontation(request(ada, kid), 10_000)).toBe('resolved');
    expect(eventsBetween(ada, kid).map((e) => e.event_type)).toEqual(['confrontation_escalated']);
    // Between adults the same roll is a fight.
    expect(handleCascadeConfrontation(request(bram, cleo), 10_000)).toBe('resolved');
    expect(eventsBetween(bram, cleo).map((e) => e.event_type)).toEqual(['fight']);
  });
});

describe('confrontationCheck (hourly roll)', () => {
  function relate(x: number, y: number, friendship: number, tags: string[] = []): void {
    db.insert(relationships).values({
      agent_a: Math.min(x, y), agent_b: Math.max(x, y),
      friendship_ab: friendship, friendship_ba: friendship, romance_ab: 0, romance_ba: 0,
      trust_ab: 0, trust_ba: 0, familiarity: 30, interaction_count: 5,
      last_interaction: 0, last_interaction_minute: 0, average_interaction_sentiment: 0,
      tags, status: 'acquaintances', created_at: 0, last_updated: 0,
    }).run();
  }

  it('a pair at -25 in the same room can have it out; the cooldown holds for 60 game hours', () => {
    relate(ada, bram, -25);
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    confrontationCheck(20_000);
    expect(eventsBetween(ada, bram).length).toBe(1);
    confrontationCheck(20_000 + COOLDOWN_MINUTES - 1);
    expect(eventsBetween(ada, bram).length).toBe(1);
  });

  it('a pair at -10 without a grudge does not; with one it does', () => {
    relate(ada, bram, -10);
    relate(ada, cleo, -10, ['grudge']);
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    confrontationCheck(30_000);
    expect(eventsBetween(ada, bram)).toEqual([]);
    expect(eventsBetween(ada, cleo).length).toBe(1);
  });
});
