import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, economy, locations, relationshipEvents } from '../../db/schema';
import { clearGatheringState, gatheringsTick } from '../gatherings';
import { allGatherings, attendanceOf } from '../gatherings/engine';
import { setGatheringRng } from '../gatherings/common';
import { MARKET, marketPull } from '../gatherings/kinds/market';
import { startWorldEvent } from '../../engine/systems/events';
import { simEvents } from '../simEvents';
import { clearSocialCallState } from '../socialCalls';
import { scheduleCall, finishCall } from '../socialCalls/engine';
import { memoryService } from '../memory/instance';
import { NOW, PERSONALITY, freshTown, insertResident, relate } from './populationFixtures';

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
  clearSocialCallState();
  vi.spyOn(memoryService, 'record').mockImplementation(() => {});
  setGatheringRng(() => 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  setGatheringRng(null);
});

describe('send-off', () => {
  it('friends see a leaver off on the square the hour before they go, with something for the road', () => {
    const town = freshTown({ homes: [2, 2, 2, 2] });
    const leaver = insertResident('Lena Voss', town.homes[0], { gender: 'female' });
    const friend = insertResident('Ana Gil', town.homes[1]);
    const pleader = insertResident('Ben Cruz', town.homes[2]);
    const bestFriend = insertResident('Cora Diaz', town.homes[3]);
    relate(leaver, friend, { friendship_ab: 50, friendship_ba: 50, status: 'friends' });
    relate(leaver, pleader, { friendship_ab: 25, friendship_ba: 25 });
    relate(leaver, bestFriend, { friendship_ab: 80, friendship_ba: 80, status: 'friends' });
    db.update(economy).set({ inventory: [{ itemId: 'bread', quantity: 6, acquiredAt: 0 }] }).where(eq(economy.agent_id, friend)).run();
    // Ben went to ask her to stay (step 2's plead_to_stay), and lost.
    const plea = scheduleCall({ kind: 'plead_to_stay', callerId: pleader, targetId: leaver, nowMin: NOW - 600 });
    if (plea) finishCall(plea.id, 'made', NOW - 500, true);

    const leaveAt = NOW + 8 * 60;
    simEvents.emit('life:leaving_decided', { agentId: leaver, leaveAtMin: leaveAt });
    const g = allGatherings().find((x) => x.kind === 'send_off')!;
    expect(g).toMatchObject({ hostIds: [leaver], venueLocationId: town.square, startMin: leaveAt - 60, endMin: leaveAt + 10 });

    gatheringsTick(g.startMin - 20);
    expect(g.invited.get(leaver)!.level).toBe('must');
    expect(g.invited.get(friend)!.level).toBe('should');
    if (plea) expect(g.invited.get(pleader)!.level).toBe('should');
    expect(g.invited.get(bestFriend)!.level).toBe('should');

    placeAt([leaver, friend, pleader], town.square);
    gatheringsTick(g.startMin);
    gatheringsTick(g.startMin + 40);
    gatheringsTick(g.endMin);
    expect(attendanceOf(g.id)!.absent).toEqual([bestFriend]);
    const inv = db.select().from(economy).where(eq(economy.agent_id, leaver)).get()!.inventory;
    expect(inv.find((i) => i.itemId === 'bread')?.quantity).toBe(1);
    const row = rowsWithBeat('send_off')[0];
    expect(row.importance).toBeGreaterThanOrEqual(0.6);
    expect(textOf('send_off')).toMatch(/2 gathered on the square to see Lena Voss off: Ana Gil and Ben Cruz\./);
    expect(textOf('send_off')).toMatch(/Ana Gil pressed something for the road on her/);
    expect(textOf('send_off')).toMatch(/Cora Diaz, of all people, did not come/);
    expect(db.select().from(relationshipEvents).where(eq(relationshipEvents.event_type, 'send_off')).all()).toHaveLength(2);
  });

  it('is called off if the leaver is gone before it starts', () => {
    const town = freshTown();
    const leaver = insertResident('Lena Voss', town.homes[0]);
    simEvents.emit('life:leaving_decided', { agentId: leaver, leaveAtMin: NOW + 480 });
    db.update(agents).set({ is_active: false }).where(eq(agents.id, leaver)).run();
    gatheringsTick(NOW + 400);
    expect(allGatherings()).toHaveLength(0);
    expect(rowsWithBeat('send_off')).toHaveLength(0);
  });
});

describe('market day', () => {
  it('the larder decides who makes the trip', () => {
    expect(marketPull({ money: 10, inventory: [] })).toBeGreaterThan(marketPull({ money: 10, inventory: [{ itemId: 'bread', quantity: 2, acquiredAt: 0 }] }));
    expect(marketPull({ money: 100, inventory: [{ itemId: 'food_raw', quantity: 9, acquiredAt: 0 }] })).toBeGreaterThan(0.15);
  });

  it('wraps the calendar\'s market: a haggle moves real money and a real loaf, and one summary row', () => {
    const town = freshTown({ homes: [2, 2, 2] });
    const seller = insertResident('Bea Ros', town.homes[0], {}, { money: 20 });
    const buyer = insertResident('Ana Gil', town.homes[1], {}, { money: 50 });
    db.update(economy).set({ inventory: [{ itemId: 'bread', quantity: 5, acquiredAt: 0 }] }).where(eq(economy.agent_id, seller)).run();
    const res = startWorldEvent('market_day', { triggeredBy: 'calendar', locationId: town.square, enforceLimits: false, announce: false });
    expect(res.ok).toBe(true);
    const g = allGatherings().find((x) => x.kind === 'market')!;
    expect(g.venueLocationId).toBe(town.square);
    gatheringsTick(g.startMin);
    expect(g.invited.get(seller)!.level).toBe('should');
    const total = money(seller) + money(buyer);
    placeAt([seller, buyer], town.square);
    gatheringsTick(g.startMin + 90);
    expect(money(seller) + money(buyer)).toBe(total);
    expect(money(seller)).toBe(24);
    expect(db.select().from(economy).where(eq(economy.agent_id, buyer)).get()!.inventory.find((i) => i.itemId === 'bread')?.quantity).toBe(1);
    gatheringsTick(g.endMin);
    expect(textOf('market_day')).toMatch(/Market day on the square drew 2 through the morning\. Ana Gil haggled Bea Ros down to \$4 for a loaf of bread\./);
  });

  it('a shopkeeper with goods whose shop is on the square works the market from the counter', () => {
    const town = freshTown({ homes: [2, 2, 2] });
    // The bakery's door moved next to the square's.
    const square = db.select().from(locations).where(eq(locations.id, town.square)).get()!;
    db.update(locations).set({ entry_point: { x: square.entry_point.x + 64, y: square.entry_point.y } }).where(eq(locations.id, town.bakery)).run();
    const baker = insertResident('Rosa Chen', town.homes[0], { workplace: town.bakery, current_location: town.bakery, current_action: { type: 'working' } }, { money: 20 });
    const idle = insertResident('Ana Gil', town.homes[1], { workplace: town.tavern, current_location: town.tavern, current_action: { type: 'working' } }, { money: 50 });
    db.update(economy).set({ inventory: [{ itemId: 'bread', quantity: 8, acquiredAt: 0 }] }).where(eq(economy.agent_id, baker)).run();
    db.update(economy).set({ inventory: [{ itemId: 'bread', quantity: 8, acquiredAt: 0 }] }).where(eq(economy.agent_id, idle)).run();
    startWorldEvent('market_day', { triggeredBy: 'calendar', locationId: town.square, enforceLimits: false, announce: false });
    const g = allGatherings().find((x) => x.kind === 'market')!;
    gatheringsTick(g.startMin);
    expect(g.payload.stallholders).toEqual([baker]);
    gatheringsTick(g.startMin + 30);
    expect(attendanceOf(g.id)!.attended.has(baker)).toBe(true);
    expect(attendanceOf(g.id)!.attended.has(idle)).toBe(false);
    expect(MARKET.lunchVisit).toBe(true);
  });

  it('a desperate, unscrupulous soul in the crowd gets the pickpocket errand — the crime path does the rest', () => {
    const town = freshTown({ homes: [2, 2, 2] });
    const thief = insertResident('Vic Lugo', town.homes[0], { personality: { ...PERSONALITY, morality: 10 } }, { money: 3 });
    const mark = insertResident('Rich Ford', town.homes[1], {}, { money: 90 });
    startWorldEvent('market_day', { triggeredBy: 'calendar', locationId: town.square, enforceLimits: false, announce: false });
    const g = allGatherings().find((x) => x.kind === 'market')!;
    gatheringsTick(g.startMin);
    placeAt([thief, mark], town.square);
    gatheringsTick(g.startMin + 90);
    expect(g.payload.thiefId).toBe(thief);
    expect(MARKET.errandFor!(g, mark, g.startMin + 95)).toBeNull();
    expect(MARKET.errandFor!(g, thief, g.startMin + 95)).toEqual({ source: 'pickpocket', targetAgentId: mark });
    // Once: the errand is spent.
    expect(MARKET.errandFor!(g, thief, g.startMin + 100)).toBeNull();
  });
});
