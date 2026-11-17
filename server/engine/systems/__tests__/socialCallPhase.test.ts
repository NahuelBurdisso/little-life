import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, agentStates, conversationQueue } from '../../../db/schema';
import { gameMinutes } from '../../../lib/gameClock';
import { clearSocialCallState } from '../../../lib/socialCalls';
import { callOf, callRecordsFor, scheduleCall, startLinger } from '../../../lib/socialCalls/engine';
import { loadDecisionContext } from '../decisions/context';
import { socialCallPhase, SOCIAL_CALL_SCORE, URGENT_SOCIAL_CALL_SCORE } from '../decisions/socialCall';
import { queueSocialConversation } from '../decisions/social';
import type { AgentTurn } from '../decisions/context';
import { freshTown, insertResident, relate } from '../../../lib/__tests__/populationFixtures';

/** 18:00: everyone is off work and nobody is in bed yet. */
const EVENING = { day: 20, hour: 18, minute: 0, totalTicks: 28_800, seasonDay: 5, season: 'spring' };
/** 11:00: the 9-17 shift is on. */
const MIDDAY = { ...EVENING, hour: 11 };
const AT = gameMinutes(EVENING);

function ctx(time = EVENING) {
  return loadDecisionContext({ time, tick_speed: 1 });
}

function agentRow(id: number) {
  return db.select().from(agents).where(eq(agents.id, id)).get()!;
}

describe('socialCallPhase: walking over to keep a promised call', () => {
  let town: ReturnType<typeof freshTown>;
  let caller: number;
  let target: number;
  beforeEach(() => {
    town = freshTown();
    clearSocialCallState();
    target = insertResident('Elena Ruiz', town.homes[0]);
    caller = insertResident('Ana Gil', town.homes[1]);
    relate(caller, target, { friendship_ab: 60, friendship_ba: 60 });
  });

  function promise(kind = 'birthday_wish', over: { notBeforeMin?: number; expiresAtMin?: number } = {}) {
    return scheduleCall({ kind, callerId: caller, targetId: target, nowMin: AT - 10, notBeforeMin: AT - 5, ...over })!;
  }

  it('walks the caller to wherever the target is, with the call\'s topic and words for the player', () => {
    promise();
    const d = socialCallPhase(agentRow(caller), ctx());
    expect(d).toMatchObject({
      action: 'socializing', score: SOCIAL_CALL_SCORE, targetAgentId: target, targetLocationId: town.homes[0],
      topic: 'birthday wishes', source: 'social_call',
    });
    expect(d!.walkDescription).toBe('On the way to wish Elena a happy birthday');
    expect(d!.description).toBe('Wishing Elena a happy birthday');
  });

  it('waits until the stagger lets them go', () => {
    promise('birthday_wish', { notBeforeMin: AT + 60 });
    expect(socialCallPhase(agentRow(caller), ctx())).toBeNull();
    expect(callOf(caller)).not.toBeNull();
  });

  it('leaves the call pending while the target sleeps', () => {
    promise();
    db.update(agents).set({ current_action: { type: 'sleeping' } }).where(eq(agents.id, target)).run();
    expect(socialCallPhase(agentRow(caller), ctx())).toBeNull();
    expect(callOf(caller)).not.toBeNull();
  });

  it('pulls nobody off a work shift — unless the call is urgent', () => {
    const noonCall = gameMinutes(MIDDAY);
    scheduleCall({ kind: 'birthday_wish', callerId: caller, targetId: target, nowMin: noonCall - 10, notBeforeMin: noonCall - 5 });
    db.update(agents).set({ workplace: town.bakery }).where(eq(agents.id, caller)).run();
    expect(socialCallPhase(agentRow(caller), ctx(MIDDAY))).toBeNull();
    clearSocialCallState();
    db.insert(agentStates).values({ agent_id: target, type: 'sick', severity: 0.9, started_at: 0, duration: 99999, source: 'test', metadata: { grave: true } }).run();
    const noon = gameMinutes(MIDDAY);
    scheduleCall({ kind: 'vigil', callerId: caller, targetId: target, nowMin: noon - 10, notBeforeMin: noon - 5 });
    expect(socialCallPhase(agentRow(caller), ctx(MIDDAY))).toMatchObject({ score: URGENT_SOCIAL_CALL_SCORE, targetAgentId: target });
  });

  it('drops the call when the target has died, and records a missed one past its window', () => {
    promise();
    db.update(agents).set({ current_action: { type: 'dead' } }).where(eq(agents.id, target)).run();
    expect(socialCallPhase(agentRow(caller), ctx())).toBeNull();
    expect(callOf(caller)).toBeNull();
    expect(callRecordsFor(target)[0].outcome).toBe('dropped');

    db.update(agents).set({ current_action: { type: 'idle' } }).where(eq(agents.id, target)).run();
    promise('birthday_wish', { expiresAtMin: AT - 1 });
    expect(socialCallPhase(agentRow(caller), ctx())).toBeNull();
    expect(callRecordsFor(target).map((r) => r.outcome)).toContain('expired');
  });

  it('drops a call that no longer makes sense (the patient at whose bedside they meant to sit recovered)', () => {
    promise('vigil');
    expect(socialCallPhase(agentRow(caller), ctx())).toBeNull();
    expect(callOf(caller)).toBeNull();
  });

  it('a sick caller stays home but keeps the promise', () => {
    promise();
    db.insert(agentStates).values({ agent_id: caller, type: 'sick', severity: 0.5, started_at: 0, duration: 99999, source: 'test', metadata: null }).run();
    expect(socialCallPhase(agentRow(caller), ctx())).toBeNull();
    expect(callOf(caller)).not.toBeNull();
  });

  it('after a vigil, stays at the bedside', () => {
    startLinger(caller, target, AT + 60, 1);
    expect(socialCallPhase(agentRow(caller), ctx())).toMatchObject({
      action: 'idle', targetLocationId: town.homes[0], description: "Sitting at Elena's bedside",
    });
  });

  it('once together, queues the visit with the call\'s trigger even if the pair just talked', () => {
    const call = promise();
    db.update(agents).set({ current_location: town.homes[0], position: { x: 300, y: 300 } }).where(eq(agents.id, caller)).run();
    db.update(agents).set({ position: { x: 300, y: 300 } }).where(eq(agents.id, target)).run();
    const d = ctx();
    const decision = socialCallPhase(agentRow(caller), d)!;
    const turn = { agent: agentRow(caller), agentNeeds: d.needsMap.get(caller)!, agentEcon: null, critical: 10, mealPlan: () => null } as AgentTurn;
    queueSocialConversation(turn, decision, { ...d, pairOnCooldown: () => true });
    const q = db.select().from(conversationQueue).all();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ participants: [caller, target], trigger_reason: 'social_call:birthday_wish', topic: 'birthday wishes' });
    expect(q[0].tier).not.toBe('template');
    expect(callOf(caller)).toMatchObject({ id: call.id, seatedAtMin: AT });
  });
});
