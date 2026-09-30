import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed (test: LLM disabled)'); });

import { db } from '../../../db';
import { agents, agentStates, goals, locations, relationships, shared_knowledge, worldState } from '../../../db/schema';
import { goalsTick } from '../goals';
import { GOAL_TRIGGER_REGISTRY } from '../../../data/goalRegistry';

/**
 * Reactive goal triggers. The two `trigger_on: 'observers'` entries (protect a sick neighbour,
 * comfort a grieving one) used to fire for the sick / grieving agent THEMSELVES, with no target:
 * a goal nothing could progress or end, which made up most of a long soak's goal churn.
 */

const TIME = { day: 5, hour: 12, minute: 0, totalTicks: 7200, seasonDay: 5, season: 'spring' };
const made: number[] = [];
let homeId: number;

function insertAgent(name: string): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female',
    // Warm and sensual enough to pass the personality gates of protect and seduce.
    personality: {
      honesty: 50, aggression: 30, warmth: 80, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 60, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  return id;
}

const addState = (agentId: number, type: string, target?: number) => db.insert(agentStates).values({
  agent_id: agentId, type, severity: 0.5, started_at: 7200, duration: 5000, source: 'test',
  target_agent_id: target ?? null, metadata: null,
}).run();

describe('goal triggers', () => {
  beforeAll(() => {
    const existing = db.select().from(worldState).get();
    if (existing) db.update(worldState).set({ time: TIME, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    else {
      db.insert(worldState).values({
        time: TIME, day_phase: 'afternoon', weather: 'sunny', weather_duration: 120, tick_speed: 1,
        is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
        pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
      }).run();
    }
    homeId = db.insert(locations).values({
      name: 'Goal Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 20, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
  });

  afterAll(() => {
    db.delete(goals).where(inArray(goals.agent_id, made)).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, made)).run();
  });

  it('the observer triggers are exactly the ones the tick must not fire on the subject', () => {
    expect(GOAL_TRIGGER_REGISTRY.filter((t) => t.trigger_on === 'observers').map((t) => t.generates).sort())
      .toEqual(['comfort_grieving', 'protect']);
  });

  it('gives a sick or grieving resident no target-less protect / comfort goal about themselves', () => {
    const sick = insertAgent('Sick Sam');
    const grieving = insertAgent('Grieving Gwen');
    addState(sick, 'sick');
    addState(grieving, 'grieving');

    goalsTick();

    expect(db.select().from(goals).where(inArray(goals.agent_id, [sick, grieving])).all()).toEqual([]);
  });

  it('still starts the goals that need no observer (an infatuated resident sets out to seduce their crush)', () => {
    const smitten = insertAgent('Smitten Sol');
    const crush = insertAgent('Crush Cal');
    addState(smitten, 'infatuated', crush);

    goalsTick();

    const rows = db.select().from(goals).where(eq(goals.agent_id, smitten)).all();
    expect(rows.map((g) => [g.type, g.target_id, g.status])).toEqual([['seduce', crush, 'active']]);
  });
});

/**
 * "Affair discovery → revenge" (goalRegistry `fact_learned` affair `involves_partner`), from an
 * affair born of an act (lib/intimacy/): the trigger reads `known_by` off the facts table, so a
 * spouse who was merged into the row as a witness (no `gossip:learned` fires for that) gets the
 * goal exactly like one who was told. Only the betrayed party does.
 */
describe('affair discovery starts a revenge goal', () => {
  const relate = (x: number, y: number, tags: string[]) => db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y), friendship_ab: 50, friendship_ba: 50, romance_ab: 70, romance_ba: 70,
    trust_ab: 50, trust_ba: 50, familiarity: 50, interaction_count: 5, last_interaction: 0,
    average_interaction_sentiment: 0, tags, status: 'partners', created_at: 0, last_updated: 0,
  }).run();
  const affair = (subject: number, target: number, knownBy: number[]) => db.insert(shared_knowledge).values({
    type: 'affair', subject_id: subject, target_id: target, content: 'x and y are getting suspiciously close',
    sensitivity: 3, known_by: knownBy, created_at: 0, is_active: true, source: 'committed',
  }).run();
  const revenge = (id: number) => db.select().from(goals).where(eq(goals.agent_id, id)).all()
    .filter((g) => g.type === 'revenge').map((g) => g.target_id);

  it('the wife who is a witness gets it, aimed at her husband; the lover, whose row reads partner too, does not', () => {
    const wife = insertAgent('Wife Wanda');
    const husband = insertAgent('Husband Hal');
    const lover = insertAgent('Lover Lena');
    relate(wife, husband, ['partner', 'married']);
    // The lover's row with the husband is "partner" as well (a warm enough pair): still not the betrayed one.
    relate(husband, lover, ['partner', 'lovers']);
    // Born of the act, known to the two; the wife then walked in (merged into known_by, no gossip event).
    affair(husband, lover, [husband, lover, wife]);

    goalsTick();

    expect(revenge(wife)).toEqual([husband]);
    expect(revenge(lover)).toEqual([]);
    expect(revenge(husband)).toEqual([]);
  });

  it('a fact that names the lover first is still about the cheater the agent is with', () => {
    const wife = insertAgent('Wife Wilma');
    const husband = insertAgent('Husband Hugo');
    const lover = insertAgent('Lover Lia');
    relate(wife, husband, ['partner']);
    // Subject is the other man (both are spoken for, so the lower id leads): the target is the husband.
    affair(lover, husband, [lover, husband, wife]);
    goalsTick();
    expect(revenge(wife)).toEqual([husband]);
  });

  it('nobody who does not know it, and nobody who is not partnered with one of them', () => {
    const wife = insertAgent('Wife Wren');
    const husband = insertAgent('Husband Hank');
    const lover = insertAgent('Lover Lark');
    const bystander = insertAgent('Bystander Bea');
    relate(wife, husband, ['partner']);
    affair(husband, lover, [husband, lover, bystander]);
    goalsTick();
    expect(revenge(wife)).toEqual([]); // has not heard
    expect(revenge(bystander)).toEqual([]); // heard, but it is nobody's betrayal
  });
});
