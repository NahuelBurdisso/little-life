import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, needs, relationshipEvents, relationships, worldState } from '../../../db/schema';
import { getPairDossier } from '../../pairDossier';
import { gameMinutes } from '../../gameClock';
import { setRuleOverrides } from '../../worldRules';
import { clearIntimacy, updatePairIntimacy } from '../state';
import { KISSED_TAG } from '../kiss';

/**
 * The pair dossier's intimacy block: adults only, and the adult-layer fields go quiet with the rule off.
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

const dossier = (a: number, b: number) => getPairDossier(a, b)!;

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

describe('the pair dossier intimacy block', () => {
  it('two adults: first kiss, kisses, nights, first night, secret, lovers and whether an evening can be arranged', () => {
    const { a, b } = couple({ tags: [KISSED_TAG, 'lovers'] });
    shared(a, b);
    expect(dossier(a, b).intimacy).toEqual({
      kissed: true, kisses: 4, firstKissMinute: NOW - 5000, nights: 2, firstNightMinute: NOW - 3000,
      lovers: true, secret: true, adultContent: true, arrange: { available: true, reason: null },
    });
    // The other way round reads the same.
    expect(dossier(b, a).intimacy).toMatchObject({ kisses: 4, nights: 2 });
  });

  it('falls back to the pivotal events for the first kiss and night when the pair state is gone', () => {
    const { a, b } = couple({ tags: [KISSED_TAG, 'lovers'] });
    for (const [type, minute] of [['first_kiss', NOW - 900], ['first_tryst', NOW - 400]] as const) {
      db.insert(relationshipEvents).values({
        agent_a: a, agent_b: b, event_type: type, description: 'x', friendship_delta_ab: 0, friendship_delta_ba: 0,
        romance_delta_ab: 0, romance_delta_ba: 0, trust_delta_ab: 0, trust_delta_ba: 0, sentiment: 0.5,
        processed: true, timestamp: 0, game_minute: minute,
      }).run();
    }
    expect(dossier(a, b).intimacy).toMatchObject({ kissed: true, kisses: 0, firstKissMinute: NOW - 900, firstNightMinute: NOW - 400, nights: 0 });
  });

  it('with the adult layer off the nights, lovers and secret read empty and arranging is unavailable, with a reason', () => {
    setRuleOverrides({ adultContent: false });
    const { a, b } = couple({ tags: [KISSED_TAG, 'lovers'] });
    shared(a, b);
    const i = dossier(a, b).intimacy!;
    expect(i).toMatchObject({ kissed: true, kisses: 4, nights: 0, firstNightMinute: null, lovers: false, secret: false, adultContent: false });
    expect(i.firstKissMinute).toBe(NOW - 5000);
    expect(i.arrange.available).toBe(false);
    expect(i.arrange.reason).toMatch(/turned off/);
  });

  it("says why an evening can't be arranged yet: they haven't kissed", () => {
    const { a, b } = couple({ tags: [] });
    expect(dossier(a, b).intimacy).toMatchObject({
      kissed: false, kisses: 0, firstKissMinute: null,
      arrange: { available: false, reason: "They haven't even kissed yet." },
    });
  });

  it('is absent when either is under 18, whatever the pair holds', () => {
    const adultAndTeen = couple({ tags: [KISSED_TAG, 'lovers'], aOver: { age: 17 } });
    shared(adultAndTeen.a, adultAndTeen.b, { kisses: 9, trysts: 9 });
    expect(dossier(adultAndTeen.a, adultAndTeen.b).intimacy).toBeNull();
    expect(dossier(adultAndTeen.b, adultAndTeen.a).intimacy).toBeNull();

    const teens = couple({ tags: [KISSED_TAG], aOver: { age: 15 }, bOver: { age: 16 } });
    expect(dossier(teens.a, teens.b).intimacy).toBeNull();
    // The JSON a client would receive never carries the block's fields either.
    expect(JSON.stringify(dossier(teens.a, teens.b))).not.toContain('firstKissMinute');
  });

  it('a pair at exactly 18 has it', () => {
    const { a, b } = couple({ aOver: { age: 18 }, bOver: { age: 18 } });
    expect(dossier(a, b).intimacy).not.toBeNull();
  });
});
