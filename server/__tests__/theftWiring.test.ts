import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { agents, agentStates, economy, locations } from '../db/schema';
import { simEvents } from '../lib/simEvents';
import { processStateEffects } from '../engine/systems/states/effects';
import { createStatesTickContext } from '../engine/systems/states/context';
import { getReputation, clearReputationCache } from '../lib/reputationEngine';
import { initMemoryObserver } from '../lib/memory/MemoryObserver';
import type { MemoryService } from '../lib/memory/MemoryService';
import { memoryService } from '../lib/memory/instance';
import { NOW, PERSONALITY, freshTown, insertResident } from '../lib/__tests__/populationFixtures';

/**
 * Theft and scam events whose payloads the listeners couldn't read: a debtor's
 * shop theft (states/effects.ts) sent neither perpetrator nor victim, so the
 * reputation hit, the victim's confrontation and revenge rules and the
 * victim's drift all saw nobody; a scam by a travelling stranger cost the
 * *victim* reputation; a crisis robbery left the victim nothing at all.
 */

type Emitted = { name: string; payload: Record<string, unknown> };
let emitted: Emitted[];

const agentRow = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;
const statesOf = (id: number) => db.select().from(agentStates).where(eq(agentStates.agent_id, id)).all();

beforeEach(() => {
  emitted = [];
  clearReputationCache();
  vi.spyOn(memoryService, 'record').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  clearReputationCache();
});

/** A desperate thief in a baker's shop (as stateTriggersEffects.test.ts sets it up). */
function steal(caughtRoll: number) {
  const town = freshTown();
  const owner = insertResident('Baker Bea', town.homes[0], {});
  db.update(locations).set({ owner }).where(eq(locations.id, town.bakery)).run();
  db.update(economy).set({ inventory: [{ itemId: 'bread', quantity: 3, acquiredAt: 0 }] })
    .where(eq(economy.agent_id, owner)).run();
  const thief = insertResident('Thief Tom', town.homes[1], {
    current_location: town.bakery,
    personality: { ...PERSONALITY, morality: 20 },
  });
  db.insert(agentStates).values({
    agent_id: thief, type: 'in_debt', severity: 0.5, started_at: NOW - 60, duration: 999999,
    source: 'test', metadata: {},
  }).run();
  const realEmit = simEvents.emit.bind(simEvents);
  vi.spyOn(simEvents, 'emit').mockImplementation((name: string | symbol, payload?: unknown) => {
    emitted.push({ name: String(name), payload: payload as Record<string, unknown> });
    return name === 'economy:theft_caught' || name === 'economy:theft_success' ? realEmit(name, payload) : true;
  });
  vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(caughtRoll).mockReturnValue(0.999);
  getReputation(thief); // registers the reputation listeners
  processStateEffects(agentRow(thief), statesOf(thief), [agentRow(owner), agentRow(thief)], NOW, 10_000, 1, createStatesTickContext());
  return { thief, owner, bakery: town.bakery };
}

describe('a debtor stealing from a shop', () => {
  it('when caught, names thief and owner and costs the thief reputation', () => {
    const { thief, owner, bakery } = steal(0);
    const caught = emitted.find((e) => e.name === 'economy:theft_caught')!.payload;
    expect(caught).toMatchObject({ agentId: thief, perpetratorId: thief, victimId: owner, locationId: bakery });
    expect(getReputation(thief)).toBeLessThan(0);
  });

  it('when unseen, names thief and owner for the goal and reputation listeners', () => {
    const { thief, owner } = steal(0.99);
    const success = emitted.find((e) => e.name === 'economy:theft_success')!.payload;
    expect(success).toMatchObject({ agentId: thief, thief, victim: owner, perpetratorId: thief, victimId: owner });
    expect(getReputation(thief)).toBeLessThan(0);
  });
});

describe('crisis scams and robberies', () => {
  const record = vi.fn();

  it('a scam by a travelling stranger costs the victim no reputation, and they remember it', () => {
    const town = freshTown();
    const victim = insertResident('Gullible Gus', town.homes[0]);
    const before = getReputation(victim);
    initMemoryObserver({ record } as unknown as MemoryService);
    record.mockClear();

    simEvents.emit('economy:scam', { agentId: victim, victimId: victim, amount: 20 });

    expect(getReputation(victim)).toBe(before);
    const line = record.mock.calls.find((c) => c[0] === victim)?.[2] as string;
    expect(line).toMatch(/\$20/);
    expect(line).toMatch(/swindl|scam/i);
  });

  it('the victim of a crisis robbery remembers being robbed', () => {
    const town = freshTown();
    const thief = insertResident('Poor Pete', town.homes[0]);
    const victim = insertResident('Rich Rita', town.homes[1]);
    initMemoryObserver({ record } as unknown as MemoryService);
    record.mockClear();

    simEvents.emit('economy:theft', { agentId: thief, thief, victim, perpetratorId: thief, victimId: victim, amount: 30 });

    const line = record.mock.calls.find((c) => c[0] === victim)?.[2] as string;
    expect(line).toMatch(/robbed/);
    expect(line).toMatch(/\$30/);
  });
});
