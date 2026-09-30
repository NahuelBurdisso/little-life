import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  activityLog, agentStates, agents, children, conversationQueue, locations, memories, needs, relationshipEvents,
  relationships, shared_knowledge, worldEvents, worldState,
} from '../../../db/schema';
import { applyTrystAftermath } from '../aftermath';
import {
  DENIAL_GUILT_MORALITY_ABOVE, SCANDAL_FRIENDSHIP, SHOWING_AFTER_MINUTES, SHOWING_GRACE_MINUTES, TELL_FATHER_AFTER_MINUTES,
  TRYST_CONCEPTION_CHANCE, fatherResponse, pregnancyPass, rollTrystConception,
} from '../pregnancy';
import { clearIntimacy } from '../state';
import { MAX_CHILDREN, PREGNANCY_MINUTES, familyTick } from '../../family';
import {
  clearFamilyState, familySnapshotStore, pregnancyOf, pregnancyInvolving, familyPromptLine,
} from '../../familyState';
import {
  WEDDING_DELAY_MINUTES, clearMilestones, getPairMilestone, milestonesSnapshotStore, milestonesTick, queueShotgunProposal,
} from '../../milestonesEngine';
import { PROPOSAL_TOPIC } from '../../../ai/prompts';
import { renderMessage } from '../../activityMessage';
import { alertTier } from '../../alertTiers';
import { setRuleOverrides } from '../../worldRules';
import { gameMinutes } from '../../gameClock';
import { simEvents } from '../../simEvents';
import { CONFIG } from '../../constants';

/**
 * An unwed pregnancy and the 1900 scandal (intimacy/pregnancy.ts): the conception roll and
 * everything that gates it, the private secret, the father told after two game days and what
 * he does (marry / deny), the shotgun proposal through the real proposal flow, the town
 * noticing when she shows (fact, feed row, the strict adults thinking less of her), a wedding
 * cancelling it, the birth with no father of record, and the checkpoint.
 */

const DAY = 24 * 60;
const TIME = { day: 40, hour: 12, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);
/** She conceived two game days ago: the father is told on the first pass at NOW, she shows at NOW + 2 days. */
const CONCEIVED = NOW - 2 * DAY;

const made: number[] = [];
const madeLocations: number[] = [];
let homeId: number;
let farId: number;


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

function insertLocation(name: string, type: string, x = 0): number {
  const id = db.insert(locations).values({
    name, type, position: { x, y: 0, width: 4, height: 4 }, entry_point: { x, y: 0 },
    capacity: 20, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  madeLocations.push(id);
  return id;
}

function insertAgent(name: string, over: Partial<typeof agents.$inferInsert> = {}, p: { loyalty?: number; morality?: number } = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 28, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: p.loyalty ?? 60, morality: p.morality ?? 60, sensuality: 50, neuroticism: 40,
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

function relate(x: number, y: number, over: Partial<typeof relationships.$inferInsert> = {}): number {
  return db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y), friendship_ab: 70, friendship_ba: 70,
    romance_ab: 80, romance_ba: 80, trust_ab: 60, trust_ba: 60, familiarity: 80, interaction_count: 40,
    last_interaction: 0, last_interaction_minute: NOW, average_interaction_sentiment: 0.5,
    tags: ['lovers'], status: 'friends', status_since_minute: NOW - 10 * DAY, created_at: 0, last_updated: 0, ...over,
  }).returning({ id: relationships.id }).get().id;
}

/** A single woman and a single man who have been lovers (not `partners`: the shotgun proposal must not need it). */
function pair(over: { mother?: Partial<typeof agents.$inferInsert>; father?: Partial<typeof agents.$inferInsert>;
  fatherP?: { loyalty?: number; morality?: number }; rel?: Partial<typeof relationships.$inferInsert> } = {}) {
  const mother = insertAgent(`Miss ${made.length}`, { gender: 'female', ...over.mother });
  const father = insertAgent(`Mister ${made.length}`, { gender: 'male', ...over.father }, over.fatherP);
  const relId = relate(mother, father, over.rel);
  return { mother, father, relId };
}

const load = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;
const rel = (id: number) => db.select().from(relationships).where(eq(relationships.id, id)).get()!;
const statesOf = (id: number) => db.select().from(agentStates).where(eq(agentStates.agent_id, id)).all().map((s) => s.type);
const scandalFacts = (motherId: number) => db.select().from(shared_knowledge)
  .where(and(eq(shared_knowledge.type, 'illegitimate_pregnancy'), eq(shared_knowledge.subject_id, motherId))).all();
const scandalRows = (id: number) => db.select().from(activityLog).where(eq(activityLog.type, 'scandal')).all()
  .filter((r) => (r.agent_ids as number[]).includes(id));

/** The friendship delta `from` feels toward `to` in the scandal events on record. */
function judgedDelta(from: number, to: number): number {
  const evs = db.select().from(relationshipEvents).where(eq(relationshipEvents.event_type, 'scandal')).all()
    .filter((e) => Math.min(from, to) === e.agent_a && Math.max(from, to) === e.agent_b);
  return evs.reduce((sum, e) => sum + (from < to ? e.friendship_delta_ab : e.friendship_delta_ba), 0);
}

/** A pregnancy as the tryst roll would start it, conceived `CONCEIVED`. */
function expecting(mother: number, father: number) {
  const p = rollTrystConception(load(mother), load(father), CONCEIVED, () => 0);
  expect(p).not.toBeNull();
  return p!;
}

function captureMemories() {
  const seen: Array<{ agentId: number; description: string }> = [];
  const fn = (p: { agentId: number; description: string }) => { seen.push(p); };
  simEvents.on('life:milestone', fn);
  return { seen, stop: () => simEvents.off('life:milestone', fn) };
}

/** What conversations.ts emits when an LLM proposal conversation closes, for the proposer. */
function proposalEnded(proposer: number, other: number, answer: string, sentiment = 0) {
  simEvents.emit('conversation:ended', {
    agentId: proposer, perpetratorId: other, conversationId: 997_000 + proposer, summary: PROPOSAL_TOPIC,
    turns: 2, sentiment,
    messages: [{ speakerId: proposer, text: 'Will you marry me?' }, { speakerId: other, text: answer }],
  });
}

// ─── Pure rules ──────────────────────────────────────────────────────────────

describe('what the father does (pure)', () => {
  const base = { loyalty: 60, morality: 60, romance: 80, spokenFor: false };

  it('a loyal, decent man who still loves her marries her', () => {
    expect(fatherResponse(base)).toBe('marry');
  });

  it('a man promised elsewhere turns her away whatever his character', () => {
    expect(fatherResponse({ ...base, loyalty: 100, morality: 100, spokenFor: true })).toBe('deny');
  });

  it('a man who no longer feels anything for her turns her away', () => {
    expect(fatherResponse({ ...base, loyalty: 100, morality: 100, romance: 10 })).toBe('deny');
  });

  it('weighs loyalty, conscience and romance', () => {
    expect(fatherResponse({ loyalty: 10, morality: 30, romance: 60, spokenFor: false })).toBe('deny');
    expect(fatherResponse({ loyalty: 90, morality: 40, romance: 40, spokenFor: false })).toBe('marry');
    // Nothing but romance is not enough; a scoundrel who is merely in love still walks away.
    expect(fatherResponse({ loyalty: 5, morality: 5, romance: 100, spokenFor: false })).toBe('deny');
  });
});

// ─── Against the DB ──────────────────────────────────────────────────────────

describe('an unwed pregnancy against the DB', () => {
  beforeAll(() => {
    setClock();
    homeId = insertLocation('Lovers Lane Cottage', 'home', 0);
    farId = insertLocation('Far Cottage', 'home', 900);
    insertLocation('Unwed Square', 'town_square', 400); // the wedding is held on the square
  });

  beforeEach(() => {
    clearIntimacy();
    clearFamilyState();
    clearMilestones();
    setClock();
    setRuleOverrides({ adultContent: true });
    db.delete(children).run();
    db.update(worldEvents).set({ is_active: false }).where(eq(worldEvents.type, 'wedding')).run();
    // Earlier tests' agents stay in town but out of the way: no stray onlookers, no stale pairs.
    if (made.length) db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  afterAll(() => {
    setRuleOverrides({ adultContent: false });
    db.delete(children).run();
    db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, 'proposal')).run();
    db.delete(worldEvents).where(eq(worldEvents.type, 'wedding')).run();
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, made), inArray(shared_knowledge.target_id, made))).run();
    db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, made), inArray(relationshipEvents.agent_b, made))).run();
    db.delete(activityLog).where(inArray(activityLog.type, ['scandal', 'drama', 'proposal', 'engagement', 'rejection', 'wedding', 'moved_in', 'christening'])).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, made)).run();
    db.delete(memories).where(inArray(memories.agent_id, made)).run();
    db.delete(needs).where(inArray(needs.agent_id, made)).run();
    db.delete(agents).where(inArray(agents.id, made)).run();
    db.delete(locations).where(inArray(locations.id, madeLocations)).run();
    clearIntimacy();
    clearFamilyState();
    clearMilestones();
  });

  // ─── Conception ────────────────────────────────────────────────────────────

  describe('the conception roll', () => {
    const roll = (m: number, f: number, rng = () => 0) => rollTrystConception(load(m), load(f), NOW, rng);

    it('a night between a man and an unmarried woman can start a pregnancy, at 6 percent', () => {
      const { mother, father } = pair();
      expect(TRYST_CONCEPTION_CHANCE).toBe(0.06);
      expect(roll(mother, father, () => 0.06)).toBeNull();
      expect(pregnancyOf(mother)).toBeUndefined();
      const p = roll(mother, father, () => 0.059);
      expect(p).toMatchObject({ motherId: mother, fatherId: father, unwed: true, conceivedAt: NOW });
      // The roll goes the same whichever of the two is passed first.
      expect(pregnancyOf(mother)).toBeDefined();
    });

    it('starts from a completed night: the aftermath rolls it, an interrupted evening does not', () => {
      const { mother, father } = pair();
      const done = { a: mother, b: father, venueId: homeId, secret: true, first: true, interrupted: false, now: NOW };
      vi.spyOn(Math, 'random').mockReturnValue(0);
      applyTrystAftermath({ ...done, interrupted: true });
      expect(pregnancyOf(mother)).toBeUndefined();
      applyTrystAftermath(done);
      expect(pregnancyOf(mother)).toMatchObject({ fatherId: father, unwed: true });
    });

    it('never for two women or two men (and never when the pair passes the sexes the other way round)', () => {
      const a = insertAgent('Ada Same', { gender: 'female' });
      const b = insertAgent('Bea Same', { gender: 'female' });
      expect(roll(a, b)).toBeNull();
      const c = insertAgent('Carl Same', { gender: 'male' });
      const d = insertAgent('Dan Same', { gender: 'male' });
      expect(roll(c, d)).toBeNull();
      // Either argument order finds the mother.
      const { mother, father } = pair();
      expect(rollTrystConception(load(father), load(mother), NOW, () => 0)).toMatchObject({ motherId: mother });
    });

    it('never when she is 45 or older, still at 44', () => {
      const old = pair({ mother: { age: 45 } });
      expect(roll(old.mother, old.father)).toBeNull();
      const edge = pair({ mother: { age: 44 } });
      expect(roll(edge.mother, edge.father)).not.toBeNull();
    });

    it('never for a minor, however the row was built', () => {
      const girl = pair({ mother: { age: 17 } });
      expect(roll(girl.mother, girl.father)).toBeNull();
      const boy = pair({ father: { age: 17 } });
      expect(roll(boy.mother, boy.father)).toBeNull();
      const both = pair({ mother: { age: 16 }, father: { age: 16 } });
      expect(roll(both.mother, both.father)).toBeNull();
      // A missing age fails closed too.
      const blank = pair();
      expect(rollTrystConception({ ...load(blank.mother), age: null as unknown as number }, load(blank.father), NOW, () => 0)).toBeNull();
      expect(pregnancyOf(blank.mother)).toBeUndefined();
    });

    it('a married mother keeps the daily roll: this one is skipped, to her husband or to a lover', () => {
      const husband = insertAgent('Her Husband', { gender: 'male' });
      const wife = insertAgent('The Wife', { gender: 'female' });
      relate(wife, husband, { tags: ['partner', 'married'], status: 'partners' });
      const lover = insertAgent('The Lover', { gender: 'male' });
      relate(wife, lover);
      expect(roll(wife, husband)).toBeNull();
      expect(roll(wife, lover)).toBeNull();
      expect(pregnancyOf(wife)).toBeUndefined();
    });

    it('a widow is unmarried again', () => {
      const husband = insertAgent('Late Husband', { gender: 'male' });
      const widow = insertAgent('The Widow', { gender: 'female' });
      relate(widow, husband, { tags: ['partner', 'married'], status: 'partners' });
      db.update(agents).set({ is_active: false }).where(eq(agents.id, husband)).run();
      const lover = insertAgent('New Love', { gender: 'male' });
      relate(widow, lover);
      expect(roll(widow, lover)).not.toBeNull();
    });

    it('never with the rule off', () => {
      const { mother, father } = pair();
      setRuleOverrides({ adultContent: false });
      expect(roll(mother, father)).toBeNull();
      expect(pregnancyOf(mother)).toBeUndefined();
    });

    it('never while already expecting, past the family cap or right after a baby', () => {
      const first = pair();
      expect(roll(first.mother, first.father)).not.toBeNull();
      expect(roll(first.mother, first.father)).toBeNull();

      const big = pair();
      for (let i = 0; i < MAX_CHILDREN; i++) {
        db.insert(children).values({ name: `Kid ${i}`, sex: 'female', birth_game_minute: NOW - (30 + i) * DAY, mother_id: big.mother, father_id: null, home: homeId }).run();
      }
      expect(roll(big.mother, big.father)).toBeNull();

      const recent = pair();
      db.insert(children).values({ name: 'Newest', sex: 'male', birth_game_minute: NOW - 2 * DAY, mother_id: recent.mother, father_id: null, home: homeId }).run();
      expect(roll(recent.mother, recent.father)).toBeNull();
    });

    it('starts a private secret only she knows, and a memory', () => {
      const { mother, father } = pair();
      const mem = captureMemories();
      const p = roll(mother, father)!;
      mem.stop();
      const f = db.select().from(shared_knowledge).where(eq(shared_knowledge.id, p.factId!)).get()!;
      expect(f).toMatchObject({ type: 'pregnancy', subject_id: mother, target_id: father, sensitivity: 3, is_public: false });
      expect(f.known_by).toEqual([mother]);
      expect(mem.seen.filter((m) => m.agentId === mother)).toHaveLength(1);
      expect(mem.seen.find((m) => m.agentId === father)).toBeUndefined();
      // She is expecting, and nobody has been told anything: no feed row, no town news.
      expect(db.select().from(activityLog).where(eq(activityLog.type, 'expecting')).all()
        .filter((r) => (r.agent_ids as number[]).includes(mother))).toHaveLength(0);
    });

    it('the married timers never run for it: nobody is told, nothing is announced', () => {
      const { mother, father } = pair();
      expecting(mother, father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();
      familyTick(TIME, NOW + 3 * DAY, () => 0);
      const p = pregnancyOf(mother)!;
      expect(p.spouseTold).toBeUndefined();
      expect(p.announced).toBeUndefined();
      expect(db.select().from(activityLog).where(eq(activityLog.type, 'expecting')).all()
        .filter((r) => (r.agent_ids as number[]).includes(mother))).toHaveLength(0);
    });
  });

  // ─── Telling the father ────────────────────────────────────────────────────

  describe('telling the father', () => {
    it('two game days in she tells him: he learns the secret and both have a memory', () => {
      const { mother, father } = pair();
      const p = expecting(mother, father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();

      // Not yet.
      pregnancyPass(CONCEIVED + TELL_FATHER_AFTER_MINUTES - 1);
      expect(pregnancyOf(mother)!.spouseTold).toBeUndefined();

      const mem = captureMemories();
      pregnancyPass(CONCEIVED + TELL_FATHER_AFTER_MINUTES);
      mem.stop();
      expect(pregnancyOf(mother)!.spouseTold).toBe(true);
      const f = db.select().from(shared_knowledge).where(eq(shared_knowledge.id, p.factId!)).get()!;
      expect(f.known_by).toEqual(expect.arrayContaining([mother, father]));
      expect(mem.seen.some((m) => m.agentId === father)).toBe(true);
      expect(mem.seen.some((m) => m.agentId === mother)).toBe(true);
      // Told once.
      const before = mem.seen.length;
      const again = captureMemories();
      pregnancyPass(CONCEIVED + TELL_FATHER_AFTER_MINUTES + 10);
      again.stop();
      expect(again.seen.length).toBe(0);
      expect(before).toBeGreaterThan(0);
    });

    it('still tells him with the rule off: the pregnancy already exists', () => {
      const { mother, father } = pair();
      expecting(mother, father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();
      setRuleOverrides({ adultContent: false });
      pregnancyPass(CONCEIVED + TELL_FATHER_AFTER_MINUTES);
      expect(pregnancyOf(mother)!.spouseTold).toBe(true);
    });

    it('he shows up in her prompt line and in his own once he knows', () => {
      const { mother, father } = pair();
      expecting(mother, father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();
      expect(familyPromptLine(father, NOW)).toBe('');
      pregnancyPass(NOW);
      expect(familyPromptLine(father, NOW)).toContain('is expecting your baby');
      expect(familyPromptLine(mother, NOW)).toContain('nobody knows yet');
    });
  });

  // ─── Marry: the shotgun proposal ───────────────────────────────────────────

  describe('the father means to marry her', () => {
    function toldAndWilling() {
      const c = pair();
      expecting(c.mother, c.father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [c.mother, c.father])).run();
      pregnancyPass(NOW);
      return c;
    }

    it('queues a proposal at once, for a pair that are not partners, with the shotgun flag', () => {
      const { mother, father, relId } = toldAndWilling();
      expect(rel(relId).status).toBe('friends');
      expect(getPairMilestone(mother, father)).toMatchObject({ proposerId: father, shotgun: true, pendingSince: NOW });
      // They are together (same home): the question is seated now, opened by the father.
      const q = db.select().from(conversationQueue).where(eq(conversationQueue.trigger_reason, 'proposal')).all()
        .filter((r) => r.participants.includes(mother) && r.participants.includes(father));
      expect(q).toHaveLength(1);
      expect(q[0].participants[0]).toBe(father);
      expect(pregnancyOf(mother)!.fatherDenied).toBeUndefined();
    });

    it('a yes leads to an engagement that stands although they are not partners, and to the wedding', () => {
      const { mother, father, relId } = toldAndWilling();
      proposalEnded(father, mother, 'Yes! Of course I will.', 0.5);
      expect(rel(relId).tags).toContain('engaged');
      expect(getPairMilestone(mother, father)).toEqual({ engagedAt: NOW, shotgun: true });

      // The status gate that calls an engagement off must not: they are still `friends`.
      milestonesTick({ ...TIME, hour: 12 }, NOW + 60);
      expect(rel(relId).tags).toContain('engaged');

      // A game day later, in the daytime, the wedding.
      milestonesTick({ ...TIME, hour: 12 }, NOW + WEDDING_DELAY_MINUTES + 10);
      expect(rel(relId).tags).toContain('married');
      expect(rel(relId).tags).not.toContain('engaged');
      expect(getPairMilestone(mother, father)).toBeUndefined();
    });

    it('a wedding before she shows cancels the scandal, and the pregnancy carries on as a married one', () => {
      const { mother, father } = toldAndWilling();
      proposalEnded(father, mother, 'Yes! Of course I will.', 0.5);
      milestonesTick({ ...TIME, hour: 12 }, NOW + WEDDING_DELAY_MINUTES + 10);
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES + 10);
      expect(scandalFacts(mother)).toHaveLength(0);
      expect(scandalRows(mother)).toHaveLength(0);
      expect(pregnancyOf(mother)!.unwed).toBe(false);
      expect(pregnancyOf(mother)!.showing).toBeUndefined();
      // The married timers take it from here: the town is told the happy way.
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();
      familyTick(TIME, CONCEIVED + SHOWING_AFTER_MINUTES + 20, () => 0);
      expect(pregnancyOf(mother)!.announced).toBe(true);
    });

    it('an engagement still waiting for its wedding puts the scandal off, but only for so long', () => {
      const { mother, father } = toldAndWilling();
      proposalEnded(father, mother, 'Yes! Of course I will.', 0.5);
      // Showing time, engaged, no wedding yet: no scandal.
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES);
      expect(scandalFacts(mother)).toHaveLength(0);
      expect(pregnancyOf(mother)!.showing).toBeUndefined();
      // The wedding never came: after the grace she shows anyway.
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES + SHOWING_GRACE_MINUTES);
      expect(scandalFacts(mother)).toHaveLength(1);
    });

    it('a refusal goes to the scandal path, with the father named', () => {
      const { mother, father, relId } = toldAndWilling();
      const witness = insertAgent('Chapel Witness', { gender: 'female', age: 45 }, { morality: 90 });
      proposalEnded(father, mother, "No. I'm sorry — I can't.", 0.3);
      expect(rel(relId).tags).not.toContain('engaged');
      expect(getPairMilestone(mother, father)?.shotgun).toBeUndefined();

      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES);
      const [fact] = scandalFacts(mother);
      expect(fact).toBeDefined();
      expect(fact.target_id).toBe(father);
      expect(fact.known_by).toEqual(expect.arrayContaining([mother, father, witness]));
      // The strict witness thinks less of both.
      expect(judgedDelta(witness, mother)).toBe(SCANDAL_FRIENDSHIP);
      expect(judgedDelta(witness, father)).toBe(SCANDAL_FRIENDSHIP);
    });

    it('a shotgun proposal is never made for a pair that could not marry', () => {
      // Same sex.
      const a = insertAgent('Ann Same', { gender: 'female' });
      const b = insertAgent('Bea Same2', { gender: 'female' });
      relate(a, b);
      expect(queueShotgunProposal(a, b)).toBe(false);
      // A minor.
      const girl = insertAgent('Girl Young', { gender: 'female', age: 17 });
      const man = insertAgent('Man Old', { gender: 'male' });
      relate(girl, man);
      expect(queueShotgunProposal(man, girl)).toBe(false);
      // Promised elsewhere.
      const { mother, father } = pair();
      const fiancee = insertAgent('The Fiancee', { gender: 'female' });
      relate(fiancee, father, { tags: ['partner', 'engaged'], status: 'partners' });
      expect(queueShotgunProposal(father, mother)).toBe(false);
      expect(getPairMilestone(mother, father)).toBeUndefined();
    });

    it('a father promised elsewhere turns her away instead', () => {
      const { mother, father } = pair();
      const fiancee = insertAgent('Other Fiancee', { gender: 'female' });
      relate(fiancee, father, { tags: ['partner', 'married'], status: 'partners' });
      expecting(mother, father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();
      pregnancyPass(NOW);
      expect(pregnancyOf(mother)!.fatherDenied).toBe(true);
      expect(getPairMilestone(mother, father)).toBeUndefined();
    });
  });

  // ─── Deny ──────────────────────────────────────────────────────────────────

  describe('the father turns her away', () => {
    function toldAndUnwilling(morality = 55) {
      const c = pair({ fatherP: { loyalty: 10, morality } });
      expecting(c.mother, c.father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [c.mother, c.father])).run();
      pregnancyPass(NOW);
      return c;
    }

    it('she is heartbroken, he is guilty if he has a conscience, and no proposal is made', () => {
      const { mother, father } = toldAndUnwilling(55);
      expect(DENIAL_GUILT_MORALITY_ABOVE).toBe(50);
      expect(pregnancyOf(mother)!.fatherDenied).toBe(true);
      expect(pregnancyOf(mother)!.fatherId).toBe(father); // for the record
      expect(statesOf(mother)).toContain('heartbroken');
      expect(statesOf(father)).toContain('guilty');
      expect(getPairMilestone(mother, father)).toBeUndefined();
      // He is no longer "the father" as far as the prompts go.
      expect(pregnancyInvolving(father)).toBeUndefined();
    });

    it('a scoundrel feels no guilt', () => {
      const { mother, father } = toldAndUnwilling(40);
      expect(statesOf(mother)).toContain('heartbroken');
      expect(statesOf(father)).not.toContain('guilty');
    });

    it('when she shows the town whispers about her alone: no father is named', () => {
      const { mother, father } = toldAndUnwilling();
      const witness = insertAgent('Porch Witness', { gender: 'female', age: 50 }, { morality: 85 });
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES);
      const [fact] = scandalFacts(mother);
      expect(fact.target_id).toBeNull();
      expect(fact.content).not.toContain('father');
      expect(fact.known_by).not.toContain(father);
      expect(judgedDelta(witness, mother)).toBe(SCANDAL_FRIENDSHIP);
      expect(judgedDelta(witness, father)).toBe(0);
    });

    it('the baby is born with no father of record, and neutral wording', () => {
      const { mother, father } = toldAndUnwilling();
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES);
      familyTick(TIME, CONCEIVED + PREGNANCY_MINUTES, () => 0);
      const kid = db.select().from(children).where(eq(children.mother_id, mother)).get()!;
      expect(kid.father_id).toBeNull();
      // Not `true_father_id`: that column drives the marriage's paternity drama.
      expect(kid.true_father_id).toBeNull();
      expect(pregnancyOf(mother)).toBeUndefined();
      const row = db.select().from(activityLog).where(eq(activityLog.type, 'drama')).all()
        .find((r) => (r.metadata as { beat?: string } | null)?.beat === 'birth' && (r.agent_ids as number[]).includes(mother))!;
      expect(row.agent_ids).toEqual([mother]);
      expect(String((row.template_data as { description: string }).description)).toBe(`${load(mother).name} welcomed a baby ${kid.sex === 'female' ? 'daughter' : 'son'}, ${kid.name}!`);
      expect(String((row.template_data as { description: string }).description)).not.toContain(load(father).name);
    });
  });

  // ─── The scandal ───────────────────────────────────────────────────────────

  describe('showing', () => {
    it('the town sees: a secret born to whoever is beside her, a feed row, the strict adults think less of her', () => {
      const { mother, father } = pair({ fatherP: { loyalty: 10, morality: 40 } });
      expecting(mother, father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();
      const strict = insertAgent('Strict Aunt', { gender: 'female', age: 52 }, { morality: 90 });
      const easy = insertAgent('Easygoing Uncle', { gender: 'male', age: 40 }, { morality: 40 });
      const child = insertAgent('Sunday Child', { gender: 'female', age: 12 }, { morality: 95 });
      const away = insertAgent('Faraway Prude', { gender: 'female', age: 60, current_location: farId, home: farId }, { morality: 99 });
      pregnancyPass(NOW); // told, turned away

      // Before her time: nothing.
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES - 1);
      expect(scandalFacts(mother)).toHaveLength(0);

      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES);
      const [fact] = scandalFacts(mother);
      expect(fact).toMatchObject({ sensitivity: 3, is_public: false, source: 'observed' });
      expect(fact.content).toBe(`${load(mother).name} is expecting a child out of wedlock`);
      // Known to her and the adults there; not to a child, not to somebody across town.
      expect(fact.known_by).toEqual(expect.arrayContaining([mother, strict, easy]));
      expect(fact.known_by).not.toContain(child);
      expect(fact.known_by).not.toContain(away);

      const [row] = scandalRows(mother);
      expect(row).toMatchObject({ type: 'scandal', category: 'drama' });
      expect((row.metadata as { beat: string }).beat).toBe('scandal');
      expect(row.importance).toBeGreaterThanOrEqual(0.85);
      expect(renderMessage({ type: 'scandal', template_data: row.template_data as Record<string, string>, timestamp: 0 }))
        .toBe(`Whispers follow ${load(mother).name} through town.`);
      expect(alertTier({ type: 'scandal', category: 'drama', importance: row.importance })).toBe('major');

      // Only the strict adult thinks less of her; the easygoing one does not; nobody who is not a grown-up.
      expect(judgedDelta(strict, mother)).toBe(SCANDAL_FRIENDSHIP);
      expect(judgedDelta(easy, mother)).toBe(0);
      expect(judgedDelta(child, mother)).toBe(0);
      expect(pregnancyOf(mother)!.showing).toBe(true);
      // Once each, however many passes.
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES + 10);
      expect(judgedDelta(strict, mother)).toBe(SCANDAL_FRIENDSHIP);
      expect(scandalRows(mother)).toHaveLength(1);
    });

    it('a strict adult who only learns of it later is judged when the pass next sees them', () => {
      const { mother, father } = pair({ fatherP: { loyalty: 10, morality: 40 } });
      expecting(mother, father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();
      const witness = insertAgent('First Witness', { gender: 'female', age: 33 }, { morality: 20 });
      pregnancyPass(NOW);
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES);
      const late = insertAgent('Late Hearer', { gender: 'female', age: 61, current_location: farId, home: farId }, { morality: 88 });
      expect(judgedDelta(late, mother)).toBe(0);
      // Gossip reached her (gossipEngine adds knowers silently).
      const [fact] = scandalFacts(mother);
      db.update(shared_knowledge).set({ known_by: [...(fact.known_by as number[]), late] }).where(eq(shared_knowledge.id, fact.id)).run();
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES + 30);
      expect(judgedDelta(late, mother)).toBe(SCANDAL_FRIENDSHIP);
      expect(judgedDelta(witness, mother)).toBe(0);
    });

    it('waits until somebody can see her, but only for so long', () => {
      const { mother, father } = pair({ fatherP: { loyalty: 10, morality: 40 } });
      expecting(mother, father);
      // Alone in the house: the only other person in town is the father, who is elsewhere.
      db.update(agents).set({ is_active: true }).where(eq(agents.id, mother)).run();
      db.update(agents).set({ is_active: true, current_location: farId }).where(eq(agents.id, father)).run();
      pregnancyPass(NOW);
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES);
      expect(scandalFacts(mother)).toHaveLength(0);
      expect(pregnancyOf(mother)!.showing).toBeUndefined();
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES + SHOWING_GRACE_MINUTES);
      expect(scandalFacts(mother)).toHaveLength(1);
      expect(scandalRows(mother)).toHaveLength(1);
    });

    it('does not run for a married pregnancy, or with the rule off (she is still told the father, but no scandal)', () => {
      const { mother, father } = pair();
      expecting(mother, father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();
      setRuleOverrides({ adultContent: false });
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES);
      expect(scandalFacts(mother)).toHaveLength(0);
      expect(scandalRows(mother)).toHaveLength(0);
      expect(pregnancyOf(mother)!.showing).toBeUndefined();
      expect(pregnancyOf(mother)!.spouseTold).toBe(true);
    });

    it('the scandal fact is retired at the birth, and a later pregnancy starts a fresh one', () => {
      const { mother, father } = pair({ fatherP: { loyalty: 10, morality: 40 } });
      expecting(mother, father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();
      insertAgent('Neighbour One', { gender: 'female', age: 40 });
      pregnancyPass(NOW);
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES);
      const [first] = scandalFacts(mother);
      expect(first.is_active).toBe(true);

      familyTick(TIME, CONCEIVED + PREGNANCY_MINUTES, () => 0);
      expect(pregnancyOf(mother)).toBeUndefined();
      expect(db.select().from(shared_knowledge).where(eq(shared_knowledge.id, first.id)).get()!.is_active).toBe(false);

      // Another child, another whisper: a new fact, not the old one attached again.
      const second = rollTrystConception(load(mother), load(father), NOW + 300 * DAY, () => 0)!;
      expect(second).not.toBeNull();
      pregnancyPass(NOW + 300 * DAY + TELL_FATHER_AFTER_MINUTES);
      pregnancyPass(NOW + 300 * DAY + SHOWING_AFTER_MINUTES);
      const active = scandalFacts(mother).filter((f) => f.is_active);
      expect(active).toHaveLength(1);
      expect(active[0].id).not.toBe(first.id);
      expect(pregnancyOf(mother)!.scandalFactId).toBe(active[0].id);
    });

    it('a wedding after the town has whispered retires the scandal too', () => {
      const { mother, father } = pair({ fatherP: { loyalty: 10, morality: 40 } });
      expecting(mother, father);
      db.update(agents).set({ is_active: true }).where(inArray(agents.id, [mother, father])).run();
      insertAgent('Neighbour Two', { gender: 'female', age: 40 });
      pregnancyPass(NOW);
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES);
      const [fact] = scandalFacts(mother);
      expect(fact.is_active).toBe(true);
      // They marry (after the father turned her away, he comes round).
      db.update(relationships).set({ tags: ['lovers', 'married'], status: 'partners' })
        .where(or(eq(relationships.agent_a, mother), eq(relationships.agent_b, mother))).run();
      const p = pregnancyOf(mother)!;
      (p as { fatherDenied?: boolean }).fatherDenied = false;
      pregnancyPass(CONCEIVED + SHOWING_AFTER_MINUTES + 20);
      expect(pregnancyOf(mother)!.unwed).toBe(false);
      expect(db.select().from(shared_knowledge).where(eq(shared_knowledge.id, fact.id)).get()!.is_active).toBe(false);
    });
  });

  // ─── The checkpoint ────────────────────────────────────────────────────────

  describe('persistence', () => {
    it('round-trips an unwed pregnancy with its scandal state', () => {
      familySnapshotStore.restore({
        pregnancies: {
          7: { fatherId: 8, unwed: true, conceivedAt: 100, factId: 3, spouseTold: true, fatherDenied: true, showing: true, scandalFactId: 9, judgedBy: [4, 5] },
        },
      });
      expect(pregnancyOf(7)).toEqual({
        motherId: 7, fatherId: 8, unwed: true, conceivedAt: 100, factId: 3, spouseTold: true,
        fatherDenied: true, showing: true, scandalFactId: 9, judgedBy: [4, 5],
      });
      const out = familySnapshotStore.serialize();
      familySnapshotStore.restore(out);
      expect(familySnapshotStore.serialize()).toEqual(out);
      clearFamilyState();
    });

    it('restores an old snapshot as a married pregnancy, and accepts an unwed one with no father', () => {
      familySnapshotStore.restore({
        pregnancies: {
          5: { fatherId: 6, conceivedAt: 10 },
          // A married pregnancy always names its father; an unwed one may not.
          8: { fatherId: null, conceivedAt: 10 },
          9: { fatherId: null, unwed: true, conceivedAt: 10 },
        },
      });
      expect(pregnancyOf(5)).toEqual({ motherId: 5, fatherId: 6, unwed: false, conceivedAt: 10 });
      expect(pregnancyOf(8)).toBeUndefined();
      expect(pregnancyOf(9)).toEqual({ motherId: 9, fatherId: null, unwed: true, conceivedAt: 10 });
      clearFamilyState();
    });

    it('a shotgun proposal survives a restart', () => {
      milestonesSnapshotStore.restore({
        '3-4': { proposerId: 4, pendingSince: 50, shotgun: true },
        '5-6': { engagedAt: 60, shotgun: true },
        '7-8': { retryAfter: 90, shotgun: true }, // a flag without a proposal or an engagement is noise
      });
      expect(getPairMilestone(3, 4)).toEqual({ proposerId: 4, pendingSince: 50, shotgun: true });
      expect(getPairMilestone(5, 6)).toEqual({ engagedAt: 60, shotgun: true });
      expect(getPairMilestone(7, 8)).toEqual({ retryAfter: 90 });
      clearMilestones();
    });
  });
});
