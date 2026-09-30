import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, locations, relationshipEvents, relationships, worldState } from '../../db/schema';
import { applyTemplateBeats, decideTemplateBeats, type BeatPerson, type TemplateBeatInput } from '../templateBeats';
import type { PersonalityProfile } from '../personality';

/**
 * Template chats produced no drama beats at all (only the LLM tier read beats off its
 * transcript), so a town on templates ran on gossip alone. These rules decide what a template
 * chat came to from the pair's state and the script that was played.
 */

const personality = (over: Partial<PersonalityProfile> = {}): PersonalityProfile => ({
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50,
  ...over,
} as PersonalityProfile);

const person = (over: Partial<BeatPerson> = {}): BeatPerson => ({
  personality: personality(), states: [], friendship: 20, romance: 0, trust: 30,
  hasConfessableSin: false, negativeFacts: 0, ...over,
});

const input = (over: Partial<TemplateBeatInput> = {}): TemplateBeatInput => ({
  scriptId: 'weather_sun', sentiment: 0.3, ids: [1, 2], people: [person(), person()],
  status: 'acquaintances', tags: [], ...over,
});

const always = () => 0;
const never = () => 0.999;

describe('decideTemplateBeats (pure)', () => {
  it('ordinary small talk comes to nothing', () => {
    expect(decideTemplateBeats(input(), always)).toEqual([]);
  });

  it('a standoff can boil over into an insult from the hotter head, and a fight from a hothead', () => {
    const mild = person({ personality: personality({ aggression: 30 }), friendship: -40 });
    const hot = person({ personality: personality({ aggression: 80 }), friendship: -40 });
    const standoff = input({ scriptId: 'standoff', sentiment: -0.4, people: [mild, hot], status: 'rivals' });
    expect(decideTemplateBeats(standoff, always)).toEqual([{ kind: 'insult', actor: 1 }, { kind: 'fight', actor: 1 }]);
    expect(decideTemplateBeats(standoff, never)).toEqual([]);

    // A mild pair insults each other at most; nobody comes to blows.
    const calm = input({ scriptId: 'standoff', sentiment: -0.4, people: [mild, mild], status: 'rivals' });
    expect(decideTemplateBeats(calm, always)).toEqual([{ kind: 'insult', actor: 0 }]);
  });

  it('anger at the other one or drink turns up the heat', () => {
    const angry = person({ states: [{ type: 'angry', target: 1 }], friendship: -30 });
    const beats = decideTemplateBeats(input({
      scriptId: 'standoff', sentiment: -0.4, people: [person({ friendship: -30 }), angry],
    }), always);
    expect(beats[0]).toEqual({ kind: 'insult', actor: 1 });
  });

  it('a sour chat only ends in an insult from a real hothead', () => {
    const sour = input({ sentiment: -0.35 });
    expect(decideTemplateBeats(sour, always)).toEqual([]);
    const hot = person({ personality: personality({ aggression: 85 }) });
    expect(decideTemplateBeats({ ...sour, people: [person(), hot] }, always)).toEqual([{ kind: 'insult', actor: 1 }]);
  });

  it('a crush flirts on the flirting script, unless the listener rebuffed it', () => {
    const crush = person({ romance: 35 });
    expect(decideTemplateBeats(input({ scriptId: 'flirting', sentiment: 0.5, people: [crush, person()] }), always))
      .toEqual([{ kind: 'flirt', actor: 0 }]);
    expect(decideTemplateBeats(input({ scriptId: 'flirting', sentiment: 0.05, people: [crush, person()] }), always))
      .toEqual([]);
    // The same warm chat on another topic is no flirt.
    expect(decideTemplateBeats(input({ scriptId: 'weather_sun', sentiment: 0.5, people: [crush, person()] }), always))
      .toEqual([]);
  });

  it('nobody flirts with, or as, someone grieving, heartbroken or sick (B2)', () => {
    const crush = person({ romance: 35 });
    const flirt = (people: [BeatPerson, BeatPerson], scriptId = 'flirting') =>
      decideTemplateBeats(input({ scriptId, sentiment: 0.5, people }), always);
    // The control: the same crush on the same script does flirt.
    expect(flirt([crush, person()])).toEqual([{ kind: 'flirt', actor: 0 }]);
    for (const type of ['grieving', 'heartbroken', 'sick']) {
      const troubled = person({ states: [{ type, target: null }] });
      for (const scriptId of ['flirting', 'shy_flirt', 'sweethearts']) {
        expect(flirt([crush, troubled], scriptId), `listener ${type} / ${scriptId}`).toEqual([]);
        expect(flirt([{ ...crush, states: troubled.states }, person()], scriptId), `opener ${type} / ${scriptId}`).toEqual([]);
      }
    }
    // Other states don't stop a flirt.
    expect(flirt([crush, person({ states: [{ type: 'drunk', target: null }] })])).toEqual([{ kind: 'flirt', actor: 0 }]);
  });

  it('an honest one with a secret confides in someone they trust', () => {
    const guilty = person({ personality: personality({ honesty: 70 }), hasConfessableSin: true, trust: 60 });
    expect(decideTemplateBeats(input({ people: [person(), guilty] }), always)).toEqual([{ kind: 'confession', actor: 1 }]);
    // Not to someone they don't trust, and not a liar.
    expect(decideTemplateBeats(input({ people: [person(), { ...guilty, trust: 20 }] }), always)).toEqual([]);
    expect(decideTemplateBeats(input({
      people: [person(), { ...guilty, personality: personality({ honesty: 30 }) }],
    }), always)).toEqual([]);
  });

  it('old enemies with a warm exchange may make up; never across estrangement', () => {
    const loyal = person({ personality: personality({ loyalty: 70 }), friendship: 5 });
    const feud = input({ people: [loyal, person({ friendship: 0 })], tags: ['grudge'], status: 'acquaintances' });
    expect(decideTemplateBeats(feud, always)).toEqual([{ kind: 'reconciliation', actor: 0 }]);
    expect(decideTemplateBeats({ ...feud, tags: ['grudge', 'estranged'] }, always)).toEqual([]);
    // A known scoundrel isn't forgiven over small talk.
    expect(decideTemplateBeats({ ...feud, people: [loyal, person({ negativeFacts: 4 })] }, always)).toEqual([]);
  });
});

describe('applyTemplateBeats (writes the same rows as the LLM tier)', () => {
  const made: number[] = [];
  let a: typeof agents.$inferSelect;
  let b: typeof agents.$inferSelect;
  const NOW = 8 * 1440 + 600;

  beforeAll(() => {
    const time = { day: 8, hour: 10, minute: 0, totalTicks: NOW, seasonDay: 8, season: 'spring' };
    const existing = db.select().from(worldState).get();
    if (existing) db.update(worldState).set({ time, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    else {
      db.insert(worldState).values({
        time, day_phase: 'morning', weather: 'sunny', weather_duration: 120, tick_speed: 1,
        is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
        pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
      }).run();
    }
    const home = db.insert(locations).values({
      name: 'Beat Tavern', type: 'tavern', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 20, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    const insert = (name: string, aggression: number) => {
      const row = db.insert(agents).values({
        name, bio: 'test', traits: [], age: 30, gender: 'male',
        personality: personality({ aggression }),
        sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
        current_action: { type: 'idle' }, action_started: 0, action_queue: [],
        schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
        home, current_location: home, created_at: 0, is_active: true,
      }).returning().get();
      made.push(row.id);
      return row;
    };
    a = insert('Abe Calm', 30);
    b = insert('Bo Hothead', 90);
    db.insert(relationships).values({
      agent_a: Math.min(a.id, b.id), agent_b: Math.max(a.id, b.id),
      friendship_ab: -50, friendship_ba: -50, romance_ab: 0, romance_ba: 0, trust_ab: 0, trust_ba: 0,
      familiarity: 40, status: 'rivals', tags: [], interaction_count: 5, average_interaction_sentiment: -0.4,
      last_interaction: 0, created_at: 0, last_updated: 0,
    }).run();
  });

  afterAll(() => {
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  it('an insult in a standoff: drama row tagged insult, interaction event, relationship hit; then the pair cools off', () => {
    const beats = applyTemplateBeats([a, b], 'standoff', -0.45, NOW, () => 0);
    expect(beats.map((x) => x.kind)).toEqual(['insult', 'fight']);

    const rows = db.select().from(activityLog)
      .where(and(eq(activityLog.type, 'drama'), eq(activityLog.initiator_id, b.id)))
      .orderBy(desc(activityLog.id)).all();
    expect(rows.map((r) => (r.metadata as { beat?: string } | null)?.beat).sort()).toEqual(['fight', 'insult']);
    expect(rows.every((r) => r.target_id === a.id)).toBe(true);

    const events = db.select().from(relationshipEvents)
      .where(and(eq(relationshipEvents.agent_a, Math.min(a.id, b.id)), eq(relationshipEvents.agent_b, Math.max(a.id, b.id))))
      .all().map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(['insult', 'fight']));

    // Same pair again within the cooldown: nothing, whatever the dice say.
    expect(applyTemplateBeats([a, b], 'standoff', -0.45, NOW + 30, () => 0)).toEqual([]);
  });
});
