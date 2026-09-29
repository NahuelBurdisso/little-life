import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../db';
import { agents, locations, shared_knowledge } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { RippleEngine } from '../lib/cascade/RippleEngine';
import { WitnessAmplifier } from '../lib/cascade/WitnessAmplifier';
import { rippleRules } from '../lib/cascade/rippleRules';
import { simEvents } from '../lib/simEvents';
import type { PersonalityProfile } from '../lib/personality';

/**
 * Review finding: a witness rumor about a cascade-chained state blamed the
 * wrong person. X insults Y → insult_anger makes Y angry → anger_lash_out
 * fires on Y's state:triggered, whose payload still carries perpetratorId X,
 * and the bystander's rumor said "X flew into a rage". The confrontation that
 * anger_lash_out then emitted still named X as perpetrator, too.
 */

const NEUTRAL: PersonalityProfile = {
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50,
};
// Curious and nothing else, so fast_gossip is the only witness behaviour.
const NOSY: PersonalityProfile = { ...NEUTRAL, curiosity: 90 };

function insertLocation(): number {
  return db.insert(locations).values({
    name: 'chain plaza',
    type: 'plaza',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 1, y: 4 },
    owner: null,
    capacity: 10,
    current_occupants: [],
    operating_hours: null,
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, at: number, personality: PersonalityProfile): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality,
    age: 30,
    gender: 'male',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 0, y: 0 },
    current_destination: null,
    current_location: at,
    current_action: { type: 'idle' },
    action_started: 0,
    action_duration: null,
    action_queue: [],
    current_path: null,
    schedule: {
      wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [],
    },
    home: at,
    workplace: null,
    created_at: Date.now(),
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function rumorsKnownBy(witnessId: number) {
  return db.select().from(shared_knowledge)
    .where(and(eq(shared_knowledge.type, 'rumor'), eq(shared_knowledge.source, 'witness:fast_gossip')))
    .all()
    .filter((f) => (f.known_by as number[]).includes(witnessId));
}

describe('witness rumors through a cascade chain', () => {
  let plaza: number;
  let insulter: number;
  let insulted: number;
  let bystander: number;
  /** Events the chain itself emitted (anger_lash_out's confrontation). */
  const emitted: any[] = [];
  const capture = (p: any) => { if (p?._cascade) emitted.push(p); };

  beforeAll(() => {
    plaza = insertLocation();
    insulter = insertAgent('Chain Xavi', plaza, NEUTRAL);
    insulted = insertAgent('Chain Yves', plaza, NEUTRAL);
    bystander = insertAgent('Chain Wanda', plaza, NOSY);

    const engine = new RippleEngine({
      rules: ['insult_anger', 'anger_lash_out'].map((id) => rippleRules.find((r) => r.id === id)!),
    });
    engine.setWitnessAmplifier(new WitnessAmplifier());
    vi.spyOn(Math, 'random').mockReturnValue(0);
    simEvents.on('interaction:completed', capture);

    simEvents.emit('interaction:completed', {
      agentId: insulter,
      perpetratorId: insulter,
      victimId: insulted,
      action: 'insult',
      locationId: plaza,
    });
  });

  afterAll(() => {
    simEvents.off('interaction:completed', capture);
    vi.restoreAllMocks();
  });

  it('casts the lash-out with the angry agent as aggressor and the insulter as target', () => {
    const lashOut = emitted.find((p) => p._cascade?.parentRuleId === 'anger_lash_out');
    expect(lashOut).toMatchObject({
      action: 'confrontation',
      agentId: insulted,
      perpetratorId: insulted,
      victimId: insulter,
    });
  });

  it('pins the deed on the perpetrator when the parties are distinct', () => {
    const insult = rumorsKnownBy(bystander).find((f) => f.content.includes('publicly insulted'));
    expect(insult?.subject_id).toBe(insulter);
    expect(insult?.target_id).toBe(insulted);
  });

  it('pins the rage on the person who is angry, not on the chain perpetrator', () => {
    const rage = rumorsKnownBy(bystander).find((f) => f.content.includes('flew into a rage'));
    expect(rage?.subject_id).toBe(insulted);
    expect(rage?.content).toBe('Chain Yves flew into a rage, according to Chain Wanda');
  });
});
