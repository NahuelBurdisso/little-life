import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db';
import { agents, locations, shared_knowledge } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { WitnessAmplifier, describeWitnessedAct } from '../lib/cascade/WitnessAmplifier';

/**
 * Playtest: "Rumor about Priya Sharma: witnessed by Ray Kowalski". The rumor a
 * curious witness starts has to say what they saw, not just that they saw it.
 */

function insertHome(): number {
  return db.insert(locations).values({
    name: 'witness home',
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
    current_location: null,
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

const NAMES: Record<number, string> = { 1: 'Xavi', 2: 'Tom' };
const nameOf = (id: number) => NAMES[id] ?? `#${id}`;

describe('describeWitnessedAct', () => {
  it('describes an interaction by its action, naming the victim', () => {
    expect(describeWitnessedAct('interaction:completed', { agentId: 1, perpetratorId: 1, victimId: 2, action: 'insult' }, nameOf))
      .toEqual({ actorId: 1, otherId: 2, act: 'publicly insulted Tom' });
  });

  it('matches free-text actions by keyword', () => {
    expect(describeWitnessedAct('interaction:completed', { agentId: 1, action: 'stole bread from the bakery' }, nameOf)?.act)
      .toBe('was seen stealing');
  });

  it('describes visible states', () => {
    expect(describeWitnessedAct('state:triggered', { agentId: 2, state: 'drunk' }, nameOf)?.act)
      .toBe('was stumbling around drunk');
  });

  it('attributes a state to its owner, not to the perpetrator the chain carried along', () => {
    // X (1) insulted Y (2); Y's anger arrives as state:triggered with
    // perpetratorId still X. The rage is Y's.
    expect(describeWitnessedAct('state:triggered', { agentId: 2, state: 'angry', perpetratorId: 1, victimId: 2 }, nameOf))
      .toEqual({ actorId: 2, otherId: null, act: 'flew into a rage' });
  });

  it('attributes a deed to the perpetrator when the parties are distinct', () => {
    expect(describeWitnessedAct('economy:theft_caught', { agentId: 1, perpetratorId: 1, victimId: 2 }, nameOf))
      .toEqual({ actorId: 1, otherId: 2, act: 'was caught stealing from Tom' });
  });

  it('returns null when nothing visible happened', () => {
    expect(describeWitnessedAct('goal:completed', { agentId: 1, goalType: 'befriend' }, nameOf)).toBeNull();
    expect(describeWitnessedAct('state:triggered', { agentId: 1, state: 'lonely' }, nameOf)).toBeNull();
    expect(describeWitnessedAct('interaction:completed', { agentId: 1, action: 'wave' }, nameOf)).toBeNull();
  });
});

describe('fast_gossip witness rumors', () => {
  const amplifier = new WitnessAmplifier();
  let priya: number;
  let ray: number;
  let tom: number;

  beforeAll(() => {
    const home = insertHome();
    priya = insertAgent('Witness Priya', home);
    ray = insertAgent('Witness Ray', home);
    tom = insertAgent('Witness Tom', home);
  });

  it('puts the witnessed act in the rumor, not just the witness', () => {
    amplifier.applyBehaviors(ray, [{ type: 'fast_gossip' }], tom, priya, {
      ruleId: 'test',
      source: 'interaction:completed',
      payload: { agentId: priya, perpetratorId: priya, victimId: tom, action: 'confrontation' },
    });

    const [rumor] = rumorsAbout(priya);
    expect(rumor.content).toBe(
      'Witness Priya got into a heated confrontation with Witness Tom, according to Witness Ray',
    );
    expect(rumor.known_by).toEqual([ray]);
  });

  it('starts no rumor when there is nothing to describe', () => {
    amplifier.applyBehaviors(ray, [{ type: 'fast_gossip' }], null, tom, {
      ruleId: 'test',
      source: 'goal:completed',
      payload: { agentId: tom },
    });

    expect(rumorsAbout(tom)).toHaveLength(0);
  });
});
