import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  activityLog, agents, agentStates, economy, loans, needs, relationshipEvents, shared_knowledge,
} from '../../db/schema';
import { clearEffectivePersonalities, setEffectivePersonality } from '../states';
import { clearSocialCallState, onCallConversationEnded, socialCallsHourly } from '../socialCalls';
import { callOf, callsMadeTo, lingerOf, pendingCallsFor } from '../socialCalls/engine';
import { producers } from '../socialCalls/kinds';
import { loansHourly, onHardTimes } from '../socialCalls/loans';
import { setSocialCallRng } from '../socialCalls/produce';
import { simEvents } from '../simEvents';
import { callTrigger } from '../socialCalls/topics';
import type { SocialCall } from '../socialCalls/types';
import { DAY, NOW, PERSONALITY, freshTown, insertResident, relate } from './populationFixtures';

const WARM = { ...PERSONALITY, warmth: 95, loyalty: 80 };

/** The caller's conversation with the target ended (the template tier's emit, as the caller sees it). */
function visit(call: SocialCall, chat: { template?: boolean; sentiment?: number; turns?: number } = {}): void {
  onCallConversationEnded({
    agentId: call.callerId, perpetratorId: call.targetId, triggerReason: callTrigger(call.kind),
    template: chat.template ?? true, sentiment: chat.sentiment ?? 0.3, turns: chat.turns ?? 4,
  });
}

function rowsWithBeat(beat: string) {
  return db.select().from(activityLog).all().filter((r) => (r.metadata as { beat?: string } | null)?.beat === beat);
}

function moodSources(id: number): string[] {
  return (db.select().from(needs).where(eq(needs.agent_id, id)).get()?.mood_modifiers ?? []).map((m) => m.source);
}

function giveState(id: number, type: string, severity = 0.6, metadata: Record<string, unknown> | null = null): void {
  db.insert(agentStates).values({ agent_id: id, type, severity, started_at: NOW, duration: 9999, source: 'test', metadata }).run();
}

describe('social calls: each kind end to end', () => {
  let town: ReturnType<typeof freshTown>;
  beforeEach(() => {
    town = freshTown();
    clearSocialCallState();
    // Every roll comes up: whoever qualifies comes (up to the kind's maximum), and visits go well.
    setSocialCallRng(() => 0);
  });
  afterEach(() => {
    clearEffectivePersonalities();
    setSocialCallRng(null);
  });

  describe('sick_visit', () => {
    it('a fever brings a warm friend with food; the visit eases it and leaves one feed row', () => {
      const patient = insertResident('Elena Ruiz', town.homes[0]);
      const friend = insertResident('Ana Gil', town.homes[1]);
      setEffectivePersonality(friend, WARM);
      relate(patient, friend, { friendship_ab: 60, friendship_ba: 60 });
      db.update(economy).set({ inventory: [{ itemId: 'bread', quantity: 6, acquiredAt: 0 }] }).where(eq(economy.agent_id, friend)).run();
      giveState(patient, 'sick', 0.6);

      producers.onSick(patient, NOW);
      const call = callOf(friend)!;
      expect(call).toMatchObject({ kind: 'sick_visit', targetId: patient });
      expect(call.notBeforeMin).toBeGreaterThan(NOW);

      visit(call);
      expect(callOf(friend)).toBeNull();
      expect(callsMadeTo(patient, 'sick_visit')).toHaveLength(1);
      const inv = db.select().from(economy).where(eq(economy.agent_id, patient)).get()!.inventory;
      expect(inv.find((i) => i.itemId === 'bread')?.quantity).toBe(1);
      expect(moodSources(patient)).toContain('sick_visit');
      const sick = db.select().from(agentStates).where(and(eq(agentStates.agent_id, patient), eq(agentStates.type, 'sick'))).get()!;
      expect(sick.severity).toBeCloseTo(0.55);
      const rows = rowsWithBeat('sick_visit');
      expect(rows).toHaveLength(1);
      expect(rows[0].importance).toBeGreaterThanOrEqual(0.5);
      expect(rows[0].importance).toBeLessThanOrEqual(0.65);
      expect((rows[0].template_data as { description: string }).description).toMatch(/Ana Gil called on Elena Ruiz, who is ill and brought/);
    });

    it('not for a sniffle, not from the household, and not from a rival', () => {
      const patient = insertResident('Elena Ruiz', town.homes[0]);
      const housemate = insertResident('Hugo Ruiz', town.homes[0]);
      const rival = insertResident('Rita Mora', town.homes[1]);
      for (const id of [housemate, rival]) setEffectivePersonality(id, WARM);
      relate(patient, housemate, { friendship_ab: 80, friendship_ba: 80 });
      relate(patient, rival, { friendship_ab: 50, friendship_ba: 50, status: 'rivals' });
      giveState(patient, 'sick', 0.2);
      producers.onSick(patient, NOW);
      expect(pendingCallsFor(patient)).toHaveLength(0);
      db.update(agentStates).set({ severity: 0.7 }).where(eq(agentStates.agent_id, patient)).run();
      producers.onSick(patient, NOW);
      expect(pendingCallsFor(patient)).toHaveLength(0);
    });
  });

  describe('vigil', () => {
    it('a grave illness brings the spouse at once (urgent), and the healer', () => {
      const patient = insertResident('Elena Ruiz', town.homes[0]);
      const husband = insertResident('Tomas Ruiz', town.homes[1]);
      const doctor = insertResident('Doc Hale', town.homes[2], {}, { job: 'doctor' });
      setEffectivePersonality(husband, { ...PERSONALITY, warmth: 30, loyalty: 95 });
      relate(patient, husband, { friendship_ab: 70, friendship_ba: 70, status: 'partners', tags: ['married'] });
      giveState(patient, 'sick', 0.8, { grave: true });

      producers.onGrave(patient, NOW);
      expect(callOf(husband)).toMatchObject({ kind: 'vigil', urgent: true });
      expect(callOf(doctor)).toMatchObject({ kind: 'vigil', payload: { role: 'healer' } });

      visit(callOf(husband)!);
      expect(lingerOf(husband, NOW + 30)).toMatchObject({ targetId: patient });
      expect(rowsWithBeat('vigil')).toHaveLength(1);
      expect(rowsWithBeat('vigil')[0].importance).toBeGreaterThan(0.7);
    });

    it('if the patient dies, those who kept the vigil grieve harder and those who never came feel guilt', () => {
      const patient = insertResident('Elena Ruiz', town.homes[0]);
      const husband = insertResident('Tomas Ruiz', town.homes[1]);
      const sister = insertResident('Lucia Ruiz', town.homes[2]);
      for (const id of [husband, sister]) setEffectivePersonality(id, WARM);
      relate(patient, husband, { friendship_ab: 70, friendship_ba: 70, status: 'partners', tags: ['married'] });
      relate(patient, sister, { friendship_ab: 90, friendship_ba: 90 });
      giveState(patient, 'sick', 0.8, { grave: true });
      producers.onGrave(patient, NOW);
      expect(callOf(sister)).not.toBeNull();
      visit(callOf(husband)!);

      producers.onDeathAfterVigil(patient, NOW + 300);
      expect(moodSources(husband)).toContain('vigil_grief');
      expect(moodSources(sister)).toContain('vigil_guilt');
    });
  });

  describe('condolence', () => {
    it('a friend who is not mourning comes to the mourner; another mourner does not', () => {
      const widow = insertResident('Rosa Vidal', town.homes[0]);
      const friend = insertResident('Ana Gil', town.homes[1]);
      const fellowMourner = insertResident('Pablo Vidal', town.homes[2]);
      for (const id of [friend, fellowMourner]) setEffectivePersonality(id, WARM);
      relate(widow, friend, { friendship_ab: 60, friendship_ba: 60 });
      relate(widow, fellowMourner, { friendship_ab: 80, friendship_ba: 80 });
      giveState(widow, 'grieving');
      giveState(fellowMourner, 'grieving');

      producers.onMourning(widow, 'Tom Vidal', NOW);
      expect(pendingCallsFor(widow, 'condolence').map((c) => c.callerId)).toEqual([friend]);
      visit(callOf(friend)!);
      expect((rowsWithBeat('condolence')[0].template_data as { description: string }).description).toMatch(/condolences for Tom Vidal/);
      expect(moodSources(widow)).toContain('condolence');
    });

    it('caps the condolence calls one death brings, however many mourners', () => {
      const deceased = 'Tom Vidal';
      const mourners = [0, 1, 2, 3].map((i) => insertResident(`Mourner ${i}`, town.homes[i % 3]));
      const friends = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => insertResident(`Friend ${i}`, town.homes[i % 3]));
      for (const f of friends) setEffectivePersonality(f, WARM);
      for (const m of mourners) {
        giveState(m, 'grieving');
        for (const f of friends) relate(m, f, { friendship_ab: 80, friendship_ba: 80 });
      }
      for (const m of mourners) producers.onMourning(m, deceased, NOW);
      const total = mourners.reduce((s, m) => s + pendingCallsFor(m, 'condolence').length, 0);
      expect(total).toBeLessThanOrEqual(5);
      expect(total).toBeGreaterThan(0);
    });
  });

  describe('congratulate', () => {
    it('friends of an engaged couple come round, at most three', () => {
      const a = insertResident('Rosa Vidal', town.homes[0]);
      const b = insertResident('Diego Paz', town.homes[1], { gender: 'male' });
      const friends = [0, 1, 2, 3].map((i) => insertResident(`Friend ${i}`, town.homes[2]));
      for (const f of friends) {
        setEffectivePersonality(f, WARM);
        relate(a, f, { friendship_ab: 70, friendship_ba: 70 });
        relate(b, f, { friendship_ab: 70, friendship_ba: 70 });
      }
      producers.onEngaged(a, b, NOW);
      const calls = [...pendingCallsFor(a, 'congratulate'), ...pendingCallsFor(b, 'congratulate')];
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.length).toBeLessThanOrEqual(3);
      visit(calls[0]);
      expect((rowsWithBeat('congratulation')[0].template_data as { description: string }).description).toMatch(/on the engagement/);
    });

    it('a birth brings congratulations on the baby by name', () => {
      const mother = insertResident('Rosa Vidal', town.homes[0]);
      const friend = insertResident('Ana Gil', town.homes[1]);
      setEffectivePersonality(friend, WARM);
      relate(mother, friend, { friendship_ab: 70, friendship_ba: 70 });
      producers.onBirth([mother], 'Ada', NOW);
      const call = callOf(friend)!;
      expect(call.payload).toMatchObject({ occasion: 'birth', childName: 'Ada' });
      visit(call);
      expect((rowsWithBeat('congratulation')[0].template_data as { description: string }).description).toMatch(/little Ada/);
    });
  });

  describe('birthday_wish', () => {
    it('a close friend calls during the day; a birthday nobody marked is noticed at night', () => {
      const remembered = insertResident('Rosa Vidal', town.homes[0]);
      const forgotten = insertResident('Lone Wolf', town.homes[1]);
      const friend = insertResident('Ana Gil', town.homes[2]);
      setEffectivePersonality(friend, WARM);
      relate(remembered, friend, { friendship_ab: 80, friendship_ba: 80 });

      producers.onBirthday(remembered, NOW);
      producers.onBirthday(forgotten, NOW);
      const call = callOf(friend)!;
      expect(call.kind).toBe('birthday_wish');
      expect(call.notBeforeMin).toBeGreaterThanOrEqual(NOW + 9 * 60);
      expect(call.expiresAtMin).toBeLessThanOrEqual(NOW + 22 * 60);
      visit(call);

      socialCallsHourly(NOW + 22 * 60);
      const lonely = rowsWithBeat('forgotten_birthday');
      expect(lonely).toHaveLength(1);
      expect(lonely[0].initiator_id).toBe(forgotten);
      expect(moodSources(forgotten)).toContain('forgotten_birthday');
      expect(moodSources(remembered)).not.toContain('forgotten_birthday');
    });
  });

  describe('welcome', () => {
    it('neighbours and the mayor call on a newcomer; the first tie starts above a stranger', () => {
      const newcomer = insertResident('New Face', town.homes[0]);
      const neighbour = insertResident('Ana Gil', town.homes[1]);
      const mayor = insertResident('Mayor May', town.homes[2], {}, { job: 'mayor' });
      for (const id of [neighbour, mayor]) setEffectivePersonality(id, { ...WARM, curiosity: 90 });
      producers.onArrived(newcomer, NOW);
      expect(callOf(neighbour)).toMatchObject({ kind: 'welcome', targetId: newcomer });
      expect(callOf(mayor)).toMatchObject({ kind: 'welcome', targetId: newcomer });
      expect(callOf(mayor)!.notBeforeMin).toBeGreaterThanOrEqual(NOW + 20 * 60);

      visit(callOf(neighbour)!);
      const ev = db.select().from(relationshipEvents).all().find((e) => e.event_type === 'visit')!;
      expect(Math.min(ev.friendship_delta_ab, ev.friendship_delta_ba)).toBeGreaterThanOrEqual(10);
      expect(rowsWithBeat('welcome')).toHaveLength(1);
    });
  });

  describe('console', () => {
    it('losing one\'s work brings a friend; a new trade by choice does not', () => {
      const loser = insertResident('Rosa Vidal', town.homes[0]);
      const friend = insertResident('Ana Gil', town.homes[1]);
      setEffectivePersonality(friend, WARM);
      relate(loser, friend, { friendship_ab: 70, friendship_ba: 70 });
      producers.onJobChanged(loser, 'farmer', 'baker', 'ambition', NOW);
      expect(callOf(friend)).toBeNull();
      producers.onJobChanged(loser, 'farmer', 'unemployed', 'vacancy', NOW);
      const call = callOf(friend)!;
      expect(call).toMatchObject({ kind: 'console', payload: { reason: 'work' } });
      visit(call);
      expect(moodSources(loser)).toContain('consoled');
      expect(rowsWithBeat('consolation')).toHaveLength(1);
    });

    it('a broken heart is consoled by a friend, never by the one who broke it', () => {
      const heartbroken = insertResident('Rosa Vidal', town.homes[0]);
      const ex = insertResident('Diego Paz', town.homes[1], { gender: 'male' });
      setEffectivePersonality(ex, WARM);
      relate(heartbroken, ex, { friendship_ab: 70, friendship_ba: 70, romance_ab: 60 });
      producers.onHeartbroken(heartbroken, NOW);
      expect(callOf(ex)).toBeNull();
    });

    it('the election\'s losers are consoled and the winner congratulated', () => {
      const winner = insertResident('Win Ner', town.homes[0]);
      const loser = insertResident('Lo Ser', town.homes[1]);
      const fw = insertResident('Friend Win', town.homes[2]);
      const fl = insertResident('Friend Lose', town.homes[2]);
      for (const id of [fw, fl]) setEffectivePersonality(id, WARM);
      relate(winner, fw, { friendship_ab: 70, friendship_ba: 70 });
      relate(loser, fl, { friendship_ab: 70, friendship_ba: 70 });
      producers.onElection(winner, [loser], NOW);
      expect(callOf(fw)).toMatchObject({ kind: 'congratulate', payload: { occasion: 'election' } });
      expect(callOf(fl)).toMatchObject({ kind: 'console', payload: { reason: 'election' } });
    });
  });

  describe('plead_to_stay', () => {
    it('a close friend comes to ask them to stay, and is glad later if they do', () => {
      const thinker = insertResident('Rosa Vidal', town.homes[0]);
      const friend = insertResident('Ana Gil', town.homes[1]);
      setEffectivePersonality(friend, WARM);
      relate(thinker, friend, { friendship_ab: 70, friendship_ba: 70 });
      producers.onThinkingOfLeaving(thinker, NOW);
      visit(callOf(friend)!);
      expect(rowsWithBeat('plea_to_stay')).toHaveLength(1);
      producers.onDecidedToStay(thinker, NOW + 600);
      expect(moodSources(friend)).toContain('friend_stayed');
    });
  });

  describe('meet_at_gate', () => {
    it('a warm spouse meets them out of jail', () => {
      const convict = insertResident('Rosa Vidal', town.homes[0]);
      const husband = insertResident('Diego Paz', town.homes[1], { gender: 'male' });
      setEffectivePersonality(husband, WARM);
      relate(convict, husband, { friendship_ab: 70, friendship_ba: 70, status: 'partners', tags: ['married'] });
      producers.onReleased(convict, NOW);
      const call = callOf(husband)!;
      expect(call.payload.mode).toBe('welcome');
      visit(call);
      expect(rowsWithBeat('welcome_home')).toHaveLength(1);
      expect(moodSources(convict)).toContain('welcomed_home');
    });

    it('a cold, upright close tie comes instead to give them a piece of their mind', () => {
      const convict = insertResident('Rosa Vidal', town.homes[0]);
      const aunt = insertResident('Aunt Prim', town.homes[1]);
      setEffectivePersonality(aunt, { ...PERSONALITY, warmth: 20, morality: 90, loyalty: 95 });
      relate(convict, aunt, { friendship_ab: 60, friendship_ba: 60 });
      producers.onReleased(convict, NOW);
      const call = callOf(aunt)!;
      expect(call.payload.mode).toBe('reproach');
      visit(call);
      expect(rowsWithBeat('cold_shoulder')).toHaveLength(1);
      const ev = db.select().from(relationshipEvents).all().find((e) => e.event_type === 'reproach')!;
      expect(Math.min(ev.friendship_delta_ab, ev.friendship_delta_ba)).toBeLessThan(0);
    });
  });

  describe('lend_money', () => {
    function lendingPair(): { debtor: number; lender: number } {
      const debtor = insertResident('Broke Bob', town.homes[0], {}, { money: 2 });
      const lender = insertResident('Rich Ruth', town.homes[1], {}, { money: 300 });
      setEffectivePersonality(lender, WARM);
      relate(debtor, lender, { friendship_ab: 70, friendship_ba: 70 });
      return { debtor, lender };
    }
    const money = (id: number) => db.select().from(economy).where(eq(economy.agent_id, id)).get()!.money;

    it('a well-off warm friend lends real money, recorded as a loan', () => {
      const { debtor, lender } = lendingPair();
      onHardTimes(debtor, NOW);
      const call = callOf(lender)!;
      expect(call.kind).toBe('lend_money');
      visit(call);
      const loan = db.select().from(loans).get()!;
      expect(loan).toMatchObject({ lender_id: lender, borrower_id: debtor, status: 'open' });
      expect(money(lender)).toBeCloseTo(300 - loan.amount);
      expect(money(debtor)).toBeCloseTo(2 + loan.amount);
      expect(rowsWithBeat('loan')).toHaveLength(1);
      // At most one loan at a time.
      onHardTimes(debtor, NOW + 60);
      expect(pendingCallsFor(debtor, 'lend_money')).toHaveLength(0);
    });

    it('a poor or cold friend does not lend', () => {
      const debtor = insertResident('Broke Bob', town.homes[0], {}, { money: 2 });
      const poor = insertResident('Poor Pat', town.homes[1], {}, { money: 40 });
      const cold = insertResident('Cold Cal', town.homes[2], {}, { money: 400 });
      setEffectivePersonality(poor, WARM);
      setEffectivePersonality(cold, { ...PERSONALITY, warmth: 10 });
      relate(debtor, poor, { friendship_ab: 70, friendship_ba: 70 });
      relate(debtor, cold, { friendship_ab: 70, friendship_ba: 70 });
      onHardTimes(debtor, NOW);
      expect(pendingCallsFor(debtor)).toHaveLength(0);
    });

    it('is repaid once the borrower is back on their feet', () => {
      const { debtor, lender } = lendingPair();
      onHardTimes(debtor, NOW);
      visit(callOf(lender)!);
      const loan = db.select().from(loans).get()!;
      db.update(economy).set({ money: 200 }).where(eq(economy.agent_id, debtor)).run();
      const before = money(lender);
      loansHourly(NOW + DAY);
      expect(db.select().from(loans).get()!.status).toBe('repaid');
      expect(money(lender)).toBeCloseTo(before + loan.amount);
      expect(money(debtor)).toBeCloseTo(200 - loan.amount);
      expect(rowsWithBeat('loan_repaid')).toHaveLength(1);
    });

    it('unpaid after two weeks, it sours into a debt the lender knows of', () => {
      const { debtor, lender } = lendingPair();
      onHardTimes(debtor, NOW);
      visit(callOf(lender)!);
      db.update(economy).set({ money: 5 }).where(eq(economy.agent_id, debtor)).run();
      loansHourly(NOW + 13 * DAY);
      expect(db.select().from(loans).get()!.status).toBe('open');
      loansHourly(NOW + 15 * DAY);
      expect(db.select().from(loans).get()!.status).toBe('overdue');
      const fact = db.select().from(shared_knowledge).where(eq(shared_knowledge.type, 'debt')).get()!;
      expect(fact).toMatchObject({ subject_id: debtor, target_id: lender });
      expect(fact.known_by as number[]).toContain(lender);
      expect(rowsWithBeat('loan_unpaid')).toHaveLength(1);
      // Once.
      loansHourly(NOW + 16 * DAY);
      expect(rowsWithBeat('loan_unpaid')).toHaveLength(1);
    });

    it('is voided when the borrower is gone', () => {
      const { debtor, lender } = lendingPair();
      onHardTimes(debtor, NOW);
      visit(callOf(lender)!);
      db.update(agents).set({ is_active: false }).where(eq(agents.id, debtor)).run();
      loansHourly(NOW + DAY);
      expect(db.select().from(loans).get()!.status).toBe('void');
    });
  });

  describe('wiring', () => {
    it('the sim\'s own events reach the producers', () => {
      const patient = insertResident('Elena Ruiz', town.homes[0]);
      const widow = insertResident('Rosa Vidal', town.homes[1]);
      const friend = insertResident('Ana Gil', town.homes[2]);
      const other = insertResident('Otto Paz', town.homes[2]);
      for (const id of [friend, other]) setEffectivePersonality(id, WARM);
      relate(patient, friend, { friendship_ab: 60, friendship_ba: 60 });
      relate(widow, other, { friendship_ab: 60, friendship_ba: 60 });
      giveState(patient, 'sick', 0.7);
      giveState(widow, 'grieving');
      // The widow's first: Otto is also one of the patient's neighbours, and one call at a time.
      simEvents.emit('state:triggered', { agentId: widow, state: 'grieving', cause: 'mourning Tom Vidal' });
      simEvents.emit('state:triggered', { agentId: patient, state: 'sick', cause: 'random:environment' });
      expect(callOf(friend)).toMatchObject({ kind: 'sick_visit' });
      expect(callOf(other)).toMatchObject({ kind: 'condolence', payload: { deceased: 'Tom Vidal' } });
      // A death drops every call to the dead.
      simEvents.emit('life:death', { agentId: patient, name: 'Elena Ruiz', cause: 'x', causeDescription: 'x' });
      expect(callOf(friend)).toBeNull();
    });
  });

  describe('the visit itself', () => {
    it('an LLM chat that never got a line said is not a visit: the call stays pending', () => {
      const patient = insertResident('Elena Ruiz', town.homes[0]);
      const friend = insertResident('Ana Gil', town.homes[1]);
      setEffectivePersonality(friend, WARM);
      relate(patient, friend, { friendship_ab: 60, friendship_ba: 60 });
      giveState(patient, 'sick', 0.6);
      producers.onSick(patient, NOW);
      visit(callOf(friend)!, { template: false, turns: 0 });
      expect(callOf(friend)).not.toBeNull();
    });

    it('only the caller\'s own emit, for this kind and this target, counts', () => {
      const patient = insertResident('Elena Ruiz', town.homes[0]);
      const friend = insertResident('Ana Gil', town.homes[1]);
      setEffectivePersonality(friend, WARM);
      relate(patient, friend, { friendship_ab: 60, friendship_ba: 60 });
      giveState(patient, 'sick', 0.6);
      producers.onSick(patient, NOW);
      const call = callOf(friend)!;
      onCallConversationEnded({ agentId: patient, perpetratorId: friend, triggerReason: callTrigger('sick_visit'), template: true });
      onCallConversationEnded({ agentId: friend, perpetratorId: patient, triggerReason: 'needs_social', template: true });
      onCallConversationEnded({ agentId: friend, perpetratorId: patient, triggerReason: callTrigger('welcome'), template: true });
      expect(callOf(friend)?.id).toBe(call.id);
    });

    it('a call nobody kept is recorded missed by the hourly sweep', () => {
      const patient = insertResident('Elena Ruiz', town.homes[0]);
      const friend = insertResident('Ana Gil', town.homes[1]);
      setEffectivePersonality(friend, WARM);
      relate(patient, friend, { friendship_ab: 60, friendship_ba: 60 });
      giveState(patient, 'sick', 0.6);
      producers.onSick(patient, NOW);
      socialCallsHourly(NOW + 3 * DAY);
      expect(callOf(friend)).toBeNull();
      expect(callsMadeTo(patient)).toHaveLength(0);
    });
  });
});
