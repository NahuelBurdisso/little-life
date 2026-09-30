import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, needs, relationships, worldState } from '../../../db/schema';
import { computeRelationshipDeltas, type ConversationImpactContext } from '../../relationshipImpact';
import type { PersonalityProfile } from '../../personality';
import { chemistry, type RomanceParty } from '../attraction';
import {
  NEGLECT_DAYS, NEGLECT_LONGING_MIN, PARTNER_PULL_LONGING_MIN, WANDER_CHEMISTRY_MIN, WANDER_LOYALTY_BELOW,
  WANDER_ROMANCE_MULTIPLIER, WANDER_SCORE_BONUS, isNeglected, partnerPullBonus, wanderScoreBonus,
  type NeglectCtx,
} from '../neglect';
import { neglectedPartnerOf, wandersToward } from '../wandering';
import { committedTo } from '../committed';
import { clearIntimacy, ensureAgentIntimacy, updatePairIntimacy } from '../state';
import { setRuleOverrides } from '../../worldRules';
import { MARRIED_TAG } from '../../marriage';

/**
 * The wandering eye: who counts as neglected, what it does to romance gain toward
 * others (never the partner, never a minor) and to the evening's social score.
 * Pure rules first (every input injected), then the DB readers that feed them.
 */

const DAY = 24 * 60;
const NOW = 100 * DAY;

const neglected = (over: Partial<NeglectCtx> = {}): NeglectCtx => ({
  adultContent: true, spokenFor: true, longing: NEGLECT_LONGING_MIN, now: NOW, lastIntimateAt: NOW - (NEGLECT_DAYS * DAY + 1),
  ...over,
});

describe('isNeglected', () => {
  it('is a spoken-for adult, long unattended and aching', () => {
    expect(isNeglected({ age: 30 }, neglected())).toBe(true);
  });

  it('needs more than four days, and longing of 70', () => {
    expect(isNeglected({ age: 30 }, neglected({ lastIntimateAt: NOW - NEGLECT_DAYS * DAY }))).toBe(false);
    expect(isNeglected({ age: 30 }, neglected({ longing: NEGLECT_LONGING_MIN - 1 }))).toBe(false);
  });

  it('is not about the single and unknown: nobody to neglect them, or no way to tell', () => {
    expect(isNeglected({ age: 30 }, neglected({ spokenFor: false }))).toBe(false);
    expect(isNeglected({ age: 30 }, neglected({ lastIntimateAt: null }))).toBe(false);
  });

  it('is never true with the adult layer off, or for a minor', () => {
    expect(isNeglected({ age: 30 }, neglected({ adultContent: false }))).toBe(false);
    expect(isNeglected({ age: 17 }, neglected())).toBe(false);
    expect(isNeglected({ age: undefined as unknown as number }, neglected())).toBe(false);
  });
});

// ─── Romance gain ────────────────────────────────────────────────────────────

const personality = (loyalty: number): PersonalityProfile => ({
  honesty: 50, aggression: 30, warmth: 50, impulsiveness: 50, vanity: 40,
  curiosity: 50, loyalty, morality: 50, sensuality: 60, neuroticism: 40,
});

const wife: RomanceParty = { id: 1, age: 32, gender: 'female', orientation: 'straight' };
const stranger: RomanceParty = { id: 2, age: 34, gender: 'male', orientation: 'straight' };
const lad: RomanceParty = { id: 3, age: 16, gender: 'male', orientation: 'straight' };

function flirt(a: RomanceParty, b: RomanceParty, loyaltyA: number, over: Partial<ConversationImpactContext> = {}): ConversationImpactContext {
  return {
    overallSentiment: 0.7, turnCount: 6, topic: 'flirting',
    personalityA: personality(loyaltyA), personalityB: personality(50), compatibility: 1,
    existingFriendshipAB: 30, existingFriendshipBA: 30, existingRomanceAB: 10, existingRomanceBA: 10, isTemplate: false,
    partyA: a, partyB: b, worldSeed: 7, ...over,
  };
}

describe('romance gain of a neglected agent toward others', () => {
  it('a faithful one (loyalty 80) is unaffected', () => {
    const plain = computeRelationshipDeltas(flirt(wife, stranger, 80));
    const flagged = computeRelationshipDeltas(flirt(wife, stranger, 80, { neglectedA: true }));
    expect(flagged.romanceAB).toBe(plain.romanceAB);
  });

  it('a neglected one with loyalty under 50 gains 1.5x, only for their own side', () => {
    const plain = computeRelationshipDeltas(flirt(wife, stranger, WANDER_LOYALTY_BELOW - 1));
    const flagged = computeRelationshipDeltas(flirt(wife, stranger, WANDER_LOYALTY_BELOW - 1, { neglectedA: true }));
    expect(plain.romanceAB).toBeGreaterThan(0);
    expect(flagged.romanceAB).toBeCloseTo(plain.romanceAB * WANDER_ROMANCE_MULTIPLIER, 0);
    expect(flagged.romanceAB).toBeGreaterThan(plain.romanceAB);
    expect(flagged.romanceBA).toBe(plain.romanceBA);
  });

  it('loyalty exactly 50 does not wander', () => {
    const plain = computeRelationshipDeltas(flirt(wife, stranger, WANDER_LOYALTY_BELOW));
    const flagged = computeRelationshipDeltas(flirt(wife, stranger, WANDER_LOYALTY_BELOW, { neglectedA: true }));
    expect(flagged.romanceAB).toBe(plain.romanceAB);
  });

  it('applies to either side of the pair', () => {
    const plain = computeRelationshipDeltas(flirt(stranger, wife, 50, { personalityA: personality(50), personalityB: personality(20) }));
    const flagged = computeRelationshipDeltas(flirt(stranger, wife, 50, { personalityA: personality(50), personalityB: personality(20), neglectedB: true }));
    expect(flagged.romanceBA).toBeGreaterThan(plain.romanceBA);
    expect(flagged.romanceAB).toBe(plain.romanceAB);
  });

  it('a minor target gains nothing, neglect or not', () => {
    const d = computeRelationshipDeltas(flirt(wife, lad, 10, { neglectedA: true }));
    expect(d.romanceAB).toBe(0);
    const d2 = computeRelationshipDeltas(flirt(lad, wife, 50, { personalityA: personality(50), personalityB: personality(10), neglectedB: true }));
    expect(d2.romanceAB).toBe(0);
    expect(d2.romanceBA).toBe(0);
  });

  it('a cold chat is not softened: negative deltas are never scaled', () => {
    const plain = computeRelationshipDeltas(flirt(wife, stranger, 10, { overallSentiment: -0.6, topic: 'argument' }));
    const flagged = computeRelationshipDeltas(flirt(wife, stranger, 10, { overallSentiment: -0.6, topic: 'argument', neglectedA: true }));
    expect(flagged.romanceAB).toBe(plain.romanceAB);
  });
});

// ─── Decision scoring ────────────────────────────────────────────────────────

describe('wanderScoreBonus', () => {
  const find = (aId: number, wantHigh: boolean): number => {
    for (let id = 100; id < 400; id++) if ((chemistry(aId, id, 7) >= WANDER_CHEMISTRY_MIN) === wantHigh) return id;
    throw new Error('no pair found');
  };
  const other = (id: number, over: Partial<RomanceParty> = {}): RomanceParty => ({ id, age: 30, gender: 'male', orientation: 'straight', ...over });
  const ctx = (over: Partial<Parameters<typeof wanderScoreBonus>[0]> = {}) => ({
    neglected: true, loyalty: 30, self: wife, other: other(find(1, true)), worldSeed: 7, isPartner: false, ...over,
  });

  it('is +20 toward a chemistry-rich, attractive adult', () => {
    expect(wanderScoreBonus(ctx())).toBe(WANDER_SCORE_BONUS);
  });

  it('is 0 for a faithful agent, a not-neglected one, and for their own partner', () => {
    expect(wanderScoreBonus(ctx({ loyalty: 80 }))).toBe(0);
    expect(wanderScoreBonus(ctx({ neglected: false }))).toBe(0);
    expect(wanderScoreBonus(ctx({ isPartner: true }))).toBe(0);
  });

  it('is 0 without chemistry, without attraction, and for a minor', () => {
    expect(wanderScoreBonus(ctx({ other: other(find(1, false)) }))).toBe(0);
    expect(wanderScoreBonus(ctx({ other: other(find(1, true), { gender: 'female' }) }))).toBe(0);
    expect(wanderScoreBonus(ctx({ other: other(find(1, true), { age: 16 }) }))).toBe(0);
  });
});

describe('partnerPullBonus', () => {
  const pull = (over: Partial<Parameters<typeof partnerPullBonus>[0]> = {}) => partnerPullBonus({
    adultContent: true, evening: true, longing: 90, tags: ['partner'], status: 'partners', adults: true, ...over,
  });

  it('scales with longing (longing / 3) once it reaches 60', () => {
    expect(pull({ longing: PARTNER_PULL_LONGING_MIN })).toBeCloseTo(PARTNER_PULL_LONGING_MIN / 3);
    expect(pull({ longing: 90 })).toBeCloseTo(30);
    expect(pull({ longing: 90 })).toBeGreaterThan(pull({ longing: 66 }));
    expect(pull({ longing: PARTNER_PULL_LONGING_MIN - 1 })).toBe(0);
  });

  it('reaches partners, spouses, fiances and lovers, and nobody else', () => {
    for (const tags of [['married'], ['engaged'], ['lovers'], ['partner']]) expect(pull({ tags, status: 'friends' }), tags[0]).toBeGreaterThan(0);
    expect(pull({ tags: ['kissed'], status: 'friends' })).toBe(0);
  });

  it('is an evening thing, and only with the adult layer on and adults involved', () => {
    expect(pull({ evening: false })).toBe(0);
    expect(pull({ adultContent: false })).toBe(0);
    expect(pull({ adults: false })).toBe(0);
  });
});

// ─── DB readers ──────────────────────────────────────────────────────────────

describe('neglectedPartnerOf / wandersToward', () => {
  const made: number[] = [];
  let homeId = 0;

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

  function insertAgent(name: string, gender: string, loyalty: number, age = 30): number {
    const id = db.insert(agents).values({
      name, bio: 'test', traits: [], age, gender, orientation: 'straight',
      personality: { ...personality(loyalty) },
      sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
      current_action: { type: 'idle' }, action_started: 0, action_queue: [],
      schedule: { wakeTime: 6, sleepTime: 23, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
      home: homeId, current_location: null, created_at: 0, is_active: true,
    }).returning({ id: agents.id }).get().id;
    made.push(id);
    return id;
  }

  function relate(x: number, y: number, over: Partial<typeof relationships.$inferInsert> = {}): void {
    db.insert(relationships).values({
      agent_a: Math.min(x, y), agent_b: Math.max(x, y), friendship_ab: 70, friendship_ba: 70,
      romance_ab: 80, romance_ba: 80, trust_ab: 70, trust_ba: 70, familiarity: 80, interaction_count: 40,
      last_interaction: 0, average_interaction_sentiment: 0.5, tags: ['partner'], status: 'partners',
      status_since_minute: NOW - 30 * DAY, created_at: 0, last_updated: 0, ...over,
    }).run();
  }

  beforeAll(() => {
    setClock();
    homeId = db.insert(locations).values({
      name: 'Wandering Cottage', type: 'home', position: { x: 0, y: 0, width: 96, height: 96 }, entry_point: { x: 0, y: 96 },
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

  function couple(loyalty = 30, over: Partial<typeof relationships.$inferInsert> = {}) {
    const a = insertAgent(`Wife ${made.length}`, 'female', loyalty);
    const h = insertAgent(`Husband ${made.length}`, 'male', 50);
    relate(a, h, over);
    return { a, h, agent: { id: a, age: 30 } };
  }

  it('committedTo finds a spouse before a fiance before a partner, ignores `except` and the dead', () => {
    const { a, h } = couple();
    expect(committedTo(a)).toBe(h);
    expect(committedTo(a, h)).toBeNull();
    db.update(agents).set({ is_active: false }).where(eq(agents.id, h)).run();
    expect(committedTo(a)).toBeNull();
    db.update(agents).set({ is_active: true }).where(eq(agents.id, h)).run();
    const suitor = insertAgent(`Suitor ${made.length}`, 'male', 50);
    relate(a, suitor, { tags: [MARRIED_TAG], status: 'friends' });
    expect(committedTo(a)).toBe(suitor);
    expect(committedTo(a, suitor)).toBe(h);
  });

  it('is neglected once the partnership is over four days old with no night and longing 70', () => {
    const { a, h, agent } = couple();
    ensureAgentIntimacy(a).longing = 80;
    expect(neglectedPartnerOf(agent, NOW)).toBe(h);
  });

  it('a recent night together with the partner clears it', () => {
    const { a, h, agent } = couple();
    ensureAgentIntimacy(a).longing = 80;
    updatePairIntimacy(a, h, (p) => { p.lastTrystAt = NOW - DAY; });
    expect(neglectedPartnerOf(agent, NOW)).toBeNull();
    updatePairIntimacy(a, h, (p) => { p.lastTrystAt = NOW - 5 * DAY; });
    expect(neglectedPartnerOf(agent, NOW)).toBe(h);
  });

  it('a partnership younger than four days, an unknown start, low longing or the rule off is not neglect', () => {
    const young = couple(30, { status_since_minute: NOW - DAY });
    ensureAgentIntimacy(young.a).longing = 95;
    expect(neglectedPartnerOf(young.agent, NOW)).toBeNull();

    const unknown = couple(30, { status_since_minute: null });
    ensureAgentIntimacy(unknown.a).longing = 95;
    expect(neglectedPartnerOf(unknown.agent, NOW)).toBeNull();

    const cool = couple();
    ensureAgentIntimacy(cool.a).longing = 40;
    expect(neglectedPartnerOf(cool.agent, NOW)).toBeNull();

    const off = couple();
    ensureAgentIntimacy(off.a).longing = 95;
    setRuleOverrides({ adultContent: false });
    expect(neglectedPartnerOf(off.agent, NOW)).toBeNull();
  });

  it('wandersToward: a neglected pair member for everyone but the partner, never for a minor', () => {
    const { a, h, agent } = couple(30);
    ensureAgentIntimacy(a).longing = 80;
    const other = insertAgent(`Other ${made.length}`, 'male', 50);
    const minor = insertAgent(`Minor ${made.length}`, 'male', 50, 16);
    expect(wandersToward(agent, { id: other, age: 30 }, NOW)).toBe(true);
    expect(wandersToward(agent, { id: h, age: 30 }, NOW)).toBe(false);
    expect(wandersToward(agent, { id: minor, age: 16 }, NOW)).toBe(false);
  });
});
