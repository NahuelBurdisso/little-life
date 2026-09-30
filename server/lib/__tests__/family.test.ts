import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  activityLog, agentStates, agents, children, conversationQueue, economy, locations, memories, needs, relationshipEvents, relationships,
  shared_knowledge, simSnapshots, worldEvents, worldState,
} from '../../db/schema';
import {
  ANNOUNCE_AFTER_MINUTES, CHRISTENING_DELAY_MINUTES, MARRIED_MIN_DAYS, MAX_CHILDREN, MIN_DAYS_BETWEEN_BABIES,
  PATERNITY_QUEUE_PRIORITY, PREGNANCY_MINUTES, SPOUSE_TOLD_AFTER_MINUTES, canConceive, estrangementChance,
  familyDaily, familyTick, isChristeningHour, onParentGone, pickChildName, type ConceptionGate,
} from '../family';
import {
  BABY_DAYS, TODDLER_DAYS, childStage, clearFamilyState, describeChild, familyPlanLine, familyPromptLine,
  familySnapshotStore, marriedSinceOf, newbornOf, pendingChristenings, pendingConfrontations, pregnancyOf,
  christeningTriggeredBy, parseChristeningTrigger, parentsOfChild,
} from '../familyState';
import { heirsOf } from '../heirs';
import { getPairDossier } from '../pairDossier';
import { buildAgentSystemPrompt, topicIntent, congratsTopic, PATERNITY_TOPIC } from '../../ai/prompts';
import { buildDailyPlanPrompt } from '../planning/planPrompts';
import { gameMinutes } from '../gameClock';
import { CONFIG } from '../constants';
import { MARRIED_AFFAIR_SENSITIVITY } from '../marriage';
import { clearPerWorldCaches, persistedStoreKeys, restoreWorldCaches, saveWorldCaches } from '../../engine/worldCaches';
import { CHALLENGE_KINDS, type TownSnapshot } from '../challenges/catalog';
import { beginChallenge, evaluateChallenge } from '../challenges/evaluate';
import { candidateOffers } from '../challenges/suggest';

/**
 * Married life and children (lib/family.ts): conception gates, the pregnancy's
 * timeline (the husband told, the town told, the birth), the christening, the
 * paternity secret and its reveal, heirs with children, the prompt lines and
 * the checkpoint.
 */

const DAY = 24 * 60;
const always = () => 0;
const never = () => 0.999;

// ─── Pure rules ──────────────────────────────────────────────────────────────

describe('conception gates', () => {
  const ok: ConceptionGate = {
    marriedMinutes: MARRIED_MIN_DAYS * DAY, motherAge: 28, fatherAge: 30, romance: 80,
    expecting: false, childCount: 0, youngestAgeDays: null, notNow: false,
  };

  it('opens for a couple married long enough, in love, of age', () => {
    expect(canConceive(ok)).toBe(true);
  });

  it('stays shut for newlyweds, a cooled marriage, the too young or too old', () => {
    expect(canConceive({ ...ok, marriedMinutes: null })).toBe(false);
    expect(canConceive({ ...ok, marriedMinutes: MARRIED_MIN_DAYS * DAY - 1 })).toBe(false);
    expect(canConceive({ ...ok, romance: 40 })).toBe(false);
    expect(canConceive({ ...ok, motherAge: 17 })).toBe(false);
    expect(canConceive({ ...ok, motherAge: 50 })).toBe(false);
    expect(canConceive({ ...ok, fatherAge: 16 })).toBe(false);
  });

  it('never while expecting, in a bad state, at the family cap or right after a baby', () => {
    expect(canConceive({ ...ok, expecting: true })).toBe(false);
    expect(canConceive({ ...ok, notNow: true })).toBe(false);
    expect(canConceive({ ...ok, childCount: MAX_CHILDREN })).toBe(false);
    expect(canConceive({ ...ok, childCount: 1, youngestAgeDays: MIN_DAYS_BETWEEN_BABIES - 1 })).toBe(false);
    expect(canConceive({ ...ok, childCount: 1, youngestAgeDays: MIN_DAYS_BETWEEN_BABIES })).toBe(true);
  });
});

describe('small rules', () => {
  it('christenings start in the daytime only', () => {
    expect(isChristeningHour(3)).toBe(false);
    expect(isChristeningHour(10)).toBe(true);
    expect(isChristeningHour(15)).toBe(true);
    expect(isChristeningHour(16)).toBe(false);
  });

  it('names a baby with a period name nobody in town has', () => {
    const first = pickChildName('female', new Set(), always);
    expect(first).toBe('Ada');
    expect(pickChildName('female', new Set(['Ada']), always)).toBe('Agnes');
    expect(pickChildName('male', new Set(), always)).toBe('Abel');
  });

  it('a hot temper makes estrangement likelier, a warm heart less', () => {
    const base = estrangementChance({ aggression: 50, warmth: 50 });
    expect(estrangementChance({ aggression: 90, warmth: 50 })).toBeGreaterThan(base);
    expect(estrangementChance({ aggression: 50, warmth: 90 })).toBeLessThan(base);
    expect(estrangementChance(null)).toBe(base);
    expect(estrangementChance({ aggression: 100, warmth: 0 })).toBeLessThanOrEqual(0.75);
  });

  it('ages a child from baby to toddler to child', () => {
    expect(childStage(0)).toBe('baby');
    expect(childStage(BABY_DAYS)).toBe('toddler');
    expect(childStage(TODDLER_DAYS)).toBe('child');
    expect(describeChild({ name: 'Ana', sex: 'female', birth_game_minute: 0 }, 2 * DAY)).toBe('baby daughter Ana (2 days old)');
    expect(describeChild({ name: 'Tom', sex: 'male', birth_game_minute: 0 }, 60)).toBe('baby son Tom (newborn)');
  });

  it('round-trips the christening trigger', () => {
    expect(parseChristeningTrigger(christeningTriggeredBy(42))).toBe(42);
    expect(parseChristeningTrigger('wedding:1-2')).toBeNull();
    expect(parseChristeningTrigger(null)).toBeNull();
  });

  it('writes an intent for the congratulations and the confrontation', () => {
    expect(topicIntent(congratsTopic('Ana'), 'Rosa')).toMatch(/little Ana\. Congratulate them/);
    expect(topicIntent(PATERNITY_TOPIC, 'Tom')).toMatch(/may be Tom's, not yours/);
  });
});

// ─── Against the DB ──────────────────────────────────────────────────────────

const TIME = { day: 40, hour: 12, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);

let homeId: number;
let otherHomeId: number;
let squareId: number;
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

function insertLocation(name: string, type: string): number {
  return db.insert(locations).values({
    name, type, position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
    capacity: 20, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female',
    personality: {
      honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  db.insert(needs).values({
    agent_id: id, hunger: 70, energy: 70, social: 60, comfort: 60, fun: 60, mood: 50, stress: 20,
    decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES }, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
    mood_modifiers: [], last_updated: 0,
  }).run();
  return id;
}

function relate(a: number, b: number, over: Partial<typeof relationships.$inferInsert> = {}): number {
  return db.insert(relationships).values({
    agent_a: Math.min(a, b), agent_b: Math.max(a, b),
    friendship_ab: 70, friendship_ba: 70, romance_ab: 85, romance_ba: 85,
    trust_ab: 60, trust_ba: 60, familiarity: 80, interaction_count: 40,
    last_interaction: 0, last_interaction_minute: NOW, average_interaction_sentiment: 0.5,
    tags: ['partner', 'married'], status: 'partners', status_since_minute: NOW - 20 * DAY,
    created_at: 0, last_updated: 0, ...over,
  }).returning({ id: relationships.id }).get().id;
}

/** A married couple whose marriage clock has already run MARRIED_MIN_DAYS. */
function marriedCouple(over: { wife?: Partial<typeof agents.$inferInsert>; husband?: Partial<typeof agents.$inferInsert> } = {}) {
  const wife = insertAgent(`Wife ${made.length}`, over.wife);
  const husband = insertAgent(`Husband ${made.length}`, { gender: 'male', ...over.husband });
  const relId = relate(wife, husband);
  familyTick(TIME, NOW - MARRIED_MIN_DAYS * DAY); // starts the clock
  return { wife, husband, relId };
}

const child = (motherId: number) => db.select().from(children).where(eq(children.mother_id, motherId)).get();
const fact = (id: number) => db.select().from(shared_knowledge).where(eq(shared_knowledge.id, id)).get()!;
const feedOf = (type: string, id: number) => db.select().from(activityLog).where(eq(activityLog.type, type)).all()
  .filter((r) => (r.agent_ids as number[]).includes(id));
const beatRows = (beat: string, id: number) => feedOf('drama', id)
  .filter((r) => (r.metadata as { beat?: string } | null)?.beat === beat);
const tick = (at: number, hour = 12) => familyTick({ ...TIME, hour }, at, always);

describe('family against the DB', () => {
  beforeAll(() => {
    setClock();
    homeId = insertLocation('Family Cottage', 'home');
    otherHomeId = insertLocation('Friend Cottage', 'home');
    squareId = insertLocation('Family Square', 'town_square');
  });

  beforeEach(() => {
    clearFamilyState();
    db.delete(children).run();
    db.update(worldEvents).set({ is_active: false }).where(eq(worldEvents.type, 'christening')).run();
    db.update(relationships).set({ tags: [] }).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
  });

  afterAll(() => {
    db.delete(children).run();
    db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, 'paternity')).run();
    db.delete(worldEvents).where(eq(worldEvents.type, 'christening')).run();
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, made), inArray(shared_knowledge.target_id, made))).run();
    db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, made), inArray(relationshipEvents.agent_b, made))).run();
    db.delete(activityLog).where(inArray(activityLog.type, ['drama', 'expecting', 'christening', 'moved_in'])).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
    db.delete(needs).where(inArray(needs.agent_id, made)).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, made)).run();
    db.delete(memories).where(inArray(memories.agent_id, made)).run();
    db.delete(economy).where(inArray(economy.agent_id, made)).run();
    db.delete(agents).where(inArray(agents.id, made)).run();
    db.delete(locations).where(inArray(locations.id, [homeId, otherHomeId, squareId])).run();
    clearFamilyState();
  });

  describe('pregnancy gates', () => {
    it('starts the marriage clock the first time it meets a married couple', () => {
      const wife = insertAgent('Clocked Wife');
      const husband = insertAgent('Clocked Husband', { gender: 'male' });
      relate(wife, husband);
      tick(NOW);
      expect(marriedSinceOf(wife, husband)).toBe(NOW);
      // Newlyweds: the roll never happens before MARRIED_MIN_DAYS.
      familyDaily(NOW + DAY, always);
      expect(pregnancyOf(wife)).toBeUndefined();
    });

    it('conceives on a lucky day once married long enough, never on an unlucky one', () => {
      const { wife, husband } = marriedCouple();
      familyDaily(NOW, never);
      expect(pregnancyOf(wife)).toBeUndefined();
      familyDaily(NOW, always);
      expect(pregnancyOf(wife)).toMatchObject({ motherId: wife, fatherId: husband, conceivedAt: NOW });
      // A private secret only she knows.
      const f = fact(pregnancyOf(wife)!.factId!);
      expect(f.type).toBe('pregnancy');
      expect(f.known_by).toEqual([wife]);
      expect(f.sensitivity).toBeGreaterThanOrEqual(2);
      // Not twice.
      familyDaily(NOW + DAY, always);
      expect(pregnancyOf(wife)!.conceivedAt).toBe(NOW);
    });

    it('needs a mother and a father of plausible age, still in love', () => {
      const old = marriedCouple({ wife: { age: 52 } });
      const cold = marriedCouple();
      db.update(relationships).set({ romance_ab: 30 })
        .where(and(eq(relationships.agent_a, Math.min(cold.wife, cold.husband)), eq(relationships.agent_b, Math.max(cold.wife, cold.husband)))).run();
      const two = insertAgent('Wife A');
      const three = insertAgent('Wife B');
      relate(two, three);
      tick(NOW - MARRIED_MIN_DAYS * DAY);
      familyDaily(NOW, always);
      expect(pregnancyOf(old.wife)).toBeUndefined();
      expect(pregnancyOf(cold.wife)).toBeUndefined();
      expect(pregnancyOf(two)).toBeUndefined();
      expect(pregnancyOf(three)).toBeUndefined();
    });
  });

  describe('the pregnancy and the birth', () => {
    it('tells the husband after a day, the town after two, and gives birth after seven', () => {
      const { wife, husband } = marriedCouple();
      const friend = insertAgent('Close Friend', { home: otherHomeId });
      relate(wife, friend, { tags: [], status: 'close_friends', romance_ab: 0, romance_ba: 0, friendship_ab: 80, friendship_ba: 80 });
      familyDaily(NOW, always);
      const factId = pregnancyOf(wife)!.factId!;

      tick(NOW + SPOUSE_TOLD_AFTER_MINUTES - 10);
      expect(fact(factId).known_by).toEqual([wife]);
      tick(NOW + SPOUSE_TOLD_AFTER_MINUTES);
      expect(fact(factId).known_by).toContain(husband);
      expect(pregnancyOf(wife)!.spouseTold).toBe(true);
      expect(familyPromptLine(husband, NOW + DAY)).toMatch(/is expecting your baby/);

      tick(NOW + ANNOUNCE_AFTER_MINUTES);
      const announced = fact(factId);
      expect(announced.sensitivity).toBe(1);
      expect(announced.is_public).toBe(true);
      expect(announced.known_by).toContain(friend);
      expect(feedOf('expecting', wife)).toHaveLength(1);

      tick(NOW + PREGNANCY_MINUTES - 10);
      expect(child(wife)).toBeUndefined();
      tick(NOW + PREGNANCY_MINUTES);
      const baby = child(wife)!;
      expect(baby).toMatchObject({ mother_id: wife, father_id: husband, true_father_id: null, home: homeId, alive: true, sex: 'female' });
      expect(baby.birth_game_minute).toBe(NOW + PREGNANCY_MINUTES);
      expect(pregnancyOf(wife)).toBeUndefined();
      expect(fact(factId).is_active).toBe(false);
      expect(beatRows('birth', wife)).toHaveLength(1);
      expect(beatRows('birth', wife)[0].template_data).toMatchObject({ description: expect.stringContaining(`welcomed a baby daughter, ${baby.name}`) });
      // Joy and a mood lift for both parents.
      expect(db.select().from(needs).where(eq(needs.agent_id, husband)).get()!.mood_modifiers.some((m) => m.source === 'new_baby')).toBe(true);
      // Friends want to congratulate.
      expect(newbornOf(wife, NOW + PREGNANCY_MINUTES + 60)?.id).toBe(baby.id);
    });

    it('holds the christening a day later, in daylight, on the square', () => {
      const { wife, husband } = marriedCouple();
      familyDaily(NOW, always);
      const born = NOW + PREGNANCY_MINUTES;
      tick(born);
      const baby = child(wife)!;
      expect(pendingChristenings()).toEqual([{ childId: baby.id, dueAt: born + CHRISTENING_DELAY_MINUTES }]);

      tick(born + 60);
      expect(db.select().from(worldEvents).where(eq(worldEvents.triggered_by, christeningTriggeredBy(baby.id))).get()).toBeUndefined();
      tick(born + CHRISTENING_DELAY_MINUTES, 3); // due, but the middle of the night
      expect(db.select().from(worldEvents).where(eq(worldEvents.triggered_by, christeningTriggeredBy(baby.id))).get()).toBeUndefined();
      tick(born + CHRISTENING_DELAY_MINUTES + 60, 11);
      const ev = db.select().from(worldEvents).where(eq(worldEvents.triggered_by, christeningTriggeredBy(baby.id))).get()!;
      expect(ev).toMatchObject({ type: 'christening', location_id: squareId, is_active: true });
      expect(parentsOfChild(baby.id)).toEqual([wife, husband]);
      expect(pendingChristenings()).toEqual([]);
      expect(feedOf('christening', wife)).toHaveLength(1);
    });

    it('costs new parents sleep each morning of the first days', () => {
      const { wife } = marriedCouple();
      familyDaily(NOW, always);
      tick(NOW + PREGNANCY_MINUTES);
      db.update(needs).set({ energy: 70 }).where(eq(needs.agent_id, wife)).run();
      familyDaily(NOW + PREGNANCY_MINUTES + DAY, never);
      expect(db.select().from(needs).where(eq(needs.agent_id, wife)).get()!.energy).toBeLessThan(70);
    });
  });

  describe('paternity', () => {
    function withLover() {
      const { wife, husband, relId } = marriedCouple();
      const lover = insertAgent('The Lover', { gender: 'male' });
      db.insert(shared_knowledge).values({
        type: 'affair', subject_id: wife, target_id: lover, content: 'test', sensitivity: 4,
        known_by: [lover], created_at: 0, is_active: true, source: 'observed',
      }).run();
      familyDaily(NOW, always);
      return { wife, husband, lover, relId };
    }

    it('makes the lover the true father and keeps it a sensitivity-4 secret only she knows', () => {
      const { wife, husband, lover } = withLover();
      const p = pregnancyOf(wife)!;
      expect(p.trueFatherId).toBe(lover);
      const f = fact(p.paternityFactId!);
      expect(f).toMatchObject({ type: 'paternity', subject_id: wife, target_id: lover, sensitivity: MARRIED_AFFAIR_SENSITIVITY });
      expect(f.known_by).toEqual([wife]);
      expect(f.content).toContain(`, not Husband`);
      expect(familyPromptLine(wife, NOW)).toContain("you fear it is The's, not Husband's");
      // The child carries it once born.
      tick(NOW + PREGNANCY_MINUTES);
      expect(child(wife)).toMatchObject({ father_id: husband, true_father_id: lover, paternity_revealed: false, paternity_fact_id: p.paternityFactId });
    });

    it('plays the reveal when the husband learns it: fury, a confrontation, maybe estrangement', () => {
      const { wife, husband, lover, relId } = withLover();
      tick(NOW + PREGNANCY_MINUTES);
      const baby = child(wife)!;
      db.update(shared_knowledge).set({ known_by: [wife, husband] }).where(eq(shared_knowledge.id, baby.paternity_fact_id!)).run();
      // The lover is across town when the husband finds out.
      db.update(agents).set({ current_location: squareId, position: { x: 900, y: 0 } }).where(eq(agents.id, lover)).run();

      tick(NOW + PREGNANCY_MINUTES + 10); // `always` rolls estrangement
      expect(child(wife)!.paternity_revealed).toBe(true);
      expect(beatRows('paternity', husband)).toHaveLength(1);
      expect(db.select().from(relationshipEvents).where(and(eq(relationshipEvents.agent_a, husband), eq(relationshipEvents.agent_b, lover))).all()).toHaveLength(1);
      const rel = db.select().from(relationships).where(eq(relationships.id, relId)).get()!;
      expect(rel.tags).toContain('estranged');
      expect(rel.tags).not.toContain('married');
      expect(rel.status).toBe('estranged');
      expect(pendingConfrontations()).toEqual([{ fatherId: husband, loverId: lover, since: NOW + PREGNANCY_MINUTES + 10 }]);

      // Apart: nothing queued. Together: the husband opens the confrontation.
      tick(NOW + PREGNANCY_MINUTES + 20);
      const queued = () => db.select().from(conversationQueue).where(eq(conversationQueue.trigger_reason, 'paternity')).all();
      expect(queued()).toHaveLength(0);
      db.update(agents).set({ current_location: homeId }).where(eq(agents.id, lover)).run();
      tick(NOW + PREGNANCY_MINUTES + 30);
      expect(queued()).toHaveLength(1);
      expect(queued()[0]).toMatchObject({ participants: [husband, lover], topic: PATERNITY_TOPIC, priority: PATERNITY_QUEUE_PRIORITY });
      expect(pendingConfrontations()).toEqual([]);

      // Played once.
      tick(NOW + PREGNANCY_MINUTES + 40);
      expect(beatRows('paternity', husband)).toHaveLength(1);
    });

    it('also plays when the secret becomes common knowledge, and a gentle husband may stay', () => {
      const { wife, husband, relId } = withLover();
      db.update(agents).set({ personality: {
        honesty: 50, aggression: 0, warmth: 100, impulsiveness: 50, vanity: 40,
        curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
      } }).where(eq(agents.id, husband)).run();
      const p = pregnancyOf(wife)!;
      db.update(shared_knowledge).set({ is_public: true }).where(eq(shared_knowledge.id, p.paternityFactId!)).run();
      familyTick(TIME, NOW + 10, () => 0.5); // above his estrangement chance
      expect(pregnancyOf(wife)!.paternityRevealed).toBe(true);
      expect(beatRows('paternity', husband)).toHaveLength(1);
      expect(db.select().from(relationships).where(eq(relationships.id, relId)).get()!.tags).toContain('married');
    });
  });

  describe('heirs and guardians', () => {
    it('lists the spouse first, then the child held in trust by a guardian', () => {
      const { wife, husband } = marriedCouple();
      // Its own house: the other test residents share the cottage, and a
      // housemate would be the guardian before any friend.
      const nursery = insertLocation('Nursery House', 'home');
      const baby = db.insert(children).values({
        name: 'Ada', sex: 'female', birth_game_minute: NOW, mother_id: wife, father_id: husband, home: nursery,
      }).returning().get();
      expect(heirsOf(husband)[0]).toEqual({ agentId: wife, kind: 'spouse' });
      // The widow is also the child's guardian: not listed twice.
      expect(heirsOf(husband).filter((h) => h.agentId === wife)).toHaveLength(1);

      // Both gone but a friend: the friend holds the estate in trust and takes the child in.
      const friend = insertAgent('Godmother', { home: otherHomeId });
      relate(husband, friend, { tags: [], status: 'close_friends', romance_ab: 0, romance_ba: 0, friendship_ab: 80, friendship_ba: 80 });
      db.update(agents).set({ is_active: false }).where(inArray(agents.id, [wife])).run();
      db.update(agents).set({ home: otherHomeId }).where(eq(agents.id, wife)).run();
      const heirs = heirsOf(husband);
      expect(heirs[0]).toEqual({ agentId: friend, kind: 'child', child: { id: baby.id, name: 'Ada', sex: 'female' } });

      db.update(agents).set({ is_active: false }).where(eq(agents.id, husband)).run();
      onParentGone(husband, 'death');
      expect(db.select().from(children).where(eq(children.id, baby.id)).get()!.home).toBe(otherHomeId);
      expect(feedOf('moved_in', friend)).toHaveLength(1);
      db.delete(children).run();
      db.delete(locations).where(eq(locations.id, nursery)).run();
    });

    it('shows the children a pair shares in their dossier', () => {
      const { wife, husband } = marriedCouple();
      db.insert(children).values({
        name: 'Ada', sex: 'female', birth_game_minute: NOW - DAY, mother_id: wife, father_id: husband, home: homeId,
      }).run();
      expect(getPairDossier(wife, husband)!.children).toEqual([
        expect.objectContaining({ name: 'Ada', sex: 'female', ageDays: 1, rumoured: false }),
      ]);
      const stranger = insertAgent('Stranger', { gender: 'male' });
      expect(getPairDossier(wife, stranger)!.children).toEqual([]);
    });

    it('a child whose last parent leaves town goes with them', () => {
      const wife = insertAgent('Widow');
      const baby = db.insert(children).values({
        name: 'Abel', sex: 'male', birth_game_minute: NOW, mother_id: wife, father_id: null, home: homeId,
      }).returning().get();
      db.update(agents).set({ is_active: false }).where(eq(agents.id, wife)).run();
      onParentGone(wife, 'left');
      expect(db.select().from(children).where(eq(children.id, baby.id)).get()!.home).toBeNull();
    });
  });

  describe('prompt lines', () => {
    it('names the children in one short line, in the dialogue and the plan prompts', () => {
      const { wife, husband } = marriedCouple();
      db.insert(children).values({
        name: 'Ada', sex: 'female', birth_game_minute: NOW - 2 * DAY, mother_id: wife, father_id: husband, home: homeId,
      }).run();
      const line = familyPromptLine(husband, NOW);
      expect(line).toBe('Your family: your baby daughter Ada (2 days old).');
      expect(line.split('\n')).toHaveLength(1);
      expect(familyPlanLine(husband, NOW)).toMatch(/^Family: baby daughter Ada \(2 days old\) — set aside a little time at home for the baby\.$/);

      const agent = db.select().from(agents).where(eq(agents.id, husband)).get()! as never;
      const n = { hunger: 70, energy: 70, social: 60, mood: 50 } as never;
      const system = buildAgentSystemPrompt(agent, n, { money: 50, job_title: 'Baker' } as never, null, [], {
        reputationLabel: 'neutral', reputationScore: 0, hobbies: [], moodMomentum: 0, drinkCount: 0, family: line,
      });
      expect(system).toContain(line);

      const plan = buildDailyPlanPrompt({
        name: 'H', age: 30, traits: [], personality: { honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50, curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50 },
        needs: { hunger: 70, energy: 70, social: 60, mood: 50, stress: 20 }, home: 'Home', workplace: null,
        workStart: 9, workEnd: 17, wakeTime: 6, sleepTime: 22, goals: [], reflections: [], yesterdayPlan: null,
        dayNumber: 1, validLocations: ['Home'], family: familyPlanLine(husband, NOW),
      });
      expect(plan.system).toContain('set aside a little time at home for the baby');
      // Nobody else gets a line.
      expect(familyPromptLine(insertAgent('Single'), NOW)).toBe('');
    });
  });

  describe('persistence', () => {
    it('is a registered snapshot store, cleared on a world replace and restored after a restart', () => {
      expect(persistedStoreKeys()).toContain('family');
      db.delete(simSnapshots).run();
      familySnapshotStore.restore({
        pregnancies: { 7: { fatherId: 8, conceivedAt: 100, factId: 3, spouseTold: true, trueFatherId: 9, paternityFactId: 4 } },
        marriedSince: { '7-8': 50 },
        christenings: { 12: 999 },
        confrontations: [{ fatherId: 8, loverId: 9, since: 77 }],
      });
      const before = familySnapshotStore.serialize();
      saveWorldCaches();
      clearPerWorldCaches();
      expect(pregnancyOf(7)).toBeUndefined();
      restoreWorldCaches();
      expect(familySnapshotStore.serialize()).toEqual(before);
      // A checkpoint from before unwed pregnancies existed restores as a married one.
      expect(pregnancyOf(7)).toEqual({ motherId: 7, fatherId: 8, unwed: false, conceivedAt: 100, factId: 3, spouseTold: true, trueFatherId: 9, paternityFactId: 4 });
    });

    it('restore skips malformed entries', () => {
      familySnapshotStore.restore({
        pregnancies: { x: { fatherId: 1, conceivedAt: 2 }, 5: { fatherId: 'a', conceivedAt: 2 }, 6: { fatherId: 1, conceivedAt: 2 } },
        marriedSince: { junk: 1, '1-2': 'soon', '3-4': 9 },
        christenings: { 1: 'x', 2: 5 },
        confrontations: [{ fatherId: 1 }, 'x'],
      });
      expect(familySnapshotStore.serialize()).toEqual({
        pregnancies: { 6: { motherId: 6, fatherId: 1, unwed: false, conceivedAt: 2 } },
        marriedSince: { '3-4': 9 },
        christenings: { 2: 5 },
        confrontations: [],
      });
      clearFamilyState();
    });
  });
});

// ─── The "First baby" challenge ──────────────────────────────────────────────

describe('first baby challenge', () => {
  const snap = (over: Partial<TownSnapshot> = {}): TownSnapshot => ({
    nowMinute: 1000, day: 1, season: 'spring', seasonEndMinute: 10_000, nextSeasonEndMinute: 20_000,
    agents: [
      { id: 1, name: 'Ada Finch', age: 30, active: true, dead: false, social: 50 },
      { id: 2, name: 'Tom Finch', age: 31, active: true, dead: false, social: 50 },
    ],
    pairs: [{ a: 1, b: 2, friendship: 60, romanceMax: 90, romanceMin: 85, status: 'partners', tags: ['married'] }],
    publicSecretIds: [], hiddenSecretCount: 0, lastPlayerActionId: 0, handsOnCount: 0, deathEnabled: true,
    children: [{ id: 5, name: 'Older', motherId: 1, fatherId: 2 }],
    ...over,
  });

  it('is in the catalog and offered once a couple is married', () => {
    expect(CHALLENGE_KINDS.first_baby.icon).toBeTruthy();
    expect(candidateOffers(snap(), () => 0).some((o) => o.kind === 'first_baby')).toBe(true);
    expect(candidateOffers(snap({ pairs: [] }), () => 0).some((o) => o.kind === 'first_baby')).toBe(false);
  });

  it('completes on a child born after it began, not on one already there', () => {
    const offer = { id: 'c1', kind: 'first_baby' as const, difficulty: 'hard' as const, goal: 'x', agentIds: [], durationDays: 16, status: 'offered' as const, offeredAt: 0 };
    const started = beginChallenge(offer, snap());
    expect(started.baseline?.childIds).toEqual([5]);
    expect(evaluateChallenge(started, snap()).status).toBe('active');
    const done = evaluateChallenge(started, snap({ children: [{ id: 5, name: 'Older', motherId: 1, fatherId: 2 }, { id: 6, name: 'Mae', motherId: 1, fatherId: 2 }] }));
    expect(done.status).toBe('completed');
    expect(done.outcome).toBe('Ada and Tom welcomed little Mae.');
  });
});
