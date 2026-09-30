import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, needs, relationshipEvents, relationships, worldState } from '../../../db/schema';
import { intimacyRouter } from '../../../routers/intimacy';
import { gameMinutes } from '../../gameClock';
import { setRuleOverrides } from '../../worldRules';
import { clearIntimacy, ensureAgentIntimacy, updatePairIntimacy } from '../state';
import { KISSED_TAG } from '../kiss';

/**
 * The Hearts ledger router against the DB: nobody under 18, and the adult-layer sections go quiet with the rule off.
 */

const TIME = { day: 40, hour: 14, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);

let homeId: number;
const made: number[] = [];

function setClock(): void {
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time: TIME, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time: TIME, day_phase: 'afternoon', weather: 'sunny', weather_duration: 120, tick_speed: 1,
    is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
    pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
  }).run();
}

function insertAgent(name: string, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 23, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  db.insert(needs).values({
    agent_id: id, hunger: 60, energy: 60, social: 40, comfort: 50, fun: 40, mood: 55, stress: 20,
    decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
    thresholds: { critical: 10, low: 30, satisfied: 70 }, mood_modifiers: [], last_updated: 0,
  }).run();
  return id;
}

function couple(opts: { tags?: string[]; aOver?: Partial<typeof agents.$inferInsert>; bOver?: Partial<typeof agents.$inferInsert> } = {}) {
  const a = insertAgent(`Read A${made.length}`, { gender: 'female', ...opts.aOver });
  const b = insertAgent(`Read B${made.length}`, { gender: 'male', ...opts.bOver });
  db.insert(relationships).values({
    agent_a: a, agent_b: b, friendship_ab: 70, friendship_ba: 70, romance_ab: 80, romance_ba: 80,
    trust_ab: 60, trust_ba: 60, familiarity: 80, interaction_count: 40, last_interaction: 0,
    average_interaction_sentiment: 0.5, tags: opts.tags ?? [KISSED_TAG], status: 'romantic_interest',
    created_at: 0, last_updated: 0,
  }).run();
  return { a, b };
}

/** Kisses and nights on the pair's in-memory state. */
function shared(a: number, b: number, over: { kisses?: number; trysts?: number; secret?: boolean } = {}) {
  updatePairIntimacy(a, b, (p) => {
    p.kisses = over.kisses ?? 4;
    p.firstKissAt = NOW - 5000;
    p.trysts = over.trysts ?? 2;
    p.firstTrystAt = NOW - 3000;
    p.secret = over.secret ?? true;
  });
}


beforeAll(() => {
  setClock();
  homeId = db.insert(locations).values({
    name: 'Reads Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
    capacity: 20, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
});

beforeEach(() => {
  clearIntimacy();
  setClock();
  setRuleOverrides({ adultContent: true });
  db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
});

afterAll(() => {
  setRuleOverrides({ adultContent: false });
  db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, made), inArray(relationshipEvents.agent_b, made))).run();
  db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
  db.delete(needs).where(inArray(needs.agent_id, made)).run();
  db.delete(agents).where(inArray(agents.id, made)).run();
  db.delete(locations).where(eq(locations.id, homeId)).run();
  clearIntimacy();
});

describe('the Hearts ledger router', () => {
  const ledger = () => intimacyRouter.createCaller({} as never).getLedger();
  const nameOf = (id: number) => db.select({ n: agents.name }).from(agents).where(eq(agents.id, id)).get()!.n;

  it('lists adult lovers (secrets and all) and their longing, and never a minor', async () => {
    const lovers = couple({ tags: [KISSED_TAG, 'lovers'] });
    shared(lovers.a, lovers.b, { secret: true });
    ensureAgentIntimacy(lovers.a).longing = 77;
    const teens = couple({ tags: [KISSED_TAG, 'lovers', 'partner'], aOver: { age: 16 }, bOver: { age: 16 } });
    shared(teens.a, teens.b);
    ensureAgentIntimacy(teens.a).longing = 99;
    const mixed = couple({ tags: [KISSED_TAG, 'lovers'], aOver: { age: 17 } });
    shared(mixed.a, mixed.b);

    const l = await ledger();
    expect(l.adultContent).toBe(true);
    expect(l.lovers.map((x) => [x.a.id, x.b.id, x.secret, x.nights])).toEqual([[lovers.a, lovers.b, true, 2]]);
    expect(l.longing.map((x) => x.person.id)).toEqual([lovers.a]);
    const text = JSON.stringify(l);
    for (const id of [teens.a, teens.b, mixed.a]) expect(text).not.toContain(nameOf(id));
    expect(l.milestones.map((m) => m.kind).sort()).toEqual(['first_kiss', 'first_night']);
  });

  it('hides longing, lovers and first nights with the rule off; kisses stay', async () => {
    setRuleOverrides({ adultContent: false });
    const lovers = couple({ tags: [KISSED_TAG, 'lovers'] });
    shared(lovers.a, lovers.b);
    ensureAgentIntimacy(lovers.a).longing = 90;
    const l = await ledger();
    expect(l.adultContent).toBe(false);
    expect(l.longing).toEqual([]);
    expect(l.lovers).toEqual([]);
    expect(l.milestones.map((m) => m.kind)).toEqual(['first_kiss']);
  });
});
