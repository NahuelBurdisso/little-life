import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, locations, needs, relationships, worldState } from '../../db/schema';
import { clearIntimacy, ensureAgentIntimacy, updatePairIntimacy } from '../../lib/intimacy/state';
import { ENGAGED_TAG, MARRIED_TAG } from '../../lib/marriage';
import { setRuleOverrides } from '../../lib/worldRules';
import { intimacyLines, intimacyLinesFor, type IntimacyContext } from '../intimacyContext';

/**
 * What a speaker privately knows about the person in front of them. Pure rules
 * first (the whole context injected), then the reader that gathers it.
 */

const self = { age: 30 };
const rosa = { age: 28, name: 'Rosa' };

const ctx = (over: Partial<IntimacyContext> = {}): IntimacyContext => ({
  adultContent: true, tags: [], trysts: 0, secret: false, longing: 0, drawn: false, ownBond: null, otherBond: null, ...over,
});

describe('intimacyLines', () => {
  it('says nothing about strangers', () => {
    expect(intimacyLines(self, rosa, ctx())).toEqual([]);
  });

  it('secret lovers: nobody may know', () => {
    expect(intimacyLines(self, rosa, ctx({ tags: ['lovers'], trysts: 2, secret: true })))
      .toEqual(['You and Rosa are lovers; nobody may know.']);
  });

  it('the secret line appears only when it is a secret', () => {
    const lines = intimacyLines(self, rosa, ctx({ tags: ['kissed', 'lovers'], trysts: 2, secret: false }));
    expect(lines).toEqual(['You and Rosa are lovers.']);
    expect(lines.join(' ')).not.toContain('nobody');
  });

  it('a kiss alone is "You have kissed Rosa."', () => {
    expect(intimacyLines(self, rosa, ctx({ tags: ['kissed'] }))).toEqual(['You have kissed Rosa.']);
  });

  it('lovers supersede the kiss line (they have obviously kissed)', () => {
    const lines = intimacyLines(self, rosa, ctx({ tags: ['kissed', 'lovers'], trysts: 1 }));
    expect(lines.join(' ')).not.toContain('kissed');
  });

  it('a night counts as lovers even if the tag is missing (tags lag one tick)', () => {
    expect(intimacyLines(self, rosa, ctx({ trysts: 1 }))).toEqual(['You and Rosa are lovers.']);
  });

  it('with the adult rule off, lovers read as a kiss and nothing more', () => {
    const lines = intimacyLines(self, rosa, ctx({ adultContent: false, tags: ['kissed', 'lovers'], trysts: 3, secret: true }));
    expect(lines).toEqual(['You have kissed Rosa.']);
  });

  it('a committed speaker who kissed or lay with another is reminded what it costs', () => {
    const married = intimacyLines(self, rosa, ctx({ tags: ['kissed'], ownBond: { name: 'Thomas', kind: 'married' } }));
    expect(married).toEqual(['You have kissed Rosa.', 'You are married to Thomas; if this came out it would ruin you.']);
    const engaged = intimacyLines(self, rosa, ctx({ tags: ['kissed'], ownBond: { name: 'Thomas', kind: 'engaged' } }));
    expect(engaged[1]).toContain('engaged to Thomas');
  });

  it('the cost line needs something to hide: a bond alone says nothing', () => {
    expect(intimacyLines(self, rosa, ctx({ ownBond: { name: 'Thomas', kind: 'married' } }))).toEqual([]);
  });

  it('"You ache for Rosa." needs the rule, longing of 70 and being drawn to her', () => {
    expect(intimacyLines(self, rosa, ctx({ drawn: true, longing: 70 }))).toEqual(['You ache for Rosa.']);
    expect(intimacyLines(self, rosa, ctx({ drawn: true, longing: 69 }))).toEqual([]);
    expect(intimacyLines(self, rosa, ctx({ drawn: false, longing: 90 }))).toEqual([]);
    expect(intimacyLines(self, rosa, ctx({ adultContent: false, drawn: true, longing: 90 }))).toEqual([]);
  });

  it('hints that somebody the speaker is drawn to is spoken for', () => {
    expect(intimacyLines(self, rosa, ctx({ drawn: true, otherBond: { name: 'Marco' } })))
      .toEqual(['Rosa is already spoken for by Marco.']);
    expect(intimacyLines(self, rosa, ctx({ drawn: false, otherBond: { name: 'Marco' } }))).toEqual([]);
  });

  it('never more than two lines, chosen by priority', () => {
    const all = ctx({
      tags: ['kissed', 'lovers'], trysts: 4, secret: true, longing: 95, drawn: true,
      ownBond: { name: 'Thomas', kind: 'married' }, otherBond: { name: 'Marco' },
    });
    expect(intimacyLines(self, rosa, all)).toEqual([
      'You and Rosa are lovers; nobody may know.',
      'You are married to Thomas; if this came out it would ruin you.',
    ]);
    const noBond = intimacyLines(self, rosa, { ...all, ownBond: null });
    expect(noBond).toEqual(['You and Rosa are lovers; nobody may know.', 'You ache for Rosa.']);
  });

  it('minors never get a line, whatever the tags say', () => {
    const everything = ctx({
      tags: ['kissed', 'lovers', 'crush'], trysts: 3, secret: true, longing: 100, drawn: true,
      ownBond: { name: 'Thomas', kind: 'married' }, otherBond: { name: 'Marco' },
    });
    expect(intimacyLines({ age: 17 }, rosa, everything)).toEqual([]);
    expect(intimacyLines(self, { age: 17, name: 'Rosa' }, everything)).toEqual([]);
    expect(intimacyLines({ age: undefined as unknown as number }, rosa, everything)).toEqual([]);
    expect(intimacyLines(self, { age: '30' as unknown as number, name: 'Rosa' }, everything)).toEqual([]);
  });

  it('no line describes an act: only "kissed", "lovers" and the cost of being found out', () => {
    const all = [
      ...intimacyLines(self, rosa, ctx({ tags: ['lovers'], trysts: 1, secret: true, ownBond: { name: 'T', kind: 'married' } })),
      ...intimacyLines(self, rosa, ctx({ tags: ['kissed'], drawn: true, longing: 80 })),
      ...intimacyLines(self, rosa, ctx({ drawn: true, longing: 80, otherBond: { name: 'M' } })),
    ].join(' ');
    expect(all).not.toMatch(/\b(bed|naked|sex|touch|body|undress|embrace)\b/i);
  });
});

describe('intimacyLinesFor', () => {
  const made: number[] = [];
  let homeId = 0;
  const personality = { honesty: 50, aggression: 30, warmth: 50, impulsiveness: 50, vanity: 40, curiosity: 50, loyalty: 50, morality: 50, sensuality: 60, neuroticism: 40 };

  function setClock(): void {
    const time = { day: 100, hour: 20, minute: 0, totalTicks: 0, seasonDay: 10, season: 'spring' };
    const existing = db.select().from(worldState).get();
    if (existing) { db.update(worldState).set({ time }).where(eq(worldState.id, existing.id)).run(); return; }
    db.insert(worldState).values({
      time, day_phase: 'evening', weather: 'sunny', weather_duration: 120, tick_speed: 1,
      is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
      pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
    }).run();
  }

  function insertAgent(name: string, gender: string, age = 30) {
    const id = db.insert(agents).values({
      name, bio: 'test', traits: [], age, gender, orientation: 'straight', personality,
      sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
      current_action: { type: 'idle' }, action_started: 0, action_queue: [],
      schedule: { wakeTime: 6, sleepTime: 23, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
      home: homeId, current_location: null, created_at: 0, is_active: true,
    }).returning({ id: agents.id }).get().id;
    made.push(id);
    return { id, age, gender, orientation: 'straight' };
  }

  function relate(x: number, y: number, tags: string[]): void {
    db.insert(relationships).values({
      agent_a: Math.min(x, y), agent_b: Math.max(x, y), friendship_ab: 70, friendship_ba: 70,
      romance_ab: 80, romance_ba: 80, trust_ab: 70, trust_ba: 70, familiarity: 80, interaction_count: 40,
      last_interaction: 0, average_interaction_sentiment: 0.5, tags, status: 'friends',
      status_since_minute: 0, created_at: 0, last_updated: 0,
    }).run();
  }

  beforeAll(() => {
    setClock();
    homeId = db.insert(locations).values({
      name: 'Context Cottage', type: 'home', position: { x: 0, y: 0, width: 96, height: 96 }, entry_point: { x: 0, y: 96 },
      capacity: 20, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
  });
  beforeEach(() => { clearIntimacy(); setRuleOverrides({ adultContent: true }); });
  afterAll(() => {
    setRuleOverrides({ adultContent: false });
    for (const id of made) {
      db.delete(relationships).where(eq(relationships.agent_a, id)).run();
      db.delete(relationships).where(eq(relationships.agent_b, id)).run();
      db.delete(needs).where(eq(needs.agent_id, id)).run();
      db.delete(agents).where(eq(agents.id, id)).run();
    }
    db.delete(locations).where(eq(locations.id, homeId)).run();
  });

  it("a married woman who kissed the baker is told what is at stake, by her husband's name", () => {
    const wife = insertAgent('Ada Marsh', 'female');
    const husband = insertAgent('Thomas Marsh', 'male');
    const baker = insertAgent('Bruno Cole', 'male');
    relate(wife.id, husband.id, [MARRIED_TAG]);
    expect(intimacyLinesFor(wife, baker, 'Bruno', ['kissed'], 40)).toEqual([
      'You have kissed Bruno.',
      'You are married to Thomas; if this came out it would ruin you.',
    ]);
  });

  it('a couple\'s own kiss is not a betrayal: the fiance is the person she is kissing', () => {
    const bride = insertAgent('Cora Vale', 'female');
    const groom = insertAgent('Dan Vale', 'male');
    relate(bride.id, groom.id, [ENGAGED_TAG]);
    expect(intimacyLinesFor(bride, groom, 'Dan', ['kissed', ENGAGED_TAG], 60)).toEqual(['You have kissed Dan.']);
  });

  it('a fiance is named as such when she kissed somebody else', () => {
    const bride = insertAgent('Cora Wade', 'female');
    const groom = insertAgent('Dan Wade', 'male');
    const other = insertAgent('Emil Stone', 'male');
    relate(bride.id, groom.id, [ENGAGED_TAG]);
    expect(intimacyLinesFor(bride, other, 'Emil', ['kissed'], 50)[1]).toContain('engaged to Dan');
  });

  it('secret lovers come from the pair state, and the secret flips off when it gets out', () => {
    const a = insertAgent('Eve Tarn', 'female');
    const b = insertAgent('Finn Tarn', 'male');
    updatePairIntimacy(a.id, b.id, (p) => { p.trysts = 1; p.secret = true; });
    expect(intimacyLinesFor(a, b, 'Finn', ['lovers'], 70)).toEqual(['You and Finn are lovers; nobody may know.']);
    updatePairIntimacy(a.id, b.id, (p) => { p.secret = false; });
    expect(intimacyLinesFor(a, b, 'Finn', ['lovers'], 70)).toEqual(['You and Finn are lovers.']);
  });

  it('aches for someone she is drawn to; not when the rule is off', () => {
    const a = insertAgent('Gia Orr', 'female');
    const b = insertAgent('Hal Orr', 'male');
    ensureAgentIntimacy(a.id).longing = 85;
    expect(intimacyLinesFor(a, b, 'Hal', [], 60)).toEqual(['You ache for Hal.']);
    expect(intimacyLinesFor(a, b, 'Hal', [], 10)).toEqual([]);
    setRuleOverrides({ adultContent: false });
    expect(intimacyLinesFor(a, b, 'Hal', [], 60)).toEqual([]);
  });

  it('hints when the one she is drawn to is already spoken for', () => {
    const a = insertAgent('Ida Pike', 'female');
    const b = insertAgent('Jon Pike', 'male');
    const c = insertAgent('Kay Pike', 'female');
    relate(b.id, c.id, [MARRIED_TAG]);
    expect(intimacyLinesFor(a, b, 'Jon', [], 60)).toEqual(['Jon is already spoken for by Kay.']);
    expect(intimacyLinesFor(a, b, 'Jon', [], 5)).toEqual([]);
  });

  it('minors get nothing even with a marriage, a kiss and a night on record', () => {
    const teen = insertAgent('Lou Reed', 'female', 17);
    const adult = insertAgent('Max Reed', 'male');
    const spouse = insertAgent('Ned Reed', 'male');
    relate(adult.id, spouse.id, [MARRIED_TAG]);
    updatePairIntimacy(teen.id, adult.id, (p) => { p.trysts = 2; p.secret = true; });
    ensureAgentIntimacy(teen.id).longing = 100;
    expect(intimacyLinesFor(teen, adult, 'Max', ['kissed', 'lovers', 'crush'], 90)).toEqual([]);
    expect(intimacyLinesFor(adult, teen, 'Lou', ['kissed', 'lovers', 'crush'], 90)).toEqual([]);
  });
});
