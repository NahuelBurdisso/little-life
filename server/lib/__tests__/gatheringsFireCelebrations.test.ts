import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  activityLog, agents, agentStates, economy, locations, relationshipEvents, shared_knowledge, worldEvents, worldState,
} from '../../db/schema';
import { clearGatheringState, gatheringsTick } from '../gatherings';
import { allGatherings } from '../gatherings/engine';
import { setGatheringRng } from '../gatherings/common';
import { fireInviteLevel, fireOutcome, HELPERS_NEEDED } from '../gatherings/kinds/fire';
import { torchFor } from '../gatherings/kinds/celebration';
import { ROUND, roundBuyers, standRound } from '../gatherings/kinds/tavernRound';
import { startWorldEvent } from '../../engine/systems/events';
import { clearFavorLedger, getNetFavorBalance } from '../favorEngine';
import { weddingTriggeredBy } from '../marriage';
import { memoryService } from '../memory/instance';
import { PERSONALITY, freshTown, insertResident, relate } from './populationFixtures';

function rowsWithBeat(beat: string) {
  return db.select().from(activityLog).all().filter((r) => (r.metadata as { beat?: string } | null)?.beat === beat);
}

function textOf(beat: string): string {
  return (rowsWithBeat(beat)[0]?.template_data as { description?: string } | undefined)?.description ?? '';
}

function placeAt(ids: number[], locationId: number | null): void {
  for (const id of ids) db.update(agents).set({ current_location: locationId, current_action: { type: 'socializing' } }).where(eq(agents.id, id)).run();
}

function money(id: number): number {
  return db.select().from(economy).where(eq(economy.agent_id, id)).get()!.money;
}

beforeEach(() => {
  clearGatheringState();
  clearFavorLedger();
  vi.spyOn(memoryService, 'record').mockImplementation(() => {});
  setGatheringRng(() => 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  setGatheringRng(null);
});

describe('fire brigade', () => {
  const calm = { warmth: 60, loyalty: 60, neuroticism: 40 };

  it('who runs to a fire: the near and awake, the brave from anywhere, sleepers only in earshot; the timid watch', () => {
    expect(fireInviteLevel({ id: 1, awake: true, distancePx: 200, p: calm })).toBe('should');
    expect(fireInviteLevel({ id: 1, awake: true, distancePx: 3000, p: calm })).toBe('may');
    expect(fireInviteLevel({ id: 1, awake: true, distancePx: 3000, p: { ...calm, loyalty: 90 } })).toBe('should');
    expect(fireInviteLevel({ id: 1, awake: false, distancePx: 200, p: calm })).toBe('should');
    expect(fireInviteLevel({ id: 1, awake: false, distancePx: 1000, p: calm })).toBeNull();
    expect(fireInviteLevel({ id: 1, awake: true, distancePx: 100, p: { ...calm, neuroticism: 90 } })).toBe('may');
    expect(fireOutcome(HELPERS_NEEDED, 0.99)).toBe('saved');
    expect(fireOutcome(0, 0)).toBe('lost');
    expect(fireOutcome(1, 0.1)).toBe('saved');
    expect(fireOutcome(1, 0.5)).toBe('lost');
  });

  function setUp() {
    const town = freshTown({ homes: [2, 2, 2, 2, 2, 2] });
    const owner = insertResident('Olga Pena', town.homes[0], { gender: 'female' }, { money: 100 });
    const h1 = insertResident('Hugo Ruiz', town.homes[1]);
    const h2 = insertResident('Ines Vila', town.homes[2]);
    const sleeper = insertResident('Saul Gomez', town.homes[3], { current_action: { type: 'sleeping' } });
    const timid = insertResident('Tito Bravo', town.homes[4], { personality: { ...PERSONALITY, neuroticism: 90 } });
    const farFriend = insertResident('Fina Soto', town.homes[5], { position: { x: 5000, y: 5000 }, personality: { ...PERSONALITY, warmth: 50, loyalty: 50 } });
    relate(owner, farFriend, { friendship_ab: 60, friendship_ba: 60, status: 'friends' });
    db.update(economy).set({ inventory: [{ itemId: 'bread', quantity: 5, acquiredAt: 0 }] }).where(eq(economy.agent_id, owner)).run();
    return { town, owner, h1, h2, sleeper, timid, farFriend };
  }

  it('a fire burns a real building and wakes the street; enough hands put it out and the owner is in their debt', () => {
    const { town, owner, h1, h2, sleeper, timid, farFriend } = setUp();
    const res = startWorldEvent('fire_outbreak', { triggeredBy: 'random', enforceLimits: false });
    expect(res.ok && res.event.location_id).toBe(town.homes[0]);
    const g = allGatherings().find((x) => x.kind === 'fire')!;
    expect(g.hostIds).toEqual([owner]);
    gatheringsTick(g.startMin);
    expect(g.invited.get(owner)!.level).toBe('must');
    expect(g.invited.get(sleeper)!.level).toBe('should');
    expect(g.invited.get(timid)!.level).toBe('may');
    expect(g.invited.get(farFriend)!.level).toBe('may');
    // Woken: the sleep is over, the next decision is taken now.
    expect(db.select().from(agents).where(eq(agents.id, sleeper)).get()!.action_duration).toBe(0);

    placeAt([owner, h1, h2, timid], town.homes[0]);
    gatheringsTick(g.startMin + 10);
    gatheringsTick(g.startMin + 50);
    expect(g.payload.outcome).toBe('saved');
    expect(db.select().from(worldEvents).where(eq(worldEvents.id, g.eventId!)).get()!.is_active).toBe(false);
    expect(getNetFavorBalance(h1, owner)).toBeGreaterThan(0);
    expect(getNetFavorBalance(h2, owner)).toBeGreaterThan(0);
    expect(money(owner)).toBe(100);
    gatheringsTick(g.endMin);
    const row = rowsWithBeat('fire_saved')[0];
    expect(row.importance).toBeGreaterThan(0.75);
    expect(textOf('fire_saved')).toMatch(/Fire at Olga's house! 3 came running with buckets — Olga Pena, Hugo Ruiz and Ines Vila — and put it out\. Olga Pena is in their debt\. Tito Bravo watched from across the street\./);
  });

  it('too few hands and it burns: money to the treasury (not out of the economy), stock lost, absent friends resented', () => {
    const { town, owner, farFriend } = setUp();
    setGatheringRng(() => 0.99);
    db.update(locations).set({ owner: null }).run();
    const startTax = db.select().from(worldState).get()!.tax_pool;
    const res = startWorldEvent('fire_outbreak', { triggeredBy: 'random', enforceLimits: false, locationId: town.homes[0] });
    expect(res.ok).toBe(true);
    const g = allGatherings().find((x) => x.kind === 'fire')!;
    gatheringsTick(g.startMin);
    placeAt([owner], town.homes[0]);
    gatheringsTick(g.startMin + 50);
    expect(g.payload.outcome).toBe('lost');
    expect(money(owner)).toBe(75);
    expect(db.select().from(worldState).get()!.tax_pool).toBe(startTax + 25);
    expect(db.select().from(economy).where(eq(economy.agent_id, owner)).get()!.inventory.find((i) => i.itemId === 'bread')?.quantity).toBe(2);
    const resent = db.select().from(relationshipEvents).where(eq(relationshipEvents.event_type, 'fire_absent')).all();
    expect(resent).toHaveLength(1);
    expect(resent[0].agent_a === owner ? resent[0].friendship_delta_ab : resent[0].friendship_delta_ba).toBeLessThan(0);
    gatheringsTick(g.endMin);
    expect(textOf('fire_lost')).toMatch(/only Olga Pena came to help, and it burned\. Olga Pena lost \$25 and stock to the flames\. Fina Soto never came\./);
    expect(rowsWithBeat('fire_lost')[0].importance).toBeGreaterThan(0.75);
    void farFriend;
  });
});

describe('weddings get guests who matter', () => {
  it('close friends come even with a plan; a toast with gifts; a guest carrying a torch is heartbroken; absent friends noticed', () => {
    const town = freshTown({ homes: [2, 2, 2, 2, 2] });
    const bride = insertResident('Eva Luna', town.homes[0], { gender: 'female' });
    const groom = insertResident('Leo Paz', town.homes[0], { gender: 'male' });
    const friend = insertResident('Ana Gil', town.homes[1]);
    const admirer = insertResident('Mario Rey', town.homes[2]);
    const absent = insertResident('Nora Cid', town.homes[3]);
    const kid = insertResident('Pip Paz', town.homes[4], { age: 15 });
    relate(bride, groom, { friendship_ab: 80, friendship_ba: 80, romance_ab: 80, romance_ba: 80, status: 'partners', tags: ['married'] });
    relate(bride, friend, { friendship_ab: 75, friendship_ba: 75, status: 'friends' });
    relate(bride, admirer, { friendship_ab: 30, friendship_ba: 30, romance_ab: 0, romance_ba: 60 });
    relate(groom, absent, { friendship_ab: 60, friendship_ba: 60, status: 'friends' });
    relate(bride, kid, { friendship_ab: 30, friendship_ba: 30, romance_ab: 0, romance_ba: 60 });
    db.update(economy).set({ inventory: [{ itemId: 'bread', quantity: 6, acquiredAt: 0 }] }).where(eq(economy.agent_id, friend)).run();

    expect(torchFor(admirer, [bride, groom])).toBe(bride);
    expect(torchFor(kid, [bride, groom])).toBeNull(); // adults only, always
    expect(torchFor(groom, [bride])).toBeNull(); // the one she is marrying

    startWorldEvent('wedding', {
      triggeredBy: weddingTriggeredBy(bride, groom), name: 'Wedding of Eva Luna & Leo Paz', locationId: town.square,
      enforceLimits: false, announce: false,
    });
    const g = allGatherings().find((x) => x.kind === 'wedding')!;
    expect(g.hostIds.sort()).toEqual([bride, groom].sort());
    gatheringsTick(g.startMin - 30);
    expect(g.invited.get(friend)!.level).toBe('should');
    expect(g.invited.get(absent)!.level).toBe('should');
    expect(g.invited.has(admirer)).toBe(false);

    placeAt([bride, groom, friend, admirer, kid], town.square);
    gatheringsTick(g.startMin + 60);
    const heart = db.select().from(agentStates).where(and(eq(agentStates.agent_id, admirer), eq(agentStates.type, 'heartbroken'))).get();
    expect(heart?.target_agent_id).toBe(bride);
    expect(db.select().from(agentStates).where(and(eq(agentStates.agent_id, kid), eq(agentStates.type, 'heartbroken'))).get()).toBeUndefined();
    gatheringsTick(g.endMin);
    const text = textOf('toast');
    expect(text).toMatch(/^Wedding of Eva Luna & Leo Paz on the square: 3 came to raise a glass/);
    expect(text).toMatch(/Ana Gil brought gifts/);
    expect(text).toMatch(/Mario Rey smiled through the toast, and left early/);
    expect(text).toMatch(/Nora Cid did not come/);
  });
});

describe('a round for the house', () => {
  it('who would stand one: good spirits and a full purse, or something to celebrate', () => {
    const b = roundBuyers([
      { id: 1, mood: 80, money: 100, celebrating: false },
      { id: 2, mood: 40, money: 30, celebrating: true },
      { id: 3, mood: 40, money: 300, celebrating: false },
      { id: 4, mood: 90, money: 10, celebrating: false },
    ]);
    expect(b.map((c) => c.id)).toEqual([2, 1]);
  });

  it('real money to the tavern keeper, a favour from each drinker, and the freeloader is noticed after a few', () => {
    const town = freshTown({ homes: [2, 2, 2] });
    const keeper = insertResident('Kai Ortiz', town.homes[0], {}, { money: 10 });
    db.update(locations).set({ owner: keeper }).where(eq(locations.id, town.tavern)).run();
    const buyer = insertResident('Bo Diaz', town.homes[1], {}, { money: 100, mood: 85 });
    const drinker = insertResident('Dee Lara', town.homes[2], {}, { money: 30 });
    const broke = insertResident('Frank Moss', town.homes[2], {}, { money: 2 });
    const now = 30_000;
    for (let i = 0; i < ROUND.FREELOAD_NOTICED; i++) standRound(buyer, town.tavern, [buyer, drinker, broke], now + i * 10);
    expect(money(buyer)).toBe(100 - 3 * 2 * ROUND.PRICE);
    expect(money(keeper)).toBe(10 + 3 * 2 * ROUND.PRICE);
    expect(getNetFavorBalance(buyer, drinker)).toBeGreaterThan(0);
    const fact = db.select().from(shared_knowledge).where(and(eq(shared_knowledge.type, 'reputation'), eq(shared_knowledge.subject_id, broke))).get();
    expect(fact?.content).toMatch(/drinks on everyone else's coin/);
    const rows = rowsWithBeat('round');
    expect(rows).toHaveLength(3);
    expect((rows[2].template_data as { description: string }).description).toMatch(/Frank Moss, broke as ever, drank theirs too/);
  });
});
