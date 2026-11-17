/**
 * The built-in kinds of social call (SOCIAL_CALL_KINDS) and the producers that
 * schedule them. Each kind is data plus a few small functions: who comes (a
 * pickCallers spec), when (a stagger), why (the topic, for the LLM prompt and
 * the template scripts), what the cast bar says, and what the visit leaves
 * behind. The table is the whole policy; the engine and the decision phase know
 * nothing of sickness or birthdays, so later passes add kinds by registering
 * their own (engine.ts `registerSocialCallKind`).
 *
 * Balance (13 residents): a handful of calls a game day at most, usually 0-3.
 * Every kind has a cap of callers per target, a per-pair cooldown, and the
 * producers below add a per-target cooldown and stagger the visitors over hours
 * or days. Loans live in ./loans.ts (a table, repayment, the soured debt).
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, agentStates, economy, relationships } from '../../db/schema';
import { congratsTopic } from '../../ai/prompts';
import { firstName } from '../../ai/names';
import { HEALER_JOBS, JOBLESS } from '../careers';
import { relieveTension } from '../cascade';
import { noteCaredBy } from '../populationFlow';
import { getEffectivePersonality } from '../states';
import type { PersonalityProfile } from '../personality';
import { logActivity } from '../activityLogger';
import {
  addWatch, callRecordsFor, callsMadeTo, pendingCallsFor, registerSocialCallKind, scheduleCall,
} from './engine';
import { bring, favour, feed, feel, firstOf, giftClause, mood, nameOf, remember, whereIs } from './effects';
import { produceCalls, rngFor } from './produce';
import type { TieKind } from './pickCallers';
import { CALL_TOPIC } from './topics';
import type { CallWatch, SocialCall, SocialCallKind, VisitResult } from './types';
import { LEND_MONEY_KIND } from './loans';
import { noteFavourReturned } from './reciprocity';

const HOUR = 60;
const DAY = 24 * HOUR;

/** Everyone who is somebody to you, closest first: the default circle for a personal call. */
const CLOSE: readonly TieKind[] = ['spouse', 'partner', 'fiance', 'family', 'best_friend', 'friend'];

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** The target's friendship toward the caller. */
function regardOf(fromId: number, toId: number): number {
  const lo = Math.min(fromId, toId), hi = Math.max(fromId, toId);
  const rel = db.select().from(relationships).where(and(eq(relationships.agent_a, lo), eq(relationships.agent_b, hi))).get();
  if (!rel) return 0;
  return rel.agent_a === fromId ? rel.friendship_ab : rel.friendship_ba;
}

function personalityOf(id: number): PersonalityProfile | null {
  return getEffectivePersonality(id)
    ?? (db.select({ p: agents.personality }).from(agents).where(eq(agents.id, id)).get()?.p as PersonalityProfile | null) ?? null;
}

/**
 * Did the visit go well? An LLM chat says so by its tone; a template chat's
 * lines were picked from the pair's state, so its sentiment says little — the
 * target's own regard for the caller and their warmth decide it, with a roll
 * (seeded on the call: the same visit always lands the same way).
 */
export function defaultJudge(call: SocialCall, chat: { template: boolean; sentiment: number }): boolean {
  if (!chat.template) return chat.sentiment >= -0.15;
  const regard = regardOf(call.targetId, call.callerId);
  const warmth = personalityOf(call.targetId)?.warmth ?? 50;
  const p = Math.max(0.35, Math.min(0.97, 0.8 + regard / 300 + (warmth - 50) / 300));
  return rngFor(`judge|${call.id}`)() < p;
}

function hasState(agentId: number, type: string): boolean {
  return db.select({ id: agentStates.id }).from(agentStates)
    .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, type))).get() != null;
}

function isActive(agentId: number): boolean {
  return db.select({ a: agents.is_active }).from(agents).where(eq(agents.id, agentId)).get()?.a === true;
}

function dayStartOf(min: number): number {
  return min - (min % DAY);
}

/** Feed line for a visit that didn't come off: still the one row, just a cooler one. */
function coolVisit(call: SocialCall, what: string): void {
  feed(call, 'consolation', `${nameOf(call.callerId)} ${what}, but ${firstOf(call.targetId)} was in no mood for company.`, 0.1, whereIs(call.callerId));
}

/** The warm half most visits share: a lift, a bit more regard both ways, the favour. */
function warmVisit(call: SocialCall, r: VisitResult, o: { moodValue: number; moodSource: string; moodMin: number; fromTarget: number; fromCaller: number; trust?: number; favour: number; eventType: string; description: string }): void {
  mood(call.targetId, o.moodValue, o.moodSource, o.moodMin, r.nowMin);
  feel(call.callerId, call.targetId, o.eventType, o.description, {
    fromCaller: { friendship: o.fromCaller, trust: Math.round((o.trust ?? 0) / 2) },
    fromTarget: { friendship: o.fromTarget, trust: o.trust ?? 0 },
    sentiment: 0.6,
  });
  favour(call.callerId, call.targetId, o.favour);
  // Kindness coming back: the target remembers who came to them because they
  // once went to the caller (the favour just recorded pays part of that debt).
  if (call.payload.returning === true) {
    noteFavourReturned();
    remember(call.targetId, `${firstOf(call.callerId)} came to me the way I once went to them. Kindness comes back.`, 0.5, 5, call.callerId);
  }
}

// ─── sick_visit ──────────────────────────────────────────────────────────────

const SICK_VISIT: SocialCallKind = {
  id: 'sick_visit',
  maxPendingPerTarget: 2,
  pairCooldownMin: 3 * DAY,
  // Not dropped when the fever breaks: a town with a doctor mends most patients
  // within hours (the first soak dropped 8 of 8 visits that way), and calling
  // on someone the day after they were ill is still the kindness. The window
  // reaches into the next evening: a caller who works and a patient who sleeps
  // early share only a few evening hours (a 14 h window let 7 of 10 lapse).
  windowMin: 30 * HOUR,
  topic: () => CALL_TOPIC.sick_visit,
  label: (_c, n) => ({ walking: `On the way to see ${n}, who is ill`, there: `Visiting ${n}, who is ill` }),
  consequence(call, r) {
    const caller = nameOf(call.callerId), target = nameOf(call.targetId);
    if (!r.good) return coolVisit(call, `looked in on ${target}, who is ill`);
    const gift = bring(call, { foodOnly: true });
    warmVisit(call, r, {
      moodValue: 6, moodSource: 'sick_visit', moodMin: 12 * HOUR, fromTarget: 4, fromCaller: 2, trust: 3, favour: 1,
      eventType: 'visit', description: `${caller} visited ${target} while they were ill`,
    });
    // A little help mending: rest, a warm meal, company. Never below the floor
    // the other treatments keep (0.1), and never the cure a healer is.
    const sick = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, call.targetId), eq(agentStates.type, 'sick'))).orderBy(desc(agentStates.id)).get();
    if (sick) db.update(agentStates).set({ severity: Math.max(0.1, sick.severity - 0.05) }).where(eq(agentStates.id, sick.id)).run();
    remember(call.callerId, `I went to see ${firstOf(call.targetId)}, who is ill${gift?.item ? ', and took them something to eat' : ''}. I hope they mend soon.`, 0.3, 5, call.targetId);
    remember(call.targetId, `${firstOf(call.callerId)} came to see me while I was ill${gift?.item ? ' and brought me something to eat' : ''}. I won't forget it.`, 0.6, 6, call.callerId);
    feed(call, 'sick_visit', `${caller} called on ${target}, who is ill${giftClause(gift)}.`, 0.4, whereIs(call.callerId));
  },
};

/** Returns whether it was a real illness (the reciprocity ordeal waits for one too). */
function onSick(agentId: number, nowMin: number): boolean {
  const sick = db.select().from(agentStates)
    .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, 'sick'))).orderBy(desc(agentStates.id)).get();
  // Not every sniffle: a fever bad enough to keep someone in bed.
  if (!sick || sick.severity < 0.4) return false;
  produceCalls({
    kind: 'sick_visit', targetId: agentId, nowMin,
    // Not the household: they are already at the bedside.
    spec: { ties: ['spouse', 'partner', 'fiance', 'family', 'best_friend', 'friend', 'acquaintance', 'neighbour'], max: 2, eagerness: 0.8, exclude: housematesOf(agentId) },
    stagger: { first: 30, spacing: 4 * HOUR, jitter: 2 * HOUR },
    targetCooldownMin: 3 * DAY,
  });
  return true;
}

function housematesOf(agentId: number): Set<number> {
  const home = db.select({ home: agents.home }).from(agents).where(eq(agents.id, agentId)).get()?.home;
  if (home == null) return new Set();
  return new Set(db.select({ id: agents.id }).from(agents).where(and(eq(agents.home, home), eq(agents.is_active, true))).all()
    .map((r) => r.id).filter((id) => id !== agentId));
}

// ─── vigil (urgent) ──────────────────────────────────────────────────────────

const VIGIL: SocialCallKind = {
  id: 'vigil',
  urgent: true,
  maxPendingPerTarget: 4,
  pairCooldownMin: 2 * DAY,
  windowMin: 12 * HOUR,
  lingerMin: 2 * HOUR,
  stillRelevant: (call) => hasState(call.targetId, 'sick'),
  topic: () => CALL_TOPIC.vigil,
  label: (c, n) => c.payload.role === 'healer'
    ? { walking: `Sent for: ${n} is gravely ill`, there: `Tending ${n}, who is gravely ill` }
    : { walking: `Hurrying to ${n}'s bedside`, there: `Keeping vigil at ${n}'s bedside` },
  // A deathbed is not a social call that can "go badly".
  judge: () => true,
  consequence(call, r) {
    const caller = nameOf(call.callerId), target = nameOf(call.targetId);
    warmVisit(call, r, {
      moodValue: 8, moodSource: 'vigil', moodMin: 12 * HOUR, fromTarget: 5, fromCaller: 4, trust: 5, favour: 2,
      eventType: 'visit', description: `${caller} sat with ${target} through a grave illness`,
    });
    if (call.payload.role === 'healer') {
      remember(call.callerId, `I was sent for to tend ${firstOf(call.targetId)}. They are gravely ill; I did what I could.`, -0.2, 7, call.targetId);
      remember(call.targetId, `${firstOf(call.callerId)} came to tend me when I was at my worst.`, 0.6, 8, call.callerId);
      feed(call, 'vigil', `${caller} was sent for and came to tend ${target}, who is gravely ill.`, 0.8, whereIs(call.callerId));
      return;
    }
    remember(call.callerId, `I sat with ${firstOf(call.targetId)} at their bedside. They are gravely ill, and I'm afraid for them.`, -0.4, 8, call.targetId);
    remember(call.targetId, `${firstOf(call.callerId)} came and sat with me when I was gravely ill. I wasn't alone.`, 0.6, 8, call.callerId);
    feed(call, 'vigil', `${caller} is keeping vigil at ${target}'s bedside.`, 0.8, whereIs(call.callerId));
  },
};

function onGrave(agentId: number, nowMin: number): void {
  produceCalls({
    kind: 'vigil', targetId: agentId, nowMin,
    spec: { ties: ['spouse', 'partner', 'fiance', 'family', 'best_friend', 'housemate'], max: 3, eagerness: 1, maxChance: 0.98 },
    stagger: { first: 0, spacing: 90, jitter: HOUR },
  });
  // And the healer, if the town has one who isn't already at the bedside.
  const patient = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!patient) return;
  const healers = db.select({ id: agents.id, loc: agents.current_location, job: economy.job }).from(agents)
    .innerJoin(economy, eq(economy.agent_id, agents.id))
    .where(eq(agents.is_active, true)).all()
    .filter((h) => h.id !== agentId && HEALER_JOBS.includes(h.job) && !hasState(h.id, 'arrested'));
  if (healers.length === 0 || healers.some((h) => h.loc != null && h.loc === patient.current_location)) return;
  scheduleCall({ kind: 'vigil', callerId: healers[0].id, targetId: agentId, nowMin, payload: { role: 'healer' } });
}

/**
 * The patient died. Those who kept the vigil grieve harder (they were there at
 * the end); those who were on their way and never got there, or let the call
 * lapse, carry a little guilt. A mood modifier and a memory each.
 */
function onDeathAfterVigil(deadId: number, nowMin: number): void {
  const since = nowMin - 4 * DAY;
  const deadName = firstOf(deadId);
  const kept = new Set(callsMadeTo(deadId, 'vigil', since).filter((r) => r.payload.role !== 'healer').map((r) => r.callerId));
  for (const id of kept) {
    if (!isActive(id)) continue;
    mood(id, -8, 'vigil_grief', 3 * DAY, nowMin);
    remember(id, `I sat with ${deadName} at the end. I keep seeing that room.`, -0.8, 9, deadId);
  }
  const missed = new Set([
    ...callRecordsFor(deadId, 'vigil', since).filter((r) => r.outcome === 'expired').map((r) => r.callerId),
    ...pendingCallsFor(deadId, 'vigil').map((c) => c.callerId),
  ].filter((id) => !kept.has(id)));
  for (const id of missed) {
    if (!isActive(id)) continue;
    mood(id, -6, 'vigil_guilt', 2 * DAY, nowMin);
    remember(id, `I meant to sit with ${deadName} at the end, and I never got there. I should have gone sooner.`, -0.7, 8, deadId);
  }
}

// ─── condolence ──────────────────────────────────────────────────────────────

/** At most this many condolence calls for one death, however many mourners it left. */
const CONDOLENCES_PER_DEATH = 5;

const CONDOLENCE: SocialCallKind = {
  id: 'condolence',
  maxPendingPerTarget: 2,
  pairCooldownMin: 7 * DAY,
  windowMin: DAY,
  topic: () => CALL_TOPIC.condolence,
  label: (_c, n) => ({ walking: `On the way to offer ${n} condolences`, there: `Offering ${n} condolences` }),
  consequence(call, r) {
    const caller = nameOf(call.callerId), target = nameOf(call.targetId);
    if (!r.good) return coolVisit(call, `called to offer ${target} condolences`);
    const gift = bring(call, { foodOnly: true });
    warmVisit(call, r, {
      moodValue: 6, moodSource: 'condolence', moodMin: DAY, fromTarget: 4, fromCaller: 2, trust: 3, favour: 1,
      eventType: 'visit', description: `${caller} came to ${target} with condolences`,
    });
    const deceased = typeof call.payload.deceased === 'string' ? call.payload.deceased : 'them';
    remember(call.callerId, `I went to ${firstOf(call.targetId)} to say how sorry I am about ${deceased}.`, 0.1, 5, call.targetId);
    remember(call.targetId, `${firstOf(call.callerId)} came by to say they were sorry about ${deceased}${gift?.item ? ', and brought food' : ''}. It helped, a little.`, 0.4, 6, call.callerId);
    feed(call, 'condolence', `${caller} called on ${target} to offer condolences for ${deceased}${giftClause(gift)}.`, 0.4, whereIs(call.callerId));
  },
};

/**
 * Condolence calls scheduled per death, across every mourner (keyed by the
 * deceased's name, which is all the `grieving` cause carries). A death leaves
 * several mourners at once, and each would otherwise bring two callers.
 */
const condolenceTally = new Map<string, number>();

function onMourning(agentId: number, deceased: string, nowMin: number): void {
  const perDeath = condolenceTally.get(deceased) ?? 0;
  if (perDeath >= CONDOLENCES_PER_DEATH) return;
  // A condolence call comes from a friend who is not grieving themselves (the
  // mourners have each other, and the funeral), and not from the household.
  // Read off the table, not the per-tick states cache: the death pipeline has
  // just inserted the other mourners' rows.
  const grieving = new Set(db.select({ id: agentStates.agent_id }).from(agentStates).where(eq(agentStates.type, 'grieving')).all().map((r) => r.id));
  const calls = produceCalls({
    kind: 'condolence', targetId: agentId, nowMin,
    spec: {
      ties: ['family', 'best_friend', 'friend', 'clique', 'acquaintance'], max: Math.min(2, CONDOLENCES_PER_DEATH - perDeath), eagerness: 0.7,
      exclude: new Set([...grieving, ...housematesOf(agentId)]),
    },
    stagger: { first: 2 * HOUR, spacing: 15 * HOUR, jitter: 8 * HOUR },
    payload: { deceased },
  });
  condolenceTally.set(deceased, perDeath + calls.length);
}

// ─── congratulate ────────────────────────────────────────────────────────────

const CONGRATULATE: SocialCallKind = {
  id: 'congratulate',
  maxPendingPerTarget: 2,
  pairCooldownMin: 5 * DAY,
  windowMin: 36 * HOUR,
  topic: (c) => c.payload.occasion === 'birth' ? congratsTopic(String(c.payload.childName ?? 'the baby'))
    : c.payload.occasion === 'election' ? CALL_TOPIC.congratulate_election : CALL_TOPIC.congratulate_engagement,
  label: (_c, n) => ({ walking: `On the way to congratulate ${n}`, there: `Congratulating ${n}` }),
  consequence(call, r) {
    const caller = nameOf(call.callerId), target = nameOf(call.targetId);
    const on = call.payload.occasion === 'birth' ? `the birth of little ${String(call.payload.childName ?? 'one')}`
      : call.payload.occasion === 'election' ? 'becoming mayor' : 'the engagement';
    if (!r.good) {
      feed(call, 'congratulation', `${caller} came to congratulate ${target} on ${on}, and was received coolly.`, 0.1, whereIs(call.callerId));
      return;
    }
    const gift = bring(call, { allowMoney: true, maxMoney: 8 });
    warmVisit(call, r, {
      moodValue: 5, moodSource: 'congratulated', moodMin: 12 * HOUR, fromTarget: 3, fromCaller: 2, trust: 2, favour: 1,
      eventType: 'visit', description: `${caller} congratulated ${target} on ${on}`,
    });
    mood(call.callerId, 4, 'congratulating', 12 * HOUR, r.nowMin);
    remember(call.callerId, `I went to congratulate ${firstOf(call.targetId)} on ${on}. They were so happy.`, 0.5, 4, call.targetId);
    remember(call.targetId, `${firstOf(call.callerId)} came by to congratulate me on ${on}${gift ? ' and brought a little something' : ''}.`, 0.6, 5, call.callerId);
    feed(call, 'congratulation', `${caller} called on ${target} to congratulate them on ${on}${giftClause(gift)}.`, 0.3, whereIs(call.callerId));
  },
};

/** Friends of one or two happy people: at most `total` callers, each to the one they are closer to. */
function congratulate(targetIds: number[], occasion: string, nowMin: number, extra: Record<string, string> = {}, total = 3): void {
  let left = total;
  const chosen = new Set<number>();
  for (const targetId of targetIds) {
    if (left <= 0) break;
    const calls = produceCalls({
      kind: 'congratulate', targetId, nowMin,
      spec: { ties: ['family', 'best_friend', 'friend', 'clique', 'acquaintance'], max: Math.min(2, left), eagerness: 0.7, exclude: new Set([...targetIds, ...chosen]) },
      stagger: { first: 2 * HOUR, spacing: 8 * HOUR, jitter: 5 * HOUR },
      payload: { occasion, ...extra },
    });
    for (const c of calls) chosen.add(c.callerId);
    left -= calls.length;
  }
}

// ─── birthday_wish ───────────────────────────────────────────────────────────

const BIRTHDAY_WISH: SocialCallKind = {
  id: 'birthday_wish',
  maxPendingPerTarget: 3,
  pairCooldownMin: 30 * DAY,
  windowMin: 14 * HOUR,
  topic: () => CALL_TOPIC.birthday_wish,
  label: (_c, n) => ({ walking: `On the way to wish ${n} a happy birthday`, there: `Wishing ${n} a happy birthday` }),
  consequence(call, r) {
    const caller = nameOf(call.callerId), target = nameOf(call.targetId);
    if (!r.good) {
      feed(call, 'birthday_wish', `${caller} remembered ${target}'s birthday, though ${firstOf(call.targetId)} was in no mood to celebrate.`, 0.1, whereIs(call.callerId));
      return;
    }
    const gift = rngFor(`bday-gift|${call.id}`)() < 0.5 ? bring(call, { allowMoney: true, maxMoney: 6 }) : null;
    warmVisit(call, r, {
      moodValue: 5, moodSource: 'birthday_wish', moodMin: 12 * HOUR, fromTarget: 3, fromCaller: 1, trust: 2, favour: 1,
      eventType: 'visit', description: `${caller} remembered ${target}'s birthday`,
    });
    remember(call.targetId, `${firstOf(call.callerId)} remembered my birthday and came round to wish me well${gift ? ', with a little present' : ''}.`, 0.6, 5, call.callerId);
    remember(call.callerId, `I went round to wish ${firstOf(call.targetId)} a happy birthday.`, 0.4, 3, call.targetId);
    feed(call, 'birthday_wish', `${caller} came round to wish ${target} a happy birthday${giftClause(gift)}.`, 0.2, whereIs(call.callerId));
  },
  onWatchDue(w: CallWatch, nowMin: number) {
    if (!isActive(w.targetId)) return;
    if (callsMadeTo(w.targetId, 'birthday_wish', w.sinceMin).length > 0) return;
    // Nobody came. That absence is a story too — legible in the feed and in
    // how they carry the next day.
    const name = nameOf(w.targetId);
    mood(w.targetId, -5, 'forgotten_birthday', DAY, nowMin);
    remember(w.targetId, 'It was my birthday today, and nobody came by. Not one person remembered.', -0.5, 6, w.targetId);
    logActivity({
      type: 'social_call',
      initiator: w.targetId,
      severity: 0.2,
      templateData: { description: `Nobody came to wish ${name} a happy birthday.` },
      metadata: { beat: 'forgotten_birthday', callKind: 'birthday_wish' },
    });
  },
};

function onBirthday(agentId: number, nowMin: number): void {
  const day = dayStartOf(nowMin);
  const end = day + 21 * HOUR;
  addWatch({ kind: 'birthday_wish', targetId: agentId, sinceMin: day, dueMin: day + 22 * HOUR });
  produceCalls({
    kind: 'birthday_wish', targetId: agentId, nowMin,
    spec: { ties: [...CLOSE, 'housemate', 'acquaintance', 'clique', 'coworker'], max: 3, eagerness: 0.75 },
    // From mid-morning, an hour or two apart, all inside the day.
    stagger: { first: Math.max(0, day + 9 * HOUR - nowMin), spacing: 2 * HOUR, jitter: 4 * HOUR },
    expiresAtMin: end,
  });
}

// ─── welcome ─────────────────────────────────────────────────────────────────

const WELCOME: SocialCallKind = {
  id: 'welcome',
  maxPendingPerTarget: 3,
  pairCooldownMin: 30 * DAY,
  windowMin: DAY,
  topic: () => CALL_TOPIC.welcome,
  label: (_c, n) => ({ walking: `On the way to welcome ${n} to town`, there: `Welcoming ${n} to town` }),
  // A newcomer has no history with anyone: a welcome is welcome.
  judge: (_c, chat) => chat.template || chat.sentiment >= -0.3,
  consequence(call, r) {
    const caller = nameOf(call.callerId), target = nameOf(call.targetId);
    const gift = rngFor(`welcome-gift|${call.id}`)() < 0.5 ? bring(call, { foodOnly: true }) : null;
    // The first tie, above a stranger's: the relationships phase creates the
    // row from this event like from any other, and judges the status itself.
    warmVisit(call, r, {
      moodValue: 6, moodSource: 'welcomed', moodMin: DAY, fromTarget: 12, fromCaller: 10, trust: 6, favour: 1,
      eventType: 'visit', description: `${caller} welcomed ${target} to town`,
    });
    remember(call.targetId, `${firstOf(call.callerId)} came by to welcome me to town${gift ? ' and brought something to eat' : ''}. Maybe I'll like it here.`, 0.6, 6, call.callerId);
    remember(call.callerId, `I went to welcome the newcomer, ${target}. They seem nice enough.`, 0.3, 4, call.targetId);
    feed(call, 'welcome', `${caller} called on ${target} to welcome them to town${giftClause(gift)}.`, 0.3, whereIs(call.callerId));
  },
};

function onArrived(agentId: number, nowMin: number): void {
  const mayor = db.select({ id: economy.agent_id }).from(economy).where(eq(economy.job, 'mayor')).all()
    .map((r) => r.id).find((id) => id !== agentId && isActive(id));
  const calls = produceCalls({
    kind: 'welcome', targetId: agentId, nowMin,
    spec: { ties: ['neighbour', 'coworker', 'townsfolk'], max: mayor != null ? 2 : 3, eagerness: 0.9, extraTrait: 'curiosity', exclude: mayor != null ? new Set([mayor]) : undefined },
    stagger: { first: 3 * HOUR, spacing: 14 * HOUR, jitter: 6 * HOUR },
  });
  // The mayor calls on every newcomer, on the second day, if one is free to.
  if (mayor != null && calls.length < 3) {
    scheduleCall({ kind: 'welcome', callerId: mayor, targetId: agentId, nowMin, notBeforeMin: nowMin + 20 * HOUR });
  }
}

// ─── console ─────────────────────────────────────────────────────────────────

const CONSOLE: SocialCallKind = {
  id: 'console',
  maxPendingPerTarget: 2,
  pairCooldownMin: 4 * DAY,
  windowMin: DAY,
  topic: (c) => c.payload.reason === 'election' ? CALL_TOPIC.console_election
    : c.payload.reason === 'heartbreak' ? CALL_TOPIC.console_heartbreak : CALL_TOPIC.console_work,
  label: (_c, n) => ({ walking: `On the way to console ${n}`, there: `Consoling ${n}` }),
  consequence(call, r) {
    const caller = nameOf(call.callerId), target = nameOf(call.targetId);
    if (!r.good) return coolVisit(call, `came to console ${target}`);
    warmVisit(call, r, {
      moodValue: 6, moodSource: 'consoled', moodMin: DAY, fromTarget: 4, fromCaller: 2, trust: 3, favour: 1,
      eventType: 'visit', description: `${caller} consoled ${target}`,
    });
    relieveTension(call.targetId);
    const why = call.payload.reason === 'election' ? 'losing the election' : call.payload.reason === 'heartbreak' ? 'my broken heart' : 'losing my work';
    remember(call.targetId, `${firstOf(call.callerId)} came to cheer me up after ${why}. I needed that.`, 0.5, 6, call.callerId);
    remember(call.callerId, `I went to console ${firstOf(call.targetId)}. They took it hard.`, 0.2, 4, call.targetId);
    const after = call.payload.reason === 'election' ? 'after the election' : call.payload.reason === 'heartbreak' ? 'over a broken heart' : 'after losing their work';
    feed(call, 'consolation', `${caller} came to console ${target} ${after}.`, 0.3, whereIs(call.callerId));
  },
};

function consoleFor(agentId: number, reason: 'election' | 'heartbreak' | 'work', nowMin: number, exclude?: Set<number>): void {
  if (pendingCallsFor(agentId, 'console').length > 0) return;
  produceCalls({
    kind: 'console', targetId: agentId, nowMin,
    spec: { ties: [...(reason === 'heartbreak' ? ['family', 'best_friend', 'friend'] as const : CLOSE), 'acquaintance'], max: 2, eagerness: 0.65, exclude },
    stagger: { first: HOUR, spacing: 10 * HOUR, jitter: 4 * HOUR },
    payload: { reason },
    targetCooldownMin: 2 * DAY,
  });
}

// ─── plead_to_stay ───────────────────────────────────────────────────────────

const PLEAD_TO_STAY: SocialCallKind = {
  id: 'plead_to_stay',
  maxPendingPerTarget: 2,
  pairCooldownMin: 5 * DAY,
  windowMin: 18 * HOUR,
  topic: () => CALL_TOPIC.plead_to_stay,
  label: (_c, n) => ({ walking: `On the way to ask ${n} not to leave town`, there: `Asking ${n} not to leave town` }),
  consequence(call, r) {
    const caller = nameOf(call.callerId), target = nameOf(call.targetId);
    if (!r.good) {
      feed(call, 'plea_to_stay', `${caller} begged ${target} not to leave town, and got no answer.`, 0.3, whereIs(call.callerId));
      return;
    }
    // The "someone cares" signal populationFlow's leaving thought waits for.
    noteCaredBy(call.targetId, call.callerId);
    warmVisit(call, r, {
      moodValue: 5, moodSource: 'pleaded_with', moodMin: DAY, fromTarget: 4, fromCaller: 2, trust: 3, favour: 1,
      eventType: 'visit', description: `${caller} asked ${target} to stay in town`,
    });
    remember(call.targetId, `${firstOf(call.callerId)} came to ask me not to leave town. I didn't know anyone would mind.`, 0.5, 7, call.callerId);
    remember(call.callerId, `I asked ${firstOf(call.targetId)} not to leave town. I hope they listen.`, 0.1, 6, call.targetId);
    feed(call, 'plea_to_stay', `${caller} went to ${target} to ask them not to leave town.`, 0.4, whereIs(call.callerId));
  },
};

function pleadersOf(agentId: number, nowMin: number): number[] {
  return [...new Set(callsMadeTo(agentId, 'plead_to_stay', nowMin - 4 * DAY).filter((r) => r.good).map((r) => r.callerId))];
}

// ─── meet_at_gate ────────────────────────────────────────────────────────────

const MEET_AT_GATE: SocialCallKind = {
  id: 'meet_at_gate',
  maxPendingPerTarget: 1,
  pairCooldownMin: 7 * DAY,
  windowMin: 8 * HOUR,
  topic: (c) => c.payload.mode === 'reproach' ? CALL_TOPIC.reproach : CALL_TOPIC.welcome_home,
  label: (c, n) => c.payload.mode === 'reproach'
    ? { walking: `Going to give ${n} a piece of their mind`, there: `Giving ${n} a piece of their mind` }
    : { walking: `Going to meet ${n} out of jail`, there: `Welcoming ${n} home from jail` },
  judge: (c, chat) => c.payload.mode !== 'reproach' && defaultJudge(c, chat),
  consequence(call, r) {
    const caller = nameOf(call.callerId), target = nameOf(call.targetId);
    if (call.payload.mode === 'reproach' || !r.good) {
      mood(call.targetId, -4, 'reproached', 12 * HOUR, r.nowMin);
      feel(call.callerId, call.targetId, 'reproach', `${caller} gave ${target} a piece of their mind about jail`, {
        fromCaller: { friendship: -2, trust: -3 }, fromTarget: { friendship: -5 }, sentiment: -0.4,
      });
      remember(call.targetId, `${firstOf(call.callerId)} was waiting when I got out — to tell me how ashamed they are of me.`, -0.5, 6, call.callerId);
      remember(call.callerId, `I gave ${firstOf(call.targetId)} a piece of my mind about jail. Someone had to.`, -0.2, 5, call.targetId);
      feed(call, 'cold_shoulder', `${caller} met ${target} out of jail only to give them a piece of their mind.`, 0.4, whereIs(call.callerId));
      return;
    }
    warmVisit(call, r, {
      moodValue: 8, moodSource: 'welcomed_home', moodMin: DAY, fromTarget: 5, fromCaller: 2, trust: 4, favour: 1,
      eventType: 'visit', description: `${caller} met ${target} out of jail`,
    });
    remember(call.targetId, `When I got out of jail, ${firstOf(call.callerId)} was there to take me home. I won't forget that.`, 0.7, 7, call.callerId);
    remember(call.callerId, `I met ${firstOf(call.targetId)} out of jail and walked them home.`, 0.3, 5, call.targetId);
    feed(call, 'welcome_home', `${caller} was there to meet ${target} out of jail and welcome them home.`, 0.4, whereIs(call.callerId));
  },
};

function onReleased(agentId: number, nowMin: number): void {
  // A warm close tie comes to take them home...
  const warm = produceCalls({
    kind: 'meet_at_gate', targetId: agentId, nowMin,
    spec: { ties: ['spouse', 'partner', 'fiance', 'family', 'best_friend'], max: 1, eagerness: 0.9 },
    stagger: { first: 0, spacing: 0, jitter: 30 },
    filter: (c) => c.warmth >= 40,
    payload: { mode: 'welcome' },
  });
  if (warm.length > 0) return;
  // ...or, failing that, a stern one comes to say what they think of it.
  produceCalls({
    kind: 'meet_at_gate', targetId: agentId, nowMin,
    spec: { ties: ['spouse', 'partner', 'family', 'best_friend', 'friend'], max: 1, eagerness: 0.6, extraTrait: 'loyalty' },
    stagger: { first: 0, spacing: 0, jitter: 60 },
    filter: (c) => c.warmth < 40 && c.morality > 65 && c.friendship >= 30,
    payload: { mode: 'reproach' },
  });
}

// ─── The table ───────────────────────────────────────────────────────────────

export const SOCIAL_CALL_KINDS: readonly SocialCallKind[] = [
  SICK_VISIT, VIGIL, CONDOLENCE, CONGRATULATE, BIRTHDAY_WISH, WELCOME, CONSOLE, PLEAD_TO_STAY, MEET_AT_GATE, LEND_MONEY_KIND,
];

export function registerBuiltInKinds(): void {
  for (const k of SOCIAL_CALL_KINDS) registerSocialCallKind(k);
}

/** The producers, by trigger; listeners.ts wires them to simEvents. */
export const producers = {
  onSick,
  onGrave,
  onDeathAfterVigil,
  onMourning,
  onBirth: (parentIds: number[], childName: string, nowMin: number) => congratulate(parentIds, 'birth', nowMin, { childName }),
  onEngaged: (a: number, b: number, nowMin: number) => congratulate([a, b], 'engagement', nowMin),
  onElection: (winnerId: number, loserIds: number[], nowMin: number) => {
    congratulate([winnerId], 'election', nowMin, {}, 2);
    for (const id of loserIds) consoleFor(id, 'election', nowMin);
  },
  onJobChanged: (agentId: number, from: string, to: string, reason: string, nowMin: number) => {
    // A loss: out of work, not by choice (retiring, a new trade wanted, the
    // election's own consolation covers the ousted mayor).
    if (!JOBLESS.has(from) && to === 'unemployed' && reason !== 'ambition' && reason !== 'election') consoleFor(agentId, 'work', nowMin);
  },
  onHeartbroken: (agentId: number, nowMin: number) => {
    const partners = new Set(db.select().from(relationships).all()
      .filter((r) => (r.agent_a === agentId || r.agent_b === agentId) && (r.romance_ab > 20 || r.romance_ba > 20))
      .map((r) => (r.agent_a === agentId ? r.agent_b : r.agent_a)));
    consoleFor(agentId, 'heartbreak', nowMin, partners);
  },
  onThinkingOfLeaving: (agentId: number, nowMin: number) => {
    produceCalls({
      kind: 'plead_to_stay', targetId: agentId, nowMin,
      spec: { ties: [...CLOSE, 'housemate', 'acquaintance'], max: 2, eagerness: 0.85 },
      stagger: { first: HOUR, spacing: 4 * HOUR, jitter: 2 * HOUR },
    });
  },
  onDecidedToStay: (agentId: number, nowMin: number) => {
    for (const id of pleadersOf(agentId, nowMin)) {
      if (!isActive(id)) continue;
      mood(id, 4, 'friend_stayed', DAY, nowMin);
      remember(id, `${firstOf(agentId)} is staying in town after all. I'm glad I asked them to.`, 0.6, 6, agentId);
    }
  },
  onLeftTown: (agentId: number, name: string, nowMin: number) => {
    for (const id of pleadersOf(agentId, nowMin)) {
      if (!isActive(id)) continue;
      remember(id, `I asked ${firstName(name)} to stay, and they left anyway.`, -0.5, 6, agentId);
    }
  },
  onReleased,
  onArrived,
  onBirthday,
};

/** Drop per-world bookkeeping of the producers (worldCaches.ts, via index.ts). */
export function clearProducerState(): void {
  condolenceTally.clear();
}
