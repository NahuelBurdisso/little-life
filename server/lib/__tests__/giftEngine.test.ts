import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../db';
import {
  activityLog,
  agents,
  agentStates,
  economy,
  economyTransactions,
  locations,
  worldState,
} from '../../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import {
  clearGiftTracking,
  giveImpulsiveGift,
  GIFT_COOLDOWN_MINUTES,
  IMPULSIVE_GIFT_COOLDOWN_MINUTES,
  IMPULSIVE_GIFT_MONEY_FLOOR,
} from '../giftEngine';
import { statesTick } from '../../engine/systems/states';
import { simEvents } from '../simEvents';
import { setEffectivePersonality } from '../states';

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

function insertEconomy(agentId: number, money: number): void {
  db.insert(economy).values({
    agent_id: agentId,
    job: 'unemployed',
    job_title: 'Unemployed',
    salary: 0,
    work_performance: 0.5,
    money,
    daily_expenses: 0,
    inventory: [],
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
function pair(giverMoney: number, receiverMoney = 50) {
  n++;
  const loc = insertLocation(`gift tavern ${n}`);
  const giver = insertAgent(`Giver ${n}`, loc);
  const receiver = insertAgent(`Receiver ${n}`, loc);
  insertEconomy(giver, giverMoney);
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
