import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, agentStates, locations, worldState } from '../../../db/schema';
import { statesTick, HOME_REST_RECOVERY } from '../states';
import { advanceClock, computeDayPhase, detectTransitions } from '../../tick';
import { processAgentDeath, clearHungerTracking } from '../../../lib/lifeEventsEngine';
import { healerInTown } from '../../../lib/careers';
import { clearVacancies } from '../../../lib/vacancies';
import { clearPopulationFlow } from '../../../lib/populationFlow';
import { memoryService } from '../../../lib/memory/instance';
import { NOW, TIME, freshTown, insertLocation, insertResident } from '../../../lib/__tests__/populationFixtures';

/**
 * A doctor's death must not take the sick with it. Healing needed a living
 * doctor or medical assistant in the same room, and the sick walked to the
 * clinic to wait for one; with nobody left, the town's only hope was the
 * illness running out on its own. Now the sick rest at home and recover there
 * (states.ts HOME_REST_RECOVERY), and the vacancy pass looks for a new doctor.
 */

type WorldTime = typeof worldState.$inferSelect['time'];

const SPEED = 30;

function tickStates(time: WorldTime): WorldTime {
  const next = advanceClock(time, SPEED);
  db.update(worldState).set({
    time: next, tick_speed: SPEED,
    pending_transitions: detectTransitions(time, computeDayPhase(time.hour), next, computeDayPhase(next.hour)),
  }).run();
  statesTick();
  return next;
}

const sickOf = (id: number) => db.select().from(agentStates)
  .where(and(eq(agentStates.agent_id, id), eq(agentStates.type, 'sick'))).get();

function makeSick(id: number, severity = 0.6, duration = 20 * 60): void {
  db.insert(agentStates).values({
    agent_id: id, type: 'sick', severity, started_at: NOW, duration, source: 'test', metadata: null,
  }).run();
}

let clinic: number;
let homes: number[];

beforeEach(() => {
  const town = freshTown({ homes: [2, 2, 2, 4] });
  homes = town.homes;
  clinic = insertLocation('The Clinic', 'clinic', 6, { x: 30, y: 22 });
  db.update(worldState).set({ tick_speed: SPEED }).run();
  clearVacancies();
  clearPopulationFlow();
  clearHungerTracking();
  vi.spyOn(memoryService, 'record').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  clearVacancies();
  clearPopulationFlow();
  clearHungerTracking();
});

describe('a doctor dies while three residents are sick', () => {
  it('nobody else dies of it over the following week, and all of them recover', () => {
    const doctor = insertResident('Dr. Ada Petrov', homes[3], { workplace: clinic, current_location: clinic }, { job: 'doctor' });
    db.update(locations).set({ owner: doctor }).where(eq(locations.id, clinic)).run();
    // Non-risky trades, young: accidents and old age can't muddy the count. Held
    // trades, so the vacancy pass can't make one of them the new doctor.
    const sick = [0, 1, 2].map((i) => insertResident(`Sick ${i}`, homes[i], {}, { job: 'bartender' }));
    for (const id of sick) makeSick(id);

    processAgentDeath(doctor, 'Dr. Ada Petrov', 'old_age', NOW);
    expect(healerInTown()).toBe(false);

    let time: WorldTime = { ...TIME, totalTicks: NOW };
    db.update(worldState).set({ time }).run();
    const days = 7;
    for (let i = 0; i < (days * 24 * 60) / SPEED; i++) time = tickStates(time);

    const dead = db.select().from(agents).where(eq(agents.is_active, false)).all().map((a) => a.id);
    expect(dead).toEqual([doctor]);
    // The original illnesses are over (a new, later bout is allowed; none of them lasted the week).
    for (const id of sick) {
      const s = sickOf(id);
      if (s) expect(s.started_at).toBeGreaterThan(NOW);
    }
  });

  it('bed rest at home shortens the illness; wandering about town does not', () => {
    const atHome = insertResident('Resting Rae', homes[0], {}, { job: 'musician' });
    const out = insertResident('Roaming Rob', homes[1], { current_location: null }, { job: 'musician' });
    makeSick(atHome, 0.6, 20 * 60);
    makeSick(out, 0.6, 20 * 60);
    // Nobody alive treats the sick in this town.
    expect(healerInTown()).toBe(false);

    let time: WorldTime = { ...TIME, totalTicks: NOW };
    db.update(worldState).set({ time }).run();
    for (let i = 0; i < 4; i++) time = tickStates(time); // two game hours

    const rested = sickOf(atHome)!;
    const roamed = sickOf(out)!;
    expect(rested.severity).toBeCloseTo(0.6 - HOME_REST_RECOVERY.SEVERITY_PER_MINUTE * 120, 5);
    expect(rested.duration).toBeLessThan(20 * 60);
    expect(roamed.severity).toBe(0.6);
    expect(roamed.duration).toBe(20 * 60);
  });

  it('with a healer alive, home rest does not replace the doctor', () => {
    insertResident('Dr. Ada Petrov', homes[3], { workplace: clinic, current_location: clinic }, { job: 'doctor' });
    const atHome = insertResident('Resting Rae', homes[0], {}, { job: 'musician' });
    makeSick(atHome, 0.6, 20 * 60);
    let time: WorldTime = { ...TIME, totalTicks: NOW };
    db.update(worldState).set({ time }).run();
    time = tickStates(time);
    expect(sickOf(atHome)!.severity).toBe(0.6);
  });
});
