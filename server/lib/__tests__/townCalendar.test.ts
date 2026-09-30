import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, aspirations, economy, goals, locations, shared_knowledge, worldEvents, worldState, agents } from '../../db/schema';
import { gameMinutes } from '../gameClock';
import { memoryService } from '../memory/instance';
import { clearHobbySkills, practiceHobby } from '../hobbyEngine';
import {
  loadCivic, onCampaignConversation, planCalendarNote, comingUpLines, electionBrewing, townCalendarTick,
} from '../townCalendar';
import { freshTown, insertLocation, insertResident, relate, type Town } from './populationFixtures';
import { clearReputationCache } from '../reputationEngine';

/**
 * The town calendar against a real (test) DB: notices two days ahead, a
 * festival starting at its venue with its contest, and a whole election from
 * campaign to count, each step once however often the pass runs.
 */

let town: Town & { hall: number };

function at(day: number, hour: number): { day: number; hour: number; minute: number; totalTicks: number; seasonDay: number; season: string } {
  const time = { day, hour, minute: 0, totalTicks: day * 1440 + hour * 60, seasonDay: day % 28, season: 'spring' };
  db.update(worldState).set({ time }).run();
  return time;
}
const tick = (day: number, hour: number) => { const t = at(day, hour); townCalendarTick(t, gameMinutes(t)); };
const rows = (type: string) => db.select().from(activityLog).where(eq(activityLog.type, type)).all()
  .map((r) => (r.template_data as { description: string }).description);
const beatRows = (beat: string) => db.select().from(activityLog).all()
  .filter((r) => (r.metadata as { beat?: string } | null)?.beat === beat);

beforeEach(() => {
  town = { ...freshTown(), hall: 0 };
  town.hall = insertLocation('Town Hall', 'town_hall', 10, { x: 16, y: 4 });
  clearHobbySkills();
  // Reputation is a per-id cache; other files in this worker used the same ids.
  clearReputationCache();
  vi.spyOn(memoryService, 'record').mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearHobbySkills();
});

describe('announcements', () => {
  it('announce a festival two days ahead, from the morning, once', () => {
    insertResident('Ann Early', town.homes[0]);
    tick(7, 5);
    expect(rows('calendar_notice')).toEqual([]);
    tick(7, 7);
    tick(7, 9);
    const notices = rows('calendar_notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/Spring Fair is in 2 days at Town Square/);
  });

  it('put today and tomorrow in plan prompts and the paper', () => {
    const id = insertResident('Pat Planner', town.homes[0]);
    at(8, 6);
    expect(planCalendarNote(id, 8).join(' ')).toMatch(/Tomorrow is the Spring Fair at Town Square from 10:00/);
    expect(comingUpLines(8).join(' ')).toMatch(/Tomorrow is the Spring Fair/);
  });
});

describe('festivals', () => {
  it('start at the venue on the day and judge the contest among those there', () => {
    const ploughman = insertResident('Paul Plough', town.homes[0], { current_location: town.square }, { job: 'farmer' });
    const other = insertResident('Olive Idle', town.homes[1], { current_location: town.square }, { job: 'shop_assistant' });
    insertResident('Sam Home', town.homes[2]);
    for (let i = 0; i < 400; i++) practiceHobby(ploughman, 'jog', i * 10);

    tick(9, 10);
    const event = db.select().from(worldEvents).where(eq(worldEvents.type, 'spring_fair')).get();
    expect(event).toMatchObject({ location_id: town.square, is_active: true, triggered_by: 'calendar:festival:spring_fair:9' });
    tick(9, 11);
    expect(db.select().from(worldEvents).where(eq(worldEvents.type, 'spring_fair')).all()).toHaveLength(1);

    tick(9, 14);
    const wins = beatRows('contest_win');
    expect(wins).toHaveLength(1);
    expect(wins[0].initiator_id).toBe(ploughman);
    expect((wins[0].template_data as { description: string }).description).toMatch(/Paul Plough won the ploughing match at the Spring Fair, ahead of Olive Idle/);
    const fact = db.select().from(shared_knowledge).where(eq(shared_knowledge.type, 'contest_win')).get();
    expect(fact).toMatchObject({ subject_id: ploughman, sensitivity: 1 });
    expect(fact!.known_by).toEqual(expect.arrayContaining([ploughman, other]));
    tick(9, 15);
    expect(beatRows('contest_win')).toHaveLength(1);
  });
});

describe('the election', () => {
  function cast() {
    const mayor = insertResident('Mae Mayor', town.homes[0], { workplace: town.hall }, { job: 'mayor' });
    const rival = insertResident('Rex Rival', town.homes[1], {}, { job: 'farmer' });
    const voters = [
      insertResident('Vi One', town.homes[2]), insertResident('Vi Two', town.homes[2]),
      insertResident('Vi Three', town.homes[2]),
    ];
    db.insert(aspirations).values({
      agent_id: rival, type: 'power', intensity: 1, status: 'active', adopted_at: 0, trigger: 'test',
      description: 'Lead the town one day',
    }).run();
    db.update(locations).set({ owner: mayor }).where(eq(locations.id, town.hall)).run();
    return { mayor, rival, voters };
  }

  it('opens a campaign with the mayor and the ambitious, each with a campaign goal', () => {
    const { mayor, rival } = cast();
    tick(21, 7);
    expect(loadCivic().election).toBeNull();
    tick(21, 8);
    const e = loadCivic().election!;
    expect(e).toMatchObject({ electionDay: 24, incumbentId: mayor });
    expect(e.candidates).toEqual([mayor, rival]);
    expect(rows('election_campaign')[0]).toMatch(/Mae Mayor \(the mayor\) and Rex Rival are standing for mayor/);
    const g = db.select().from(goals).where(and(eq(goals.type, 'campaign'), eq(goals.status, 'active'))).all();
    expect(g.map((x) => x.agent_id).sort()).toEqual([mayor, rival].sort());
    expect(planCalendarNote(rival, 21).join(' ')).toMatch(/You are standing for mayor against Mae Mayor/);
    expect(electionBrewing(21)).toMatchObject({ electionDay: 24, daysLeft: 3 });
  });

  it('counts the vote at the result hour and hands the chair over through changeJob', () => {
    const { mayor, rival, voters } = cast();
    tick(21, 8);
    // Rex canvasses everyone warmly; the mayor stays in her office.
    for (const v of voters) {
      relate(rival, v, { friendship_ab: 20, friendship_ba: 20 });
      onCampaignConversation({ agentId: rival, perpetratorId: v, sentiment: 0.8, summary: 'the upcoming election for mayor' });
    }
    expect(Object.keys(loadCivic().election!.support[String(rival)])).toHaveLength(3);

    tick(24, 17);
    expect(db.select().from(worldEvents).where(eq(worldEvents.type, 'election_day')).get()).toBeDefined();
    expect(rows('election_result')).toEqual([]);
    tick(24, 18);
    const result = rows('election_result');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/Rex Rival is elected mayor — Rex Rival 4, Mae Mayor 1/);
    const job = (id: number) => db.select().from(economy).where(eq(economy.agent_id, id)).get()!.job;
    expect(job(rival)).toBe('mayor');
    // The ousted mayor is not left with nothing: she takes the trade the winner left (Rex was a farmer).
    expect(job(mayor)).toBe('farmer');
    expect(db.select().from(agents).where(eq(agents.id, rival)).get()!.workplace).toBe(town.hall);
    const feed = beatRows('new_job').map((r) => (r.template_data as { description: string }).description).join(' ');
    expect(feed).toMatch(/Mae Mayor has cleared out the mayor's office now that Rex Rival won the election/);
    expect(feed).toMatch(/Mae Mayor is the town's new farmer now that Rex Rival has left the trade to be mayor/);
    const civic = loadCivic();
    expect(civic.election).toBeNull();
    expect(civic.lastElection).toMatchObject({ electionDay: 24, winnerId: rival, incumbentId: mayor });
    const settled = db.select().from(goals).where(eq(goals.type, 'campaign')).all();
    expect(settled.find((g) => g.agent_id === rival)!.status).toBe('completed');
    expect(settled.find((g) => g.agent_id === mayor)!.status).toBe('failed');

    tick(24, 19);
    expect(rows('election_result')).toHaveLength(1);
  });

  describe('the ousted mayor keeps a trade', () => {
    const jobOf = (id: number) => db.select().from(economy).where(eq(economy.agent_id, id)).get()!;
    const agentOf = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;

    /** Rex wins the count; `rivalJob` is what he did before (`prep` sets the rest of his life up). */
    function electRival(rivalJob: string, prep: (rival: number) => void = () => undefined) {
      const { mayor, rival, voters } = cast();
      db.update(economy).set({ job: rivalJob }).where(eq(economy.agent_id, rival)).run();
      prep(rival);
      tick(21, 8);
      for (const v of voters) {
        relate(rival, v, { friendship_ab: 20, friendship_ba: 20 });
        onCampaignConversation({ agentId: rival, perpetratorId: v, sentiment: 0.8, summary: 'the upcoming election for mayor' });
      }
      tick(24, 18);
      expect(jobOf(rival).job).toBe('mayor');
      return { mayor, rival };
    }

    it("takes over the winner's old trade with its workplace, wage and the building it ran", () => {
      // Rex baked and ran the bakery; the mayor's chair pulls him away from it.
      const { mayor, rival } = electRival('baker', (rex) => {
        db.update(agents).set({ workplace: town.bakery }).where(eq(agents.id, rex)).run();
        db.update(locations).set({ owner: rex }).where(eq(locations.id, town.bakery)).run();
      });
      expect(jobOf(mayor).job).toBe('baker');
      expect(jobOf(mayor).salary).toBeGreaterThan(0);
      expect(agentOf(mayor).workplace).toBe(town.bakery);
      expect(db.select().from(locations).where(eq(locations.id, town.bakery)).get()!.owner).toBe(mayor);
      // ...and the winner sits in the town hall, which the old mayor ran.
      expect(agentOf(rival).workplace).toBe(town.hall);
      expect(db.select().from(locations).where(eq(locations.id, town.hall)).get()!.owner).toBe(rival);
    });

    it('a winner with no trade leaves the ousted mayor an open essential trade instead', () => {
      // The bakery stands with nobody baking; the winner was unemployed.
      const { mayor } = electRival('unemployed');
      expect(jobOf(mayor).job).toBe('baker');
      expect(agentOf(mayor).workplace).toBe(town.bakery);
    });

    it('leaves her unemployed only when there is truly nothing to take', () => {
      // Put a baker and a bartender in place: no essential trade is open, and the winner had no trade.
      insertResident('Bob Baker', town.homes[2], {}, { job: 'baker' });
      insertResident('Tess Tapster', town.homes[2], {}, { job: 'bartender' });
      const { mayor } = electRival('unemployed');
      expect(jobOf(mayor).job).toBe('unemployed');
    });
  });

  it('re-elects a well-liked mayor and counts a missed evening late', () => {
    const { mayor, rival, voters } = cast();
    for (const v of voters) relate(mayor, v, { friendship_ab: 60, friendship_ba: 60, trust_ab: 50, trust_ba: 50 });
    tick(21, 8);
    tick(25, 9); // the evening of day 24 went by unseen
    expect(rows('election_result')[0]).toMatch(/Mae Mayor is re-elected mayor/);
    expect(db.select().from(economy).where(eq(economy.agent_id, mayor)).get()!.job).toBe('mayor');
    expect(db.select().from(economy).where(eq(economy.agent_id, rival)).get()!.job).toBe('farmer');
  });
});
