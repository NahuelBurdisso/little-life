import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db';
import { agents, agentStates, locations, shared_knowledge } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { RippleEngine } from '../lib/cascade/RippleEngine';
import { rippleRules } from '../lib/cascade/rippleRules';
import type { CascadeMetadata } from '../lib/cascade/cascadeTypes';

/**
 * `createFact: 'rumor'` rules used to produce "There are rumors going around
 * about X" with no content — and `jealousy_gossip` made X the jealous agent
 * themself. The rumor now comes from the event that fired the rule.
 */

function insertHome(): number {
  return db.insert(locations).values({
    name: 'rumor home',
    type: 'home',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 1, y: 4 },
    owner: null,
    capacity: 4,
    current_occupants: [],
    operating_hours: null,
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, home: number): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality: null,
    age: 30,
    gender: 'female',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 0, y: 0 },
    current_destination: null,
    current_location: home,
    current_action: { type: 'idle' },
    action_started: 0,
    action_duration: null,
    action_queue: [],
    current_path: null,
    schedule: {
      wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [],
    },
    home,
    workplace: null,
    created_at: Date.now(),
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function rumorsAbout(subjectId: number) {
  return db.select().from(shared_knowledge)
    .where(and(eq(shared_knowledge.type, 'rumor'), eq(shared_knowledge.subject_id, subjectId)))
    .all();
}

const rule = (id: string) => rippleRules.find((r) => r.id === id)!;

/** executeEffects is the unit under test; the probability/cooldown gates in front of it are not. */
function fireEffects(ruleId: string, agentId: number, metadata: Partial<CascadeMetadata>, payload: unknown): void {
  const engine = new RippleEngine();
  // Private on purpose; the test reaches in rather than widen the class for it.
  (engine as unknown as { executeEffects: (...args: unknown[]) => void }).executeEffects(
    rule(ruleId),
    agentId,
    { chainId: 'test', chainDepth: 1, parentRuleId: ruleId, ...metadata },
    payload,
  );
}

describe('cascade rumor content', () => {
  let home: number;

  beforeAll(() => {
    home = insertHome();
  });

  it('jealousy_gossip spreads a rumor about the rival, naming the love interest', () => {
    const jealous = insertAgent('Rumor Jealous', home);
    const rival = insertAgent('Rumor Rival', home);
    const love = insertAgent('Rumor Love', home);
    db.insert(agentStates).values({
      agent_id: jealous,
      type: 'jealous',
      severity: 0.6,
      started_at: 0,
      duration: 999999,
      target_agent_id: rival,
      source: 'trigger:rival_romance',
      metadata: { loveInterestId: love, rivalId: rival },
    }).run();

    fireEffects('jealousy_gossip', jealous, { perpetratorId: jealous },
      { agentId: jealous, state: 'jealous', cause: 'rival_romance' });

    expect(rumorsAbout(jealous)).toHaveLength(0);
    const [rumor] = rumorsAbout(rival);
    expect(rumor.content).toBe('Rumor Rival is only stringing Rumor Love along');
    expect(rumor.target_id).toBe(love);
    expect(rumor.known_by).toEqual([jealous]);
  });

  it('starts no rumor when the jealousy names no rival', () => {
    // Falling through to the generic branch used to make the jealous agent
    // the subject of their own rumor.
    const loner = insertAgent('Rumor Loner', home);

    fireEffects('jealousy_gossip', loner, { perpetratorId: loner },
      { agentId: loner, state: 'jealous', cause: 'rival_romance' });

    expect(rumorsAbout(loner)).toHaveLength(0);
  });

  it('announce_rumor_spread says what was done', () => {
    const crier = insertAgent('Rumor Crier', home);

    fireEffects('announce_rumor_spread', crier, { perpetratorId: crier },
      { agentId: crier, action: 'announce' });

    expect(rumorsAbout(crier).map((r) => r.content)).toEqual(['Rumor Crier made a big public announcement']);
  });
});
