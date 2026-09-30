import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed (test: LLM disabled)'); });

import { db } from '../../../db';
import { agents, agentStates, goals, locations, relationships, shared_knowledge, worldState } from '../../../db/schema';
import { goalsTick, initGoalProgressListenersForTest } from '../goals';
import { simEvents } from '../../../lib/simEvents';
import { GOAL_OUTCOME_GAINS } from '../../../lib/goals/goalProgress';
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

/**
 * Observer triggers (`trigger_on: 'observers'`): the goal belongs to someone WATCHING a state and
 * is aimed at the one who has it. A warm friend (or the spouse) of a grieving resident sets out to
 * comfort them; a friend of someone properly ill sets out to look after them. Strangers do not,
 * the sufferer never gets a goal about themselves, and no more than three people take on the same
 * sufferer with the same goal (a whole town queueing at one sickbed reads as a script, not a town).
 */
describe('observer triggers: friends visit the sick and comfort the grieving', () => {
  const madeHere: number[] = [];
  const person = (name: string): number => { const id = insertAgent(name); madeHere.push(id); return id; };

  const addFullState = (agentId: number, type: string, severity: number, metadata: Record<string, unknown> | null = null) =>
    db.insert(agentStates).values({
      agent_id: agentId, type, severity, started_at: 7200, duration: 5000, source: 'test',
      target_agent_id: null, metadata,
    }).run();

  /** `watcher` feels `friendship` toward `other` (the other way round is left cold). */
  const tie = (watcher: number, other: number, friendship: number, tags: string[] = []) => db.insert(relationships).values({
    agent_a: Math.min(watcher, other), agent_b: Math.max(watcher, other),
    friendship_ab: watcher < other ? friendship : 0, friendship_ba: watcher < other ? 0 : friendship,
    romance_ab: 0, romance_ba: 0, trust_ab: 50, trust_ba: 50, familiarity: 50, interaction_count: 5,
    last_interaction: 0, average_interaction_sentiment: 0, tags, status: 'acquaintances', created_at: 0, last_updated: 0,
  }).run();

  const goalsOf = (agentId: number) => db.select().from(goals).where(eq(goals.agent_id, agentId)).all();
  const aimedAt = (type: string, target: number) => db.select().from(goals)
    .where(and(eq(goals.type, type), eq(goals.target_id, target), eq(goals.status, 'active'))).all();

  afterAll(() => {
    db.delete(goals).where(inArray(goals.agent_id, madeHere)).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, madeHere)).run();
    db.delete(relationships).where(inArray(relationships.agent_a, madeHere)).run();
  });

  it('a warm friend of a mourner sets out to comfort them; the mourner gets nothing about themselves', () => {
    const mourner = person('Mourner Mia');
    const friend = person('Friend Fran');
    addFullState(mourner, 'grieving', 0.5);
    tie(friend, mourner, 60);

    goalsTick();

    expect(goalsOf(friend).map((g) => [g.type, g.target_id, g.status])).toEqual([['comfort_grieving', mourner, 'active']]);
    expect(goalsOf(mourner)).toEqual([]);
  });

  it('a stranger does nothing; the line is friendship 40, or being married to them', () => {
    const mourner = person('Mourner Moe');
    const stranger = person('Stranger Stu');
    const acquaintance = person('Acquaintance Ana');
    const friend = person('Friend Fil');
    const spouse = person('Spouse Sue');
    addFullState(mourner, 'grieving', 0.5);
    tie(stranger, mourner, 5);
    tie(acquaintance, mourner, 39);
    tie(friend, mourner, 40);
    tie(spouse, mourner, 10, ['married']);

    goalsTick();

    expect(goalsOf(stranger)).toEqual([]);
    expect(goalsOf(acquaintance)).toEqual([]);
    expect(goalsOf(friend).map((g) => g.target_id)).toEqual([mourner]);
    expect(goalsOf(spouse).map((g) => g.target_id)).toEqual([mourner]);
  });

  it("feeling is the watcher's: a mourner who adores someone who barely knows them earns no visit", () => {
    const mourner = person('Mourner Mac');
    const aloof = person('Aloof Al');
    addFullState(mourner, 'grieving', 0.5);
    tie(mourner, aloof, 90); // the mourner's warmth toward Al; Al's toward the mourner stays 0

    goalsTick();

    expect(goalsOf(aloof)).toEqual([]);
  });

  it('caps the goals of one type aimed at one sufferer at three, however many warm friends there are, and never doubles up across ticks', () => {
    const mourner = person('Mourner Mo');
    const friends = ['A', 'B', 'C', 'D', 'E'].map((x) => person(`Friend Cap ${x}`));
    addFullState(mourner, 'grieving', 0.5);
    for (const f of friends) tie(f, mourner, 60);

    goalsTick();
    expect(aimedAt('comfort_grieving', mourner)).toHaveLength(3);

    goalsTick();
    goalsTick();
    const active = aimedAt('comfort_grieving', mourner);
    expect(active).toHaveLength(3);
    expect(new Set(active.map((g) => g.agent_id)).size).toBe(3);
    // The two left out have nothing at all: not a queued goal, not a finished one.
    expect(friends.filter((f) => goalsOf(f).length === 0)).toHaveLength(2);
  });

  it('running the evaluation twice gives a friend one goal, not two', () => {
    const mourner = person('Mourner Mei');
    const friend = person('Friend Fay');
    addFullState(mourner, 'grieving', 0.5);
    tie(friend, mourner, 70);

    goalsTick();
    goalsTick();

    expect(goalsOf(friend)).toHaveLength(1);
  });

  it('a mild illness (severity 0.3) starts nothing; a serious one (0.7) sends a friend to look after them', () => {
    const mild = person('Mild Milo');
    const grave = person('Grave Gil');
    const mildFriend = person('Friend Mild');
    const graveFriend = person('Friend Grave');
    addFullState(mild, 'sick', 0.3);
    addFullState(grave, 'sick', 0.7);
    tie(mildFriend, mild, 80);
    tie(graveFriend, grave, 80);

    goalsTick();

    expect(goalsOf(mildFriend)).toEqual([]);
    expect(goalsOf(graveFriend).map((g) => [g.type, g.target_id])).toEqual([['protect', grave]]);
    expect(goalsOf(grave)).toEqual([]);
  });

  it('a grave-illness flag in the state metadata counts even at low severity', () => {
    const patient = person('Patient Pat');
    const friend = person('Friend Pia');
    addFullState(patient, 'sick', 0.3, { grave: true });
    tie(friend, patient, 80);

    goalsTick();

    expect(goalsOf(friend).map((g) => [g.type, g.target_id])).toEqual([['protect', patient]]);
  });

  it('with two people in need it is the closer one that gets the visit', () => {
    const near = person('Near Nell');
    const far = person('Far Fitz');
    const friend = person('Friend Fox');
    addFullState(near, 'grieving', 0.5);
    addFullState(far, 'grieving', 0.5);
    // The far one is the warmer tie, so only distance can pick the near one.
    tie(friend, near, 50);
    tie(friend, far, 90);
    db.update(agents).set({ position: { x: 3, y: 0 } }).where(eq(agents.id, near)).run();
    db.update(agents).set({ position: { x: 30, y: 0 } }).where(eq(agents.id, far)).run();

    goalsTick();

    expect(goalsOf(friend).map((g) => g.target_id)).toEqual([near]);
  });

  it('the goal is not thrown out on the spot for the OWNER not grieving, and ends when the mourner recovers', () => {
    const mourner = person('Mourner Mae');
    const helper = person('Helper Hana');
    const idler = person('Idler Ivo');
    addFullState(mourner, 'grieving', 0.5);
    tie(helper, mourner, 70);
    tie(idler, mourner, 70);

    goalsTick();
    goalsTick();
    const [helperGoal] = goalsOf(helper);
    const [idlerGoal] = goalsOf(idler);
    expect([helperGoal.status, idlerGoal.status]).toEqual(['active', 'active']);

    // The helper has been there for them; the idler never went. The grief lifts.
    db.update(goals).set({ progress: 0.4 }).where(eq(goals.id, helperGoal.id)).run();
    db.delete(agentStates).where(eq(agentStates.agent_id, mourner)).run();
    goalsTick();

    expect(goalsOf(helper)[0].status).toBe('completed');
    expect(goalsOf(idler)[0].status).toBe('abandoned');
  });

  it('a kind word to a sick partner is comfort: it advances protect (conversation:ended, partnerState "sick")', () => {
    initGoalProgressListenersForTest();
    const patient = person('Patient Pam');
    const friend = person('Friend Pol');
    const goalId = db.insert(goals).values({
      agent_id: friend, type: 'protect', target_id: patient, motivation: 'test', priority: 0.5,
      progress: 0, status: 'active', created_at: 7200,
    }).returning({ id: goals.id }).get().id;

    simEvents.emit('conversation:ended', { agentId: friend, perpetratorId: patient, sentiment: 0.4, partnerState: 'sick' });

    const row = db.select().from(goals).where(eq(goals.id, goalId)).get()!;
    expect(row.progress).toBeCloseTo(GOAL_OUTCOME_GAINS.protect.comforted!, 5);
  });
});
