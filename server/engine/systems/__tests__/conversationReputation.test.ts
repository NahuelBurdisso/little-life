import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { conversations, shared_knowledge, worldState } from '../../../db/schema';
import { simEvents } from '../../../lib/simEvents';
import { recordReputation } from '../conversations/facts';
import type { CompletionContext } from '../conversations/completionContext';
import { freshTown, insertResident } from '../../../lib/__tests__/populationFixtures';

/**
 * "Three negative conversations in the last game day" earns a bad reputation.
 * `ended_at` is wall-clock ms, and the window was a fixed 1,440,000 ms: one game
 * day at 1x, but four at 4x.
 */

const SPEED = 4;

let grump: number;
let other: number;

beforeEach(() => {
  const { homes } = freshTown();
  db.update(worldState).set({ tick_speed: SPEED }).run();
  grump = insertResident('Grumpy Gus', homes[0], {});
  other = insertResident('Patient Pat', homes[1], {});
  vi.spyOn(simEvents, 'emit').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  // The worker DB outlives this file: don't hand later files a world at 4x.
  db.update(worldState).set({ tick_speed: 1 }).run();
});

function quarrelEndedMsAgo(msAgo: number) {
  const at = Date.now() - msAgo;
  db.insert(conversations).values({
    participants: [grump, other], messages: [], location: null, trigger_reason: 'test',
    status: 'ended', started_at: at - 1000, ended_at: at, sentiment: -0.6, max_turns: 4,
  }).run();
}

function finishNegativeConversation() {
  const world = db.select().from(worldState).get()!;
  recordReputation({ overallSentiment: -0.6, participantIds: [grump, other], world } as unknown as CompletionContext);
}

const reputationFacts = () => db.select().from(shared_knowledge)
  .where(and(eq(shared_knowledge.type, 'reputation'), eq(shared_knowledge.subject_id, grump))).all();

describe('recordReputation at 4x', () => {
  it('ignores quarrels older than a game day (10 real minutes is 40 game hours)', () => {
    for (let i = 0; i < 3; i++) quarrelEndedMsAgo(600_000);
    finishNegativeConversation();
    expect(reputationFacts()).toHaveLength(0);
  });

  it('counts quarrels within the game day (1 real minute is 4 game hours)', () => {
    for (let i = 0; i < 3; i++) quarrelEndedMsAgo(60_000);
    finishNegativeConversation();
    expect(reputationFacts()).toHaveLength(1);
  });
});
