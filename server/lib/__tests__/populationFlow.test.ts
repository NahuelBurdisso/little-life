import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, agentStates, economy, needs, worldState } from '../../db/schema';
import {
  POPULATION_FLOW, arrivalAllowed, clearPopulationFlow, decidesToStay, departureAllowed, departureReasons,
  getPopulationFlowState, leavingThoughts, pickArrivalJob, pickArrivalName, pickLeaver, populationFloor,
  populationFlowDaily, populationFlowSnapshotStore, populationFlowTick, populationTargets,
  type DepartureSignals,
} from '../populationFlow';
import { clearMoodTrackers, getMoodMomentum, getMoodStreak, moodMomentumSnapshotStore } from '../moodMomentum';
import { RuleOverridesSchema, setRuleOverrides } from '../worldRules';
import { memoryService } from '../memory/instance';
import { simEvents } from '../simEvents';
import { makeRng } from '../worldgen/rng';
import { buildBrewing } from '../brewing';
import { nudgeRouter } from '../../routers/nudge';
import { CONFIG } from '../constants';
import { DAY, NOW, TIME, freshTown, insertResident, relate, type Town } from './populationFixtures';

/**
 * Population flow (lib/populationFlow.ts): unhappy residents think about
 * leaving for a day, stay if someone reaches them, otherwise walk out of town;
 * strangers take empty houses. Rate limited both ways, floored, switchable.
 */

// ─── Pure rules ──────────────────────────────────────────────────────────────

const content: DepartureSignals = {
  agentId: 1, mood: 60, moodStreak: 0, estrangedFromPartner: false, reputation: 10, friendCount: 2, debtDays: 0, heldBack: false,
};

describe('departure rules', () => {
  it('names each reason a life here has gone wrong', () => {
    expect(departureReasons(content)).toEqual([]);
    expect(departureReasons({ ...content, moodStreak: -3 })).toEqual(['unhappy']);
    expect(departureReasons({ ...content, moodStreak: -2 })).toEqual([]);
    expect(departureReasons({ ...content, estrangedFromPartner: true })).toEqual(['estranged']);
    // Distrusted but with a friend: not shunned.
    expect(departureReasons({ ...content, reputation: -40, friendCount: 1 })).toEqual([]);
    expect(departureReasons({ ...content, reputation: -40, friendCount: 0 })).toEqual(['shunned']);
    expect(departureReasons({ ...content, debtDays: 2.5 })).toEqual(['broke']);
  });

  it('picks the one with the most reasons, then the unhappiest; never someone held back', () => {
    const a = { ...content, agentId: 1, moodStreak: -4, mood: 30 };
    const b = { ...content, agentId: 2, moodStreak: -4, debtDays: 3, mood: 40 };
    const c = { ...content, agentId: 3, moodStreak: -4, mood: 20 };
    expect(pickLeaver([a, b, c])).toEqual({ agentId: 2, reasons: ['unhappy', 'broke'] });
    expect(pickLeaver([a, c])?.agentId).toBe(3);
    expect(pickLeaver([{ ...b, heldBack: true }, content])).toBeNull();
  });

  it('a thinker stays when cared for, cheered up, or no longer has a reason', () => {
    const low = { ...content, moodStreak: -4, mood: 30 };
    const t = { caredBy: null, moodAtStart: 30 };
    expect(decidesToStay(t, low)).toBe(false);
    expect(decidesToStay({ ...t, caredBy: 'Rosa' }, low)).toBe(true);
    expect(decidesToStay(t, { ...low, mood: POPULATION_FLOW.RECOVERED_MOOD })).toBe(true);
    // In fair spirits all along (broke, not sad): no change of heart.
    expect(decidesToStay({ ...t, moodAtStart: 58 }, { ...low, mood: 60 })).toBe(false);
    expect(decidesToStay(t, { ...low, moodStreak: 0 })).toBe(true);
  });

  it('keeps the town above its floor and departures days apart', () => {
    expect(populationFloor(13)).toBe(10);
    expect(populationFloor(4)).toBe(POPULATION_FLOW.MIN_FLOOR);
    const base = { living: 13, leaving: 0, target: 13, lastDepartureAt: null, now: 10 * DAY };
    expect(departureAllowed(base)).toBe(true);
    expect(departureAllowed({ ...base, living: 10 })).toBe(false);
    expect(departureAllowed({ ...base, living: 12, leaving: 1 })).toBe(true);
    expect(departureAllowed({ ...base, living: 11, leaving: 1 })).toBe(false);
    expect(departureAllowed({ ...base, lastDepartureAt: 10 * DAY - 3 * DAY })).toBe(false);
    expect(departureAllowed({ ...base, lastDepartureAt: 10 * DAY - 4 * DAY })).toBe(true);
  });

  it('lets newcomers in only below target, into an empty house, under the cap, days apart', () => {
    const base = { living: 10, leaving: 0, target: 13, emptyHomes: 1, lastArrivalAt: null, now: 10 * DAY };
    expect(arrivalAllowed(base)).toBe(true);
    expect(arrivalAllowed({ ...base, emptyHomes: 0 })).toBe(false);
    expect(arrivalAllowed({ ...base, living: 13 })).toBe(false);
    expect(arrivalAllowed({ ...base, living: 13, leaving: 1 })).toBe(true);
    expect(arrivalAllowed({ ...base, living: CONFIG.MAX_AGENTS, target: 40 })).toBe(false);
    expect(arrivalAllowed({ ...base, lastArrivalAt: 10 * DAY - 2 * DAY })).toBe(false);
    expect(arrivalAllowed({ ...base, lastArrivalAt: 10 * DAY - 3 * DAY })).toBe(true);
  });
});

describe('who arrives', () => {
  it('fills a missing essential trade first, else a helper the town has a workplace for', () => {
    const rng = makeRng(1);
    const types = ['home', 'bakery', 'clinic', 'farm', 'tavern'];
    expect(pickArrivalJob(['farmer', 'bartender'], types, rng)).toBe('doctor');
    expect(pickArrivalJob(['doctor', 'farmer', 'bartender'], types, rng)).toBe('baker');
    const helper = pickArrivalJob(['doctor', 'baker', 'farmer', 'bartender'], types, rng);
    expect(['farmhand', 'medical_assistant', 'musician']).toContain(helper);
    expect(pickArrivalJob([], ['home'], rng)).toBe('unemployed');
  });

  it('gets a period name no resident already goes by', () => {
    const rng = makeRng(7);
    const taken = ['Ada Finch', 'Albert Novak'];
    for (let i = 0; i < 30; i++) {
      const { name, gender } = pickArrivalName(taken, rng);
      expect(['female', 'male']).toContain(gender);
      expect(name.split(' ')[0]).not.toBe('Ada');
      expect(name.split(' ')[0]).not.toBe('Albert');
      expect(taken).not.toContain(name);
    }
  });
});

describe('brewing', () => {
  it('shows someone thinking of leaving, and hotter once decided', () => {
    const base = { agents: [{ id: 1, name: 'Mabel', personality: null }], tension: [], secrets: [], queue: [], goals: [], relationships: [] };
    const [thinking] = buildBrewing({ ...base, leaving: [{ agentId: 1, reasons: ['broke'], decided: false }] });
    expect(thinking).toMatchObject({ kind: 'leaving', agentIds: [1] });
    expect(thinking.text).toMatch(/Mabel is thinking of leaving town — no money/);
    const [decided] = buildBrewing({ ...base, leaving: [{ agentId: 1, reasons: [], decided: true }] });
    expect(decided.heat).toBeGreaterThan(thinking.heat);
    // A departed resident brews nothing.
    expect(buildBrewing({ ...base, agents: [], leaving: [{ agentId: 1, reasons: [], decided: false }] })).toEqual([]);
  });
});

// ─── Against the DB ──────────────────────────────────────────────────────────

let town: Town;
let recorded: Array<{ agentId: number; description: string }>;

/** The clock at midnight of `day`, and that minute. */
const midnight = (day: number) => ({ time: { ...TIME, day, hour: 0 }, now: NOW + (day - TIME.day) * DAY });
const at = (day: number, hour: number) => ({ time: { ...TIME, day, hour }, now: NOW + (day - TIME.day) * DAY + hour * 60 });
const daily = (day: number) => { const m = midnight(day); populationFlowDaily(m.time, m.now); };
const tickAt = (day: number, hour: number) => { const t = at(day, hour); populationFlowTick(t.time, t.now); };

function setClock(day: number, hour: number): void {
  const t = at(day, hour);
  db.update(worldState).set({ time: { ...t.time, totalTicks: t.now } }).run();
}

/** A town of `n` content residents in the big house and the tavern (no empty-house arrivals unless asked). */
function populate(n: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(insertResident(`Resident ${String.fromCharCode(65 + i)}`, i < 4 ? town.homes[2] : town.tavern));
  return ids;
}

/** Days of bad mood and broke for three days. One call for all of them: the restore replaces every tracker. */
function makeMiserable(...ids: number[]): void {
  moodMomentumSnapshotStore.restore(Object.fromEntries(ids.map((id) => [id, { moodSamples: [], momentum: -10, streak: -4 }])));
  for (const id of ids) {
    db.update(needs).set({ mood: 25 }).where(eq(needs.agent_id, id)).run();
    db.insert(agentStates).values({
      agent_id: id, type: 'in_debt', severity: 0.5, started_at: NOW - 3 * DAY, duration: 999_999, source: 'test',
    }).run();
  }
}

const feed = (beat: string) => db.select().from(activityLog).all()
  .filter((r) => (r.metadata as { beat?: string } | null)?.beat === beat);

beforeEach(() => {
  town = freshTown();
  clearPopulationFlow();
  clearMoodTrackers();
  recorded = [];
  vi.spyOn(memoryService, 'record').mockImplementation((agentId, _t, description) => {
    recorded.push({ agentId, description });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearPopulationFlow();
  clearMoodTrackers();
});

describe('leaving town', () => {
  it('thinks it over for a day, then says goodbye, walks to the edge and is gone', () => {
    const ids = populate(8);
    // Everyone full up; the town target is 8 so the floor is 6.
    setRuleOverrides({ populationTarget: 8 });
    // Fill the two small houses so no arrival is scheduled on the way.
    insertResident('Filler One', town.homes[0]);
    insertResident('Filler Two', town.homes[1]);
    const leaver = ids[5];
    const friend = ids[6];
    relate(leaver, friend, { friendship_ab: 60, friendship_ba: 60 });
    makeMiserable(leaver);
    const thinking = vi.fn();
    simEvents.on('life:thinking_of_leaving', thinking);

    daily(TIME.day);
    simEvents.off('life:thinking_of_leaving', thinking);
    expect(thinking.mock.calls).toEqual([[{ agentId: leaver, reason: 'unhappy', reasons: ['unhappy', 'broke'] }]]);
    expect(getPopulationFlowState().thinking).toMatchObject([{ agentId: leaver, reasons: ['unhappy', 'broke'] }]);
    expect(leavingThoughts()).toEqual([{ agentId: leaver, reasons: ['unhappy', 'broke'], decided: false }]);
    expect(recorded.some((r) => r.agentId === leaver && /think about leaving town/.test(r.description))).toBe(true);

    // Still miserable the next day: decided, leaving at 08:00.
    daily(TIME.day + 1);
    const [d] = getPopulationFlowState().departing;
    expect(d).toMatchObject({ agentId: leaver, leaveAt: at(TIME.day + 1, 8).now, walkingSince: null });
    tickAt(TIME.day + 1, 7);
    expect(feed('departure')).toHaveLength(0);

    tickAt(TIME.day + 1, 8);
    expect(feed('departure')).toHaveLength(1);
    const walking = db.select().from(agents).where(eq(agents.id, leaver)).get()!;
    expect(walking.current_action).toMatchObject({ type: 'walking', reason: 'leaving_town' });
    expect(walking.current_destination).toEqual(d.edge);
    // Their friend remembers the goodbye.
    expect(recorded.some((r) => r.agentId === friend && /left town today/.test(r.description))).toBe(true);

    // Reaching the edge: retired.
    const departed = vi.fn();
    simEvents.on('life:departed', departed);
    db.update(agents).set({ position: d.edge }).where(eq(agents.id, leaver)).run();
    tickAt(TIME.day + 1, 9);
    simEvents.off('life:departed', departed);
    expect(db.select().from(agents).where(eq(agents.id, leaver)).get()!.is_active).toBe(false);
    expect(departed).toHaveBeenCalledWith(expect.objectContaining({ agentId: leaver, reason: 'left' }));
    expect(getPopulationFlowState().departing).toHaveLength(0);
  });

  it('stays after a friend’s kind conversation', () => {
    const ids = populate(8);
    setRuleOverrides({ populationTarget: 8 });
    const leaver = ids[5];
    const friend = ids[6];
    relate(leaver, friend, { friendship_ab: 60, friendship_ba: 60 });
    makeMiserable(leaver);
    daily(TIME.day);

    simEvents.emit('conversation:ended', { agentId: leaver, perpetratorId: friend, sentiment: 0.1, turns: 4 });
    expect(getPopulationFlowState().thinking[0].caredBy).toBe('Resident');
    const stayed = vi.fn();
    simEvents.on('life:decided_to_stay', stayed);
    daily(TIME.day + 1);
    simEvents.off('life:decided_to_stay', stayed);
    expect(stayed.mock.calls).toEqual([[{ agentId: leaver }]]);
    const flow = getPopulationFlowState();
    // Stays, and does not start brooding again the same night.
    expect(flow.thinking).toHaveLength(0);
    expect(flow.departing).toHaveLength(0);
    expect(recorded.some((r) => r.agentId === leaver && /I'm staying/.test(r.description) && /Resident/.test(r.description))).toBe(true);
    expect(db.select().from(activityLog).all().some((r) => /decided to stay/.test(String(r.template_data?.description)))).toBe(true);
    // Staying ends the bad streak (playtest #4: Omar re-thought leaving every fourth day).
    expect(getMoodStreak(leaver)).toBe(0);
    expect(getMoodMomentum(leaver)).toBe(-5);
  });

  it('stays after the player reaches out', async () => {
    const ids = populate(8);
    setRuleOverrides({ populationTarget: 8 });
    const leaver = ids[5];
    makeMiserable(leaver);
    daily(TIME.day);
    const res = await nudgeRouter.createCaller({} as never).execute({ action: { type: 'give_money', agentId: leaver, amount: 20 } });
    expect(res.success).toBe(true);
    daily(TIME.day + 1);
    expect(getPopulationFlowState().departing).toHaveLength(0);
  });

  it('never drives the town below its floor', () => {
    const ids = populate(6);
    setRuleOverrides({ populationTarget: 8 }); // floor 6
    makeMiserable(ids[5]);
    daily(TIME.day);
    expect(getPopulationFlowState().thinking).toHaveLength(0);
  });

  it('lets at most one go every few days', () => {
    const ids = populate(12);
    setRuleOverrides({ populationTarget: 12 });
    insertResident('Filler One', town.homes[0]);
    insertResident('Filler Two', town.homes[1]);
    makeMiserable(ids[5], ids[6]);
    daily(TIME.day);
    daily(TIME.day + 1);
    const [first] = getPopulationFlowState().departing;
    expect(first.agentId).toBe(ids[5]); // same reasons and mood: the lower id
    // Gone that morning.
    tickAt(TIME.day + 1, 8);
    db.update(agents).set({ position: first.edge }).where(eq(agents.id, first.agentId)).run();
    tickAt(TIME.day + 1, 9);
    expect(db.select().from(agents).where(eq(agents.id, first.agentId)).get()!.is_active).toBe(false);
    // Nobody else starts thinking of it until DEPARTURE_GAP_DAYS after they set off (08:00).
    for (let d = TIME.day + 2; d <= TIME.day + 1 + POPULATION_FLOW.DEPARTURE_GAP_DAYS; d++) {
      daily(d);
      expect(getPopulationFlowState().thinking).toHaveLength(0);
    }
    daily(TIME.day + 2 + POPULATION_FLOW.DEPARTURE_GAP_DAYS);
    expect(getPopulationFlowState().thinking.map((t) => t.agentId)).toEqual([ids[6]]);
  });

  it('survives a restart halfway out of town', () => {
    const ids = populate(8);
    setRuleOverrides({ populationTarget: 8 });
    makeMiserable(ids[5]);
    daily(TIME.day);
    daily(TIME.day + 1);
    const saved = populationFlowSnapshotStore.serialize();
    clearPopulationFlow();
    populationFlowSnapshotStore.restore(JSON.parse(JSON.stringify(saved)));
    expect(getPopulationFlowState().departing.map((d) => d.agentId)).toEqual([ids[5]]);
  });
});

describe('newcomers', () => {
  it('walk in from the edge to an empty house, below target, at most every few days', () => {
    populate(6);
    setRuleOverrides({ populationTarget: 9 });
    const arrived = vi.fn();
    simEvents.on('life:arrived', arrived);

    daily(TIME.day);
    expect(getPopulationFlowState().pendingArrivalAt).toBe(at(TIME.day, POPULATION_FLOW.ARRIVE_HOUR).now);
    setClock(TIME.day, 10);
    tickAt(TIME.day, 9);
    expect(arrived).not.toHaveBeenCalled();
    tickAt(TIME.day, 10);
    simEvents.off('life:arrived', arrived);
    expect(arrived).toHaveBeenCalledTimes(1);
    const { agentId } = arrived.mock.calls[0][0] as { agentId: number };
    const newcomer = db.select().from(agents).where(eq(agents.id, agentId)).get()!;
    expect(newcomer.current_action).toMatchObject({ type: 'walking' });
    expect([town.homes[0], town.homes[1]]).toContain(newcomer.home);
    // The town had no baker (populate() makes farmers) and has a bakery: a baker comes.
    expect(db.select().from(economy).where(eq(economy.agent_id, agentId)).get()!.job).toBe('baker');
    expect(feed('arrival')).toHaveLength(1);
    // Everyone else hears of the new face.
    expect(recorded.filter((r) => /new face in town/.test(r.description))).toHaveLength(6);

    // Not the next day, even though the town is still below target.
    daily(TIME.day + 1);
    expect(getPopulationFlowState().pendingArrivalAt).toBeNull();
    // Three days after they walked in (10:00): the midnight after that.
    daily(TIME.day + POPULATION_FLOW.ARRIVAL_GAP_DAYS);
    expect(getPopulationFlowState().pendingArrivalAt).toBeNull();
    daily(TIME.day + POPULATION_FLOW.ARRIVAL_GAP_DAYS + 1);
    expect(getPopulationFlowState().pendingArrivalAt).not.toBeNull();
  });

  it('none at target, none without an empty house, none when switched off', () => {
    populate(6);
    setRuleOverrides({ populationTarget: 6 });
    daily(TIME.day);
    expect(getPopulationFlowState().pendingArrivalAt).toBeNull();

    setRuleOverrides({ populationTarget: 9, populationFlow: false });
    daily(TIME.day);
    expect(getPopulationFlowState().pendingArrivalAt).toBeNull();

    setRuleOverrides({ populationFlow: true });
    insertResident('Filler One', town.homes[0]);
    insertResident('Filler Two', town.homes[1]);
    daily(TIME.day);
    expect(getPopulationFlowState().pendingArrivalAt).toBeNull();
  });

  it('reports the town size and bounds', () => {
    populate(5);
    setRuleOverrides({ populationTarget: 12 });
    expect(populationTargets()).toMatchObject({ living: 5, target: 12, floor: 9, cap: CONFIG.MAX_AGENTS, flowOn: true });
    // No explicit target: the founders (created_at 0) set it.
    setRuleOverrides({ populationTarget: null });
    expect(populationTargets().target).toBe(5);
    // The rule accepts a real town size only.
    expect(RuleOverridesSchema.safeParse({ populationTarget: CONFIG.MAX_AGENTS + 1 }).success).toBe(false);
    expect(RuleOverridesSchema.safeParse({ populationTarget: 2 }).success).toBe(false);
    expect(RuleOverridesSchema.safeParse({ populationFlow: false }).success).toBe(true);
  });
});
