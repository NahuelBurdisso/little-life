import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../db';
import { agents, locations } from '../db/schema';
import { RippleEngine } from '../lib/cascade/RippleEngine';
import { TensionTracker, snapThreshold } from '../lib/cascade/TensionTracker';
import type { RippleRule } from '../lib/cascade/cascadeTypes';
import { simEvents } from '../lib/simEvents';
import { buildBrewing, type BrewingInput } from '../lib/brewing';
import type { PersonalityProfile } from '../lib/personality';

/**
 * Tension sources never named the resident they were about (`agentInvolved`
 * was read and stored, but nothing set it), so the Brewing panel could only say
 * "a heated confrontation weighing on them". The ripple engine now records the
 * other party of the event, and the panel says who.
 */

const PERSONALITY: PersonalityProfile = {
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50,
};

const GRIEVANCE: RippleRule = {
  id: 'test_grievance',
  source: 'test:grievance',
  target: 'self',
  probability: 1,
  personalityGates: [],
  cooldownMinutes: 0,
  effects: { tensionDelta: 10 },
};

function insertAgent(name: string, home: number): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality: PERSONALITY,
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
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home,
    workplace: null,
    created_at: Date.now(),
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

describe('tension grievances name who they are about', () => {
  const tracker = new TensionTracker();
  let home: number;

  beforeAll(() => {
    home = db.insert(locations).values({
      name: 'grievance home',
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
    const engine = new RippleEngine({ rules: [GRIEVANCE] });
    engine.setTensionTracker(tracker);
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterAll(() => vi.restoreAllMocks());

  it('records the other party of the event', () => {
    const mara = insertAgent('Mara Grievance', home);
    const jonas = insertAgent('Jonas Grievance', home);

    simEvents.emit('test:grievance', { agentId: mara, perpetratorId: jonas });

    expect(tracker.getSources(mara)).toEqual([
      expect.objectContaining({ event: 'test:grievance', agentInvolved: 'Jonas Grievance' }),
    ]);
  });

  it('names the victim when the agent is the perpetrator, and nobody for a solo event', () => {
    const edda = insertAgent('Edda Grievance', home);
    const piet = insertAgent('Piet Grievance', home);

    simEvents.emit('test:grievance', { agentId: edda, victimId: piet });
    simEvents.emit('test:grievance', { agentId: piet });

    expect(tracker.getSources(edda)[0].agentInvolved).toBe('Piet Grievance');
    // The event names only the agent themself: no one to blame.
    expect(tracker.getSources(piet)[0]).not.toHaveProperty('agentInvolved');
  });
});

describe('Brewing names the person', () => {
  const agentsIn: BrewingInput['agents'] = [
    { id: 1, name: 'Mara', personality: PERSONALITY },
    { id: 2, name: 'Jonas', personality: PERSONALITY },
  ];
  const value = snapThreshold(PERSONALITY) * 0.8;
  const brew = (sources: BrewingInput['tension'][number]['sources']) =>
    buildBrewing({
      agents: agentsIn, tension: [{ agentId: 1, value, sources }], secrets: [], queue: [], goals: [], relationships: [],
    })[0].text;

  it('says who most of the grievances are about', () => {
    const text = brew([
      { event: 'confrontation:occurred', description: 'x', tick: 1, agentInvolved: 'Jonas' },
      { event: 'jealousy:triggered', description: 'x', tick: 2, agentInvolved: 'Jonas' },
    ]);
    expect(text).toBe('Mara is close to snapping — jealousy and a heated confrontation weighing on them, mostly about Jonas');
  });

  it('says "partly" when the name is on a minority of the grievances', () => {
    const text = brew([
      { event: 'economy:distress', description: 'x', tick: 1 },
      { event: 'need:critical', description: 'x', tick: 2 },
      { event: 'confrontation:occurred', description: 'x', tick: 3, agentInvolved: 'Jonas' },
    ]);
    expect(text).toContain('partly about Jonas');
  });

  it('is unchanged when no grievance names anyone', () => {
    const text = brew([{ event: 'economy:distress', description: 'x', tick: 1 }]);
    expect(text).toBe('Mara is close to snapping — money trouble weighing on them');
  });
});
