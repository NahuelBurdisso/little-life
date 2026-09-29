import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, aspirations, economy, locations, worldState } from '../../db/schema';
import { retireResident } from '../residents';
import { changeJob, healerInTown, jobFit, jobsNamedIn, takesOverWorkplace } from '../careers';
import {
  VACANCIES, careerMovesTick, clearVacancies, fillVacancies, openVacancies, pendingCareerMoves,
} from '../vacancies';
import {
  arrivalAllowed, clearPopulationFlow, getWantedTrades, pickArrivalJob,
} from '../populationFlow';
import { processAgentDeath } from '../lifeEventsEngine';
import { heirsOf } from '../heirs';
import { MARRIED_TAG } from '../marriage';
import { memoryService } from '../memory/instance';
import { simEvents } from '../simEvents';
import { makeRng } from '../worldgen/rng';
import { jobSalary } from '../../data/jobs';
import { DAY, NOW, freshTown, insertLocation, insertResident, relate, type Town } from './populationFixtures';

/**
 * Careers, vacancies and inheritance: a death no longer takes its trade (or a
 * widow's inheritance) with it, and an ambition can change someone's job.
 */

let town: Town & { clinic: number; farm: number; hall: number };
let recorded: Array<{ agentId: number; description: string }>;

const feed = (beat: string) => db.select().from(activityLog).all()
  .filter((r) => (r.metadata as { beat?: string } | null)?.beat === beat)
  .map((r) => (r.template_data as { description: string }).description);
const econOf = (id: number) => db.select().from(economy).where(eq(economy.agent_id, id)).get()!;
const agentOf = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;
const ownerOf = (loc: number) => db.select().from(locations).where(eq(locations.id, loc)).get()!.owner;

/** Somebody in every essential trade the fixture town has a building for, working there. */
function staffTown(): Record<string, number> {
  const [h1, h2, h3] = town.homes;
  const staff = {
    doctor: insertResident('Dr. Ada Petrov', h1, { workplace: town.clinic }, { job: 'doctor' }),
    baker: insertResident('Bea Baker', h1, { workplace: town.bakery }, { job: 'baker' }),
    farmer: insertResident('Frank Field', h2, { workplace: town.farm }, { job: 'farmer' }),
    bartender: insertResident('Tess Tapper', h2, { workplace: town.tavern }, { job: 'bartender' }),
    mayor: insertResident('Mae Mayor', h3, { workplace: town.hall }, { job: 'mayor' }),
  };
  db.update(locations).set({ owner: staff.doctor }).where(eq(locations.id, town.clinic)).run();
  db.update(locations).set({ owner: staff.baker }).where(eq(locations.id, town.bakery)).run();
  db.update(locations).set({ owner: staff.farmer }).where(eq(locations.id, town.farm)).run();
  return staff;
}

beforeEach(() => {
  const base = freshTown();
  town = {
    ...base,
    clinic: insertLocation('The Clinic', 'clinic', 6, { x: 30, y: 22 }),
    farm: insertLocation('The Farm', 'farm', 8, { x: 4, y: 22 }),
    hall: insertLocation('Town Hall', 'town_hall', 10, { x: 16, y: 4 }),
  };
  clearVacancies();
  clearPopulationFlow();
  recorded = [];
  vi.spyOn(memoryService, 'record').mockImplementation((agentId, _t, description) => {
    recorded.push({ agentId, description });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearVacancies();
  clearPopulationFlow();
});

// ─── changeJob ───────────────────────────────────────────────────────────────

describe('changeJob', () => {
  it('moves the wage, title, workplace, hours and the place itself, and tells everyone', () => {
    const id = insertResident('Walt Idle', town.homes[0], {
      schedule: { wakeTime: 8, sleepTime: 23, workStart: 0, workEnd: 0, lunchTime: 13, freeTimePreferences: ['park'] },
    }, { job: 'unemployed' });
    const emit = vi.spyOn(simEvents, 'emit');

    const change = changeJob(id, 'baker', 'vacancy', { because: 'Priya has died' });

    expect(change).toMatchObject({ agentId: id, from: 'unemployed', to: 'baker', workplaceId: town.bakery, tookOver: 'The Bakery' });
    expect(econOf(id)).toMatchObject({ job: 'baker', job_title: 'Baker', salary: jobSalary('baker') });
    const row = agentOf(id);
    expect(row.workplace).toBe(town.bakery);
    // The seeded baker's day (data/agents.ts): up before dawn. Their own leisure kept.
    expect(row.schedule.workStart).toBeLessThan(9);
    expect(row.schedule.workEnd).toBeGreaterThan(row.schedule.workStart);
    expect(row.schedule.freeTimePreferences).toEqual(['park']);
    expect(ownerOf(town.bakery)).toBe(id);

    expect(emit).toHaveBeenCalledWith('plan:evaluate-replan', expect.objectContaining({ agentId: id, isDramatic: true }));
    expect(emit).toHaveBeenCalledWith('life:job_changed', expect.objectContaining({ agentId: id, from: 'unemployed', to: 'baker', reason: 'vacancy' }));
    expect(recorded.some((r) => r.agentId === id && /baker now that Priya has died/.test(r.description))).toBe(true);
    expect(feed('new_job')).toEqual([`Walt Idle is the town's new baker now that Priya has died and takes over running The Bakery.`]);

    // Same job again: nothing to do.
    expect(changeJob(id, 'baker', 'vacancy')).toBeNull();
  });

  it('does not take a place from someone still running it in that trade', () => {
    const baker = insertResident('Bea Baker', town.homes[0], { workplace: town.bakery }, { job: 'baker' });
    db.update(locations).set({ owner: baker }).where(eq(locations.id, town.bakery)).run();
    const place = { id: town.bakery, owner: baker as number | null };
    expect(takesOverWorkplace('baker', place)).toBe(false);
    // An heir who works elsewhere, or a dead owner: the trade takes it.
    db.update(economy).set({ job: 'musician' }).where(eq(economy.agent_id, baker)).run();
    expect(takesOverWorkplace('baker', place)).toBe(true);
    // A job that doesn't run its workplace never does.
    expect(takesOverWorkplace('farmhand', { id: town.farm, owner: null })).toBe(false);
  });
});

describe('reading ambitions and fit', () => {
  it('finds the trades an ambition names, in order, without the usual false friends', () => {
    expect(jobsNamedIn('Leave the farm behind and open my own bakery')).toEqual(['farmer', 'baker']);
    expect(jobsNamedIn('Become the finest physician this town has seen')).toEqual(['doctor']);
    expect(jobsNamedIn('Stay single, keep my health and serve the public')).toEqual([]);
    expect(jobsNamedIn(null)).toEqual([]);
  });

  it('scores a personality against the job leanings', () => {
    const caring = { curiosity: 80, morality: 80, warmth: 80 };
    const cold = { curiosity: 20, morality: 20, warmth: 20 };
    expect(jobFit(caring, 'doctor')).toBeGreaterThan(0.5);
    expect(jobFit(cold, 'doctor')).toBeLessThan(-0.5);
    expect(jobFit(null, 'doctor')).toBe(0);
  });
});

// ─── Vacancies ───────────────────────────────────────────────────────────────

describe('vacancies', () => {
  it('a dead doctor is replaced by the medical assistant, who takes over the clinic', () => {
    const staff = staffTown();
    const assistant = insertResident('Nell Nurse', town.homes[2], { workplace: town.clinic }, { job: 'medical_assistant' });
    insertResident('Idle Ivy', town.homes[2], {}, { job: 'unemployed' });

    processAgentDeath(staff.doctor, 'Dr. Ada Petrov', 'old_age', NOW);

    expect(econOf(assistant).job).toBe('doctor');
    expect(agentOf(assistant).workplace).toBe(town.clinic);
    expect(ownerOf(town.clinic)).toBe(assistant);
    expect(openVacancies()).toEqual([]);
    expect(healerInTown()).toBe(true);
    expect(feed('new_job')[0]).toMatch(/Nell Nurse has stepped up from worker to the town's new doctor now that Dr\. Ada Petrov has died/);
    expect(feed('help_wanted')).toEqual([]);
  });

  it('with no apprentice, hires the jobless resident whose nature and ambition suit the trade', () => {
    const staff = staffTown();
    // Baker leanings: warm (+), steady (low impulsiveness).
    const base = agentOf(staff.baker).personality!;
    const gruff = insertResident('Gruff Gus', town.homes[2], { personality: { ...base, warmth: 10, impulsiveness: 90 } }, { job: 'unemployed' });
    const kind = insertResident('Kind Kit', town.homes[2], { personality: { ...base, warmth: 90, impulsiveness: 10 } }, { job: 'retired' });
    const dreamer = insertResident('Dreamy Dot', town.homes[2], {}, { job: 'musician' });
    db.insert(aspirations).values({
      agent_id: dreamer, type: 'legacy', intensity: 0.6, status: 'active', adopted_at: NOW, trigger: 'test',
      description: 'Bake bread the whole town talks about',
    }).run();

    processAgentDeath(staff.baker, 'Bea Baker', 'old_age', NOW);

    // The musician's own ambition outweighs the others' circumstances.
    expect(econOf(dreamer).job).toBe('baker');
    expect(econOf(gruff).job).toBe('unemployed');
    expect(econOf(kind).job).toBe('retired');
    expect(ownerOf(town.bakery)).toBe(dreamer);

    // The dreamer gives it up (and the dream): the warm retiree beats the
    // gruff jobless one, whose need for a wage doesn't make up for his nature.
    db.update(aspirations).set({ status: 'shifted' }).where(eq(aspirations.agent_id, dreamer)).run();
    changeJob(dreamer, 'musician', 'player');
    expect(openVacancies()).toEqual(['baker']);
    fillVacancies();
    expect(econOf(kind).job).toBe('baker');
  });

  it('with nobody to take it, posts Help wanted once and asks the road for that trade', () => {
    const staff = staffTown();
    processAgentDeath(staff.farmer, 'Frank Field', 'old_age', NOW);

    expect(openVacancies()).toEqual(['farmer']);
    expect(feed('help_wanted')).toEqual(['Help wanted: now that Frank Field has died, the town has no farmer. A notice goes up at Town Hall.']);
    expect(getWantedTrades()).toEqual(['farmer']);
    fillVacancies();
    expect(feed('help_wanted')).toHaveLength(1);

    // The population flow's newcomer: the wanted trade first, and one past the target for it.
    const types = db.select().from(locations).all().map((l) => l.type);
    expect(pickArrivalJob(['doctor', 'baker', 'bartender', 'mayor'], types, makeRng(3), getWantedTrades())).toBe('farmer');
    const base = { living: 13, leaving: 0, target: 13, emptyHomes: 1, lastArrivalAt: null, now: 10 * DAY };
    expect(arrivalAllowed(base)).toBe(false);
    expect(arrivalAllowed({ ...base, wanted: true })).toBe(true);
    expect(arrivalAllowed({ ...base, living: 14, wanted: true })).toBe(false);

    // Filled (a newcomer, the player): off the board.
    const newcomer = insertResident('New Nate', town.homes[2], {}, { job: 'unemployed' });
    changeJob(newcomer, 'farmer', 'player');
    fillVacancies();
    expect(getWantedTrades()).toEqual([]);
  });

  it('a departure opens the trade too', () => {
    const staff = staffTown();
    const hand = insertResident('Hal Hand', town.homes[2], { workplace: town.farm }, { job: 'farmhand' });
    retireResident(staff.farmer, 'left');
    expect(econOf(hand).job).toBe('farmer');
    // No heir: the farm stood unowned for a moment, and the new farmer runs it.
    expect(ownerOf(town.farm)).toBe(hand);
    expect(feed('new_job')[0]).toMatch(/now that Frank Field has left town/);
  });
});

// ─── Ambitions ───────────────────────────────────────────────────────────────

describe('ambition-driven careers', () => {
  it('a jobless resident whose new ambition names an open trade takes it up a few hours later', () => {
    staffTown();
    const id = insertResident('Ivy Idle', town.homes[2], {}, { job: 'unemployed' });
    db.update(agents).set({ is_active: false }).where(eq(agents.name, 'Tess Tapper')).run();

    simEvents.emit('goal:ambition_shifted', { agentId: id, agentName: 'Ivy Idle', from: 'love', to: 'Run the tavern and make it the heart of town', reason: 'test' });
    const [move] = pendingCareerMoves();
    expect(move).toMatchObject({ agentId: id, job: 'bartender' });
    expect(recorded.some((r) => r.agentId === id && /work as a bartender/.test(r.description))).toBe(true);

    careerMovesTick(move.at - 10);
    expect(econOf(id).job).toBe('unemployed');
    careerMovesTick(move.at);
    expect(econOf(id).job).toBe('bartender');
    expect(feed('new_job')[0]).toMatch(/Ivy Idle has followed a long-held wish and become the town's new bartender/);
  });

  it('a jobless dreamer of a trade already held starts as its apprentice', () => {
    staffTown();
    const id = insertResident('Ned Keen', town.homes[2], {}, { job: 'unemployed' });
    simEvents.emit('goal:ambition_generated', { agentId: id, agentName: 'Ned Keen', description: 'Become a doctor and heal the sick' });
    expect(pendingCareerMoves()[0]).toMatchObject({ agentId: id, job: 'medical_assistant' });
  });

  it('the only baker does not walk out for a dream, and a taken opening is dropped', () => {
    const staff = staffTown();
    simEvents.emit('goal:ambition_shifted', { agentId: staff.baker, agentName: 'Bea Baker', from: 'x', to: 'Leave the ovens and play music every night', reason: 'test' });
    expect(pendingCareerMoves()).toEqual([]);

    const id = insertResident('Ivy Idle', town.homes[2], {}, { job: 'unemployed' });
    const other = insertResident('Otto Other', town.homes[2], {}, { job: 'unemployed' });
    db.update(agents).set({ is_active: false }).where(eq(agents.id, staff.mayor)).run();
    simEvents.emit('goal:ambition_shifted', { agentId: id, agentName: 'Ivy Idle', from: 'x', to: 'Be elected mayor', reason: 'test' });
    const [move] = pendingCareerMoves();
    expect(move.job).toBe('mayor');
    // Someone else got there first.
    changeJob(other, 'mayor', 'player');
    careerMovesTick(move.at + VACANCIES.AMBITION_DELAY_MINUTES);
    expect(econOf(id).job).toBe('unemployed');
  });
});

// ─── Inheritance ─────────────────────────────────────────────────────────────

describe('inheritance', () => {
  it('goes to the spouse before a closer friend, with money, belongings and places, named in the feed', () => {
    const [h1, h2] = town.homes;
    const baker = insertResident('Bea Baker', h1, { workplace: town.bakery }, { job: 'baker', money: 120 });
    db.update(economy).set({ inventory: [{ itemId: 'bread', quantity: 3, acquiredAt: 0 }] }).where(eq(economy.agent_id, baker)).run();
    db.update(locations).set({ owner: baker }).where(eq(locations.id, town.bakery)).run();
    const spouse = insertResident('Tom Baker', h1, { gender: 'male' }, { job: 'farmer', money: 10 });
    const friend = insertResident('Fay Friend', h2, {}, { job: 'farmer', money: 10 });
    relate(baker, spouse, { friendship_ab: 50, friendship_ba: 50, tags: [MARRIED_TAG, 'partner'], status: 'partners' });
    relate(baker, friend, { friendship_ab: 95, friendship_ba: 95 });
    expect(heirsOf(baker).map((h) => h.kind)).toEqual(['spouse', 'friend']);

    processAgentDeath(baker, 'Bea Baker', 'old_age', NOW);

    expect(econOf(spouse).money).toBe(130);
    expect(econOf(spouse).inventory).toEqual([expect.objectContaining({ itemId: 'bread', quantity: 3 })]);
    expect(econOf(friend).money).toBe(10);
    expect(econOf(baker)).toMatchObject({ money: 0, inventory: [] });
    expect(feed('inheritance')).toEqual(["Bea Baker's estate — savings ($120), belongings and The Bakery — went to Tom Baker, the widower."]);
    expect(recorded.some((r) => r.agentId === spouse && /left me/.test(r.description))).toBe(true);
  });

  it('without a spouse, the closest friend; without anyone, the town takes the money', () => {
    const [h1, h2] = town.homes;
    const a = insertResident('Al Alone', h1, {}, { money: 40 });
    const close = insertResident('Close Cal', h2, {}, { money: 0 });
    const lukewarm = insertResident('Luke Warm', h2, {}, { money: 0 });
    relate(a, close, { friendship_ab: 70, friendship_ba: 70 });
    relate(a, lukewarm, { friendship_ab: 35, friendship_ba: 35 });
    processAgentDeath(a, 'Al Alone', 'old_age', NOW);
    expect(econOf(close).money).toBe(40);
    expect(feed('inheritance')[0]).toMatch(/went to Close Cal, a close friend\./);

    const b = insertResident('Bo Nobody', h1, {}, { money: 25 });
    const taxBefore = db.select().from(worldState).get()!.tax_pool;
    processAgentDeath(b, 'Bo Nobody', 'old_age', NOW);
    expect(db.select().from(worldState).get()!.tax_pool).toBe(taxBefore + 25);
    expect(feed('inheritance')).toHaveLength(1);
  });
});
