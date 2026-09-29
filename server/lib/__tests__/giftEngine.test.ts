import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../db';
import {
  activityLog,
  agents,
  agentStates,
  economy,
  economyTransactions,
  locations,
  relationships,
  worldState,
} from '../../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import {
  clearGiftTracking,
  giveImpulsiveGift,
  GIFT_COOLDOWN_MINUTES,
  GIFT_FOOD_RESERVE,
  giftWealthTier,
  pickGiftItem,
  IMPULSIVE_GIFT_COOLDOWN_MINUTES,
  IMPULSIVE_GIFT_MONEY_FLOOR,
} from '../giftEngine';
import { statesTick } from '../../engine/systems/states';
import { simEvents } from '../simEvents';
import { setEffectivePersonality } from '../states';
import { initMemoryObserver, describeGiftForGiver } from '../memory/MemoryObserver';

/**
 * Playtest bug: `drunk` / `euphoric` rolled a $5-15 cash gift at 30% EVERY tick
 * with no cooldown. One drunk evening = ~14 gifts to the same person, the giver
 * went broke, and nothing reached the activity feed.
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

function insertAgent(name: string, at: number): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    // No personality: evaluateTriggers skips personality-less agents, so the
    // states phase only runs the effects of the states the test inserts.
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
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: at,
    workplace: null,
    created_at: Date.now(),
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

type Stack = { itemId: string; quantity: number; acquiredAt: number };

function insertEconomy(agentId: number, money: number, inventory: Stack[] = []): void {
  db.insert(economy).values({
    agent_id: agentId,
    job: 'unemployed',
    job_title: 'Unemployed',
    salary: 0,
    work_performance: 0.5,
    money,
    daily_expenses: 0,
    inventory,
    last_payday: 0,
    production_remainder: 0,
  }).run();
}

function insertState(agentId: number, type: 'drunk' | 'euphoric', startedAt: number): number {
  return db.insert(agentStates).values({
    agent_id: agentId,
    type,
    severity: 0.8,
    started_at: startedAt,
    duration: 100_000, // outlives the test; expiry isn't what's under test
    target_agent_id: null,
    source: 'test',
    metadata: null,
  }).returning({ id: agentStates.id }).get().id;
}

/** Point the world clock at `totalTicks` game minutes (tick_speed 1). */
function setClock(totalTicks: number): void {
  const time = {
    day: Math.floor(totalTicks / 1440),
    hour: Math.floor((totalTicks % 1440) / 60),
    minute: totalTicks % 60,
    totalTicks,
    seasonDay: 1,
    season: 'spring' as const,
  };
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time,
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

const money = (agentId: number) =>
  db.select().from(economy).where(eq(economy.agent_id, agentId)).get()!.money;

const giftsFrom = (agentId: number) =>
  db.select().from(economyTransactions).where(and(
    eq(economyTransactions.from_agent, agentId),
    inArray(economyTransactions.reason, ['drunk_gift', 'euphoric_gift']),
  )).all();

const feedGiftsFrom = (agentId: number) =>
  db.select().from(activityLog).where(and(
    eq(activityLog.type, 'gift'),
    eq(activityLog.initiator_id, agentId),
  )).all();

let clock = 10_000;
let n = 0;

/** Fresh giver/receiver pair alone at their own tavern. */
function pair(giverMoney: number, receiverMoney = 50, giverInventory: Stack[] = []) {
  n++;
  const loc = insertLocation(`gift tavern ${n}`);
  const giver = insertAgent(`Giver ${n}`, loc);
  const receiver = insertAgent(`Receiver ${n}`, loc);
  insertEconomy(giver, giverMoney, giverInventory);
  insertEconomy(receiver, receiverMoney);
  return { loc, giver, receiver };
}

function gift(giver: number, receiver: number, stateId: number, desiredAmount = 15) {
  const g = db.select().from(agents).where(eq(agents.id, giver)).get()!;
  const r = db.select().from(agents).where(eq(agents.id, receiver)).get()!;
  return giveImpulsiveGift({ giver: g, receiver: r, reason: 'drunk_gift', stateId, desiredAmount });
}

describe('impulsive state gifts', () => {
  beforeEach(() => {
    clearGiftTracking();
    clock += 10_000; // stay clear of the previous test's cooldowns
    setClock(clock);
  });

  it('a whole drunk evening next to someone gives once, and the feed shows it', () => {
    const { giver, receiver } = pair(200);
    insertState(giver, 'drunk', clock);

    // Two game hours of ticks. At 30% per tick the old code gave ~36 times here.
    for (let i = 0; i < 120; i++) {
      setClock(clock + i);
      statesTick();
    }

    const gifts = giftsFrom(giver);
    expect(gifts).toHaveLength(1);
    const amount = gifts[0].amount;
    expect(amount).toBeGreaterThanOrEqual(5);
    expect(amount).toBeLessThanOrEqual(15);
    expect(gifts[0].to_agent).toBe(receiver);

    // Money moved, and only between the two of them.
    expect(money(giver)).toBe(200 - amount);
    expect(money(receiver)).toBe(50 + amount);

    const feed = feedGiftsFrom(giver);
    expect(feed).toHaveLength(1);
    expect(feed[0].target_id).toBe(receiver);
    expect(String((feed[0].template_data as any).description)).toContain(`$${amount}`);
  });

  it('gives once per episode even after the cooldown has passed', () => {
    const { giver } = pair(200);
    insertState(giver, 'drunk', clock);

    for (let i = 0; i < 60; i++) { setClock(clock + i); statesTick(); }
    expect(giftsFrom(giver)).toHaveLength(1);

    // Same episode, well past the cooldown (a fast tick_speed stretches episodes).
    const later = clock + IMPULSIVE_GIFT_COOLDOWN_MINUTES * 3;
    for (let i = 0; i < 60; i++) { setClock(later + i); statesTick(); }
    expect(giftsFrom(giver)).toHaveLength(1);
  });

  it('shares one cooldown between drunk and euphoric', () => {
    const { giver } = pair(200);
    insertState(giver, 'drunk', clock);
    insertState(giver, 'euphoric', clock);

    for (let i = 0; i < 120; i++) { setClock(clock + i); statesTick(); }
    expect(giftsFrom(giver)).toHaveLength(1);
    expect(feedGiftsFrom(giver)).toHaveLength(1);
  });

  it('a new episode after the cooldown can give again', () => {
    const { giver, receiver } = pair(200);
    const first = insertState(giver, 'drunk', clock);
    expect(gift(giver, receiver, first)).not.toBeNull();

    const second = insertState(giver, 'drunk', clock);
    setClock(clock + IMPULSIVE_GIFT_COOLDOWN_MINUTES - 1);
    expect(gift(giver, receiver, second)).toBeNull();

    setClock(clock + IMPULSIVE_GIFT_COOLDOWN_MINUTES);
    expect(gift(giver, receiver, second)).not.toBeNull();
    expect(giftsFrom(giver)).toHaveLength(2);
  });

  it('caps the gift at a tenth of the giver\'s money', () => {
    const { giver, receiver } = pair(60);
    expect(gift(giver, receiver, insertState(giver, 'drunk', clock), 15)).toBe(6);
    expect(money(giver)).toBe(54);
  });

  it('never takes the giver below the floor', () => {
    const { giver, receiver } = pair(IMPULSIVE_GIFT_MONEY_FLOOR + 3);
    // 10% would be 2.3, the floor leaves 3 → 2.
    expect(gift(giver, receiver, insertState(giver, 'drunk', clock), 15)).toBe(2);
    expect(money(giver)).toBeGreaterThanOrEqual(IMPULSIVE_GIFT_MONEY_FLOOR);

    const poor = pair(IMPULSIVE_GIFT_MONEY_FLOOR);
    expect(gift(poor.giver, poor.receiver, insertState(poor.giver, 'drunk', clock))).toBeNull();
    expect(money(poor.giver)).toBe(IMPULSIVE_GIFT_MONEY_FLOOR);
    expect(giftsFrom(poor.giver)).toHaveLength(0);
    expect(feedGiftsFrom(poor.giver)).toHaveLength(0);
  });

  it('does not debit the giver when the receiver has no economy row', () => {
    n++;
    const loc = insertLocation(`gift tavern ${n}`);
    const giver = insertAgent(`Giver ${n}`, loc);
    const ghost = insertAgent(`Ghost ${n}`, loc);
    insertEconomy(giver, 200);

    expect(gift(giver, ghost, insertState(giver, 'drunk', clock))).toBeNull();
    expect(money(giver)).toBe(200);
  });

  it('forgets cooldowns on world replace', () => {
    const { giver, receiver } = pair(200);
    expect(gift(giver, receiver, insertState(giver, 'drunk', clock))).not.toBeNull();
    clearGiftTracking();
    expect(gift(giver, receiver, insertState(giver, 'drunk', clock))).not.toBeNull();
  });
});

/**
 * The conversation-gift cooldown compared Date.now() to "1440 ticks × 1000 ms" —
 * 24 real minutes, which is a game day only at tick_speed 1. It is game time now.
 */
describe('conversation gift cooldown', () => {
  beforeEach(() => {
    clearGiftTracking();
    clock += 10_000;
    setClock(clock);
    // Every roll passes: the gift chance is personality-driven and < 1.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => vi.restoreAllMocks());

  function talk(giver: number, receiver: number): void {
    simEvents.emit('conversation:ended', { agentId: giver, perpetratorId: receiver, sentiment: 0.9, turns: 6 });
  }

  const conversationGiftsFrom = (agentId: number) =>
    db.select().from(economyTransactions).where(and(
      eq(economyTransactions.from_agent, agentId),
      eq(economyTransactions.reason, 'gift'),
    )).all();

  it('allows one gift per game day, however little real time passes', () => {
    const { giver, receiver } = pair(200);
    setEffectivePersonality(giver, {
      honesty: 50, aggression: 20, warmth: 100, impulsiveness: 50, vanity: 50,
      curiosity: 50, loyalty: 50, morality: 80, sensuality: 50, neuroticism: 50,
    });

    talk(giver, receiver);
    expect(conversationGiftsFrom(giver)).toHaveLength(1);

    // Same game day: blocked.
    setClock(clock + GIFT_COOLDOWN_MINUTES - 1);
    talk(giver, receiver);
    expect(conversationGiftsFrom(giver)).toHaveLength(1);

    // A game day later — milliseconds of real time at a fast tick_speed. The
    // wall-clock cooldown kept blocking here for 24 real minutes.
    setClock(clock + GIFT_COOLDOWN_MINUTES);
    talk(giver, receiver);
    expect(conversationGiftsFrom(giver)).toHaveLength(2);
  });
});

/**
 * E8: gifts doubled after the starting ties, and poor agents gave 3-6 a day —
 * $15 or the bread they were about to eat. The budget now follows wealth
 * against the world's money target (default $75 here: comfortable >= $75,
 * tight >= $37.5, poor below).
 */
describe('conversation gift wealth budget', () => {
  beforeEach(() => {
    clearGiftTracking();
    clock += 10_000;
    setClock(clock);
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => vi.restoreAllMocks());

  const WARM = {
    honesty: 50, aggression: 20, warmth: 100, impulsiveness: 50, vanity: 50,
    curiosity: 50, loyalty: 50, morality: 80, sensuality: 50, neuroticism: 50,
  };
  const talk = (giver: number, receiver: number) =>
    simEvents.emit('conversation:ended', { agentId: giver, perpetratorId: receiver, sentiment: 0.9, turns: 6 });
  const cashGifts = (agentId: number) =>
    db.select().from(economyTransactions).where(and(
      eq(economyTransactions.from_agent, agentId),
      eq(economyTransactions.reason, 'gift'),
    )).all();
  const inv = (itemId: string, quantity: number): Stack[] => [{ itemId, quantity, acquiredAt: 0 }];
  const held = (agentId: number, itemId: string) =>
    (db.select().from(economy).where(eq(economy.agent_id, agentId)).get()!.inventory as Stack[])
      .find((i) => i.itemId === itemId)?.quantity ?? 0;

  it('sorts givers into tiers by their share of the money target', () => {
    expect(giftWealthTier(75, 75)).toBe('comfortable');
    expect(giftWealthTier(74, 75)).toBe('tight');
    expect(giftWealthTier(37.5, 75)).toBe('tight');
    expect(giftWealthTier(37, 75)).toBe('poor');
    // The same cash is comfortable in a poorer town.
    expect(giftWealthTier(50, 50)).toBe('comfortable');
  });

  it('a comfortable giver still gifts once a game day', () => {
    const { giver, receiver } = pair(200);
    setEffectivePersonality(giver, WARM);
    talk(giver, receiver);
    setClock(clock + GIFT_COOLDOWN_MINUTES);
    talk(giver, receiver);
    expect(cashGifts(giver)).toHaveLength(2);
  });

  it('a tight giver waits two game days', () => {
    const { giver, receiver } = pair(59);
    setEffectivePersonality(giver, WARM);
    talk(giver, receiver);
    expect(cashGifts(giver)).toHaveLength(1);
    // $59 - a cash gift: still tight (>= $37.5), so a day is not enough...
    setClock(clock + GIFT_COOLDOWN_MINUTES);
    talk(giver, receiver);
    expect(cashGifts(giver)).toHaveLength(1);
    // ...but two are.
    setClock(clock + GIFT_COOLDOWN_MINUTES * 2);
    talk(giver, receiver);
    expect(cashGifts(giver).length).toBeGreaterThanOrEqual(2);
  });

  it('a tight purse is opened less often: the same roll gifts when comfortable, not when tight', () => {
    // warmth 100 → 30% per friendly chat; a tight giver gets 60% of that (18%).
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const rich = pair(200);
    const tight = pair(59);
    setEffectivePersonality(rich.giver, WARM);
    setEffectivePersonality(tight.giver, WARM);
    talk(rich.giver, rich.receiver);
    talk(tight.giver, tight.receiver);
    expect(cashGifts(rich.giver)).toHaveLength(1);
    expect(cashGifts(tight.giver)).toHaveLength(0);
  });

  it('a poor giver hands over no cash: it would take them under the floor', () => {
    const { giver, receiver } = pair(30);
    setEffectivePersonality(giver, WARM);
    talk(giver, receiver);
    expect(cashGifts(giver)).toHaveLength(0);
    expect(money(giver)).toBe(30);
  });

  it('a cash gift stops at the wealth floor instead of 15% of cash', () => {
    // $45 of a $75 target: 15% is $6, but only $7 sits above the $37.5 floor.
    const { giver, receiver } = pair(45);
    setEffectivePersonality(giver, WARM);
    talk(giver, receiver);
    expect(cashGifts(giver)).toHaveLength(1);
    expect(money(giver)).toBeGreaterThanOrEqual(37.5);
  });

  it('a non-comfortable giver keeps the food they need', () => {
    expect(pickGiftItem(inv('bread', GIFT_FOOD_RESERVE), 'poor')).toBeNull();
    expect(pickGiftItem(inv('bread', GIFT_FOOD_RESERVE), 'tight')).toBeNull();
    expect(pickGiftItem(inv('bread', GIFT_FOOD_RESERVE + 1), 'poor')).toBe('bread');
    expect(pickGiftItem(inv('bread', 1), 'comfortable')).toBe('bread');
  });

  it('through the event: a poor giver with a little bread gives no bread', () => {
    // $38 is tight; with 2 loaves (under the reserve) the item path is skipped
    // and the cash fallback ($0.5 above the floor) is under the $3 minimum.
    const { giver, receiver } = pair(38, 50, inv('bread', 2));
    setEffectivePersonality(giver, WARM);
    talk(giver, receiver);
    expect(held(giver, 'bread')).toBe(2);
    expect(cashGifts(giver)).toHaveLength(0);
  });

  it('through the event: a comfortable giver gives the bread', () => {
    const { giver, receiver } = pair(200, 50, inv('bread', 2));
    setEffectivePersonality(giver, WARM);
    talk(giver, receiver);
    expect(held(giver, 'bread')).toBe(1);
    expect(held(receiver, 'bread')).toBe(1);
  });
});

/**
 * Impulsive gifts were remembered as "It felt good to be generous" — the wrong
 * self-image for a drunk handout. `gift:given` now carries the reason.
 */
describe('impulsive gift memories and reactions', () => {
  const record = vi.fn();
  beforeAll(() => initMemoryObserver({ record } as any));
  beforeEach(() => {
    clearGiftTracking();
    record.mockClear();
    clock += 10_000;
    setClock(clock);
  });

  const giverMemory = (giver: number) =>
    record.mock.calls.find((c) => c[0] === giver && String(c[2]).includes('$'))?.[2] as string | undefined;

  it('a drunk gift is remembered as a drunk gift', () => {
    const { giver, receiver } = pair(200);
    const amount = gift(giver, receiver, insertState(giver, 'drunk', clock), 10)!;
    expect(giverMemory(giver)).toBe(
      `I'd had a few too many and pressed $${amount} on Receiver ${n}. I hope I don't regret that tomorrow.`,
    );
  });

  it('a euphoric gift is remembered as high spirits', () => {
    const { giver, receiver } = pair(200);
    const g = db.select().from(agents).where(eq(agents.id, giver)).get()!;
    const r = db.select().from(agents).where(eq(agents.id, receiver)).get()!;
    giveImpulsiveGift({ giver: g, receiver: r, reason: 'euphoric_gift', stateId: insertState(giver, 'euphoric', clock), desiredAmount: 8 });
    expect(giverMemory(giver)).toContain('great mood');
  });

  it('a conversation gift keeps the generosity memory', () => {
    expect(describeGiftForGiver('Ana', { giverId: 1, receiverId: 2, item: 'bread' }))
      .toBe('I gave a gift to Ana. It felt good to be generous.');
  });

  it('still makes a co-located admirer of the giver jealous', () => {
    const { loc, giver, receiver } = pair(200);
    const admirer = insertAgent(`Admirer ${n}`, loc);
    const [a, b] = admirer < giver ? [admirer, giver] : [giver, admirer];
    const admirerIsA = a === admirer;
    db.insert(relationships).values({
      agent_a: a, agent_b: b,
      friendship_ab: 20, friendship_ba: 20,
      romance_ab: admirerIsA ? 70 : 0, romance_ba: admirerIsA ? 0 : 70,
      trust_ab: 20, trust_ba: 20, familiarity: 50, interaction_count: 5,
      last_interaction: 0, average_interaction_sentiment: 0.5, tags: [],
      status: 'acquaintance', created_at: 0, last_updated: 0,
    }).run();

    expect(gift(giver, receiver, insertState(giver, 'drunk', clock))).not.toBeNull();

    const jealous = db.select().from(agentStates).where(and(
      eq(agentStates.agent_id, admirer),
      eq(agentStates.type, 'jealous'),
    )).get();
    expect(jealous?.target_agent_id).toBe(giver);
  });
});
