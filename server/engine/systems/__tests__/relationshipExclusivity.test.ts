import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, relationshipEvents, relationships } from '../../../db/schema';
import { deriveStatus, holdsPartnerElsewhere, tick as relationshipsTick } from '../relationships';
import { gameMinutes } from '../../../lib/gameClock';

/**
 * Partner exclusivity at the one place a relationship becomes `partners` (the relationship tick).
 *
 * Before this a person could be `partners` with any number of people at once: every pair that
 * crossed the romance thresholds was promoted on its own, and a 30-day soak ended with 6-14
 * partner pairs in a 32-resident town, several of them sharing a person. Now a pair that would
 * newly become partners while either of them already holds a partner elsewhere (someone alive and
 * in town) stays a `romantic_interest` with a `crush` tag instead. Incumbents are grandfathered
 * (an existing partner row is never demoted by the tick), and a marriage is never blocked.
 *
 * The romance-choke-point harness, but with ACTIVE agents (a dead or departed partner does not
 * block); they stand nowhere (`current_location` null) so the proximity pass leaves them alone.
 */

const TIME = { day: 30, hour: 10, minute: 0 };
const NOW_MINUTES = gameMinutes(TIME);
const WORLD = { time: TIME, tick_speed: 1, pending_transitions: [] };
/** The decay pass only runs on the hour rollover. */
const HOUR_WORLD = { time: TIME, tick_speed: 1, pending_transitions: [{ type: 'hour_changed' }] };

const ids: number[] = [];
let homeId: number;

function person(name: string, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], personality: null, age: 30, gender: 'male', orientation: 'bi',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  ids.push(id);
  return id;
}

function pair(x: number, y: number, over: Partial<typeof relationships.$inferInsert> = {}): number {
  return db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y),
    friendship_ab: 60, friendship_ba: 60, romance_ab: 10, romance_ba: 10,
    trust_ab: 40, trust_ba: 40, familiarity: 60, interaction_count: 5,
    last_interaction: 0, last_interaction_minute: NOW_MINUTES,
    average_interaction_sentiment: 0.2, tags: [], status: 'friends',
    status_since_minute: NOW_MINUTES, created_at: 0, last_updated: 0, ...over,
  }).returning({ id: relationships.id }).get().id;
}

/** Already a couple: romance far past the line, tags and status as the tick would have written them. */
const couple = (x: number, y: number, tags: string[] = ['partner'], sinceMinute = NOW_MINUTES - 5000) =>
  pair(x, y, { romance_ab: 85, romance_ba: 85, tags, status: 'partners', status_since_minute: sinceMinute });

/** A pair sitting just under the partnership line: one romantic event pushes it over. */
const almost = (x: number, y: number, over: Partial<typeof relationships.$inferInsert> = {}) =>
  pair(x, y, { romance_ab: 68, romance_ba: 68, tags: ['crush'], status: 'romantic_interest', ...over });

function push(x: number, y: number, romance = 12): void {
  db.insert(relationshipEvents).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y), event_type: 'conversation', description: 'test',
    friendship_delta_ab: 1, friendship_delta_ba: 1, romance_delta_ab: romance, romance_delta_ba: romance,
    trust_delta_ab: 0, trust_delta_ba: 0, sentiment: 0.3, processed: false, timestamp: Date.now(),
  }).run();
}

const row = (id: number) => db.select().from(relationships).where(eq(relationships.id, id)).get()!;

beforeAll(() => {
  homeId = db.insert(locations).values({
    name: 'Exclusivity Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 0, y: 0 }, capacity: 4, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
});

afterEach(() => {
  // Rows are per test: a leftover partner row would block the next test's pairs.
  db.delete(relationshipEvents).where(inArray(relationshipEvents.agent_a, ids)).run();
  db.delete(relationships).where(inArray(relationships.agent_a, ids)).run();
  db.delete(agents).where(inArray(agents.id, ids)).run();
  ids.length = 0;
});

afterAll(() => {
  db.delete(locations).where(eq(locations.id, homeId)).run();
});

describe('deriveStatus with a blocked partnership', () => {
  const past = [60, 60, 85, 85, 40, 60] as const;

  it('reads as a romantic interest instead of partners, only when blocked', () => {
    expect(deriveStatus(...past)).toBe('partners');
    expect(deriveStatus(...past, false, false, true)).toBe('romantic_interest');
  });

  it('never touches a marriage or estrangement, which are decided first', () => {
    expect(deriveStatus(...past, false, true, true)).toBe('partners');
    expect(deriveStatus(...past, true, false, true)).toBe('estranged');
  });
});

describe('holdsPartnerElsewhere', () => {
  const rowOf = (a: number, b: number, status: string, tags: string[] = []) =>
    ({ agent_a: a, agent_b: b, status, tags }) as typeof relationships.$inferSelect;
  const map = (...rows: Array<ReturnType<typeof rowOf>>) => new Map(rows.map((r) => [`${r.agent_a}:${r.agent_b}`, r]));

  it('sees a live partner other than the counterpart, by status or by tag', () => {
    const active = new Set([1, 2, 3]);
    expect(holdsPartnerElsewhere(map(rowOf(1, 2, 'partners')), active, 1, 3)).toBe(true);
    expect(holdsPartnerElsewhere(map(rowOf(2, 3, 'friends', ['partner'])), active, 3, 1)).toBe(true);
    // The counterpart itself is not "elsewhere", nor is a partner who is gone, nor a plain crush.
    expect(holdsPartnerElsewhere(map(rowOf(1, 3, 'partners')), active, 1, 3)).toBe(false);
    expect(holdsPartnerElsewhere(map(rowOf(1, 2, 'partners')), new Set([1, 3]), 1, 3)).toBe(false);
    expect(holdsPartnerElsewhere(map(rowOf(1, 2, 'romantic_interest', ['crush'])), active, 1, 3)).toBe(false);
  });
});

describe('the relationship tick and partner exclusivity', () => {
  it('a pair that crosses the line becomes partners when nobody is spoken for', () => {
    const [a, b] = [person('Free Anselm'), person('Free Beatrix')];
    const p = almost(a, b);
    push(a, b);
    relationshipsTick(WORLD);
    expect(row(p).status).toBe('partners');
    expect(row(p).tags).toContain('partner');
  });

  it('a pair pushed past the thresholds while one of them has a partner stays a romantic interest with a crush', () => {
    const [a, b, c] = [person('Held Ambrose'), person('Held Bertil'), person('Held Cosima')];
    const ab = couple(a, b);
    const ac = almost(a, c);
    push(a, c);
    relationshipsTick(WORLD);
    const blocked = row(ac);
    expect(blocked.status).toBe('romantic_interest');
    expect(blocked.tags).toContain('crush');
    expect(blocked.tags).not.toContain('partner');
    // Romance itself still grew: it is the label that waits, not the feeling.
    expect(blocked.romance_ab).toBeGreaterThan(68);
    // The incumbents are untouched.
    expect(row(ab).status).toBe('partners');
    expect(row(ab).tags).toContain('partner');
  });

  it('holds when it is the OTHER side who is spoken for', () => {
    const [a, b, c] = [person('Side Alma'), person('Side Bram'), person('Side Cyril')];
    couple(b, c);
    const ab = almost(a, b);
    push(a, b);
    relationshipsTick(WORLD);
    expect(row(ab).status).toBe('romantic_interest');
    expect(row(ab).tags).not.toContain('partner');
  });

  it('a marriage overrides: a pair that carries the married tag is partners whoever else is around', () => {
    const [a, b, c] = [person('Wed Augusta'), person('Wed Benedikt'), person('Wed Clara')];
    couple(a, b);
    const ac = pair(a, c, { romance_ab: 68, romance_ba: 68, tags: ['partner', 'married'], status: 'partners' });
    push(a, c);
    relationshipsTick(WORLD);
    expect(row(ac).status).toBe('partners');
    expect(row(ac).tags).toContain('partner');
  });

  it('once the partner is inactive the pair is promoted', () => {
    const [a, b, c] = [person('Gone Aurelia'), person('Gone Bertrand'), person('Gone Camille')];
    couple(a, b);
    const ac = almost(a, c);
    push(a, c);
    relationshipsTick(WORLD);
    expect(row(ac).status).toBe('romantic_interest');

    db.update(agents).set({ is_active: false }).where(eq(agents.id, b)).run();
    push(a, c, 2);
    relationshipsTick(WORLD);
    expect(row(ac).status).toBe('partners');
    expect(row(ac).tags).toContain('partner');
  });

  it('two pairs of one person qualifying in the same tick make exactly one partnership', () => {
    const [a, b, c] = [person('Rush Adelheid'), person('Rush Benno'), person('Rush Cordelia')];
    const ab = almost(a, b);
    const ac = almost(a, c);
    push(a, b);
    push(a, c);
    relationshipsTick(WORLD);
    const statuses = [row(ab).status, row(ac).status];
    expect(statuses.filter((s) => s === 'partners')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'romantic_interest')).toHaveLength(1);
    const loser = row(ab).status === 'partners' ? row(ac) : row(ab);
    expect(loser.tags).toContain('crush');
    expect(loser.tags).not.toContain('partner');
  });

  it('a married or engaged person caps every other pair, and a married pair itself is untouched', () => {
    const [a, b, c, d] = [person('Cap Aldous'), person('Cap Bettina'), person('Cap Cassian'), person('Cap Dorothea')];
    const married = couple(a, b, ['partner', 'married']);
    const engaged = couple(c, d, ['partner', 'engaged']);
    const ac = almost(a, c);
    const bd = almost(b, d);
    push(a, c);
    push(b, d);
    relationshipsTick(WORLD);
    expect(row(ac).status).toBe('romantic_interest');
    expect(row(bd).status).toBe('romantic_interest');
    expect(row(married).status).toBe('partners');
    expect(row(engaged).status).toBe('partners');
  });

  it('an incumbent double partnership is grandfathered: events on either row keep both as they are', () => {
    const [a, b, c] = [person('Old Amalric'), person('Old Brunhild'), person('Old Cedric')];
    const ab = couple(a, b);
    const ac = couple(a, c);
    push(a, b, 1);
    push(a, c, 1);
    relationshipsTick(WORLD);
    expect(row(ab).status).toBe('partners');
    expect(row(ac).status).toBe('partners');
    expect(row(ac).tags).toContain('partner');
  });

  it('the decay pass does not flip a blocked pair to partners while the incumbent stands', () => {
    const [a, b, c] = [person('Slow Adalbert'), person('Slow Bertha'), person('Slow Caspar')];
    couple(a, b);
    // Blocked: romance far past the line but never promoted, and quiet long enough for decay to run.
    const ac = pair(a, c, {
      romance_ab: 90, romance_ba: 90, friendship_ab: 60, friendship_ba: 60, tags: ['crush'], status: 'romantic_interest',
      last_interaction_minute: NOW_MINUTES - 60 * 1440,
    });
    relationshipsTick(HOUR_WORLD);
    const after = row(ac);
    expect(after.romance_ab).toBeLessThan(90); // decay really ran
    expect(after.status).toBe('romantic_interest');
  });

  it('a blocked pair still decays to partners once the incumbent is gone (the guard is the incumbent, not the row)', () => {
    const [a, b, c] = [person('Later Adolphus'), person('Later Benita'), person('Later Cato')];
    couple(a, b);
    db.update(agents).set({ is_active: false }).where(eq(agents.id, b)).run();
    const ac = pair(a, c, {
      romance_ab: 90, romance_ba: 90, friendship_ab: 60, friendship_ba: 60, tags: ['crush'], status: 'romantic_interest',
      last_interaction_minute: NOW_MINUTES - 60 * 1440,
    });
    relationshipsTick(HOUR_WORLD);
    expect(row(ac).status).toBe('partners');
  });
});
