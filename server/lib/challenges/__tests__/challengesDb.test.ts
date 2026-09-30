import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { activityLog, agents, locations, relationships, shared_knowledge, worldState } from '../../../db/schema';
import { ALL_TABLES } from '../../../db/worldTables';
import { challengesRouter } from '../../../routers/challenges';
import { clearRulesCache, setRuleOverrides } from '../../worldRules';
import { persistAutoplayConfig } from '../../autoplaySettings';
import { logActivity } from '../../activityLogger';
import { alertTier } from '../../alertTiers';
import {
  CHALLENGE_KINDS, FULL_HOUSE_EXTRA, MATCH_ROMANCE_MAX, MATCH_ROMANCE_MIN, MINUTES_PER_DAY, OFFER_COUNT, pairOf,
} from '../catalog';
import { readTownSnapshot } from '../snapshot';
import { buildOffers, loneliest } from '../suggest';
import { emptyStore, loadStore, parseStore, recordHandsOn, saveStore } from '../store';
import { emitter } from '../../../engine/emitter';
import { runChallengeChecks } from '../evaluate';
import type { Challenge, ChallengeKind } from '../catalog';

/**
 * Against a real (test) database: the snapshot reads what the evaluator and the
 * offer builder need, offers built from it name real pairs, the store survives
 * a round trip through `rule_overrides` next to the other keys living there,
 * and a settled challenge writes its feed row.
 */

const DAY = MINUTES_PER_DAY;
const caller = challengesRouter.createCaller({} as any);

let loc = 0;
const ids: Record<string, number> = {};

function setClock(totalMinutes: number): void {
  const time = {
    day: Math.floor(totalMinutes / DAY),
    hour: Math.floor((totalMinutes % DAY) / 60),
    minute: totalMinutes % 60,
    totalTicks: totalMinutes,
    seasonDay: Math.floor(totalMinutes / DAY) % 28,
    season: 'spring',
  };
  db.update(worldState).set({ time }).run();
}

function insertAgent(name: string, o: { age?: number; active?: boolean; action?: string; gender?: string } = {}): number {
  return db.insert(agents).values({
    name, bio: 'test', traits: [], personality: null, age: o.age ?? 30, gender: o.gender ?? 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 }, current_location: loc,
    current_action: { type: o.action ?? 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: loc, created_at: 0, is_active: o.active ?? true,
  }).returning({ id: agents.id }).get().id;
}

function relate(x: number, y: number, v: { f: number; r?: number; status: string; tags?: string[] }): void {
  db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y),
    friendship_ab: v.f, friendship_ba: v.f, romance_ab: v.r ?? 0, romance_ba: (v.r ?? 0) - 5,
    trust_ab: 0, trust_ba: 0, familiarity: 40, interaction_count: 5, last_interaction: 0,
    average_interaction_sentiment: 0, tags: v.tags ?? [], status: v.status, created_at: 0, last_updated: 0,
  }).run();
}

function secret(subject: number, isPublic = false): number {
  return db.insert(shared_knowledge).values({
    type: 'secret', subject_id: subject, target_id: null, content: `secret about ${subject}`,
    sensitivity: 3, known_by: [subject], created_at: 0, source: 'seed', is_public: isPublic,
  }).returning({ id: shared_knowledge.id }).get().id;
}

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const t of ALL_TABLES) db.delete(t).run();
  loc = db.insert(locations).values({
    name: 'Challenge Square', type: 'town_square', position: { x: 0, y: 0, width: 10, height: 10 },
    entry_point: { x: 0, y: 0 }, capacity: 10, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  db.insert(worldState).values({
    time: { day: 5, hour: 9, minute: 0, totalTicks: 0, seasonDay: 5, season: 'spring' },
    day_phase: 'morning', weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true,
    last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
    map_width: 40, map_height: 30, collision_grid: '',
  }).run();

  ids.ada = insertAgent('Ada Lark');
  ids.tom = insertAgent('Tom Reed', { gender: 'male' });
  ids.bea = insertAgent('Bea Stone');
  ids.cal = insertAgent('Cal Moss');
  ids.kid = insertAgent('Kit Young', { age: 12 });
  ids.dan = insertAgent('Dan Old', { active: false, action: 'dead' });
  ids.eve = insertAgent('Eve Gone', { active: false });

  relate(ids.ada, ids.tom, { f: 30, r: 32, status: 'romantic_interest' }); // the matchmaker pair
  relate(ids.bea, ids.kid, { f: 20, r: 35, status: 'romantic_interest' }); // a child: never offered
  relate(ids.bea, ids.cal, { f: -75, status: 'enemies' });                // the peacemaker pair
  relate(ids.ada, ids.bea, { f: 55, status: 'friends' });                 // a friendship to break
  relate(ids.tom, ids.cal, { f: 12, status: 'acquaintances' });
  secret(ids.ada); secret(ids.tom); secret(ids.bea); secret(ids.cal, true);
});

afterAll(() => {
  for (const t of ALL_TABLES) db.delete(t).run();
  clearRulesCache();
  vi.restoreAllMocks();
});

beforeEach(() => {
  db.update(worldState).set({ rule_overrides: null }).run();
  clearRulesCache();
  setClock(5 * DAY + 9 * 60);
});

describe('snapshot', () => {
  it('reads the town as the checks need it', () => {
    const snap = readTownSnapshot(0)!;
    expect(snap.day).toBe(5);
    expect(snap.seasonEndMinute).toBe(28 * DAY);
    expect(snap.agents.find((a) => a.id === ids.dan)).toMatchObject({ active: false, dead: true });
    expect(snap.agents.find((a) => a.id === ids.eve)).toMatchObject({ active: false, dead: false });
    expect(pairOf(snap, ids.tom, ids.ada)).toMatchObject({ friendship: 30, romanceMax: 32, romanceMin: 27 });
    expect(snap.hiddenSecretCount).toBe(3);
    expect(snap.publicSecretIds).toHaveLength(1);
  });

  it('counts the player\'s action rows but not the reports on them', () => {
    const before = readTownSnapshot(0)!.lastPlayerActionId;
    logActivity({ type: 'player_outcome', templateData: { description: 'x' } });
    expect(readTownSnapshot(0)!.lastPlayerActionId).toBe(before);
    logActivity({ type: 'player_gift', templateData: { description: 'x' } });
    expect(readTownSnapshot(0)!.lastPlayerActionId).toBeGreaterThan(before);
  });
});

describe('suggest', () => {
  it('builds valid offers from the live town', () => {
    const snap = readTownSnapshot(0)!;
    let n = 1;
    // Several seeds: every draw must be valid, whichever kinds it lands on.
    for (let seed = 0; seed < 12; seed++) {
      let s = seed + 1;
      const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const offers = buildOffers(snap, rng, () => `c${n++}`);
      expect(offers).toHaveLength(OFFER_COUNT);
      expect(new Set(offers.map((o) => o.kind)).size).toBe(OFFER_COUNT);
      // Varied difficulty: this town supports all three tiers.
      expect(new Set(offers.map((o) => o.difficulty))).toEqual(new Set(['easy', 'medium', 'hard']));
      for (const o of offers) {
        expect(o.status).toBe('offered');
        expect(CHALLENGE_KINDS[o.kind]).toBeDefined();
        expect(o.durationDays).toBeGreaterThan(0);
        for (const id of o.agentIds) expect(snap.agents.find((a) => a.id === id)?.active).toBe(true);
        if (o.kind === 'matchmaker') {
          const p = pairOf(snap, o.agentIds[0], o.agentIds[1]);
          expect(p.romanceMax).toBeGreaterThanOrEqual(MATCH_ROMANCE_MIN);
          expect(p.romanceMax).toBeLessThanOrEqual(MATCH_ROMANCE_MAX);
          expect(o.agentIds).not.toContain(ids.kid);
          expect(o.goal).toBe('Get Ada and Tom married');
        }
        if (o.kind === 'peacemaker') {
          expect(o.agentIds.sort()).toEqual([ids.bea, ids.cal].sort());
          expect(o.difficulty).toBe('hard');
        }
        if (o.kind === 'full_house') expect(o.target).toBe(5 + FULL_HOUSE_EXTRA);
      }
    }
  });

  it('picks the resident with the weakest ties as the recluse', () => {
    // Kit's only tie is 20, Cal's best is 12: Cal is lonelier.
    expect(loneliest(readTownSnapshot(0)!)?.id).toBe(ids.cal);
  });

  it('leaves out Guardian when nobody can die', () => {
    setRuleOverrides({ deathEnabled: false });
    const snap = readTownSnapshot(0)!;
    for (let i = 0; i < 20; i++) {
      expect(buildOffers(snap, Math.random, () => 'x').some((o) => o.kind === 'guardian')).toBe(false);
    }
  });
});

describe('persistence', () => {
  it('round-trips through rule_overrides next to the rules and autoplay', () => {
    setRuleOverrides({ dramaIntensity: 'high' });
    const store = emptyStore();
    store.handsOnCount = 4;
    store.nextId = 9;
    saveStore(store);
    persistAutoplayConfig();
    // A rules change after the save must carry the challenges through.
    setRuleOverrides({ sicknessRate: 'low' });

    const row = db.select({ o: worldState.rule_overrides }).from(worldState).get()!.o!;
    expect(row.dramaIntensity).toBe('high');
    expect(row.sicknessRate).toBe('low');
    expect(row.autoplay).toBeDefined();
    expect(loadStore()).toMatchObject({ handsOnCount: 4, nextId: 9 });
  });

  it('keeps the well-formed parts of a damaged blob', () => {
    const s = parseStore({
      active: [{ id: 'c7', kind: 'feud', goal: 'g', agentIds: [], durationDays: 6, status: 'active' }, { junk: true }],
      history: 'nope',
      nextId: 2,
    });
    expect(s.active).toHaveLength(1);
    expect(s.history).toEqual([]);
    // The counter never hands out an id already in use.
    expect(s.nextId).toBe(8);
  });

  it('recordHandsOn bumps the counter', () => {
    saveStore(emptyStore());
    recordHandsOn();
    recordHandsOn();
    expect(loadStore()!.handsOnCount).toBe(2);
  });
});

describe('router + hourly check', () => {
  it('offers, accepts, settles and logs a player-tier feed row', async () => {
    const view = await caller.list();
    expect(view!.offers).toHaveLength(OFFER_COUNT);
    // Same day: the same offers come back.
    expect((await caller.list())!.offers.map((o) => o.id)).toEqual(view!.offers.map((o) => o.id));

    // Accept a hands-off challenge built on purpose (the random menu may not hold one).
    const store = loadStore()!;
    store.offers = [{ id: 'c50', kind: 'hands_off', difficulty: 'easy', goal: 'Hands off', agentIds: [], durationDays: 2, status: 'offered', offeredAt: 0 }];
    store.nextId = 51;
    saveStore(store);
    const res = await caller.choose({ id: 'c50' });
    expect(res.ok).toBe(true);
    expect((await caller.choose({ id: 'c50' })).ok).toBe(false);

    const running = (await caller.list())!;
    expect(running.active.map((c) => c.id)).toEqual(['c50']);
    expect(running.offers.some((o) => o.kind === 'hands_off')).toBe(false);

    // A day in: still running, nothing logged.
    setClock(6 * DAY + 9 * 60);
    expect(runChallengeChecks()).toEqual([]);

    // Two days in: done.
    setClock(7 * DAY + 9 * 60);
    const ended = runChallengeChecks();
    expect(ended.map((c) => c.status)).toEqual(['completed']);
    const after = loadStore()!;
    expect(after.active).toEqual([]);
    expect(after.history[0]).toMatchObject({ id: 'c50', status: 'completed' });

    const row = db.select().from(activityLog).where(eq(activityLog.type, 'challenge_completed')).orderBy(desc(activityLog.id)).get()!;
    expect(row.category).toBe('player');
    expect(String(row.template_data.description)).toMatch(/Hands off/);
    expect(alertTier(row)).toBe('player');
  });

  it('a nudge fails hands-off at the next check', async () => {
    const store = emptyStore();
    store.offers = [{ id: 'c1', kind: 'hands_off', difficulty: 'easy', goal: 'Hands off', agentIds: [], durationDays: 2, status: 'offered', offeredAt: 0 }];
    store.offersDay = 5;
    saveStore(store);
    await caller.choose({ id: 'c1' });
    logActivity({ type: 'player_nudge', templateData: { description: 'poke' } });
    const ended = runChallengeChecks();
    expect(ended[0]).toMatchObject({ status: 'failed', outcome: 'You meddled.' });
    expect(db.select().from(activityLog).where(eq(activityLog.type, 'challenge_failed')).all().length).toBeGreaterThan(0);
  });

  it('abandon moves a challenge to the history without a feed row', async () => {
    const store = emptyStore();
    store.offers = [{ id: 'c1', kind: 'feud', difficulty: 'medium', goal: 'Feud', agentIds: [], durationDays: 6, status: 'offered', offeredAt: 0 }];
    store.offersDay = 5;
    saveStore(store);
    await caller.choose({ id: 'c1' });
    const before = db.select().from(activityLog).all().length;
    expect((await caller.abandon({ id: 'c1' })).ok).toBe(true);
    expect(loadStore()!.history[0]).toMatchObject({ id: 'c1', status: 'abandoned' });
    expect(db.select().from(activityLog).all().length).toBe(before);
  });

  it('logs a surviving winter once, and only a fully watched one', () => {
    saveStore(emptyStore());
    const at = (season: string, day: number) =>
      db.update(worldState).set({ time: { day, hour: 9, minute: 0, totalTicks: 0, seasonDay: day % 28, season } }).run();
    const count = () => db.select().from(activityLog).where(eq(activityLog.type, 'season_survived')).all().length;
    const start = count();

    at('winter', 90); runChallengeChecks();   // first watch starts mid-winter
    at('spring', 112); runChallengeChecks();  // ...so this winter doesn't count
    expect(count()).toBe(start);
    at('winter', 196); runChallengeChecks();  // a winter watched from its start
    at('spring', 224); runChallengeChecks();
    expect(count()).toBe(start + 1);
    at('summer', 252); runChallengeChecks();  // not a winter
    expect(count()).toBe(start + 1);
  });
});

/**
 * "Set a goal" from the pair dossier (service.ts `aimAtPair`): an aim is stored
 * like an accepted offer, tagged `source: 'aim'`, under the same cap and
 * one-per-kind rules, and refuses what can never happen with a sentence the
 * toast shows.
 */
describe('aimAtPair', () => {
  const aims = challengesRouter.createCaller({} as any);
  const sorted = (...xs: number[]) => [...xs].sort((x, y) => x - y);

  function running(kind: ChallengeKind, id: string): Challenge {
    return {
      id, kind, difficulty: 'easy', goal: kind, agentIds: [], durationDays: 3, status: 'active',
      offeredAt: 0, startedAt: 0, deadline: 99 * DAY, baseline: {},
    };
  }

  beforeAll(() => {
    ids.gina = insertAgent('Gina Wed', { gender: 'female' });
    ids.hal = insertAgent('Hal Wed', { gender: 'male' });
    ids.ivy = insertAgent('Ivy Free', { gender: 'female' });
    ids.jon = insertAgent('Jon Pal', { gender: 'male' });
    relate(ids.gina, ids.hal, { f: 80, r: 90, status: 'partners', tags: ['married'] });
    relate(ids.ivy, ids.jon, { f: 60, status: 'friends' });
    relate(ids.hal, ids.ivy, { f: 10, r: 30, status: 'acquaintances' });
    relate(ids.ada, ids.jon, { f: 0, status: 'acquaintances' });
  });

  it("stores the aim as a running challenge tagged as the player's own", async () => {
    const res = await aims.aimAtPair({ a: ids.tom, b: ids.ada, aim: 'marry' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.challenge).toMatchObject({
      kind: 'matchmaker', source: 'aim', status: 'active', agentIds: sorted(ids.ada, ids.tom),
      goal: 'Get Ada and Tom married (your aim)', durationDays: 14,
    });
    expect(res.challenge.progress).toBeDefined();
    const stored = loadStore()!;
    expect(stored.active).toHaveLength(1);
    expect(stored.active[0]).toMatchObject({ id: res.challenge.id, source: 'aim' });
    // The id never collides with an offer's.
    expect(stored.nextId).toBeGreaterThan(Number(res.challenge.id.slice(1)));
  });

  it('keeps the tag through the stored blob', async () => {
    await aims.aimAtPair({ a: ids.ada, b: ids.tom, aim: 'marry' });
    expect(loadStore()!.active[0].source).toBe('aim');
    expect(parseStore(JSON.parse(JSON.stringify(loadStore()))).active[0].source).toBe('aim');
  });

  it("drops the day's offer of the same kind, since it could no longer be accepted", async () => {
    await aims.list();
    const store = loadStore()!;
    store.offers = [
      { id: 'c60', kind: 'matchmaker', difficulty: 'hard', goal: 'Other', agentIds: [ids.ada, ids.tom], durationDays: 14, status: 'offered', offeredAt: 0 },
      { id: 'c61', kind: 'hands_off', difficulty: 'easy', goal: 'Hands', agentIds: [], durationDays: 2, status: 'offered', offeredAt: 0 },
    ];
    store.offersDay = 5;
    store.nextId = 70;
    saveStore(store);
    expect((await aims.aimAtPair({ a: ids.ada, b: ids.tom, aim: 'marry' })).ok).toBe(true);
    expect(loadStore()!.offers.map((o) => o.id)).toEqual(['c61']);
  });

  it('marks the challenges channel dirty and announces it', async () => {
    const seen: string[] = [];
    const unsub = emitter.subscribe('challenges', (d) => seen.push(d.channel));
    try {
      await aims.aimAtPair({ a: ids.ada, b: ids.tom, aim: 'marry' });
    } finally {
      unsub();
    }
    expect(seen).toEqual(['challenges']);
  });

  it('a refusal changes nothing and stays quiet on the channel', async () => {
    const seen: string[] = [];
    const unsub = emitter.subscribe('challenges', (d) => seen.push(d.channel));
    try {
      expect((await aims.aimAtPair({ a: ids.bea, b: ids.kid, aim: 'marry' })).ok).toBe(false);
    } finally {
      unsub();
    }
    expect(seen).toEqual([]);
    expect(loadStore()?.active ?? []).toEqual([]);
  });

  it('refuses a minor for marry', async () => {
    const res = await aims.aimAtPair({ a: ids.bea, b: ids.kid, aim: 'marry' });
    expect(res).toEqual({ ok: false, reason: 'Kit is too young to marry' });
  });

  it('refuses someone who is spoken for, and a couple already married', async () => {
    const other = await aims.aimAtPair({ a: ids.hal, b: ids.ivy, aim: 'marry' });
    expect(other).toEqual({ ok: false, reason: 'Hal is already engaged or married to someone else' });
    const each = await aims.aimAtPair({ a: ids.gina, b: ids.hal, aim: 'marry' });
    expect(each).toEqual({ ok: false, reason: 'Gina and Hal are already married' });
  });

  it('refuses a pair who could never fall for each other', async () => {
    // Ada and Gina are both women drawn to men (orientation defaults to straight).
    const res = await aims.aimAtPair({ a: ids.ada, b: ids.gina, aim: 'marry' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/aren't drawn to each other/);
  });

  it('refuses an already-friends pair for befriend, and rivals for sunder', async () => {
    expect(await aims.aimAtPair({ a: ids.ivy, b: ids.jon, aim: 'befriend' }))
      .toEqual({ ok: false, reason: 'Ivy and Jon are already friends' });
    expect(await aims.aimAtPair({ a: ids.bea, b: ids.cal, aim: 'sunder' }))
      .toEqual({ ok: false, reason: 'Bea and Cal are already at odds' });
  });

  it('refuses two residents who are the same, gone, or dead', async () => {
    expect((await aims.aimAtPair({ a: ids.ada, b: ids.ada, aim: 'befriend' })).ok).toBe(false);
    expect(await aims.aimAtPair({ a: ids.ada, b: ids.dan, aim: 'befriend' }))
      .toEqual({ ok: false, reason: "Dan isn't in town any more" });
    expect((await aims.aimAtPair({ a: ids.eve, b: ids.ada, aim: 'sunder' })).ok).toBe(false);
  });

  it('aims a feud at just that pair, and befriend at a pair of enemies', async () => {
    const sunder = await aims.aimAtPair({ a: ids.ivy, b: ids.jon, aim: 'sunder' });
    expect(sunder.ok).toBe(true);
    if (sunder.ok) expect(sunder.challenge.baseline?.friendPairs).toEqual([sorted(ids.ivy, ids.jon)]);
    const peace = await aims.aimAtPair({ a: ids.cal, b: ids.bea, aim: 'befriend' });
    expect(peace.ok).toBe(true);
    if (peace.ok) expect(peace.challenge).toMatchObject({ kind: 'peacemaker', difficulty: 'hard', source: 'aim' });
  });

  it('a running challenge of the same kind blocks the aim', async () => {
    const store = emptyStore();
    store.active = [running('feud', 'c1')];
    saveStore(store);
    expect(await aims.aimAtPair({ a: ids.ivy, b: ids.jon, aim: 'sunder' }))
      .toEqual({ ok: false, reason: 'You are already running one like it' });
  });

  it('refuses a fourth challenge beyond the cap', async () => {
    const store = emptyStore();
    store.active = [running('guardian', 'c1'), running('scandal', 'c2'), running('hands_off', 'c3')];
    saveStore(store);
    expect(await aims.aimAtPair({ a: ids.ada, b: ids.tom, aim: 'marry' }))
      .toEqual({ ok: false, reason: 'You already have 3 challenges running' });
    expect(loadStore()!.active).toHaveLength(3);
  });

  it('an aimed feud settles through the hourly check with a feed row', async () => {
    await aims.aimAtPair({ a: ids.ivy, b: ids.jon, aim: 'sunder' });
    expect(runChallengeChecks()).toEqual([]);
    db.update(relationships).set({ friendship_ab: -60, friendship_ba: -60, status: 'rivals' })
      .where(eq(relationships.agent_a, Math.min(ids.ivy, ids.jon))).run();
    const ended = runChallengeChecks();
    expect(ended.map((c) => [c.kind, c.status, c.source])).toEqual([['feud', 'completed', 'aim']]);
    const row = db.select().from(activityLog).where(eq(activityLog.type, 'challenge_completed')).orderBy(desc(activityLog.id)).get()!;
    expect(alertTier(row)).toBe('player');
  });
});
