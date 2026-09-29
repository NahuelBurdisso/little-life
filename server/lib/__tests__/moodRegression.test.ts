import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, locations, needs, relationshipEvents } from '../../db/schema';
import { CONFIG } from '../constants';
import type { PersonalityProfile } from '../personality';
import { adaptNeedsMood, moodBaseline, MOOD_BASELINE_MAX, MOOD_BASELINE_MIN } from '../moodBaseline';
import { nextMomentum } from '../moodMomentum';
import {
  dailyLifeHourly, JOYS, pickMoment, STRESSORS, stressorChancePerMinute, type MomentContext,
} from '../dailyLife';

/**
 * A 30-day soak read the whole town's mood climbing 71 → 91 and staying there: needs sat
 * high all day, momentum rewarded any day over 65 with up to +15 the next (a runaway loop),
 * and nothing small ever went wrong. Mood now adapts around a personality baseline, momentum
 * is a fraction of the deviation from it, and the day has small stressors and joys.
 */

const p = (over: Partial<PersonalityProfile> = {}): PersonalityProfile => ({
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50, ...over,
});

describe('mood baseline (pure)', () => {
  it('is temperament: the anxious sit lower, the warm higher, within bounds', () => {
    expect(moodBaseline(p({ neuroticism: 85 }))).toBeLessThan(moodBaseline(p()));
    expect(moodBaseline(p({ warmth: 85 }))).toBeGreaterThan(moodBaseline(p()));
    expect(moodBaseline(p({ neuroticism: 100, warmth: 0, impulsiveness: 0, morality: 0 }))).toBe(MOOD_BASELINE_MIN);
    expect(moodBaseline(p({ neuroticism: 0, warmth: 100, impulsiveness: 100, morality: 100 }))).toBe(MOOD_BASELINE_MAX);
  });

  it('comfort counts half above the baseline, want nearly in full below it', () => {
    const b = 64;
    expect(adaptNeedsMood(b, b)).toBe(b);
    expect(adaptNeedsMood(90, b)).toBeCloseTo(b + 26 * 0.5);
    expect(adaptNeedsMood(30, b)).toBeCloseTo(b - 34 * 0.9);
  });
});

describe('mood momentum (pure)', () => {
  it('a good day lifts the next, a bad one weighs on it, never by as much as the day strayed', () => {
    const good = nextMomentum(85, 64, 0);
    expect(good.streak).toBe(1);
    expect(good.momentum).toBeGreaterThan(0);
    expect(good.momentum).toBeLessThan(85 - 64);
    const bad = nextMomentum(30, 64, 0);
    expect(bad.streak).toBe(-1);
    expect(bad.momentum).toBeLessThan(0);
  });

  it('cannot run away: iterating a comfortable town settles near its baseline-adapted mood, not ~90', () => {
    // The old rule: needs ~80, any day > 65 earned up to +15 → 90+ for good.
    const baseline = 64;
    const needsMood = adaptNeedsMood(80, baseline); // 72
    let m = 0;
    let streak = 0;
    let avg = 0;
    for (let day = 0; day < 30; day++) {
      avg = needsMood + m;
      ({ momentum: m, streak } = nextMomentum(avg, baseline, streak));
    }
    expect(avg).toBeLessThan(80);
    expect(avg).toBeGreaterThan(70);
  });
});

const ctx = (over: Partial<MomentContext> = {}): MomentContext => ({
  hour: 14, weather: 'cloudy', outdoors: false, atHome: false, atWork: false, money: 50, age: 30,
  states: [], companionHere: false, ...over,
});

describe('daily moments (pure)', () => {
  it('only offers moments that fit the moment', () => {
    const pool = (c: MomentContext) => STRESSORS.filter((m) => m.when(c)).map((m) => m.key);
    expect(pool(ctx({ outdoors: true, weather: 'rainy' }))).toContain('soaked');
    expect(pool(ctx({ outdoors: false, weather: 'rainy' }))).not.toContain('soaked');
    expect(pool(ctx({ hour: 7 }))).toContain('bad_sleep');
    expect(pool(ctx({ hour: 14 }))).not.toContain('bad_sleep');
    expect(pool(ctx({ money: 10 }))).toContain('money_worry');
    expect(pool(ctx({ money: 200 }))).not.toContain('money_worry');
    expect(pool(ctx({ companionHere: true, money: 40 }))).toContain('money_quarrel');
    expect(pickMoment(JOYS, ctx({ outdoors: true, weather: 'sunny' }), () => 0)).not.toBeNull();
  });

  it('every stressor lowers mood and every joy raises it, for a few hours', () => {
    for (const m of STRESSORS) { expect(m.mood).toBeLessThan(0); expect(m.minutes).toBeGreaterThanOrEqual(60); }
    for (const m of JOYS) expect(m.mood).toBeGreaterThan(0);
  });

  it('the anxious have more bad moments', () => {
    expect(stressorChancePerMinute(p({ neuroticism: 90 }))).toBeGreaterThan(stressorChancePerMinute(p({ neuroticism: 10 })));
  });
});

describe('dailyLifeHourly', () => {
  const made: number[] = [];
  let home: number;
  let a: number;
  let b: number;
  const NOW = 9 * 1440 + 8 * 60;

  beforeAll(() => {
    home = db.insert(locations).values({
      name: 'Quarrel Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 4, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    const insert = (name: string) => {
      const id = db.insert(agents).values({
        name, bio: 'test', traits: [], age: 30, gender: 'female', personality: p(),
        sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
        current_action: { type: 'idle' }, action_started: 0, action_queue: [],
        schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
        home, current_location: home, created_at: 0, is_active: true,
      }).returning({ id: agents.id }).get().id;
      db.insert(needs).values({
        agent_id: id, hunger: 60, energy: 60, social: 60, comfort: 60, fun: 60, mood: 60, stress: 20,
        decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES }, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
        mood_modifiers: [], last_updated: NOW,
      }).run();
      made.push(id);
      return id;
    };
    a = insert('Quinn Moment');
    b = insert('Rae Moment');
    // Everyone else in this worker's DB sleeps through the roll.
    db.update(agents).set({ current_action: { type: 'sleeping' } })
      .where(and(eq(agents.is_active, true))).run();
    db.update(agents).set({ current_action: { type: 'idle' } }).where(inArray(agents.id, made)).run();
  });

  afterAll(() => {
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  it('a roll that lands leaves a mood modifier and a feed line; a money quarrel lands on both housemates', () => {
    // At 8am at home with no economy row (money 0) and a housemate, the fitting stressors are
    // bad_sleep, burnt_loaf, money_worry, money_quarrel, lost_item: the stress roll hits (0),
    // the pick lands on the 4th (0.7), the joy roll misses (0.99). The housemate is then
    // skipped: the quarrel already landed on them.
    const seq = [0, 0.7, 0.99];
    let i = 0;
    dailyLifeHourly(8, 'cloudy', NOW, () => seq[i++ % seq.length]);

    const modsA = db.select().from(needs).where(eq(needs.agent_id, a)).get()!.mood_modifiers;
    const modsB = db.select().from(needs).where(eq(needs.agent_id, b)).get()!.mood_modifiers;
    const quarrel = 'moment:money_quarrel';
    expect(modsA.map((m) => m.source)).toContain(quarrel);
    expect(modsB.map((m) => m.source)).toContain(quarrel);
    expect(modsA.find((m) => m.source === quarrel)!.value).toBeLessThan(0);

    const rows = db.select().from(activityLog).where(eq(activityLog.type, 'daily_moment')).all()
      .filter((r) => r.initiator_id === a || r.initiator_id === b);
    expect(rows.length).toBe(2);
    expect(String((rows[0].template_data as Record<string, string>).description)).toMatch(/quarrelled over money/);

    const ev = db.select().from(relationshipEvents)
      .where(and(eq(relationshipEvents.agent_a, Math.min(a, b)), eq(relationshipEvents.agent_b, Math.max(a, b)))).all();
    expect(ev.map((e) => e.event_type)).toContain('quarrel');
  });
});
