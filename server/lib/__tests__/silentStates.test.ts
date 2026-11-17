import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { agentStates, needs } from '../../db/schema';
import { simEvents } from '../simEvents';
import { tavernTick, clearTavernTracking } from '../tavernEngine';
import { lonelinessCheck, clearLonelinessTracking } from '../lonelinessEngine';
import '../giftEngine';
import { memoryService } from '../memory/instance';
import { clearEffectivePersonalities, setEffectivePersonality } from '../states';
import { NOW, PERSONALITY, freshTown, insertResident as insertBare, relate } from './populationFixtures';

/** A resident whose effective personality the engines can read (the states phase fills it in a game). */
function insertResident(...args: Parameters<typeof insertBare>): number {
  const id = insertBare(...args);
  setEffectivePersonality(id, { ...PERSONALITY, warmth: 80 });
  return id;
}

/**
 * States some engines inserted without a `state:triggered`: the ripple rules
 * (drunk_incident, jealousy_gossip...), the memory stream and the replanner
 * never heard of them. A tavern drunk was the only drunk in town nobody noticed.
 */

let triggered: Array<{ agentId: number; state: string }>;

beforeEach(() => {
  clearTavernTracking();
  clearLonelinessTracking();
  triggered = [];
  vi.spyOn(memoryService, 'record').mockImplementation(() => {});
  const realEmit = simEvents.emit.bind(simEvents);
  vi.spyOn(simEvents, 'emit').mockImplementation((name: string | symbol, payload?: unknown) => {
    if (name === 'state:triggered') {
      triggered.push(payload as { agentId: number; state: string });
      return true;
    }
    // gift:given must still reach the gift engine's jealousy listener.
    return realEmit(name, payload);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearEffectivePersonalities();
  clearTavernTracking();
  clearLonelinessTracking();
});

const stateOf = (id: number, type: string) => db.select().from(agentStates)
  .where(and(eq(agentStates.agent_id, id), eq(agentStates.type, type))).get();

describe('states inserted outside the states phase announce themselves', () => {
  it('a fifth drink at the tavern makes the drinker drunk, and says so', () => {
    const town = freshTown();
    const id = insertResident('Toby', town.homes[0], { current_location: town.tavern, current_action: { type: 'socializing' } }, { money: 100 });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    for (let i = 0; i <= 5; i++) tavernTick(NOW + i * 30);

    expect(stateOf(id, 'drunk')).toBeDefined();
    expect(triggered.filter((t) => t.agentId === id && t.state === 'drunk')).toHaveLength(1);
  });

  it('twelve lonely hours make the lonely state, and say so', () => {
    const town = freshTown();
    const id = insertResident('Lone', town.homes[0]);
    db.update(needs).set({ social: 5 }).where(eq(needs.agent_id, id)).run();
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    lonelinessCheck(NOW);
    lonelinessCheck(NOW + 721);

    expect(stateOf(id, 'lonely')).toBeDefined();
    expect(triggered).toContainEqual(expect.objectContaining({ agentId: id, state: 'lonely' }));
  });

  it('a gift seen by someone sweet on the giver makes them jealous, and says so', () => {
    const town = freshTown();
    const giver = insertResident('Giver', town.homes[0], { current_location: town.square });
    const receiver = insertResident('Receiver', town.homes[1], { current_location: town.square });
    const witness = insertResident('Witness', town.homes[2], { current_location: town.square });
    relate(witness, giver, { romance_ab: 60, romance_ba: 60 });

    simEvents.emit('gift:given', { giverId: giver, receiverId: receiver });

    expect(stateOf(witness, 'jealous')).toBeDefined();
    expect(triggered).toContainEqual(expect.objectContaining({ agentId: witness, state: 'jealous' }));
  });
});
