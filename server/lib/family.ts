import { and, eq, or } from 'drizzle-orm';
import { db } from '../db';
import {
  agents, agentStates, children, conversationQueue, locations, needs, relationshipEvents, relationships,
  shared_knowledge, worldEvents,
} from '../db/schema';
import { CONFIG } from './constants';
import { simEvents, type SimEventPayloads } from './simEvents';
import { logActivity } from './activityLogger';
import { addKnowers, createFact } from './gossip';
import { getAgentStates, type StateType } from './states';
import { queueMaxWait } from './conversationPacing';
import { clamp } from './utils';
import { startWorldEvent } from '../engine/systems/events';
import { emitter } from '../engine/emitter';
import { PATERNITY_TOPIC } from '../ai/prompts';
import { MARRIED_AFFAIR_SENSITIVITY, MARRIED_TAG, withoutMilestoneTags } from './marriage';
import { canProposeNow } from './milestonesEngine';
import { PERIOD_FIRST_NAMES } from '../data/residentNames';
import {
  MINUTES_PER_DAY, PREGNANCY_MINUTES, addConfrontation, allPregnancies, childAgeDays, childrenOf, christeningTriggeredBy,
  dropChristening, dropConfrontation, endPregnancy, familyPairKey, guardianFor, marriedSinceOf,
  pendingChristenings, pendingConfrontations, pregnancyOf, pruneMarriedSince, scheduleChristening,
  setPregnancy, stampMarriedSince, type ChildRow, type Pregnancy,
} from './familyState';
import type { PersonalityProfile } from './personality';
import type { ClockTime } from './gameClock';
import { firstName as givenName } from '../ai/names';

// ─── Married life and children ───────────────────────────────────────────────
//
// A wedding used to be the end of every love story: the couple moved in
// together (milestonesEngine `rehomeCouple`) and nothing else ever happened
// to them. This module gives a marriage a long arc of its own, at no LLM cost
// (every step is a timer, a roll, a fact, a feed row or a memory line):
//
//   married ≥ 3 game days ──(a modest roll each game day)──▶ conception
//     ├─ a private `pregnancy` secret the mother knows
//     ├─ a game day later: she tells her husband (he knows the secret too)
//     ├─ two game days in: the town is told (`expecting` feed row, public fact)
//     └─ seven game days in: the birth ──▶ a `children` row, a `birth` beat,
//          joy and sleepless nights for the parents, friends coming by to
//          congratulate, and a christening on the square a game day later
//
// And the dark branch: a wife with a lover (an `affair` secret) may be carrying
// his child. That is a sensitivity-4 `paternity` secret only she knows; it
// travels like any other secret (confided, overheard, discovered), and the day
// her husband learns it — or the whole town does — he confronts the lover,
// and the marriage may not survive it.
//
// A pregnancy can also begin outside marriage (the adult layer, lib/intimacy/pregnancy.ts,
// through `startPregnancy`): it is marked `unwed`, skips `tellSpouse` / `announce` (that
// module tells the father and lets the town whisper), and is born through `giveBirth` like any
// other, with no father of record when he denied it.
//
// A child is not an agent: no needs, no plan, no LLM. Children appear in their
// parents' prompts (familyState.ts), in the agent panel, as a bundle in the
// mother's arms on the canvas, and in the line of heirs (heirs.ts). They never
// die — the death rule is for grown-ups; a cozy town doesn't bury babies. If
// their parents die the child goes to live with a guardian (the other parent,
// a housemate, the closest friend); if the last parent leaves town, the child
// leaves too.
//
// Timers live in familyState.ts (checkpointed to sim_snapshots). Side-effect
// module: importing it registers its `life:death` / `life:departed` listeners
// (server/index.ts imports it like milestonesEngine). `familyTick` runs every
// 10 game minutes, `familyDaily` at each day change (engine/tick.ts).

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** A couple married for fewer game days than this doesn't conceive yet. */
export const MARRIED_MIN_DAYS = 3;
/** Both spouses' romance toward each other must be at least this. */
export const PREGNANCY_MIN_ROMANCE = 60;
/**
 * Chance per game day for a couple that passes every gate. Modest on purpose:
 * about a week of marriage on average, so a town of a few couples sees a
 * baby now and then, not a nursery.
 */
export const PREGNANCY_CHANCE_PER_DAY = 0.15;
export const MOTHER_MIN_AGE = 18;
export const MOTHER_MAX_AGE = 44;
export const FATHER_MIN_AGE = 18;
/** No couple has more than this many children in town. */
export const MAX_CHILDREN = 4;
/** And never two babies closer together than this (game days of the youngest). */
export const MIN_DAYS_BETWEEN_BABIES = 8;
/** She tells her husband this long after conception... */
export const SPOUSE_TOLD_AFTER_MINUTES = 1 * MINUTES_PER_DAY;
/** ...and the town this long after. */
export const ANNOUNCE_AFTER_MINUTES = 2 * MINUTES_PER_DAY;
/** The whole pregnancy (familyState.ts, where the agent panel reads it too). */
export { PREGNANCY_MINUTES };
/** The christening comes a game day after the birth... */
export const CHRISTENING_DELAY_MINUTES = 1 * MINUTES_PER_DAY;
/** ...at a daytime hour (a three-hour event started at 15:00 ends at 18:00). */
export const CHRISTENING_FIRST_HOUR = 10;
export const CHRISTENING_LAST_START_HOUR = 15;
/** A wife with a lover: chance the lover is the true father. */
export const AFFAIR_PATERNITY_CHANCE = 0.5;
/** New parents: joyful and sleep-starved for this many game days after the birth. */
export const NEW_PARENT_DAYS = 3;
/** Energy each new parent wakes up without, every morning of those days. */
export const NEW_PARENT_ENERGY_COST = 15;
/** How long the betrayed husband keeps looking for the lover to have it out with him. */
export const CONFRONTATION_PENDING_MINUTES = 3 * MINUTES_PER_DAY;
/** Queue priority of that conversation: urgent, but below a proposal. */
export const PATERNITY_QUEUE_PRIORITY = CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY - 10;
const PATERNITY_QUEUE_WAIT_MINUTES = 60;
/** States in which nobody starts a family (the mother's or the father's). */
const NOT_NOW_STATES = new Set(['arrested', 'grieving', 'depressed', 'heartbroken']);

export type Rng = () => number;

// ─── Pure rules (exported for tests) ─────────────────────────────────────────

export interface ConceptionGate {
  /** Game minutes the couple has been married, or null when the clock hasn't started. */
  marriedMinutes: number | null;
  motherAge: number;
  fatherAge: number;
  /** The LOWER of the two romances. */
  romance: number;
  /** She is already expecting. */
  expecting: boolean;
  /** Their children in town. */
  childCount: number;
  /** Age in game days of their youngest, or null for a first baby. */
  youngestAgeDays: number | null;
  /** One of them is in a state that rules it out (arrested, grieving...). */
  notNow: boolean;
}

/** Whether a married couple may conceive today (the daily roll comes after). */
export function canConceive(g: ConceptionGate): boolean {
  if (g.marriedMinutes == null || g.marriedMinutes < MARRIED_MIN_DAYS * MINUTES_PER_DAY) return false;
  if (g.motherAge < MOTHER_MIN_AGE || g.motherAge > MOTHER_MAX_AGE || g.fatherAge < FATHER_MIN_AGE) return false;
  if (g.romance < PREGNANCY_MIN_ROMANCE) return false;
  if (g.expecting || g.notNow) return false;
  return roomForAnotherChild(g);
}

/**
 * The family-size rule, on its own: at most MAX_CHILDREN in town, and never two
 * babies closer than MIN_DAYS_BETWEEN_BABIES. The unwed conception roll
 * (lib/intimacy/pregnancy.ts) asks this without the marriage gates.
 */
export function roomForAnotherChild(g: Pick<ConceptionGate, 'childCount' | 'youngestAgeDays'>): boolean {
  if (g.childCount >= MAX_CHILDREN) return false;
  return g.youngestAgeDays == null || g.youngestAgeDays >= MIN_DAYS_BETWEEN_BABIES;
}

export function isChristeningHour(hour: number): boolean {
  return hour >= CHRISTENING_FIRST_HOUR && hour <= CHRISTENING_LAST_START_HOUR;
}

/**
 * A period first name for the baby, avoiding every name already in town
 * (residents' first names and other children) so "little Ada" is never
 * confused with Ada the baker. Falls back to the whole list if it runs out.
 */
export function pickChildName(sex: string, taken: ReadonlySet<string>, rng: Rng): string {
  const pool: readonly string[] = sex === 'female' ? PERIOD_FIRST_NAMES.female : PERIOD_FIRST_NAMES.male;
  const free = pool.filter((n) => !taken.has(n));
  const from = free.length > 0 ? free : pool;
  return from[Math.min(from.length - 1, Math.floor(rng() * from.length))];
}

/**
 * Chance the marriage ends in estrangement when the husband learns the baby
 * may not be his: a hot temper makes it likelier, a warm heart less likely.
 */
export function estrangementChance(p: Pick<PersonalityProfile, 'aggression' | 'warmth'> | null): number {
  const aggression = p?.aggression ?? 50;
  const warmth = p?.warmth ?? 50;
  return clamp(0.35 + (aggression - 50) / 200 - (warmth - 50) / 250, 0.1, 0.75);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type AgentRow = typeof agents.$inferSelect;

function firstName(full: string): string {
  return givenName(full);
}

function kinWord(sex: string): string {
  return sex === 'female' ? 'daughter' : 'son';
}

function remember(agentId: number, description: string, valence: number, importance: number, related?: number | null): void {
  simEvents.emit('life:milestone', { agentId, description, valence, importance, relatedAgentId: related ?? undefined });
}

function addMood(agentId: number, value: number, source: string, minutes: number, now: number): void {
  const row = db.select().from(needs).where(eq(needs.agent_id, agentId)).get();
  if (!row) return;
  const mods = row.mood_modifiers.filter((m) => m.source !== source);
  mods.push({ source, value, expiresAt: now + minutes });
  db.update(needs).set({ mood_modifiers: mods }).where(eq(needs.id, row.id)).run();
}

function addState(agentId: number, type: StateType, severity: number, minutes: number, now: number, source: string, target?: number): void {
  if (getAgentStates(agentId).includes(type)) return;
  db.insert(agentStates).values({
    agent_id: agentId, type, severity, started_at: now, duration: minutes,
    target_agent_id: target ?? null, source, metadata: null,
  }).run();
  simEvents.emit('state:triggered', { agentId, state: type, cause: source });
}

/**
 * A relationship event from `from`'s side: the deltas are `from`'s feelings
 * toward `to` (the relationships phase normalises the pair).
 */
function feel(from: number, to: number, type: string, description: string,
  d: { friendship: number; romance: number; trust: number }, sentiment: number): void {
  db.insert(relationshipEvents).values({
    agent_a: from, agent_b: to, event_type: type, description,
    friendship_delta_ab: d.friendship, friendship_delta_ba: 0,
    romance_delta_ab: d.romance, romance_delta_ba: 0,
    trust_delta_ab: d.trust, trust_delta_ba: 0,
    sentiment, processed: false, timestamp: Date.now(),
  }).run();
}

function relBetween(a: number, b: number) {
  return db.select().from(relationships)
    .where(and(eq(relationships.agent_a, Math.min(a, b)), eq(relationships.agent_b, Math.max(a, b))))
    .get();
}

/** The open area a christening is held on: where the weddings are. */
function squareVenue(): number | null {
  const all = db.select({ id: locations.id, type: locations.type }).from(locations).all();
  for (const type of ['town_square', 'market_square', 'park']) {
    const found = all.filter((l) => l.type === type).sort((x, y) => x.id - y.id)[0];
    if (found) return found.id;
  }
  return null;
}

/** A man the mother is having an affair with (an active `affair` secret), other than her husband. */
function affairLoverOf(mother: AgentRow, fatherId: number, byId: ReadonlyMap<number, AgentRow>): number | null {
  const facts = db.select({ subject: shared_knowledge.subject_id, target: shared_knowledge.target_id })
    .from(shared_knowledge)
    .where(and(
      eq(shared_knowledge.type, 'affair'),
      eq(shared_knowledge.is_active, true),
      or(eq(shared_knowledge.subject_id, mother.id), eq(shared_knowledge.target_id, mother.id)),
    ))
    .all();
  for (const f of facts) {
    const other = f.subject === mother.id ? f.target : f.subject;
    if (other == null || other === fatherId || other === mother.id) continue;
    const lover = byId.get(other);
    if (lover?.is_active && lover.gender === 'male' && lover.age >= FATHER_MIN_AGE) return other;
  }
  return null;
}

// ─── Conception (daily) ──────────────────────────────────────────────────────

/**
 * At each day change (engine/tick.ts): new parents wake up tired, and every
 * married couple that passes the gates rolls for a baby.
 */
export function familyDaily(nowMinutes: number, rng: Rng = Math.random): void {
  const agentRows = db.select().from(agents).all();
  const byId = new Map(agentRows.map((a) => [a.id, a]));
  let dirty = false;

  // Sleepless nights: every morning of a baby's first days costs its parents
  // some energy (the needs system reads it like any other tiredness).
  for (const a of agentRows) {
    if (!a.is_active) continue;
    const youngest = childrenOf(a.id).at(-1);
    if (!youngest || nowMinutes - youngest.birth_game_minute > NEW_PARENT_DAYS * MINUTES_PER_DAY) continue;
    const n = db.select({ id: needs.id, energy: needs.energy }).from(needs).where(eq(needs.agent_id, a.id)).get();
    if (n) db.update(needs).set({ energy: Math.max(5, n.energy - NEW_PARENT_ENERGY_COST) }).where(eq(needs.id, n.id)).run();
  }

  const married = db.select().from(relationships).all().filter((r) => r.tags.includes(MARRIED_TAG));
  for (const rel of married) {
    const a = byId.get(rel.agent_a);
    const b = byId.get(rel.agent_b);
    if (!a?.is_active || !b?.is_active) continue;
    // 1900, and no adoption yet: a baby needs a mother and a father.
    const mother = a.gender === 'female' && b.gender === 'male' ? a : b.gender === 'female' && a.gender === 'male' ? b : null;
    if (!mother) continue;
    const father = mother === a ? b : a;
    const since = marriedSinceOf(a.id, b.id);
    const kids = childrenOf(mother.id);
    const youngest = kids.at(-1);
    const gate: ConceptionGate = {
      marriedMinutes: since == null ? null : nowMinutes - since,
      motherAge: mother.age,
      fatherAge: father.age,
      romance: Math.min(rel.romance_ab, rel.romance_ba),
      expecting: pregnancyOf(mother.id) != null,
      childCount: kids.length,
      youngestAgeDays: youngest ? childAgeDays(youngest.birth_game_minute, nowMinutes) : null,
      notNow: [mother.id, father.id].some((id) => getAgentStates(id).some((s) => NOT_NOW_STATES.has(s))),
    };
    if (!canConceive(gate)) continue;
    if (rng() >= PREGNANCY_CHANCE_PER_DAY) continue;
    conceive(mother, father, nowMinutes, rng, byId);
    dirty = true;
  }
  if (dirty) emitter.markDirty('agents.all');
}

/** A married couple's baby on the way (the daily roll): who, if anyone, else may be the father. */
function conceive(mother: AgentRow, father: AgentRow, now: number, rng: Rng, byId: ReadonlyMap<number, AgentRow>): Pregnancy {
  const lover = affairLoverOf(mother, father.id, byId);
  const trueFatherId = lover != null && rng() < AFFAIR_PATERNITY_CHANCE ? lover : undefined;
  return beginPregnancy(mother, father, trueFatherId != null ? byId.get(trueFatherId) ?? null : null, false, now);
}

export interface StartPregnancyInput {
  motherId: number;
  /** The father as the town will believe; null when nobody is named (an unwed pregnancy). */
  fatherId: number | null;
  /** The mother's lover, when he is the real father of a married woman's child (an affair). */
  trueFatherId?: number;
  /** Conceived outside marriage: the engine's tell-the-husband / announce timers do not run (see `Pregnancy.unwed`). */
  unwed: boolean;
  now: number;
}

/**
 * Begin a pregnancy from outside the daily roll: the adult layer's unwed conception
 * (lib/intimacy/pregnancy.ts) comes in through here so it shares the one place a
 * pregnancy is created. Null when the mother is not in town or is already expecting.
 */
export function startPregnancy(input: StartPregnancyInput): Pregnancy | null {
  if (pregnancyOf(input.motherId)) return null;
  const rowOf = (id: number | null | undefined) => (id == null ? null : db.select().from(agents).where(eq(agents.id, id)).get() ?? null);
  const mother = rowOf(input.motherId);
  if (!mother?.is_active) return null;
  return beginPregnancy(mother, rowOf(input.fatherId), rowOf(input.trueFatherId), input.unwed, input.now);
}

/** A baby on the way: the pregnancy timer, the secret, and — with a lover — the paternity secret. */
function beginPregnancy(mother: AgentRow, father: AgentRow | null, trueFather: AgentRow | null, unwed: boolean, now: number): Pregnancy {
  const p: Pregnancy = { motherId: mother.id, fatherId: father?.id ?? null, unwed, conceivedAt: now };
  // Private: only she knows. Sensitivity 2 — happy news, but hers to tell, so
  // it spreads like a confidence (secretSharing) rather than like the weather.
  // Unmarried, it is a step heavier (3): a secret she has every reason to keep.
  const factId = createFact('pregnancy', mother.id, father?.id ?? null, unwed ? 3 : 2, [mother.id], 'private');
  if (factId != null) p.factId = factId;

  let fear = '';
  if (trueFather && father) {
    p.trueFatherId = trueFather.id;
    // The worst secret a married woman can keep in 1900: a step past every
    // other (same bar as an affair that betrays a marriage).
    p.paternityFactId = createFact('paternity', mother.id, trueFather.id, MARRIED_AFFAIR_SENSITIVITY, [mother.id], 'private',
      { detail: father.name }) ?? existingFactId('paternity', mother.id, trueFather.id) ?? undefined;
    fear = ` I'm afraid it may be ${firstName(trueFather.name)}'s, not ${firstName(father.name)}'s.`;
  }
  setPregnancy(p);

  if (unwed) {
    remember(mother.id, "I'm expecting a baby, and I'm not married. I haven't told anyone yet.", -0.3, 8, father?.id);
    addMood(mother.id, -3, 'expecting', MINUTES_PER_DAY, now);
  } else {
    remember(mother.id, `I'm expecting a baby! I haven't told anyone yet.${fear}`, fear ? 0.1 : 0.8, 8, father?.id);
    addMood(mother.id, fear ? 3 : 10, 'expecting', MINUTES_PER_DAY, now);
  }
  return p;
}

function existingFactId(type: string, subject: number, target: number): number | null {
  return db.select({ id: shared_knowledge.id }).from(shared_knowledge)
    .where(and(eq(shared_knowledge.type, type), eq(shared_knowledge.subject_id, subject), eq(shared_knowledge.target_id, target)))
    .get()?.id ?? null;
}

// ─── The periodic pass ───────────────────────────────────────────────────────

/**
 * Every 10 game minutes (engine/tick.ts): start marriage clocks, move each
 * pregnancy along (tell the husband, tell the town, the birth), hold the
 * christenings that are due, notice paternity secrets that got out, and seat
 * the husband's confrontation with the lover once the two meet.
 */
export function familyTick(time: ClockTime, nowMinutes: number, rng: Rng = Math.random): void {
  const agentRows = db.select().from(agents).all();
  const byId = new Map(agentRows.map((a) => [a.id, a]));
  const alive = (id: number | null | undefined) => id != null && byId.get(id)?.is_active === true;
  let dirty = false;

  // --- Marriage clocks ---
  const live = new Set<string>();
  for (const r of db.select().from(relationships).all()) {
    if (!r.tags.includes(MARRIED_TAG) || !alive(r.agent_a) || !alive(r.agent_b)) continue;
    live.add(familyPairKey(r.agent_a, r.agent_b));
    if (marriedSinceOf(r.agent_a, r.agent_b) == null) stampMarriedSince(r.agent_a, r.agent_b, nowMinutes);
  }
  pruneMarriedSince(live);

  // --- Pregnancies ---
  for (const p of allPregnancies()) {
    if (!alive(p.motherId)) {
      // She died or left town while expecting. The story ends off-stage —
      // nothing is announced, nobody is told there was a baby to lose.
      endPregnancy(p.motherId);
      if (p.factId != null) db.update(shared_knowledge).set({ is_active: false }).where(eq(shared_knowledge.id, p.factId)).run();
      // The whispering about an unwed one ends with it.
      retireScandal(p);
      continue;
    }
    const age = nowMinutes - p.conceivedAt;
    // An unwed pregnancy has its own timers (lib/intimacy/pregnancy.ts): who she tells,
    // and whether the town whispers, is not the married couple's cheerful schedule.
    if (!p.unwed) {
      if (!p.spouseTold && age >= SPOUSE_TOLD_AFTER_MINUTES) { tellSpouse(p, byId, nowMinutes); dirty = true; }
      if (!p.announced && age >= ANNOUNCE_AFTER_MINUTES) { announce(p, byId, nowMinutes); dirty = true; }
    }
    if (p.fatherId != null && p.trueFatherId != null && p.paternityFactId != null && !p.paternityRevealed
      && paternityOut(p.paternityFactId, p.fatherId, byId)) {
      p.paternityRevealed = true;
      revealPaternity({ motherId: p.motherId, fatherId: p.fatherId, loverId: p.trueFatherId, childName: null }, byId, nowMinutes, rng);
      dirty = true;
    }
    if (age >= PREGNANCY_MINUTES) { giveBirth(p, byId, nowMinutes, rng); dirty = true; }
  }

  // --- Paternity secrets about children already born ---
  const suspect = db.select().from(children)
    .where(and(eq(children.alive, true), eq(children.paternity_revealed, false))).all()
    .filter((c) => c.true_father_id != null && c.paternity_fact_id != null);
  for (const c of suspect) {
    if (!paternityOut(c.paternity_fact_id!, c.father_id, byId)) continue;
    db.update(children).set({ paternity_revealed: true }).where(eq(children.id, c.id)).run();
    if (c.father_id != null) {
      revealPaternity({ motherId: c.mother_id, fatherId: c.father_id, loverId: c.true_father_id!, childName: c.name }, byId, nowMinutes, rng);
    }
    dirty = true;
  }

  // --- Christenings ---
  for (const pc of pendingChristenings()) {
    if (nowMinutes < pc.dueAt) continue;
    const child = db.select().from(children).where(eq(children.id, pc.childId)).get();
    if (!child || child.home == null) { dropChristening(pc.childId); continue; }
    if (!isChristeningHour(time.hour) || christeningBlocked()) continue;
    if (holdChristening(child, byId)) { dropChristening(pc.childId); dirty = true; }
  }

  // --- The husband and the lover ---
  for (const c of pendingConfrontations()) {
    const f = byId.get(c.fatherId);
    const l = byId.get(c.loverId);
    if (!f?.is_active || !l?.is_active || nowMinutes - c.since > CONFRONTATION_PENDING_MINUTES) {
      dropConfrontation(c.fatherId, c.loverId);
      continue;
    }
    if (paternityQueued(f.id, l.id)) continue;
    if (!canProposeNow(f, l)) continue;
    db.insert(conversationQueue).values({
      // The husband first: participants[0] opens, and the topic's intent is his.
      participants: [f.id, l.id],
      tier: 'llm_standard',
      priority: PATERNITY_QUEUE_PRIORITY,
      trigger_reason: 'paternity',
      topic: PATERNITY_TOPIC,
      queued_at: Date.now(), // wall-clock ms, like every producer
      max_wait: queueMaxWait(PATERNITY_QUEUE_WAIT_MINUTES),
    }).run();
    dropConfrontation(c.fatherId, c.loverId);
    dirty = true;
  }

  if (dirty) emitter.markDirty('agents.all');
}

function paternityQueued(a: number, b: number): boolean {
  return db.select({ participants: conversationQueue.participants }).from(conversationQueue)
    .where(eq(conversationQueue.trigger_reason, 'paternity')).all()
    .some((q) => q.participants.includes(a) && q.participants.includes(b));
}

/** Another welcome, a wedding or a funeral on the square, or a storm: wait for the next pass. */
function christeningBlocked(): boolean {
  const active = db.select({ type: worldEvents.type }).from(worldEvents).where(eq(worldEvents.is_active, true)).all();
  return active.some((e) => e.type === 'christening' || e.type === 'wedding' || e.type === 'funeral' || e.type === 'storm');
}

// ─── Telling ─────────────────────────────────────────────────────────────────

function tellSpouse(p: Pregnancy, byId: ReadonlyMap<number, AgentRow>, now: number): void {
  p.spouseTold = true;
  const father = p.fatherId != null ? byId.get(p.fatherId) : undefined;
  const mother = byId.get(p.motherId);
  if (!father?.is_active || !mother) return; // widowed while expecting: nobody to tell
  if (p.factId != null) addKnowers(p.factId, [father.id]);
  remember(father.id, `${firstName(mother.name)} told me we're expecting a baby! I'm going to be a father.`, 0.9, 8, mother.id);
  remember(mother.id, `I told ${firstName(father.name)} about the baby.`, p.trueFatherId != null ? 0.2 : 0.7, 6, father.id);
  addMood(father.id, 12, 'expecting', MINUTES_PER_DAY, now);
}

/**
 * The town is told. The secret becomes public news: sensitivity 1 (spreads to
 * whoever is nearby like any public fact), everyone already knows it, and it
 * is marked public so gossipEngine's "the whole town now knows" exposure —
 * a stress hit meant for scandals — never fires on happy news.
 */
function announce(p: Pregnancy, byId: ReadonlyMap<number, AgentRow>, now: number): void {
  if (!p.spouseTold) tellSpouse(p, byId, now);
  p.announced = true;
  const mother = byId.get(p.motherId);
  const father = p.fatherId != null ? byId.get(p.fatherId) : undefined;
  if (!mother) return;
  const town = [...byId.values()].filter((a) => a.is_active).map((a) => a.id);
  if (p.factId != null) {
    db.update(shared_knowledge)
      .set({ sensitivity: 1, known_by: town, is_public: true, revealed_at: Date.now() })
      .where(eq(shared_knowledge.id, p.factId)).run();
  }
  const couple = father?.is_active ? `${mother.name} and ${father.name} are` : `${mother.name} is`;
  logActivity({
    type: 'expecting',
    agents: father?.is_active ? [mother.id, father.id] : [mother.id],
    templateData: { description: `${couple} expecting a baby!` },
  });
}

/**
 * The whispers are over (she married the father, or the child was born): the
 * `illegitimate_pregnancy` secret stops being current. Left active it would keep being
 * gossiped and, worse, a LATER unwed pregnancy of hers would find it as its duplicate
 * (createFact dedups on type + subject + target) and never raise a scandal of its own.
 * giveBirth calls this too, and so does the pregnancy pass when she marries the father
 * (intimacy/pregnancy.ts). A no-op when there is no scandal fact.
 */
export function retireScandal(p: Pregnancy): void {
  if (p.scandalFactId == null) return;
  db.update(shared_knowledge).set({ is_active: false }).where(eq(shared_knowledge.id, p.scandalFactId)).run();
  delete p.scandalFactId;
}

// ─── The birth ───────────────────────────────────────────────────────────────

function giveBirth(p: Pregnancy, byId: ReadonlyMap<number, AgentRow>, now: number, rng: Rng): ChildRow | null {
  endPregnancy(p.motherId);
  const mother = byId.get(p.motherId);
  if (!mother) return null;
  const father = p.fatherId != null ? byId.get(p.fatherId) : undefined;
  // An unwed father who turned her away is not a parent of record (`fatherDenied`).
  const fatherHere = father?.is_active === true && !p.fatherDenied;
  // An unwed birth is worded neutrally: the town is told of the mother and the baby, and of a
  // father only once he stands beside her as her husband (a shotgun wedding that did happen).
  const named = fatherHere && (!p.unwed || relBetween(mother.id, father!.id)?.tags.includes(MARRIED_TAG) === true);

  const sex = rng() < 0.5 ? 'female' : 'male';
  const taken = new Set<string>([
    ...[...byId.values()].map((a) => firstName(a.name)),
    ...db.select({ name: children.name }).from(children).all().map((c) => c.name),
  ]);
  const name = pickChildName(sex, taken, rng);
  const child = db.insert(children).values({
    name,
    sex,
    birth_game_minute: now,
    mother_id: mother.id,
    // NULL for a father who denied it: never `true_father_id`, which drives the paternity drama.
    father_id: p.fatherDenied ? null : p.fatherId,
    true_father_id: p.trueFatherId ?? null,
    home: mother.home,
    alive: true,
    paternity_fact_id: p.paternityFactId ?? null,
    paternity_revealed: p.paternityRevealed === true,
  }).returning().get();

  // The pregnancy is over; the birth is its own (public) fact.
  if (p.factId != null) db.update(shared_knowledge).set({ is_active: false }).where(eq(shared_knowledge.id, p.factId)).run();
  // The whispers about an unwed one end with it, so a later pregnancy of hers can start a fresh scandal.
  retireScandal(p);
  const kin = kinWord(sex);
  const parents = named ? `${mother.name} and ${father!.name}` : mother.name;
  logActivity({
    type: 'drama',
    initiator: mother.id,
    ...(named ? { target: father!.id } : {}),
    location: mother.home,
    templateData: { description: `${parents} welcomed a baby ${kin}, ${name}!` },
    metadata: { beat: 'birth' },
  });
  const town = [...byId.values()].filter((a) => a.is_active).map((a) => a.id);
  createFact('birth', mother.id, named ? father!.id : null, 1, town, 'event', { detail: `a ${sex === 'female' ? 'girl' : 'boy'} named ${name}` });

  // The parents: joy, a few days of mood lift, and memories.
  const parentIds = fatherHere ? [mother.id, father!.id] : [mother.id];
  for (const id of parentIds) {
    addState(id, 'euphoric', 0.8, 6 * 60, now, 'family:birth');
    addMood(id, 15, 'new_baby', NEW_PARENT_DAYS * MINUTES_PER_DAY, now);
  }
  const fear = p.trueFatherId != null && !p.paternityRevealed
    ? ` When I look at ${sex === 'female' ? 'her' : 'his'} face I can't stop wondering whose ${kin} ${name} really is.`
    : '';
  const own = p.unwed && !fatherHere ? 'my' : 'our';
  remember(mother.id, `I gave birth to ${own} ${kin}, ${name}. I've never been so tired or so happy.${fear}`, fear ? 0.5 : 1, 10, fatherHere ? father!.id : undefined);
  if (fatherHere) remember(father!.id, `Our ${kin} ${name} was born today. I'm a father.`, 1, 10, mother.id);

  // Friends hear the news and mean to congratulate (decisions/social.ts picks the
  // topic when they next talk to a parent, familyState `newbornOf`).
  const friends = new Set<number>();
  for (const pid of parentIds) {
    for (const r of db.select().from(relationships).where(or(eq(relationships.agent_a, pid), eq(relationships.agent_b, pid))).all()) {
      const other = r.agent_a === pid ? r.agent_b : r.agent_a;
      const f = r.agent_a === other ? r.friendship_ab : r.friendship_ba;
      if (f > 30 && !parentIds.includes(other) && byId.get(other)?.is_active) friends.add(other);
    }
  }
  for (const id of friends) {
    remember(id, `${parents} had a baby ${kin}, ${name}. I must congratulate them.`, 0.6, 5, mother.id);
  }
  // ...and some do go and do it (lib/socialCalls `congratulate`): the wish above
  // used to be all there was.
  const born: SimEventPayloads['family:birth'] = { childId: child.id, childName: name, parentIds: [...parentIds] };
  simEvents.emit('family:birth', born);

  scheduleChristening(child.id, now + CHRISTENING_DELAY_MINUTES);
  return child;
}

// ─── The christening ─────────────────────────────────────────────────────────

function holdChristening(child: ChildRow, byId: ReadonlyMap<number, AgentRow>): boolean {
  const venue = squareVenue();
  const mother = byId.get(child.mother_id);
  const father = child.father_id != null ? byId.get(child.father_id) : undefined;
  const parents = [mother, father].filter((a): a is AgentRow => a?.is_active === true);
  const parentNames = parents.map((a) => a.name).join(' and ') || 'the family';
  const title = `Christening of little ${child.name}`;
  const description = `The town gathers on the square to welcome ${parentNames}'s baby ${kinWord(child.sex)}, ${child.name}.`;
  const result = startWorldEvent('christening', {
    triggeredBy: christeningTriggeredBy(child.id),
    name: title,
    description,
    locationId: venue,
    enforceLimits: false,
    // The typed `christening` feed row below instead of a generic line.
    announce: false,
  });
  if (!result.ok) return false;

  logActivity({
    type: 'christening',
    agents: parents.map((a) => a.id),
    ...(venue != null ? { location: venue } : {}),
    templateData: { description },
  });
  for (const a of byId.values()) {
    if (!a.is_active) continue;
    if (parents.some((p) => p.id === a.id)) {
      remember(a.id, `We welcomed little ${child.name} on the square today, with the whole town there.`, 0.9, 7);
    } else {
      simEvents.emit('event:world', { agentId: a.id, name: title, description });
    }
  }
  return true;
}

// ─── Paternity ───────────────────────────────────────────────────────────────

/** The paternity secret has reached the husband, or the whole town. */
function paternityOut(factId: number, fatherId: number | null, byId: ReadonlyMap<number, AgentRow>): boolean {
  const f = db.select({ is_public: shared_knowledge.is_public, known_by: shared_knowledge.known_by, is_active: shared_knowledge.is_active })
    .from(shared_knowledge).where(eq(shared_knowledge.id, factId)).get();
  if (!f || !f.is_active) return false;
  if (f.is_public) return true;
  return fatherId != null && byId.get(fatherId)?.is_active === true && (f.known_by as number[]).includes(fatherId);
}

interface Reveal { motherId: number; fatherId: number; loverId: number; childName: string | null }

/**
 * The husband knows. He is furious with the lover and wounded by his wife;
 * the marriage may end in estrangement (a roll on his temper); and he goes
 * looking for the lover to have it out (a queued conversation once they meet,
 * `familyTick`). The child stays with the mother either way.
 */
function revealPaternity(r: Reveal, byId: ReadonlyMap<number, AgentRow>, now: number, rng: Rng): void {
  const father = byId.get(r.fatherId);
  const mother = byId.get(r.motherId);
  const lover = byId.get(r.loverId);
  if (!father?.is_active || !mother || !lover) return;
  const fN = firstName(father.name), mN = firstName(mother.name), lN = firstName(lover.name);
  const baby = r.childName ? `little ${r.childName}` : `the baby ${mN} is carrying`;

  feel(father.id, mother.id, 'paternity', `${fN} learned the baby may be ${lN}'s`,
    { friendship: -25, romance: -35, trust: -45 }, -0.9);
  if (mother.is_active) {
    feel(mother.id, father.id, 'paternity', `${mN}'s secret about the baby came out`, { friendship: -5, romance: -5, trust: -10 }, -0.5);
  }
  if (lover.is_active) {
    feel(father.id, lover.id, 'paternity', `${fN} learned ${lN} may have fathered ${mN}'s baby`,
      { friendship: -40, romance: 0, trust: -40 }, -0.9);
    addState(father.id, 'angry', 0.85, 12 * 60, now, 'family:paternity', lover.id);
  }

  logActivity({
    type: 'drama',
    initiator: father.id,
    target: mother.id,
    agents: [father.id, mother.id, lover.id],
    severity: 0.8,
    templateData: { description: `${father.name} has learned that ${baby} may be ${lover.name}'s, not his.` },
    metadata: { beat: 'paternity' },
  });
  remember(father.id, `I found out ${baby} may not be mine — it may be ${lN}'s. I can't even look at ${mN}.`, -0.95, 9, lover.id);
  if (mother.is_active) remember(mother.id, `${fN} knows about ${lN} and the baby. Everything is coming apart.`, -0.8, 9, father.id);
  if (lover.is_active) addConfrontation({ fatherId: father.id, loverId: lover.id, since: now });

  // The marriage: a roll on his temper.
  const rel = relBetween(father.id, mother.id);
  if (!rel || !mother.is_active || !rel.tags.includes(MARRIED_TAG)) return;
  if (rng() >= estrangementChance(father.personality as PersonalityProfile | null)) return;
  db.update(relationships).set({
    tags: [...withoutMilestoneTags(rel.tags).filter((t) => t !== 'estranged'), 'estranged'],
    status: 'estranged',
    status_since_minute: now,
  }).where(eq(relationships.id, rel.id)).run();
  logActivity({
    type: 'drama',
    agents: [father.id, mother.id],
    severity: 0.7,
    templateData: { description: `${father.name} and ${mother.name} are estranged for good — he cannot forgive her.` },
    metadata: { beat: 'estrangement' },
  });
  simEvents.emit('relationship:changed', { agentId: father.id, otherName: mother.name, status: 'estranged' });
  simEvents.emit('relationship:changed', { agentId: mother.id, otherName: father.name, status: 'estranged' });
}

// ─── A parent gone ───────────────────────────────────────────────────────────

/**
 * A parent died or left town. Each of their children stays with the other
 * parent if there is one; a child whose last parent LEFT goes with them
 * (their home is cleared: they are no longer in town); a child whose last
 * parent DIED goes to live with their guardian (familyState `guardianFor`),
 * or stays in the house, looked in on by the neighbours, when there is none.
 */
export function onParentGone(agentId: number, reason: string): void {
  const kids = childrenOf(agentId);
  if (kids.length === 0) return;
  const gone = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).get();
  for (const child of kids) {
    const guardian = guardianFor(child, agentId);
    const withOtherParent = guardian != null && (guardian === child.mother_id || guardian === child.father_id);
    if (withOtherParent) continue; // the other parent is still here: nothing changes
    if (reason !== 'death') {
      // The last parent in town moved away (or was removed): the child goes with them.
      const otherParentHere = [child.mother_id, child.father_id].some((id) => id != null && id !== agentId
        && db.select({ a: agents.is_active }).from(agents).where(eq(agents.id, id)).get()?.a === true);
      if (!otherParentHere) {
        db.update(children).set({ home: null }).where(eq(children.id, child.id)).run();
        continue;
      }
    }
    if (guardian == null) continue;
    const g = db.select({ id: agents.id, name: agents.name, home: agents.home }).from(agents).where(eq(agents.id, guardian)).get();
    if (!g || g.home === child.home) continue;
    db.update(children).set({ home: g.home }).where(eq(children.id, child.id)).run();
    const homeName = db.select({ name: locations.name }).from(locations).where(eq(locations.id, g.home)).get()?.name ?? 'their home';
    logActivity({
      type: 'moved_in',
      agents: [g.id, agentId],
      location: g.home,
      templateData: { description: `Little ${child.name} has gone to live with ${g.name} at ${homeName}.` },
    });
    remember(g.id, `I've taken in little ${child.name}${gone ? `, ${firstName(gone.name)}'s child` : ''}. The child will want for nothing while I live.`, 0.3, 8, agentId);
  }
  emitter.markDirty('agents.all');
}

// ─── Registration ────────────────────────────────────────────────────────────

let initialized = false;

function initFamily(): void {
  if (initialized) return;
  initialized = true;
  const guarded = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      // Listeners run inside the emitting phase (a death pipeline, a
      // departure): never let the family bookkeeping take that down with it.
      console.warn(`[family] ${label} failed:`, (err as Error).message);
    }
  };
  simEvents.on('life:death', (p: { agentId: number }) => guarded('death', () => onParentGone(p.agentId, 'death')));
  simEvents.on('life:departed', (p: { agentId: number; reason: string }) => guarded('departure', () => onParentGone(p.agentId, p.reason)));
}

// Auto-initialize on import
initFamily();
