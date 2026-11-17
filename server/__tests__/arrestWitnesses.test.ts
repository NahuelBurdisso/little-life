import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { agents, economy, locations, shared_knowledge, worldState } from '../db/schema';
import { simEvents } from '../lib/simEvents';
import { constableArrests } from '../engine/systems/decisions/crime';
import type { DecisionTickContext } from '../engine/systems/decisions/context';
import { RippleEngine } from '../lib/cascade/RippleEngine';
import { rippleRules } from '../lib/cascade/rippleRules';
import { createFact } from '../lib/gossip';
import { memoryService } from '../lib/memory/instance';
import { NOW, freshTown, insertLocation, insertResident } from '../lib/__tests__/populationFixtures';

/**
 * The arrest teleported the prisoner to the prison and only then emitted
 * `crime:arrested` without a place, so `arrest_gossip` looked for witnesses
 * among the inmates. And a witness report that repeats a fact the town already
 * has (the arrest fact, a caught theft's) was dropped as a duplicate, so the
 * witness never learned it at all.
 */

type Emitted = { name: string; payload: Record<string, unknown> };
let emitted: Emitted[];

beforeEach(() => {
  emitted = [];
  vi.spyOn(memoryService, 'record').mockImplementation(() => {});
  const realEmit = simEvents.emit.bind(simEvents);
  vi.spyOn(simEvents, 'emit').mockImplementation((name: string | symbol, payload?: unknown) => {
    emitted.push({ name: String(name), payload: payload as Record<string, unknown> });
    return realEmit(name, payload);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function knowersOf(type: string, subject: number): number[] {
  return db.select().from(shared_knowledge)
    .where(and(eq(shared_knowledge.type, type), eq(shared_knowledge.subject_id, subject), eq(shared_knowledge.is_active, true)))
    .all()
    .flatMap((f) => f.known_by as number[]);
}

describe('an arrest in the square', () => {
  it('is announced where it happened, and everyone there learns of it', () => {
    const town = freshTown({ homes: [2, 2, 2, 2] });
    const prison = insertLocation('The Jail', 'prison', 6, { x: 34, y: 24 });
    const constable = insertResident('Constable Cole', town.homes[0], { current_location: town.square }, { job: 'constable' });
    const crook = insertResident('Crook', town.homes[1], { current_location: town.square });
    const onlookers = [2, 3].map((i) => insertResident(`Onlooker ${i}`, town.homes[i], { current_location: town.square }));
    // Eight rumors: the bar without first-hand knowledge.
    const record = Array.from({ length: 8 }, (_, i) => ({
      id: 10_000 + i, subject_id: crook, type: 'rumor', is_active: true, paid_at: null, known_by: [] as number[],
    }));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const rows = db.select().from(agents).all();
    constableArrests({
      world: { ...db.select().from(worldState).get()!, tick_speed: 1 },
      activeAgents: rows,
      allLocations: db.select().from(locations).all(),
      econMap: new Map(db.select().from(economy).all().map((e) => [e.agent_id, e])),
      allActiveKnowledge: record,
      nowMinutes: NOW,
    } as unknown as DecisionTickContext);

    expect(db.select().from(agents).where(eq(agents.id, crook)).get()!.current_location).toBe(prison);
    const arrested = emitted.find((e) => e.name === 'crime:arrested')!.payload;
    expect(arrested).toMatchObject({ agentId: crook, perpetratorId: crook, victimId: constable, locationId: town.square });
    const knowers = knowersOf('arrest', crook);
    for (const id of [constable, crook, ...onlookers]) expect(knowers).toContain(id);
  });
});

describe('witness reports of a fact the town already has', () => {
  it('a caught theft\'s onlooker learns the theft fact the thief and victim already share', () => {
    const town = freshTown({ homes: [2, 2] });
    new RippleEngine({ rules: [rippleRules.find((r) => r.id === 'theft_witness_report')!] });
    const thief = insertResident('Thief', town.homes[0], { current_location: town.bakery });
    const victim = insertResident('Victim', town.homes[1], { current_location: town.bakery });
    const witness = insertResident('Witness', town.homes[1], { current_location: town.bakery });
    // What crime.ts writes before the event.
    createFact('theft', thief, victim, 2, [thief, victim], 'witnessed');
    vi.spyOn(Math, 'random').mockReturnValue(0);

    simEvents.emit('economy:theft_caught', { agentId: thief, perpetratorId: thief, victimId: victim, locationId: town.bakery });

    expect(knowersOf('theft', thief)).toContain(witness);
  });
});
