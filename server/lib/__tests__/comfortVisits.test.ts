import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agentStates, needs } from '../../db/schema';
import { simEvents } from '../simEvents';
import { clearEffectivePersonalities, setEffectivePersonality } from '../states';
import {
  scheduleComfortVisit,
  getComfortVisit,
  completeComfortVisit,
  clearLonelinessTracking,
  lonelinessCheck,
  COMFORT_VISIT_WINDOW_MINUTES,
} from '../lonelinessEngine';
import { NOW, PERSONALITY, freshTown, insertResident, relate } from './populationFixtures';

describe('comfort visits', () => {
  beforeEach(() => clearLonelinessTracking());

  it('hands the visitor their pending visit until it expires', () => {
    scheduleComfortVisit(3, 7, 1000);

    expect(getComfortVisit(3, 1000)).toEqual({ lonelyAgentId: 7, expiresAt: 1000 + COMFORT_VISIT_WINDOW_MINUTES });
    expect(getComfortVisit(3, 1000 + COMFORT_VISIT_WINDOW_MINUTES)).not.toBeNull();
    expect(getComfortVisit(3, 1001 + COMFORT_VISIT_WINDOW_MINUTES)).toBeNull();
  });

  it('forgets an expired visit so it cannot come back', () => {
    scheduleComfortVisit(3, 7, 0);
    getComfortVisit(3, COMFORT_VISIT_WINDOW_MINUTES + 1);
    expect(getComfortVisit(3, 0)).toBeNull();
  });

  it('is only for the scheduled visitor', () => {
    scheduleComfortVisit(3, 7, 0);
    expect(getComfortVisit(7, 0)).toBeNull();
    expect(getComfortVisit(4, 0)).toBeNull();
  });

  it('ends once the conversation is queued', () => {
    scheduleComfortVisit(3, 7, 0);
    completeComfortVisit(3);
    expect(getComfortVisit(3, 0)).toBeNull();
  });

  it('is cleared on world replace', () => {
    scheduleComfortVisit(3, 7, 0);
    clearLonelinessTracking();
    expect(getComfortVisit(3, 0)).toBeNull();
  });
});

describe('a long-lonely resident gets a visit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearEffectivePersonalities();
    clearLonelinessTracking();
  });

  it('even when the states phase already made them lonely an hour in', () => {
    const town = freshTown();
    const lonely = insertResident('Lonely Lou', town.homes[0]);
    const friend = insertResident('Warm Wendy', town.homes[1]);
    setEffectivePersonality(friend, { ...PERSONALITY, warmth: 90 });
    relate(lonely, friend, { friendship_ab: 40, friendship_ba: 40 });
    db.update(needs).set({ social: 5 }).where(eq(needs.agent_id, lonely)).run();
    // What states/triggers.ts writes after an hour under 20 social.
    db.insert(agentStates).values({
      agent_id: lonely, type: 'lonely', severity: 0.7, started_at: NOW, duration: 999999,
      source: 'needs:low_social', metadata: null,
    }).run();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(simEvents, 'emit').mockImplementation(() => true);

    lonelinessCheck(NOW);
    lonelinessCheck(NOW + 721);

    expect(getComfortVisit(friend, NOW + 721)).toEqual(expect.objectContaining({ lonelyAgentId: lonely }));
    // One lonely-state row: the engine doesn't stack a second one.
    expect(db.select().from(agentStates).where(eq(agentStates.agent_id, lonely)).all()).toHaveLength(1);
  });

  it('asks again only after another twelve lonely hours', () => {
    const town = freshTown();
    const lonely = insertResident('Lonely Lou', town.homes[0]);
    const friend = insertResident('Warm Wendy', town.homes[1]);
    setEffectivePersonality(friend, { ...PERSONALITY, warmth: 90 });
    relate(lonely, friend, { friendship_ab: 40, friendship_ba: 40 });
    db.update(needs).set({ social: 5 }).where(eq(needs.agent_id, lonely)).run();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(simEvents, 'emit').mockImplementation(() => true);

    lonelinessCheck(NOW);
    lonelinessCheck(NOW + 721);
    completeComfortVisit(friend);
    lonelinessCheck(NOW + 781);
    expect(getComfortVisit(friend, NOW + 781)).toBeNull();
    lonelinessCheck(NOW + 721 + 721);
    expect(getComfortVisit(friend, NOW + 1442)).not.toBeNull();
  });
});
