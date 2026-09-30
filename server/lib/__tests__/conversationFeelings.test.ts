import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('../../ai/ollama', () => ({ callOllamaChat: vi.fn() }));

import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, conversations, locations, relationshipEvents } from '../../db/schema';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import { simEvents } from '../simEvents';
import { clearSpotlight } from '../spotlight';
import { bumpWorldEpoch, currentWorldEpoch } from '../worldEpoch';
import { initMemoryObserver } from '../memory/MemoryObserver';
import type { MemoryService } from '../memory/MemoryService';
import {
  FEELING_POINTS, FEELINGS_EVENT, SORE_FEELINGS_EVENT,
  applyConversationFeelings, feelingDelta, feelingSentiment, type FeelingPair,
} from '../conversationFeelings';

/**
 * The model's verdict on how a two-person conversation went (the summary call's
 * `feelings`) becomes a relationship event: the delta mapping, the sore-talk feed row,
 * the stale-world guard, and the whole path from `conversation:ended`.
 */

describe('feeling → deltas', () => {
  it('each step is FEELING_POINTS of friendship; only negatives cost trust', () => {
    expect(feelingDelta(0)).toEqual({ friendship: 0, trust: 0 });
    expect(feelingDelta(1)).toEqual({ friendship: FEELING_POINTS, trust: 0 });
    expect(feelingDelta(3)).toEqual({ friendship: 3 * FEELING_POINTS, trust: 0 });
    expect(feelingDelta(-1)).toEqual({ friendship: -FEELING_POINTS, trust: -1 });
    expect(feelingDelta(-3)).toEqual({ friendship: -3 * FEELING_POINTS, trust: -3 });
  });

  it('sentiment is the mean over the range; one side badly hurt is pivotal', () => {
    expect(feelingSentiment(0, 0)).toBe(0);
    expect(feelingSentiment(3, 3)).toBe(1);
    expect(feelingSentiment(-3, 0)).toBe(-0.5);
  });
});

let loc = 0;
let ana = 0;
let ben = 0;
const ids = () => [ana, ben];

function eventsOfPair() {
  return db.select().from(relationshipEvents).where(or(
    and(eq(relationshipEvents.agent_a, ana), eq(relationshipEvents.agent_b, ben)),
    and(eq(relationshipEvents.agent_a, ben), eq(relationshipEvents.agent_b, ana)),
  )).all();
}

function feedOfPair() {
  return db.select().from(activityLog)
    .where(or(inArray(activityLog.initiator_id, ids()), inArray(activityLog.target_id, ids()))).all();
}

beforeAll(() => {
  loc = db.insert(locations).values({
    name: 'Feelings Test Parlour', type: 'tavern', position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 0, y: 0 }, capacity: 10, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  const agent = (name: string) => db.insert(agents).values({
    name, bio: 'test', traits: [], personality: null, age: 30, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 }, current_location: loc,
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: loc, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
  ana = agent('Ana Feelings');
  ben = agent('Ben Feelings');
});

afterAll(() => {
  db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, ids()), inArray(relationshipEvents.agent_b, ids()))).run();
  db.delete(activityLog).where(or(inArray(activityLog.initiator_id, ids()), inArray(activityLog.target_id, ids()))).run();
  db.delete(conversations).where(eq(conversations.location, loc)).run();
  db.delete(agents).where(inArray(agents.id, ids())).run();
  db.delete(locations).where(eq(locations.id, loc)).run();
});

beforeEach(() => {
  db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, ids()), inArray(relationshipEvents.agent_b, ids()))).run();
  db.delete(activityLog).where(or(inArray(activityLog.initiator_id, ids()), inArray(activityLog.target_id, ids()))).run();
});

describe('applyConversationFeelings', () => {
  const pair = (): FeelingPair => ({ aId: ana, aName: 'Ana Feelings', bId: ben, bName: 'Ben Feelings' });
  const feelings = (a: number, b: number) => new Map([['Ana Feelings', a], ['Ben Feelings', b]]);

  it('writes one unprocessed event with each side toward the other', () => {
    expect(applyConversationFeelings(pair(), feelings(1, -1), currentWorldEpoch())).toBe(true);
    const [ev] = eventsOfPair();
    expect(ev.event_type).toBe(FEELINGS_EVENT);
    expect(ev.processed).toBe(false);
    // Stored (lower id, higher id): ana was inserted first.
    expect([ev.agent_a, ev.agent_b]).toEqual([ana, ben]);
    expect(ev.friendship_delta_ab).toBe(FEELING_POINTS);
    expect(ev.friendship_delta_ba).toBe(-FEELING_POINTS);
    expect(ev.trust_delta_ab).toBe(0);
    expect(ev.trust_delta_ba).toBe(-1);
    expect(feedOfPair()).toEqual([]);
  });

  it('a talk that left someone offended is a quarrel with a feed row', () => {
    applyConversationFeelings(pair(), feelings(0, -2), currentWorldEpoch());
    const [ev] = eventsOfPair();
    expect(ev.event_type).toBe(SORE_FEELINGS_EVENT);
    const feed = feedOfPair();
    expect(feed.length).toBe(1);
    expect(feed[0].initiator_id).toBe(ben);
    expect(JSON.stringify(feed[0])).toContain('Ben Feelings came away from a talk with Ana Feelings offended');
  });

  it('nothing for a talk that changed nothing, or a missing verdict', () => {
    expect(applyConversationFeelings(pair(), feelings(0, 0), currentWorldEpoch())).toBe(false);
    expect(applyConversationFeelings(pair(), new Map(), currentWorldEpoch())).toBe(false);
    expect(eventsOfPair()).toEqual([]);
  });

  it('drops a verdict from a replaced world, or for ids that changed hands', () => {
    const epoch = currentWorldEpoch();
    bumpWorldEpoch();
    expect(applyConversationFeelings(pair(), feelings(-3, -3), epoch)).toBe(false);
    expect(applyConversationFeelings({ ...pair(), aName: 'Someone Else' }, new Map([['Someone Else', -3]]), currentWorldEpoch())).toBe(false);
    expect(eventsOfPair()).toEqual([]);
  });
});

describe('from conversation:ended through the summary call', () => {
  const record = vi.fn();
  const summariesWas = CONFIG.AI.CONVERSATION_SUMMARIES;

  beforeAll(() => {
    (CONFIG.AI as { CONVERSATION_SUMMARIES: boolean }).CONVERSATION_SUMMARIES = true;
    clearSpotlight();
    initMemoryObserver({ record } as unknown as MemoryService);
  });

  afterAll(() => {
    (CONFIG.AI as { CONVERSATION_SUMMARIES: boolean }).CONVERSATION_SUMMARIES = summariesWas;
  });

  beforeEach(() => {
    vi.mocked(callOllamaChat).mockClear();
  });

  function endConversation(opts: { fallbackLine?: boolean } = {}): number {
    // Seven lines so that, one canned, six real ones still earn an off-screen summary.
    const messages = Array.from({ length: 7 }, (_, i) => ({
      speakerId: i % 2 ? ben : ana,
      text: `A perfectly polite remark, number ${i}.`,
      sentiment: 0,
      fallback: opts.fallbackLine === true && i === 3,
    }));
    const conversationId = db.insert(conversations).values({
      participants: [ana, ben], messages, location: loc, trigger_reason: 'test', topic: 'chat',
      status: 'ended', started_at: 0, ended_at: 0, sentiment: 0, max_turns: 7,
    }).returning({ id: conversations.id }).get().id;
    for (const [me, other] of [[ana, 'Ben Feelings'], [ben, 'Ana Feelings']] as const) {
      simEvents.emit('conversation:ended', {
        agentId: me, conversationId, otherName: other, summary: 'chat', turns: 7, sentiment: 0, messages,
      });
    }
    return conversationId;
  }

  const reply = JSON.stringify({
    'Ana Feelings': 'Ben looked down his nose at my cooking and I have not forgotten it.',
    'Ben Feelings': 'Ana and I talked about her cooking over supper.',
    feelings: { 'Ana Feelings': -2, 'Ben Feelings': 0 },
  });

  it('one call for the pair asks for feelings, and the verdict lands as an event', async () => {
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: reply }) as never);
    endConversation();
    await vi.waitFor(() => expect(eventsOfPair().length).toBe(1));
    expect(callOllamaChat).toHaveBeenCalledTimes(1);
    const call = vi.mocked(callOllamaChat).mock.calls[0][0] as unknown as { format: { properties: object } };
    expect(call.format.properties).toHaveProperty('feelings');
    expect(eventsOfPair()[0].event_type).toBe(SORE_FEELINGS_EVENT);
  });

  it('a transcript with a canned fallback line is not judged', async () => {
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: reply }) as never);
    endConversation({ fallbackLine: true });
    await vi.waitFor(() => expect(callOllamaChat).toHaveBeenCalledTimes(1));
    const call = vi.mocked(callOllamaChat).mock.calls[0][0] as unknown as { format: { properties: object } };
    expect(call.format.properties).not.toHaveProperty('feelings');
    await new Promise((r) => setTimeout(r, 10));
    expect(eventsOfPair()).toEqual([]);
  });

  it('LLM_CONVERSATION_SUMMARIES=0 turns it off with the summaries', async () => {
    (CONFIG.AI as { CONVERSATION_SUMMARIES: boolean }).CONVERSATION_SUMMARIES = false;
    try {
      endConversation();
      await new Promise((r) => setTimeout(r, 10));
      expect(callOllamaChat).not.toHaveBeenCalled();
      expect(eventsOfPair()).toEqual([]);
    } finally {
      (CONFIG.AI as { CONVERSATION_SUMMARIES: boolean }).CONVERSATION_SUMMARIES = true;
    }
  });
});
