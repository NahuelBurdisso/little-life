import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, agentStates, relationshipEvents, worldEvents } from '../../db/schema';
import { clearGatheringState, gatheringsTick } from '../gatherings';
import { allGatherings, attendanceOf, gatheringRecords } from '../gatherings/engine';
import { setGatheringRng } from '../gatherings/common';
import { eulogyLine, funeralStart } from '../gatherings/kinds/funeral';
import { processAgentDeath, clearHungerTracking } from '../lifeEventsEngine';
import { clearVacancies } from '../vacancies';
import { clearPopulationFlow } from '../populationFlow';
import { memoryService } from '../memory/instance';
import { NOW, freshTown, insertResident, relate } from './populationFixtures';

function rowsWithBeat(beat: string) {
  return db.select().from(activityLog).all().filter((r) => (r.metadata as { beat?: string } | null)?.beat === beat);
}

function placeAt(ids: number[], locationId: number | null): void {
  for (const id of ids) db.update(agents).set({ current_location: locationId, current_action: { type: 'socializing' } }).where(eq(agents.id, id)).run();
}

describe('funeral → wake, end to end on the test DB', () => {
  beforeEach(() => {
    clearVacancies();
    clearPopulationFlow();
    clearHungerTracking();
    clearGatheringState();
    vi.spyOn(memoryService, 'record').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Every roll comes up: the rival comes anyway.
    setGatheringRng(() => 0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setGatheringRng(null);
  });

  function setUp() {
    const town = freshTown({ homes: [2, 2, 2, 2, 2, 2] });
    const dead = insertResident('Tom Hall', town.homes[0], { gender: 'male' }, { job: 'bartender' });
    const widow = insertResident('Rosa Hall', town.homes[0], { gender: 'female' });
    const friend = insertResident('Ana Gil', town.homes[1]);
    const skipper = insertResident('Sam Ortiz', town.homes[2]);
    const rival = insertResident('Rita Mora', town.homes[3]);
    const stranger = insertResident('Paco Leon', town.homes[4]);
    relate(dead, widow, { friendship_ab: 90, friendship_ba: 90, status: 'partners', tags: ['married'] });
    relate(dead, friend, { friendship_ab: 70, friendship_ba: 70, status: 'friends' });
    relate(dead, skipper, { friendship_ab: 45, friendship_ba: 45, status: 'friends' });
    relate(dead, rival, { friendship_ab: -50, friendship_ba: -50, status: 'rivals' });
    relate(widow, friend, { friendship_ab: 40, friendship_ba: 40 });
    return { town, dead, widow, friend, skipper, rival, stranger };
  }

  it('a death sets the funeral for the next morning on the square, and the town comes', () => {
    const { town, dead, widow, friend, skipper, rival, stranger } = setUp();
    processAgentDeath(dead, 'Tom Hall', 'old_age', NOW);

    // No event at once any more: the gathering starts it when the funeral opens.
    expect(db.select().from(worldEvents).all().filter((e) => e.type === 'funeral')).toHaveLength(0);
    const g = allGatherings().find((x) => x.kind === 'funeral')!;
    expect(g).toMatchObject({ subjectId: dead, venueLocationId: town.square, startMin: funeralStart(NOW) });
    expect(g.startMin - NOW).toBe(24 * 60 + 10 * 60);

    gatheringsTick(g.startMin - 45);
    const ev = db.select().from(worldEvents).all().find((e) => e.type === 'funeral')!;
    expect(ev.location_id).toBe(town.square);
    expect(g.invited.get(widow)!.level).toBe('must');
    expect(g.invited.get(friend)!.level).toBe('must'); // a mourner (friendship > 50)
    expect(g.invited.get(skipper)!.level).toBe('should');
    expect(g.invited.get(rival)!.level).toBe('should'); // rolled to come anyway
    expect(g.invited.get(stranger)!.level).toBe('may');

    placeAt([widow, friend, rival, stranger], town.square);
    gatheringsTick(g.startMin);
    gatheringsTick(g.startMin + 60);
    expect(g.payload.eulogistId).toBe(widow);
    expect(g.payload.eulogy).toBe(eulogyLine('Tom', 'spouse'));
    gatheringsTick(g.startMin + 180);

    const att = attendanceOf(g.id)!;
    expect(att.absent).toEqual([skipper]);
    const rows = rowsWithBeat('funeral');
    expect(rows).toHaveLength(1);
    expect(rows[0].importance).toBeGreaterThanOrEqual(0.6);
    const text = (rows[0].template_data as { description: string }).description;
    expect(text).toMatch(/Tom Hall was buried on the square: 4 came/);
    expect(text).toMatch(/Rosa Hall spoke for him: "Tom was my whole life/);
    expect(text).toMatch(/Even Rita Mora, who never got on with him, came/);
    expect(text).toMatch(/Not there: Sam Ortiz/);

    // "She didn't even come to the funeral": the mourners hold it against the friend who stayed away.
    const missed = db.select().from(relationshipEvents).where(eq(relationshipEvents.event_type, 'missed_funeral')).all();
    expect(missed.length).toBe(2);
    for (const e of missed) {
      const mournerIsA = e.agent_a !== skipper;
      expect(mournerIsA ? e.friendship_delta_ab : e.friendship_delta_ba).toBeLessThan(0);
    }
    // A full turnout (4 of 5 living) eased the widow's grief.
    const grief = db.select().from(agentStates).where(and(eq(agentStates.agent_id, widow), eq(agentStates.type, 'grieving'))).get()!;
    expect(grief.severity).toBeLessThan(0.8);

    // The wake that evening at the tavern.
    const wake = allGatherings().find((x) => x.kind === 'wake')!;
    expect(wake.venueLocationId).toBe(town.tavern);
    gatheringsTick(wake.startMin - 30);
    expect(wake.invited.get(widow)!.level).toBe('should');
    expect(wake.invited.get(stranger)!.level).toBe('may');
    placeAt([widow, friend, stranger], town.tavern);
    gatheringsTick(wake.startMin);
    gatheringsTick(wake.startMin + 60);
    gatheringsTick(wake.startMin + 180);
    const wakeRows = rowsWithBeat('wake');
    expect(wakeRows).toHaveLength(1);
    expect(wakeRows[0].importance).toBeGreaterThanOrEqual(0.6);
    expect((wakeRows[0].template_data as { description: string }).description).toMatch(/3 gathered at The Tavern that evening to drink to Tom Hall/);
    // Shared grief: warmth between the three at the table.
    expect(db.select().from(relationshipEvents).where(eq(relationshipEvents.event_type, 'wake')).all()).toHaveLength(3);
    expect(gatheringRecords().map((r) => r.kind).sort()).toEqual(['funeral', 'wake']);
  });

  it('an empty funeral embitters the mourners; a rival who stays away is named', () => {
    const { dead, widow, rival } = setUp();
    setGatheringRng(() => 0.99); // the rival stays away
    processAgentDeath(dead, 'Tom Hall', 'old_age', NOW);
    const g = allGatherings().find((x) => x.kind === 'funeral')!;
    gatheringsTick(g.startMin - 45);
    expect(g.invited.has(rival)).toBe(false);
    gatheringsTick(g.startMin + 180);
    const text = (rowsWithBeat('funeral')[0].template_data as { description: string }).description;
    expect(text).toMatch(/Nobody came to Tom Hall's funeral/);
    expect(text).toMatch(/Rita Mora, his old rival, pointedly stayed away/);
    const grief = db.select().from(agentStates).where(and(eq(agentStates.agent_id, widow), eq(agentStates.type, 'grieving'))).get()!;
    expect(grief.severity).toBeGreaterThan(0.8);
  });

  it('a storm puts the funeral off', () => {
    const { dead } = setUp();
    processAgentDeath(dead, 'Tom Hall', 'old_age', NOW);
    const g = allGatherings().find((x) => x.kind === 'funeral')!;
    const start = g.startMin;
    db.insert(worldEvents).values({
      type: 'storm', name: 'Storm', description: 'x', started_at: start - 60, duration: 4, effects: {}, location_id: null,
      triggered_by: 'test', is_active: true,
    }).run();
    gatheringsTick(start - 45);
    expect(g.status).toBe('scheduled');
    expect(g.startMin).toBe(start + 180);
  });
});
