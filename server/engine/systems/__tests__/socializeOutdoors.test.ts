import { describe, it, expect, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, economy, locations, needs, relationships, worldState } from '../../../db/schema';
import { scoreFreeTimeActions } from '../decisions/freeTime';
import { freshTown, insertResident, relate } from '../../../lib/__tests__/populationFixtures';

/**
 * Wanting to spend free time with someone who is out in the street gave the
 * socialising option `targetLocationId: other.current_location`, which is null
 * outdoors: the seeker "socialised" wherever they stood. It now heads for the
 * town square nearest the other person, as a comfort visit does.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('socialising with someone outdoors', () => {
  it('goes to the square nearest them instead of nowhere', () => {
    const town = freshTown();
    const seeker = insertResident('Seeker', town.homes[0]);
    // In the street near the square (tile 16,16 is its corner; this is 2 tiles off).
    const walker = insertResident('Walker', town.homes[1], { current_location: null, position: { x: 18 * 32, y: 18 * 32 } });
    relate(seeker, walker, { friendship_ab: 60, friendship_ba: 60 });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const row = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;
    const scores = scoreFreeTimeActions(
      row(seeker),
      db.select().from(needs).where(eq(needs.agent_id, seeker)).get()!,
      db.select().from(economy).where(eq(economy.agent_id, seeker)).get()!,
      db.select().from(locations).all(),
      db.select().from(relationships).all(),
      [row(seeker), row(walker)],
      db.select().from(worldState).get()!,
      new Map(db.select().from(economy).all().map((e) => [e.agent_id, e])),
    );

    const option = scores.find((s) => s.action === 'socializing' && s.targetAgentId === walker);
    expect(option?.targetLocationId).toBe(town.square);
  });
});
