/**
 * Taking sides: a falling-out between two residents spreads through the people
 * close to them, over days.
 *
 * Why this exists. A public fight (confrontationEngine.ts) touched the two
 * fighters and one random witness; a quarrel, a betrayal, a debt gone sour, a
 * skipped funeral each stayed between the two people it happened to. In a small
 * town that is not how it goes: friends and family hear of it and are expected
 * to say where they stand. This is that:
 *
 *   a falling-out (a relationship event of the kinds in TRIGGERS, read on
 *   `relationship:event_applied`) → `startFeud`: the people close to either side
 *   are lined up to decide over the following days (FACTIONS.DECIDE_*)
 *   → the hourly pass decides each one in turn (decide.ts `decideSide`): with A,
 *   with B, neutral, or a peacemaker who walks to one and then the other (the
 *   `mediate` social call, ./mediate.ts); someone close to both is torn
 *   → ONE summary row per batch of decisions ("The quarrel between A and B has
 *   split their friends: …"), and when each side has drawn enough people, a
 *   TOWN FEUD: the camps avoid each other in free time (cliques.ts), don't sit
 *   together at a gathering's chats (decisions/gathering.ts), lean to opposite
 *   candidates for mayor (townCalendar.ts), and the Brewing tab, the chronicle
 *   and the paper carry it (brewing.ts, chronicle.ts → gazette.ts);
 *   → it ends when the two make peace (then the side-takers thaw), when one of
 *   them dies or leaves, or after a long quiet stretch.
 *
 * Not a snowball: at most a couple of feuds at once in a town of 13, a person
 * holds a side in one feud at a time, and no pair can lose more than
 * FACTIONS.PAIR_COOL_CAP friendship to side-taking, ever.
 *
 * Side-effect module like lib/socialCalls: importing it registers the `mediate`
 * call kind and the listeners (server/index.ts and engine/tick.ts import it).
 * Listeners run inside the emitter's transaction and only RECORD (a feud and its
 * deciders); every effect happens in the hourly pass (`factionsHourly`).
 * Dice are seeded (world seed + key): the decision phases' tests sequence their
 * own Math.random draws, and nothing here may shift them.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import { agents, loans, relationshipEvents, relationships, shared_knowledge } from '../../db/schema';
import { simEvents } from '../simEvents';
import { gameMinutesNow } from '../worldClock';
import { logActivity } from '../activityLogger';
import { makeRng, stringToSeed } from '../worldgen/rng';
import { currentWorldSeed } from '../intimacy/worldSeed';
import { addTensionFor } from '../cascade';
import { getEffectivePersonality } from '../states';
import type { PersonalityProfile } from '../personality';
import type { DramaBeat } from '../../data/dramaBeats';
import { gatherCandidates } from '../socialCalls/ties';
import { feel, firstOf, mood, nameOf, remember } from '../socialCalls/effects';
import type { TieKind } from '../socialCalls/pickCallers';
import { decideSide, tieWeightOf, type Side, type Stance } from './decide';
import {
  FACTIONS, activeFeuds, addLog, addThaw, coolAllowance, countTally, endFeud, feudBetween, noteCooled,
  noteSlight, sideCounts, sidesHeldBy, startFeud, takeDueThaws, townSideMin, type Feud, type FeudEnd,
} from './store';
import { registerMediateKind, scheduleMediation } from './mediate';

export {
  factionTally, factionsSnapshotStore, feudSocialPenalty, opposedInTownFeud, townCamps, activeFeuds, sideIn, stanceIn,
} from './store';
export type { Feud } from './store';

const HOUR = 60;
const DAY = 24 * HOUR;

/** Ties that make someone expected to say where they stand. */
const CLOSE: readonly TieKind[] = ['spouse', 'partner', 'fiance', 'family', 'housemate', 'best_friend', 'friend', 'clique'];
const HOSTILE_STATUSES = new Set(['rivals', 'enemies', 'estranged']);

// ─── Dice ────────────────────────────────────────────────────────────────────

let rngOverride: (() => number) | null = null;

/** Tests only: every roll draws from `fn` (null restores the seeded source). */
export function setFactionRng(fn: (() => number) | null): void {
  rngOverride = fn;
}

export function rngFor(key: string): () => number {
  if (rngOverride) return rngOverride;
  const r = makeRng(stringToSeed(`${String(currentWorldSeed())}|feud|${key}`));
  return () => r.next();
}

// ─── Small DB helpers ────────────────────────────────────────────────────────

function isActive(id: number): boolean {
  return db.select({ a: agents.is_active }).from(agents).where(eq(agents.id, id)).get()?.a === true;
}

function population(): number {
  return db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all().length;
}

function relOf(a: number, b: number) {
  return db.select().from(relationships)
    .where(and(eq(relationships.agent_a, Math.min(a, b)), eq(relationships.agent_b, Math.max(a, b)))).get() ?? null;
}

/** `from`'s friendship and trust toward `to`. */
function feelingToward(from: number, to: number): { friendship: number; trust: number } {
  const r = relOf(from, to);
  if (!r) return { friendship: 0, trust: 0 };
  return r.agent_a === from
    ? { friendship: r.friendship_ab, trust: r.trust_ab }
    : { friendship: r.friendship_ba, trust: r.trust_ba };
}

function personalityOf(id: number): PersonalityProfile | null {
  return getEffectivePersonality(id)
    ?? (db.select({ p: agents.personality }).from(agents).where(eq(agents.id, id)).get()?.p as PersonalityProfile | null) ?? null;
}

function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function feudFeed(f: Feud, beat: DramaBeat, description: string, severity: number, agentIds: number[]): void {
  logActivity({
    type: 'feud',
    initiator: f.aId,
    target: f.bId,
    agents: [...new Set([f.aId, f.bId, ...agentIds])].slice(0, 12),
    severity,
    templateData: { description },
    metadata: { beat, feudId: f.id },
  });
}

// ─── What starts a feud ──────────────────────────────────────────────────────

type TriggerKind = 'clash' | 'quarrel' | 'betrayal' | 'debt' | 'slight';

/**
 * The relationship events that are a falling-out worth taking sides over, and
 * how the town speaks of each — in the Brewing tab, the chronicle and so the
 * paper. Never a secret's content: an affair or an unpaid debt is a fact only
 * its holders know (they weigh it, decide.ts `knownCulprit`), so the town says
 * no more than "a bitter falling-out" or "a matter of money".
 */
const TRIGGERS: Record<string, { kind: TriggerKind; text: string }> = {
  confrontation_escalated: { kind: 'clash', text: 'a shouting match in public' },
  fight: { kind: 'clash', text: 'a fight in public' },
  quarrel: { kind: 'quarrel', text: 'a bitter quarrel' },
  affair_discovered: { kind: 'betrayal', text: 'a bitter falling-out' },
  loan_unpaid: { kind: 'debt', text: 'a matter of money' },
  missed_funeral: { kind: 'slight', text: 'a funeral one of them stayed away from' },
  fire_absent: { kind: 'slight', text: 'a fire one of them never came to' },
  wedding_absent: { kind: 'slight', text: 'a wedding one of them stayed away from' },
  ingratitude: { kind: 'slight', text: 'a kindness never returned' },
  election_grudge: { kind: 'slight', text: 'the election for mayor' },
};

/** Event types that end a feud between its principals. */
const MENDS = new Set(['reconciliation', 'confrontation_resolved']);

type EventRow = typeof relationshipEvents.$inferSelect;

/**
 * Who is aggrieved (a) and who is the other (b) in an event. The relationship
 * rows are written in either order, so the deltas say it: the one whose regard
 * dropped is the aggrieved. With no sign (a clash, both hurt alike) the row's
 * own order stands.
 */
function orient(e: EventRow): [number, number] {
  if (e.friendship_delta_ab < 0 && e.friendship_delta_ba >= 0) return [e.agent_a, e.agent_b];
  if (e.friendship_delta_ba < 0 && e.friendship_delta_ab >= 0) return [e.agent_b, e.agent_a];
  return [e.agent_a, e.agent_b];
}

/** Holders of an active fact of `type` about `subject` (who would know who was in the wrong). */
function factHolders(types: readonly string[], subject: number): number[] {
  return db.select({ known: shared_knowledge.known_by }).from(shared_knowledge)
    .where(and(inArray(shared_knowledge.type, [...types]), eq(shared_knowledge.is_active, true),
      or(eq(shared_knowledge.subject_id, subject), eq(shared_knowledge.target_id, subject)))).all()
    .flatMap((r) => r.known as number[]);
}

/** The people close to `id` (their regard ≥ 40): they hear what was done to them. */
function confidantsOf(id: number): number[] {
  return gatherCandidates(id).filter((c) => c.friendship >= 40).map((c) => c.id);
}

/**
 * A relationship event was applied (the relationships phase). Starts a feud when
 * it is a falling-out between two living residents, freshens a running one, or
 * ends one when the two make up. Records only: the deciding is the hourly pass's.
 */
export function onRelationshipEvent(p: { eventId: number; oldStatus: string; newStatus: string }, nowMin: number): void {
  const e = db.select().from(relationshipEvents).where(eq(relationshipEvents.id, p.eventId)).get();
  if (!e) return;
  if (MENDS.has(e.event_type)) {
    const f = feudBetween(e.agent_a, e.agent_b);
    if (f) finishFeud(f, 'reconciled', nowMin);
    return;
  }
  const trig = TRIGGERS[e.event_type];
  if (!trig || !isActive(e.agent_a) || !isActive(e.agent_b)) return;
  let [aId, bId] = orient(e);
  let culprit: Side | null = null;
  let knownBy: number[] = [];
  const rel = relOf(aId, bId);
  const avg = rel ? (rel.friendship_ab + rel.friendship_ba) / 2 : 0;

  switch (trig.kind) {
    case 'clash':
      break;
    case 'quarrel':
      // A sour talk is only a falling-out between people already at odds.
      if (!HOSTILE_STATUSES.has(p.oldStatus) && avg > -10 && !(rel?.tags ?? []).includes('grudge')) {
        const f = feudBetween(aId, bId);
        if (f) f.lastActivityMin = nowMin;
        return;
      }
      break;
    case 'betrayal': {
      // "<discoverer> found out about <partner>'s affair": the one who strayed is in the wrong.
      const discoverer = e.description.startsWith(nameOf(e.agent_a)) ? e.agent_a : e.agent_b;
      [aId, bId] = [discoverer, discoverer === e.agent_a ? e.agent_b : e.agent_a];
      culprit = 'b';
      knownBy = factHolders(['affair'], bId);
      break;
    }
    case 'debt': {
      const loan = db.select().from(loans).where(or(
        and(eq(loans.lender_id, e.agent_a), eq(loans.borrower_id, e.agent_b)),
        and(eq(loans.lender_id, e.agent_b), eq(loans.borrower_id, e.agent_a)),
      )).all().pop();
      if (loan) [aId, bId] = [loan.lender_id, loan.borrower_id];
      culprit = 'b';
      knownBy = factHolders(['debt'], bId);
      break;
    }
    case 'slight': {
      // One slight between friends is forgiven; two, or one on top of coolness, is a falling-out.
      const n = noteSlight(aId, bId, nowMin);
      if (n < FACTIONS.SLIGHTS_TO_FEUD && avg > 10) return;
      culprit = 'b';
      knownBy = confidantsOf(aId);
      break;
    }
  }
  const f = startFeud({
    aId, bId, cause: e.event_type, causeText: trig.text, culprit, culpritKnownBy: knownBy,
    adultCause: trig.kind === 'betrayal', nowMin, population: population(),
  });
  if (!f) return;
  addLog(f, nowMin, `${nameOf(aId)} and ${nameOf(bId)} fell out over ${trig.text}.`);
  lineUpDeciders(f, nowMin);
}

/** The people close to either side, closest first, each with a day to decide on. */
function lineUpDeciders(f: Feud, nowMin: number): void {
  const minAge = f.adultCause ? 18 : 16;
  const byId = new Map<number, number>();
  for (const c of [...gatherCandidates(f.aId), ...gatherCandidates(f.bId)]) {
    if (c.id === f.aId || c.id === f.bId || c.age < minAge) continue;
    const w = tieWeightOf(c.ties, CLOSE);
    if (w > 0) byId.set(c.id, Math.max(byId.get(c.id) ?? 0, w));
  }
  const chosen = [...byId].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, FACTIONS.MAX_DECIDERS);
  const rng = rngFor(`line-up|${f.id}|${nowMin}`);
  for (const [id] of chosen) {
    f.pending.set(id, nowMin + FACTIONS.DECIDE_AFTER_MIN + Math.round(rng() * FACTIONS.DECIDE_SPREAD_MIN));
  }
}

// ─── The hourly pass ─────────────────────────────────────────────────────────

/** Hourly (engine/tick.ts, in a transaction): decisions due, summary rows, town feuds, endings, thaws. */
export function factionsHourly(nowMin: number): void {
  const pop = population();
  for (const f of activeFeuds()) {
    if (!isActive(f.aId) || !isActive(f.bId)) {
      finishFeud(f, 'gone', nowMin);
      continue;
    }
    for (const [id, due] of [...f.pending]) {
      if (due > nowMin) continue;
      f.pending.delete(id);
      if (isActive(id)) decide(f, id, nowMin);
    }
    if (f.flushAtMin != null && nowMin >= f.flushAtMin) flush(f);
    checkTownFeud(f, pop, nowMin);
    if (f.pending.size === 0 && nowMin - f.lastActivityMin >= FACTIONS.QUIET_MIN) finishFeud(f, 'faded', nowMin);
  }
  for (const t of takeDueThaws(nowMin)) {
    if (!isActive(t.fromId) || !isActive(t.toId)) continue;
    feel(t.fromId, t.toId, 'thaw', `${nameOf(t.fromId)} came round to ${nameOf(t.toId)} once the feud was over`, {
      fromCaller: { friendship: t.amount }, fromTarget: { friendship: Math.ceil(t.amount / 2) }, sentiment: 0.2,
    });
    noteCooled(t.fromId, t.toId, -t.amount);
  }
}

/** One person makes up their mind. */
export function decide(f: Feud, id: number, nowMin: number): Stance {
  const A = nameOf(f.aId), B = nameOf(f.bId);
  // Already standing with someone in another feud: they keep out of this one.
  if (sidesHeldBy(id).length >= FACTIONS.MAX_SIDES_PER_PERSON) {
    f.stances.set(id, 'neutral');
    countTally('neutral');
    return 'neutral';
  }
  const tiesA = gatherCandidates(f.aId).find((c) => c.id === id)?.ties ?? [];
  const tiesB = gatherCandidates(f.bId).find((c) => c.id === id)?.ties ?? [];
  const p = personalityOf(id);
  const decision = decideSide({
    towardA: { tie: tieWeightOf(tiesA, CLOSE), ...feelingToward(id, f.aId) },
    towardB: { tie: tieWeightOf(tiesB, CLOSE), ...feelingToward(id, f.bId) },
    warmth: p?.warmth ?? 50, aggression: p?.aggression ?? 50, loyalty: p?.loyalty ?? 50, morality: p?.morality ?? 50,
    knownCulprit: f.culprit != null && f.culpritKnownBy.includes(id) ? f.culprit : null,
  }, rngFor(`side|${f.id}|${id}`));
  let stance = decision.stance;
  const me = nameOf(id);

  if (decision.torn) {
    countTally('torn');
    mood(id, -4, 'torn_loyalties', 2 * DAY, nowMin);
    addTensionFor(id, 10, `caught between ${A} and ${B}`, `${A} and ${B}`);
    remember(id, `${firstOf(f.aId)} and ${firstOf(f.bId)} have fallen out, and I care for them both. I hate being caught in the middle.`, -0.4, 6, f.aId);
  }

  if (stance === 'mediator') {
    if (scheduleMediation(f, id, nowMin)) {
      countTally('mediationsTried');
      f.stances.set(id, 'mediator');
      addLog(f, nowMin, `${me} set out to make peace between them.`);
      f.lastActivityMin = nowMin;
      return 'mediator';
    }
    stance = 'neutral';
  }

  f.stances.set(id, stance);
  if (stance === 'a' || stance === 'b') {
    countTally('sided');
    const own = stance === 'a' ? f.aId : f.bId;
    const opp = stance === 'a' ? f.bId : f.aId;
    const cool = coolAllowance(id, opp, FACTIONS.SIDE_COOL);
    if (cool > 0) {
      feel(id, opp, 'took_sides', `${me} took ${nameOf(own)}'s side against ${nameOf(opp)}`, {
        fromCaller: { friendship: -cool, trust: -2 }, fromTarget: { friendship: -Math.ceil(cool / 2) }, sentiment: -0.3,
      });
      noteCooled(id, opp, cool);
      f.cooled.set(id, (f.cooled.get(id) ?? 0) + cool);
    }
    feel(id, own, 'stood_by', `${me} stood by ${nameOf(own)}`, {
      fromCaller: { friendship: 2 }, fromTarget: { friendship: 3, trust: 2 }, sentiment: 0.4,
    });
    remember(id, `I've taken ${firstOf(own)}'s side in this business with ${firstOf(opp)}. Somebody has to stand by them.`, -0.1, 6, own);
    remember(own, `${firstOf(id)} is standing by me against ${firstOf(opp)}. I won't forget it.`, 0.5, 6, id);
    remember(opp, `${firstOf(id)} has taken ${firstOf(own)}'s side against me.`, -0.4, 6, id);
    addLog(f, nowMin, `${me} took ${nameOf(own)}'s side.`);
  } else {
    countTally('neutral');
  }
  f.buffer.push({ id, stance, torn: decision.torn });
  if (f.flushAtMin == null) f.flushAtMin = nowMin + FACTIONS.FLUSH_AFTER_MIN;
  f.lastActivityMin = nowMin;
  return stance;
}

/**
 * The batch of decisions as ONE row: "The quarrel between A and B has split
 * their friends: …". A lone side-taker gets a row of their own; a lone neutral
 * gets none unless they are torn (that is a story).
 */
export function flush(f: Feud): void {
  const batch = f.buffer;
  f.buffer = [];
  f.flushAtMin = null;
  const A = nameOf(f.aId), B = nameOf(f.bId);
  const withA = batch.filter((d) => d.stance === 'a').map((d) => d.id);
  const withB = batch.filter((d) => d.stance === 'b').map((d) => d.id);
  const out = batch.filter((d) => d.stance === 'neutral').map((d) => d.id);
  const torn = batch.filter((d) => d.torn).map((d) => d.id);
  const sided = withA.length + withB.length;
  if (sided === 0 && torn.length === 0) return;
  const who = (ids: number[]) => nameList(ids.map(nameOf));
  if (sided === 1 && batch.length === 1) {
    const id = withA[0] ?? withB[0];
    const own = withA.length ? A : B, opp = withA.length ? B : A;
    feudFeed(f, 'took_sides', `${nameOf(id)} has taken ${own}'s side in the quarrel with ${opp}${torn.includes(id) ? ', though it tore at them' : ''}.`, 0, [id]);
    return;
  }
  if (sided === 0) {
    feudFeed(f, 'torn', `${who(torn)}, close to both ${A} and ${B}, ${torn.length === 1 ? 'is' : 'are'} torn between them.`, 0, torn);
    return;
  }
  const parts: string[] = [];
  if (withA.length) parts.push(`${who(withA)} stand${withA.length === 1 ? 's' : ''} with ${firstOf(f.aId)}`);
  if (withB.length) parts.push(`${who(withB)} with ${firstOf(f.bId)}`);
  let text = `The quarrel between ${A} and ${B} has split their friends: ${parts.join('; ')}.`;
  const neutralNotTorn = out.filter((id) => !torn.includes(id));
  if (neutralNotTorn.length) text += ` ${who(neutralNotTorn)} won't take sides.`;
  const tornOut = out.filter((id) => torn.includes(id));
  if (tornOut.length) text += ` ${who(tornOut)} ${tornOut.length === 1 ? 'is' : 'are'} torn between them.`;
  feudFeed(f, 'took_sides', text, 0.17, batch.map((d) => d.id));
}

function checkTownFeud(f: Feud, pop: number, nowMin: number): void {
  if (f.townSinceMin != null) return;
  const c = sideCounts(f);
  const need = townSideMin(pop);
  if (c.a.length < need || c.b.length < need) return;
  f.townSinceMin = nowMin;
  f.lastActivityMin = nowMin;
  countTally('townStarted');
  const text = `The quarrel between ${nameOf(f.aId)} and ${nameOf(f.bId)} has become a town feud: ${nameList(c.a.map(nameOf))} stand with ${firstOf(f.aId)}, ${nameList(c.b.map(nameOf))} with ${firstOf(f.bId)}.`;
  addLog(f, nowMin, 'It became a town feud.');
  feudFeed(f, 'town_feud', text, 0.7, [...c.a, ...c.b]);
}

/** The feud is over. A town feud says so in the feed; a reconciliation thaws the side-takers. */
export function finishFeud(f: Feud, reason: FeudEnd, nowMin: number): void {
  if (f.buffer.length > 0) flush(f);
  endFeud(f, reason, nowMin);
  const A = nameOf(f.aId), B = nameOf(f.bId);
  if (reason === 'reconciled') {
    // Their friends come round, slowly: half of what side-taking cost, over the next days.
    let i = 0;
    for (const [id, lost] of f.cooled) {
      const stance = f.stances.get(id);
      const opp = stance === 'a' ? f.bId : stance === 'b' ? f.aId : null;
      if (opp == null || lost <= 0) continue;
      addThaw(id, opp, Math.ceil(lost / 2), nowMin + DAY + (i++ % 4) * 8 * HOUR);
    }
  }
  if (f.townSinceMin == null) return;
  const gone = !isActive(f.aId) ? f.aId : !isActive(f.bId) ? f.bId : null;
  const text = reason === 'reconciled'
    ? `${A} and ${B} have made peace, and the feud that split the town is over. Their friends will come round, in time.`
    : reason === 'gone' && gone != null
      ? `With ${nameOf(gone)} gone, the feud between ${A} and ${B} is over — though not everyone has forgotten whose side they were on.`
      : `The feud between ${A} and ${B} has burned itself out. Nobody quite remembers who said what first.`;
  feudFeed(f, 'feud_ended', text, 0.7, [...f.stances.keys()]);
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

function guarded<T>(name: string, fn: (p: T) => void): (p: T) => void {
  return (p: T) => {
    try {
      fn(p);
    } catch (err) {
      console.warn(`[factions] ${name} failed:`, (err as Error).message);
    }
  };
}

let initialized = false;

function initFactions(): void {
  if (initialized) return;
  initialized = true;
  registerMediateKind((f, nowMin) => finishFeud(f, 'reconciled', nowMin));
  simEvents.on('relationship:event_applied', guarded<{ eventId: number; oldStatus: string; newStatus: string }>(
    'relationship:event_applied', (p) => onRelationshipEvent(p, gameMinutesNow())));
}

initFactions();
