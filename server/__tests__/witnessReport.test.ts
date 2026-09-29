import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../db';
import { agents, locations, shared_knowledge } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { RippleEngine } from '../lib/cascade/RippleEngine';
import { rippleRules } from '../lib/cascade/rippleRules';
import { simEvents } from '../lib/simEvents';
import { isOwnSecret } from '../lib/gossip';
import type { PersonalityProfile } from '../lib/personality';

/**
 * Witness-report rules (theft_witness_report, arrest_gossip,
 * confrontation_witness_gossip) made the *witness* the fact's subject:
 * "Wanda was caught stealing from Priya" when Wanda only watched — and the
 * own-secret gossip filter then stopped Wanda from telling anyone.
 */

const PERSONALITY: PersonalityProfile = {
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 80, loyalty: 50, morality: 80, sensuality: 50, neuroticism: 50,
};

function insertLocation(): number {
  return db.insert(locations).values({
    name: 'report market',
    type: 'shop',
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

function insertAgent(name: string, at: number): number {
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

describe('witness reports', () => {
  let market: number;

  beforeAll(() => {
    market = insertLocation();
    new RippleEngine({
      rules: ['theft_witness_report', 'confrontation_witness_gossip'].map((id) => rippleRules.find((r) => r.id === id)!),
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('a theft report is about the thief, and the witness can still tell it', () => {
    const thief = insertAgent('Report Thief', market);
    const victim = insertAgent('Report Victim', market);
    const witness = insertAgent('Report Witness', market);

    simEvents.emit('economy:theft_caught', { agentId: thief, perpetratorId: thief, victimId: victim, locationId: market });

    const fact = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.type, 'theft'), eq(shared_knowledge.source, 'cascade:theft_witness_report')))
      .all()
      .find((f) => (f.known_by as number[]).includes(witness))!;
    expect(fact.subject_id).toBe(thief);
    expect(fact.target_id).toBe(victim);
    expect(fact.content).toBe('Report Thief was caught stealing from Report Victim');
    expect(isOwnSecret(fact, witness)).toBe(false);
  });

  it('a fight report names both fighters and is neither fighter\'s to gossip', () => {
    // A fresh place, so the earlier test's agents can't be picked as the witness.
    const yard = insertLocation();
    const a = insertAgent('Report Brawler', yard);
    const b = insertAgent('Report Other', yard);
    const witness = insertAgent('Report Onlooker', yard);

    simEvents.emit('confrontation:occurred', { agentId: a, perpetratorId: a, victimId: b, locationId: yard });

    const fact = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.type, 'fight'), eq(shared_knowledge.subject_id, a)))
      .get()!;
    expect(fact.content).toBe('Report Brawler got into a fight with Report Other');
    expect(fact.known_by as number[]).toContain(witness);
    expect(isOwnSecret(fact, a)).toBe(true);
    expect(isOwnSecret(fact, b)).toBe(true);
    expect(isOwnSecret(fact, witness)).toBe(false);
  });
});

describe('isOwnSecret', () => {
  const fact = (type: string) => ({ subject_id: 1, target_id: 2, type });

  it('covers the target only for facts they took part in', () => {
    expect(isOwnSecret(fact('affair'), 2)).toBe(true);
    expect(isOwnSecret(fact('conspiracy'), 2)).toBe(true);
    expect(isOwnSecret(fact('confrontation'), 2)).toBe(true);
    // Being the object of someone's crush or theft is not your own secret.
    expect(isOwnSecret(fact('crush'), 2)).toBe(false);
    expect(isOwnSecret(fact('theft'), 2)).toBe(false);
    expect(isOwnSecret(fact('crush'), 1)).toBe(true);
  });
});
