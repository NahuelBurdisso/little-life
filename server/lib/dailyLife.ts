/**
 * The small ups and downs of an ordinary day: a bad night's sleep, a burnt loaf, a quarrel
 * over money, a soaking in the rain — and now and then a perfect loaf or a coin in the street.
 *
 * WHY: nothing in a calm town ever went slightly wrong. Mood was needs plus whatever drama
 * happened, the needs sat high all day, and drama was rare, so a 30-day soak read a flat ~90
 * for every resident for weeks (see moodBaseline.ts for the other half of the fix). Real days
 * have friction. These moments are cheap (no LLM, one roll per resident per game hour), each
 * leaves a mood modifier for a few hours, a first-person memory the planner and dialogue can
 * draw on ("I burnt a whole loaf of bread"), and a low-importance feed line.
 *
 * Rates are per GAME MINUTE awake (rolled once an hour with `chancePerTick(p, 60)`, the same
 * odds at any speed): ~1.4 stressors a day for an average temperament (more for the anxious),
 * ~0.7 small joys (more for the warm). Net, a few points off the day's mean mood, and spread.
 *
 * The catalogue and the pick are pure (`pickMoment`); `dailyLifeHourly` reads the town and
 * writes the effects. `applyMoment` is shared with the other cheap life sources
 * (smallMisdeeds.ts, personalEvents.ts).
 */
import { db } from '../db';
import { agents, agentStates, economy, locations, needs, relationships } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { chancePerTick } from './gameClock';
import { insertPairEvent } from './conversationBeats';
import type { PersonalityProfile } from './personality';
import { firstName as givenName } from '../ai/names';

export type Rng = () => number;

/** What a moment can depend on. */
export interface MomentContext {
  hour: number;
  weather: string;
  outdoors: boolean;
  atHome: boolean;
  atWork: boolean;
  money: number;
  age: number;
  states: readonly string[];
  /** A partner or housemate is in the same place (the one money quarrels need). */
  companionHere: boolean;
}

export interface Moment {
  key: string;
  /** Mood modifier while it lasts. */
  mood: number;
  /** Game minutes it lasts. */
  minutes: number;
  when: (c: MomentContext) => boolean;
  /** Feed line, third person. */
  feed: (first: string) => string;
  /** The resident's own memory of it. */
  memory: string;
}

const MORNING = (c: MomentContext) => c.hour >= 6 && c.hour <= 9;
const MEALTIME = (c: MomentContext) => (c.hour >= 6 && c.hour <= 9) || (c.hour >= 17 && c.hour <= 20);
const WET = (c: MomentContext) => c.weather === 'rainy' || c.weather === 'stormy';
const SHORT_OF_MONEY = (c: MomentContext) => c.money < 25 || c.states.includes('in_debt');

export const STRESSORS: readonly Moment[] = [
  {
    key: 'bad_sleep', mood: -6, minutes: 300, when: MORNING,
    feed: (n) => `${n} slept badly and woke up with a sore head.`,
    memory: 'I slept badly last night and woke with a sore head.',
  },
  {
    key: 'burnt_loaf', mood: -4, minutes: 180, when: (c) => c.atHome && MEALTIME(c),
    feed: (n) => `${n} burnt a whole loaf of bread.`,
    memory: 'I burnt a whole loaf of bread. What a waste.',
  },
  {
    key: 'money_worry', mood: -7, minutes: 360, when: SHORT_OF_MONEY,
    feed: (n) => `${n} counted the coins twice, and it still wasn't enough.`,
    memory: "I counted my coins twice and it still isn't enough.",
  },
  {
    // Needs someone to quarrel with: `dailyLifeHourly` finds them and hurts the pair a little.
    key: 'money_quarrel', mood: -6, minutes: 300,
    when: (c) => c.companionHere && (c.money < 60 || c.states.includes('in_debt')),
    feed: (n) => `${n} had a quarrel over money at home.`,
    memory: 'We quarrelled over money again.',
  },
  {
    key: 'soaked', mood: -5, minutes: 180, when: (c) => c.outdoors && WET(c),
    feed: (n) => `${n} got caught in the rain and soaked through.`,
    memory: 'I got caught in the rain and soaked to the bone.',
  },
  {
    key: 'chilled', mood: -4, minutes: 180, when: (c) => c.outdoors && c.weather === 'snowy',
    feed: (n) => `${n} is chilled to the bone from the snow.`,
    memory: "I can't get warm after being out in the snow.",
  },
  {
    key: 'heat', mood: -3, minutes: 180, when: (c) => c.weather === 'hot',
    feed: (n) => `The heat has given ${n} a headache.`,
    memory: 'This heat has given me a headache.',
  },
  {
    key: 'work_trouble', mood: -5, minutes: 240, when: (c) => c.atWork,
    feed: (n) => `Nothing went right for ${n} at work today.`,
    memory: 'Nothing went right at work today.',
  },
  {
    key: 'aching', mood: -4, minutes: 360, when: (c) => c.age >= 55,
    feed: (n) => `${n}'s back is aching again.`,
    memory: 'My back is aching again.',
  },
  {
    key: 'lost_item', mood: -3, minutes: 240, when: () => true,
    feed: (n) => `${n} has lost a good pair of gloves somewhere.`,
    memory: "I've lost my good gloves somewhere.",
  },
  {
    key: 'rude_remark', mood: -4, minutes: 180, when: (c) => !c.atHome,
    feed: (n) => `A passing traveller's rude remark soured ${n}'s mood.`,
    memory: "A traveller passing through was rude to me, and it's stuck with me.",
  },
];

export const JOYS: readonly Moment[] = [
  {
    key: 'good_bake', mood: 4, minutes: 180, when: (c) => c.atHome && MEALTIME(c),
    feed: (n) => `${n}'s bread came out perfect.`,
    memory: 'My bread came out perfect today.',
  },
  {
    key: 'found_coin', mood: 3, minutes: 120, when: (c) => c.outdoors,
    feed: (n) => `${n} found a coin in the street.`,
    memory: 'I found a coin in the street. A small thing, but it made me smile.',
  },
  {
    key: 'birdsong', mood: 3, minutes: 180, when: MORNING,
    feed: (n) => `A blackbird sang outside ${n}'s window all morning.`,
    memory: 'A blackbird sang outside my window all morning.',
  },
  {
    key: 'sunshine', mood: 4, minutes: 180, when: (c) => c.outdoors && c.weather === 'sunny',
    feed: (n) => `${n} stopped to enjoy the sunshine.`,
    memory: 'I stopped for a moment just to enjoy the sunshine.',
  },
  {
    key: 'good_work', mood: 4, minutes: 240, when: (c) => c.atWork,
    feed: (n) => `${n} had a satisfying day's work.`,
    memory: "I did good work today, and I know it.",
  },
];

/** Minutes awake in a day, for turning "per day" into "per game minute". */
const AWAKE_MINUTES = 960;

/** Stressor rate per game minute awake: ~1.4/day at neuroticism 50, 0.9 at 10, 2 at 90. */
export function stressorChancePerMinute(p: PersonalityProfile | null | undefined): number {
  const neuroticism = p?.neuroticism ?? 50;
  return (1.3 / AWAKE_MINUTES) * (0.6 + neuroticism / 100);
}

/** Small-joy rate per game minute awake: ~0.7/day at warmth 50. */
export function joyChancePerMinute(p: PersonalityProfile | null | undefined): number {
  const warmth = p?.warmth ?? 50;
  return (0.7 / AWAKE_MINUTES) * (0.6 + warmth / 125);
}

/** One moment from `pool` that fits `c`, uniformly; null when none does. */
export function pickMoment(pool: readonly Moment[], c: MomentContext, rng: Rng = Math.random): Moment | null {
  const fits = pool.filter((m) => m.when(c));
  if (fits.length === 0) return null;
  return fits[Math.min(fits.length - 1, Math.floor(rng() * fits.length))];
}

// ─── Effects ──────────────────────────────────────────────────────────────────

/** Add (or refresh) a mood modifier; the needs phase sums and expires them. */
export function addMoodModifier(agentId: number, value: number, source: string, minutes: number, nowMinutes: number): void {
  const row = db.select().from(needs).where(eq(needs.agent_id, agentId)).get();
  if (!row) return;
  const mods = row.mood_modifiers.filter((m) => m.source !== source);
  mods.push({ source, value, expiresAt: nowMinutes + minutes });
  db.update(needs).set({ mood_modifiers: mods }).where(eq(needs.id, row.id)).run();
}

/**
 * A moment lands on `agentId`: the mood modifier, their memory of it (MemoryObserver's
 * `life:milestone`, valence from the mood), and a `daily_moment` feed line.
 */
export function applyMoment(
  agent: { id: number; name: string },
  moment: Pick<Moment, 'key' | 'mood' | 'minutes' | 'memory'> & { feedLine: string },
  nowMinutes: number,
  opts: { importance?: number; relatedAgentId?: number; location?: number | null } = {},
): void {
  addMoodModifier(agent.id, moment.mood, `moment:${moment.key}`, moment.minutes, nowMinutes);
  simEvents.emit('life:milestone', {
    agentId: agent.id,
    description: moment.memory,
    valence: Math.max(-1, Math.min(1, moment.mood / 10)),
    importance: opts.importance ?? 3,
    ...(opts.relatedAgentId != null ? { relatedAgentId: opts.relatedAgentId } : {}),
  });
  logActivity({
    type: 'daily_moment',
    initiator: agent.id,
    ...(opts.relatedAgentId != null ? { target: opts.relatedAgentId } : {}),
    ...(opts.location != null ? { location: opts.location } : {}),
    templateData: { description: moment.feedLine },
  });
}

type AgentRow = typeof agents.$inferSelect;

/**
 * Once per game hour: every awake resident may have a small bad moment and, separately, a
 * small good one. A money quarrel lands on both people and costs the pair a little goodwill.
 */
export function dailyLifeHourly(hour: number, weather: string, nowMinutes: number, tickRng: Rng = Math.random): void {
  const active = db.select().from(agents).where(eq(agents.is_active, true)).all();
  if (active.length === 0) return;
  const locTypes = new Map(db.select({ id: locations.id, type: locations.type }).from(locations).all().map((l) => [l.id, l.type]));
  const money = new Map(db.select({ id: economy.agent_id, money: economy.money }).from(economy).all().map((e) => [e.id, e.money]));
  const statesByAgent = new Map<number, string[]>();
  for (const s of db.select({ agent: agentStates.agent_id, type: agentStates.type }).from(agentStates).all()) {
    const list = statesByAgent.get(s.agent) ?? [];
    list.push(s.type);
    statesByAgent.set(s.agent, list);
  }
  const partners = new Set<string>();
  for (const r of db.select({ a: relationships.agent_a, b: relationships.agent_b, status: relationships.status, tags: relationships.tags })
    .from(relationships).all()) {
    if (r.status === 'partners' || (r.tags as string[]).includes('partner')) partners.add(`${r.a}-${r.b}`);
  }
  const isCompanion = (x: AgentRow, y: AgentRow) =>
    x.home === y.home || partners.has(`${Math.min(x.id, y.id)}-${Math.max(x.id, y.id)}`);

  const quarrelled = new Set<number>();
  for (const agent of active) {
    if ((agent.current_action as { type?: string } | null)?.type === 'sleeping') continue;
    if (quarrelled.has(agent.id)) continue;
    const personality = (agent.personality as PersonalityProfile | null) ?? null;
    const here = agent.current_location;
    const companion = here != null
      ? active.find((o) => o.id !== agent.id && o.current_location === here && isCompanion(agent, o)
        && (o.current_action as { type?: string } | null)?.type !== 'sleeping')
      : undefined;
    const ctx: MomentContext = {
      hour,
      weather,
      outdoors: here == null,
      atHome: here != null && here === agent.home,
      atWork: here != null && agent.workplace != null && here === agent.workplace && locTypes.get(here) !== 'home',
      money: money.get(agent.id) ?? 0,
      age: agent.age ?? 30,
      states: statesByAgent.get(agent.id) ?? [],
      companionHere: companion != null,
    };
    const first = givenName(agent.name);

    if (tickRng() < chancePerTick(stressorChancePerMinute(personality), 60)) {
      const m = pickMoment(STRESSORS, ctx, tickRng);
      if (m?.key === 'money_quarrel' && companion) {
        const otherFirst = givenName(companion.name);
        const line = `${first} and ${otherFirst} quarrelled over money.`;
        applyMoment(agent, { ...m, feedLine: line }, nowMinutes, { relatedAgentId: companion.id, location: here });
        applyMoment(companion, { ...m, feedLine: line }, nowMinutes, { relatedAgentId: agent.id, location: here });
        insertPairEvent(agent.id, companion.id, 'quarrel', `${agent.name} and ${companion.name} quarrelled over money`, {
          friendshipFrom: -2, friendshipTo: -2,
        }, -0.4);
        quarrelled.add(companion.id);
      } else if (m && m.key !== 'money_quarrel') {
        applyMoment(agent, { ...m, feedLine: m.feed(first) }, nowMinutes, { location: here });
      }
    }
    if (tickRng() < chancePerTick(joyChancePerMinute(personality), 60)) {
      const m = pickMoment(JOYS, ctx, tickRng);
      if (m) applyMoment(agent, { ...m, feedLine: m.feed(first) }, nowMinutes, { location: here });
    }
  }
}
