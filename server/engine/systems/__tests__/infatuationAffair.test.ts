import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  activityLog, agentStates, agents, locations, needs, relationshipEvents, relationships, shared_knowledge, worldState,
} from '../../../db/schema';
import { statesTick } from '../states';
import { clearIntimacy } from '../../../lib/intimacy/state';

/**
 * The states phase turns a strong crush (romance > 60, the `infatuated` state) into an `affair` rumor,
 * "X and Y are getting suspiciously close". It used to do so whenever the crush had romance > 40 with ANY third
 * person, spoken for or not, so two single people drifting together were "an affair": a 30-day soak had 32 such
 * facts (18 of them between pairs who had never even kissed), each known by ~11 residents, and every one a
 * candidate for a partner's reckoning. An affair needs somebody spoken for: the crush's own partner, fiance(e)
 * or spouse, or the crush's.
 */

let homeId = 0;
const made: number[] = [];
let createdWorld = false;
let savedWorld: Pick<typeof worldState.$inferSelect, 'time' | 'tick_speed' | 'pending_transitions'> | undefined;

function ensureWorld(): boolean {
  if (db.select().from(worldState).get()) return false;
  db.insert(worldState).values({
    time: { day: 1, hour: 20, minute: 0, totalTicks: 1200, seasonDay: 1, season: 'spring' },
    day_phase: 'evening', weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true,
    last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
    map_width: 40, map_height: 30, collision_grid: '',
  }).run();
  return true;
}

function insertAgent(name: string, sensuality: number): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'bi',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 23, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  db.insert(needs).values({
    agent_id: id, hunger: 60, energy: 60, social: 60, comfort: 60, fun: 60, mood: 60, stress: 10,
    decay_rates: { hunger: 0, energy: 0, social: 0, comfort: 0, fun: 0 },
    thresholds: { critical: 10, low: 30, satisfied: 70 }, mood_modifiers: [], last_updated: 0,
  }).run();
  return id;
}

function relate(x: number, y: number, romanceXY: number, romanceYX: number, over: { status?: string; tags?: string[] } = {}): void {
  const [a, b] = x < y ? [x, y] : [y, x];
  const [rab, rba] = x < y ? [romanceXY, romanceYX] : [romanceYX, romanceXY];
  db.insert(relationships).values({
    agent_a: a, agent_b: b, friendship_ab: 60, friendship_ba: 60, romance_ab: rab, romance_ba: rba,
    trust_ab: 60, trust_ba: 60, familiarity: 60, interaction_count: 10, last_interaction: 0,
    last_interaction_minute: 1_000_000, average_interaction_sentiment: 0.4,
    tags: over.tags ?? [], status: over.status ?? 'romantic_interest', status_since_minute: 0, created_at: 0, last_updated: 0,
  }).run();
}

const affairs = () => db.select().from(shared_knowledge).all()
  .filter((f) => f.type === 'affair' && (made.includes(f.subject_id) || (f.target_id != null && made.includes(f.target_id))));

/** X is smitten with T (romance 70); nobody else can fall for anybody (T cold toward X, third person low sensuality). */
function triangle() {
  const x = insertAgent(`Smitten ${made.length}`, 60);
  const t = insertAgent(`Target ${made.length}`, 10);
  const z = insertAgent(`Third ${made.length}`, 10);
  relate(x, t, 70, 0);
  return { x, t, z };
}

describe('the infatuation rumor: an affair needs somebody spoken for', () => {
  beforeAll(() => {
    createdWorld = ensureWorld();
    const w = db.select().from(worldState).get()!;
    savedWorld = { time: w.time, tick_speed: w.tick_speed, pending_transitions: w.pending_transitions };
    homeId = db.insert(locations).values({
      name: 'Infatuation Cottage', type: 'house', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 1, y: 4 },
      capacity: 10, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
  });

  beforeEach(() => {
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, made), inArray(shared_knowledge.target_id, made))).run();
    clearIntimacy();
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, made), inArray(shared_knowledge.target_id, made))).run();
    db.delete(activityLog).where(inArray(activityLog.initiator_id, made)).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, made)).run();
    db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, made), inArray(relationshipEvents.agent_b, made))).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
    db.delete(needs).where(inArray(needs.agent_id, made)).run();
    db.delete(agents).where(inArray(agents.id, made)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
    if (createdWorld) db.delete(worldState).run();
    else if (savedWorld) db.update(worldState).set(savedWorld).run();
  });

  it('a crush whose target is merely fond of somebody else is not an affair', () => {
    const { x, t, z } = triangle();
    relate(t, z, 50, 50); // romance > 40 with a third, but nobody is spoken for
    statesTick();
    expect(db.select().from(agentStates).where(eq(agentStates.agent_id, x)).all().map((s) => s.type)).toContain('infatuated');
    expect(affairs()).toHaveLength(0);
  });

  it('a crush on somebody\'s partner is one, with the people in the room as knowers', () => {
    const { x, t, z } = triangle();
    relate(t, z, 90, 90, { status: 'partners', tags: ['partner'] });
    const bystander = insertAgent(`Bystander ${made.length}`, 10);
    statesTick();
    const found = affairs();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ subject_id: x, target_id: t });
    // Only those actually in the room (the third person is home too; nobody else in town is a knower).
    expect(new Set(found[0].known_by as number[])).toEqual(new Set([z, bystander]));
  });

  it('a crush from somebody who is spoken for themselves is one too', () => {
    const { x, t, z } = triangle();
    // Below the crush's own threshold, so it is T they fall for, while still spoken for to Z.
    relate(x, z, 55, 55, { status: 'partners', tags: ['partner', 'engaged'] });
    statesTick();
    expect(affairs().filter((f) => f.subject_id === x && f.target_id === t)).toHaveLength(1);
  });

  it('two people who are simply together (partners, romance both ways) are not scandalous', () => {
    const x = insertAgent(`Sweet ${made.length}`, 60);
    const t = insertAgent(`Heart ${made.length}`, 10);
    relate(x, t, 80, 80, { status: 'partners', tags: ['partner'] });
    statesTick();
    expect(affairs()).toHaveLength(0);
  });
});
