import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agentStates, economy, loans, relationshipEvents } from '../../db/schema';
import { clearEffectivePersonalities, setEffectivePersonality } from '../states';
import { clearFavorLedger, favorsOwed, recordFavorGiven } from '../favorEngine';
import { clearSocialCallState, onCallConversationEnded, socialCallsHourly } from '../socialCalls';
import { callOf } from '../socialCalls/engine';
import { producers } from '../socialCalls/kinds';
import { loansHourly, onHardTimes } from '../socialCalls/loans';
import { setSocialCallRng } from '../socialCalls/produce';
import { gratitude, pickCallers, type CallerCandidate } from '../socialCalls/pickCallers';
import { RECIPROCITY, noteOrdeal, pickUngrateful, reciprocityTally } from '../socialCalls/reciprocity';
import { callTrigger } from '../socialCalls/topics';
import { NOW, PERSONALITY, freshTown, insertResident, relate } from './populationFixtures';

const COLD = { ...PERSONALITY, warmth: 20, loyalty: 30 };

function cand(over: Partial<CallerCandidate>): CallerCandidate {
  return {
    id: 1, ties: ['friend'], friendship: 45, hostile: false, unavailable: false, busy: false,
    warmth: 50, loyalty: 50, morality: 50, curiosity: 50, money: 50, age: 30, ...over,
  };
}

describe('kindness comes back: the debt brings people', () => {
  it('owing the target makes a caller readier, by 10% a favour up to +40%', () => {
    expect(gratitude(undefined)).toBe(1);
    expect(gratitude(1)).toBe(1);
    expect(gratitude(2)).toBeCloseTo(1.2);
    expect(gratitude(9)).toBeCloseTo(1.4);
    // Two equal friends: the one who owes the target goes first, and comes where the other wouldn't.
    const picked = pickCallers([cand({ id: 1 }), cand({ id: 2, owes: 4 })], { ties: ['friend'], max: 1 }, () => 0.37);
    expect(picked).toEqual([2]);
  });

  describe('in the town', () => {
    let town: ReturnType<typeof freshTown>;
    beforeEach(() => {
      town = freshTown();
      clearSocialCallState();
      clearFavorLedger();
      setSocialCallRng(() => 0);
    });
    afterEach(() => {
      clearEffectivePersonalities();
      setSocialCallRng(null);
    });

    it('a cold friend who owes the patient still comes, and the feed and memory say why', () => {
      const patient = insertResident('Elena Ruiz', town.homes[0]);
      const friend = insertResident('Ana Gil', town.homes[1]);
      setEffectivePersonality(friend, COLD);
      relate(patient, friend, { friendship_ab: 50, friendship_ba: 50 });
      recordFavorGiven(patient, friend, 3);
      db.insert(agentStates).values({ agent_id: patient, type: 'sick', severity: 0.6, started_at: NOW, duration: 9999, source: 'test', metadata: null }).run();
      producers.onSick(patient, NOW);
      const call = callOf(friend)!;
      expect(call.payload.returning).toBe(true);
      onCallConversationEnded({ agentId: friend, perpetratorId: patient, triggerReason: callTrigger('sick_visit'), template: true, sentiment: 0.3, turns: 4 });
      const row = db.select().from(activityLog).all().find((r) => (r.metadata as { beat?: string } | null)?.beat === 'sick_visit')!;
      expect((row.template_data as { description: string }).description).toMatch(/returning an old kindness\.$/);
      expect(reciprocityTally().favoursReturned).toBe(1);
      // The visit itself pays part of the debt back.
      expect(favorsOwed(friend, patient)).toBe(2);
    });

    it('a lender not warm enough for a stranger lends to someone who helped them; repaying settles the gratitude', () => {
      const debtor = insertResident('Tomas Paz', town.homes[0], {}, { money: 2 });
      const lender = insertResident('Rosa Chen', town.homes[1], {}, { money: 400 });
      setEffectivePersonality(lender, COLD);
      relate(debtor, lender, { friendship_ab: 50, friendship_ba: 50 });
      onHardTimes(debtor, NOW);
      expect(callOf(lender)).toBeNull();
      recordFavorGiven(debtor, lender, 3);
      onHardTimes(debtor, NOW + 5000);
      expect(callOf(lender)).toMatchObject({ kind: 'lend_money', targetId: debtor });
      onCallConversationEnded({ agentId: lender, perpetratorId: debtor, triggerReason: callTrigger('lend_money'), template: true, sentiment: 0.3, turns: 4 });
      const loan = db.select().from(loans).get()!;
      // The loan (a favour of 2) returned most of what she owed him.
      expect(favorsOwed(lender, debtor)).toBe(1);
      db.update(economy).set({ money: 500 }).where(eq(economy.agent_id, debtor)).run();
      loansHourly(NOW + 6000);
      expect(db.select().from(loans).where(eq(loans.id, loan.id)).get()!.status).toBe('repaid');
      // He owed her nothing for it, so repaying doesn't put her in his debt.
      expect(favorsOwed(lender, debtor)).toBe(1);
      expect(favorsOwed(debtor, lender)).toBe(0);
    });

    it('repaying a loan clears the gratitude it left', () => {
      const debtor = insertResident('Tomas Paz', town.homes[0], {}, { money: 2 });
      const lender = insertResident('Rosa Chen', town.homes[1], {}, { money: 400 });
      setEffectivePersonality(lender, { ...PERSONALITY, warmth: 80 });
      relate(debtor, lender, { friendship_ab: 50, friendship_ba: 50 });
      onHardTimes(debtor, NOW);
      onCallConversationEnded({ agentId: lender, perpetratorId: debtor, triggerReason: callTrigger('lend_money'), template: true, sentiment: 0.3, turns: 4 });
      expect(favorsOwed(debtor, lender)).toBe(2);
      db.update(economy).set({ money: 500 }).where(eq(economy.agent_id, debtor)).run();
      loansHourly(NOW + 6000);
      expect(favorsOwed(debtor, lender)).toBe(0);
    });

    it('ingratitude: the close friend who owes most and never came is remembered for it, once', () => {
      const x = insertResident('Elena Ruiz', town.homes[0]);
      const y = insertResident('Ana Gil', town.homes[1]);
      const z = insertResident('Bea Cruz', town.homes[2]);
      relate(x, y, { friendship_ab: 55, friendship_ba: 55 });
      relate(x, z, { friendship_ab: 55, friendship_ba: 55 });
      recordFavorGiven(x, y, 5);
      recordFavorGiven(x, z, 1);
      noteOrdeal(x, 'sick', NOW);
      socialCallsHourly(NOW + 60);
      expect(reciprocityTally().ingratitude).toBe(0);
      socialCallsHourly(NOW + RECIPROCITY.JUDGE_AFTER_MIN + 60);
      expect(reciprocityTally().ingratitude).toBe(1);
      const ev = db.select().from(relationshipEvents).all().filter((e) => e.event_type === 'ingratitude');
      expect(ev).toHaveLength(1);
      const row = db.select().from(activityLog).all().find((r) => (r.metadata as { beat?: string } | null)?.beat === 'ingratitude')!;
      expect((row.template_data as { description: string }).description).toBe('Elena Ruiz did a great deal for Ana Gil — and Ana never came when Elena was ill.');
      expect(row.importance).toBeCloseTo(0.55, 2);
      // Once per pair in a while: a second ordeal soon after holds nothing new against her.
      noteOrdeal(x, 'grieving', NOW + 4 * 24 * 60);
      socialCallsHourly(NOW + 7 * 24 * 60);
      expect(reciprocityTally().ingratitude).toBe(1);
    });
  });

  it('pickUngrateful: owes enough, close, stayed away without cause', () => {
    const base = { owes: 4, regard: 50, kin: false, came: false, excused: false, onCooldown: false };
    expect(pickUngrateful([{ id: 1, ...base }, { id: 2, ...base, owes: 6 }])).toBe(2);
    expect(pickUngrateful([{ id: 1, ...base, came: true }])).toBeNull();
    expect(pickUngrateful([{ id: 1, ...base, excused: true }])).toBeNull();
    expect(pickUngrateful([{ id: 1, ...base, owes: 2 }])).toBeNull();
    expect(pickUngrateful([{ id: 1, ...base, regard: 10 }])).toBeNull();
    expect(pickUngrateful([{ id: 1, ...base, regard: 10, kin: true }])).toBe(1);
  });
});
