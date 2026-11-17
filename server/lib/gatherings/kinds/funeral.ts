/**
 * The funeral and the wake.
 *
 * A death used to start a `funeral` world event at once, with no place and no
 * pull: nobody went. Now the town buries its dead the next morning on the
 * square (worldgen has no church or graveyard), the people who loved them are
 * pulled in, the closest of them speaks, and who came — and who didn't — is
 * remembered:
 *
 *   must   — the mourners (lifeEventsEngine's `grieving`, cause "mourning <name>"),
 *            the spouse, partner, family and household, the heir;
 *   should — friends, coworkers, the clique, the mayor; a rival rolls on character:
 *            comes anyway (a story), or pointedly stays away (also a story);
 *   may    — everyone else.
 *
 * The moment is the eulogy, by the closest tie present. At the end a full
 * turnout eases the mourners' grief, an empty one embitters it, and a close tie
 * who stayed away without cause (not ill, jailed or gone) loses standing with the
 * mourners: "she didn't even come to the funeral".
 *
 * The wake follows that evening at the tavern, when there is one: the mourners
 * and whoever was at the funeral drink to the dead, and shared grief warms the
 * ties among them (small, capped).
 */
import { and, eq, like } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, agentStates, economy } from '../../../db/schema';
import { firstName } from '../../../ai/names';
import { startWorldEvent } from '../../../engine/systems/events';
import { heirsOf } from '../../heirs';
import { gatherCandidates } from '../../socialCalls/ties';
import { feel, mood, remember } from '../../socialCalls/effects';
import { invite, scheduleGathering } from '../engine';
import {
  DAY, HOUR, atPlace, dayStartOf, excused, gatheringFeed, isActive, nameList, regard, rngFor, squareVenue, statesOf, tavernVenue,
} from '../common';
import { GATHERING_TOPIC } from '../topics';
import type { Attendance, Gathering, GatheringKind } from '../types';
import { FRIENDS, KIN, holds, inviteByTies } from './invites';
import type { TieKind } from '../../socialCalls/pickCallers';

/** The funeral is held at this hour of the day after the death. */
export const FUNERAL_HOUR = 10;
export const FUNERAL_LENGTH_MIN = 3 * HOUR;
export const WAKE_HOUR = 19;
export const WAKE_LENGTH_MIN = 3 * HOUR;

/** A turnout this large (of the living) is "the whole town came": the mourners take comfort. */
const FULL_TURNOUT_SHARE = 0.4;
/** This few is an empty funeral: the mourners notice. */
const EMPTY_TURNOUT = 2;
/** Mourners a skipped funeral is held against (each a small relationship event). */
const RESENTERS_PER_SKIPPER = 3;
/** Pairs warmed at the wake, at most. */
const WAKE_PAIRS_MAX = 10;

function nameOf(id: number): string {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? 'someone';
}

function pronoun(id: number): { obj: string; pos: string } {
  const g = db.select({ g: agents.gender }).from(agents).where(eq(agents.id, id)).get()?.g;
  return g === 'female' ? { obj: 'her', pos: 'her' } : g === 'male' ? { obj: 'him', pos: 'his' } : { obj: 'them', pos: 'their' };
}

/** The mourners of `deadId` (the grieving states the death wrote), still grieving. */
export function mournersOf(deadId: number): number[] {
  return db.select({ id: agentStates.agent_id }).from(agentStates)
    .where(and(eq(agentStates.type, 'grieving'), like(agentStates.source, `event:death_of_${deadId}`))).all()
    .map((r) => r.id).filter(isActive);
}

/** When the funeral of someone who died at `deathMin` is held: the next day, mid-morning. */
export function funeralStart(deathMin: number): number {
  return dayStartOf(deathMin) + DAY + FUNERAL_HOUR * HOUR;
}

const CLOSE_TIES: readonly TieKind[] = [...KIN, ...FRIENDS];

/**
 * The eulogy's line, from what the speaker was to the dead. Templates, in the
 * voice of the time: a cheap LLM line is not worth a slot for a feed quote.
 */
export function eulogyLine(dead: string, tie: TieKind | 'other'): string {
  switch (tie) {
    case 'spouse':
    case 'partner':
    case 'fiance':
      return `${dead} was my whole life. I don't know how to keep the house without them.`;
    case 'family':
      return `${dead} gave me our children and the best years I had.`;
    case 'housemate':
      return `We shared a roof, ${dead} and I. The place is too quiet now.`;
    case 'best_friend':
      return `There was never a truer friend than ${dead}. I'll miss them every day I have left.`;
    case 'friend':
    case 'acquaintance':
      return `${dead} was a good friend to me, and to this town.`;
    case 'coworker':
      return `I worked beside ${dead} every day. The work won't be the same without them.`;
    default:
      return `${dead} was one of us. The town is smaller today.`;
  }
}

const TIE_ORDER: readonly TieKind[] = ['spouse', 'partner', 'fiance', 'family', 'best_friend', 'housemate', 'friend', 'coworker', 'acquaintance'];

function closestTieKind(ties: readonly TieKind[]): TieKind | 'other' {
  return TIE_ORDER.find((t) => ties.includes(t)) ?? 'other';
}

// ─── funeral ────────────────────────────────────────────────────────────────

export const FUNERAL: GatheringKind = {
  id: 'funeral',
  leadMin: 45,
  stormDelayMin: 3 * HOUR,
  stayMin: { may: 90 },
  mayChancePerMin: 0.006,
  encounterPerMin: 0.06,
  momentsAt: [60],
  invite(g, nowMin) {
    const deadId = g.subjectId!;
    const mourners = new Set(mournersOf(deadId));
    const heir = heirsOf(deadId)[0]?.agentId;
    const cands = inviteByTies(g, deadId, { must: KIN, should: [...FRIENDS, 'coworker', 'clique'], mayRest: true }, { anyTarget: true });
    for (const id of mourners) invite(g, id, 'must', g.startMin - 45);
    if (heir != null && isActive(heir)) invite(g, heir, 'must', g.startMin - 45);
    const mayor = db.select({ id: economy.agent_id }).from(economy).where(eq(economy.job, 'mayor')).all().map((r) => r.id).find(isActive);
    if (mayor != null && mayor !== deadId) invite(g, mayor, 'should', g.startMin - 30);
    // Close ties, remembered for the judgement at the end (a coworker who stays at
    // the counter is not "she didn't even come").
    g.payload.closeTies = [...new Set([...mourners, ...cands.filter((c) => !c.hostile && holds(c, CLOSE_TIES)).map((c) => c.id)])];
    // Rivals roll on character: the warm or dutiful come anyway; the rest stay away, pointedly.
    const came: number[] = [];
    const away: number[] = [];
    for (const c of cands) {
      if (!c.hostile || c.age < 16 || c.unavailable) continue;
      const p = 0.15 + c.warmth / 300 + c.loyalty / 400;
      if (rngFor(`rival|${g.id}|${c.id}|${nowMin}`)() < p) {
        invite(g, c.id, 'should', g.startMin - 30);
        came.push(c.id);
      } else {
        away.push(c.id);
      }
    }
    g.payload.rivalsInvited = came;
    g.payload.rivalsAway = away;
  },
  onOpen(g) {
    const dead = String(g.payload.deadName ?? 'someone');
    const result = startWorldEvent('funeral', {
      triggeredBy: `death:${g.subjectId}`,
      name: `Funeral of ${dead}`,
      description: `The town gathers ${atPlace(g.venueLocationId)} to bury ${dead}.`,
      locationId: g.venueLocationId,
      enforceLimits: false,
      // The summary row at the end is the feed entry; the death itself was the news.
      announce: false,
    });
    if (result.ok) g.eventId = result.event.id;
  },
  label(g) {
    const dead = firstName(String(g.payload.deadName ?? 'someone'));
    return { walking: `On the way to ${dead}'s funeral`, there: `At ${dead}'s funeral` };
  },
  topic: (g) => GATHERING_TOPIC.funeral(firstName(String(g.payload.deadName ?? 'them'))),
  moment(g, present) {
    if (present.length === 0) return;
    const deadId = g.subjectId!;
    const dead = firstName(String(g.payload.deadName ?? 'them'));
    // The closest tie present speaks: the one who loved them most.
    const speaker = [...present].sort((a, b) => regard(b, deadId) - regard(a, deadId) || a - b)[0];
    const cand = inviteTiesOf(deadId, speaker);
    g.payload.eulogistId = speaker;
    g.payload.eulogy = eulogyLine(dead, cand);
  },
  onClose(g, att, nowMin) {
    closeFuneral(g, att, nowMin);
  },
};

/** What `speakerId` was to the dead, read the same way the invitations read it. */
function inviteTiesOf(deadId: number, speakerId: number): TieKind | 'other' {
  const c = gatherCandidates(deadId, { anyTarget: true }).find((x) => x.id === speakerId);
  return closestTieKind(c?.ties ?? []);
}

function closeFuneral(g: Gathering, att: Attendance, nowMin: number): void {
  const deadId = g.subjectId!;
  const deadName = String(g.payload.deadName ?? nameOf(deadId));
  const dead = firstName(deadName);
  const him = pronoun(deadId);
  const mourners = mournersOf(deadId);
  const came = [...att.attended].filter(isActive);
  const living = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all().length;
  const full = came.length >= Math.max(4, Math.ceil(living * FULL_TURNOUT_SHARE));
  const empty = came.length <= EMPTY_TURNOUT;

  // The turnout, on the mourners' grief.
  for (const m of mourners) {
    if (full) {
      mood(m, 6, 'funeral_turnout', 2 * DAY, nowMin);
      adjustGrief(m, deadId, -0.15);
    } else if (empty) {
      mood(m, -6, 'funeral_empty', 2 * DAY, nowMin);
      adjustGrief(m, deadId, 0.1);
    }
  }

  // Close ties who stayed away without cause.
  const closeTies = new Set((g.payload.closeTies as number[] | undefined) ?? []);
  const skippers = att.absent.filter((id) => closeTies.has(id) && !excused(id));
  const presentMourners = mourners.filter((m) => att.attended.has(m));
  for (const s of skippers) {
    for (const m of presentMourners.filter((x) => x !== s).slice(0, RESENTERS_PER_SKIPPER)) {
      feel(m, s, 'missed_funeral', `${nameOf(s)} stayed away from ${deadName}'s funeral`, {
        fromCaller: { friendship: -3, trust: -2 }, fromTarget: {}, sentiment: -0.3,
      });
      remember(m, `${firstName(nameOf(s))} didn't even come to ${dead}'s funeral.`, -0.5, 6, s);
    }
  }

  // Memories for those who were there.
  const eulogistId = typeof g.payload.eulogistId === 'number' ? g.payload.eulogistId : null;
  for (const id of came) {
    const isMourner = mourners.includes(id);
    const spoke = id === eulogistId;
    remember(id,
      spoke ? `I spoke for ${dead} at the funeral today. I hope I said it right.`
        : `We buried ${dead} today${full ? ', and it seemed the whole town was there' : empty ? ', and hardly anyone came' : ''}.`,
      isMourner ? -0.6 : -0.3, isMourner ? 8 : 5, deadId);
  }
  const rivalsCame = ((g.payload.rivalsInvited as number[] | undefined) ?? []).filter((id) => att.attended.has(id));
  for (const r of rivalsCame) remember(r, `I went to ${dead}'s funeral. We never got on, but it seemed right to be there.`, -0.1, 6, deadId);

  // The ONE row.
  const parts: string[] = [];
  const venue = atPlace(g.venueLocationId);
  parts.push(came.length === 0
    ? `Nobody came to ${deadName}'s funeral ${venue}.`
    : came.length === 1
      ? `${deadName} was buried ${venue}, and only ${nameOf(came[0])} came.`
      : `${deadName} was buried ${venue}: ${came.length} came to say goodbye${full ? ', nearly the whole town' : ''}.`);
  if (eulogistId != null && typeof g.payload.eulogy === 'string') {
    parts.push(`${nameOf(eulogistId)} spoke for ${him.obj}: "${g.payload.eulogy}"`);
  }
  if (rivalsCame.length > 0) parts.push(`Even ${nameOf(rivalsCame[0])}, who never got on with ${him.obj}, came.`);
  const away = ((g.payload.rivalsAway as number[] | undefined) ?? []).filter(isActive);
  if (away.length > 0) parts.push(`${nameOf(away[0])}, ${him.pos} old rival, pointedly stayed away.`);
  if (skippers.length > 0) parts.push(`Not there: ${nameList(skippers.map(nameOf), 3)} — and the mourners noticed.`);
  gatheringFeed(g, 'funeral', parts.join(' '), 0.4, [...came, ...skippers]);

  scheduleWake(g, came, nowMin);
}

function adjustGrief(agentId: number, deadId: number, delta: number): void {
  const row = db.select().from(agentStates)
    .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, 'grieving'), eq(agentStates.source, `event:death_of_${deadId}`))).get();
  if (!row) return;
  db.update(agentStates).set({ severity: Math.max(0.1, Math.min(1, row.severity + delta)) }).where(eq(agentStates.id, row.id)).run();
}

/** The evening after the funeral, at the tavern (none in town: no wake). */
function scheduleWake(funeral: Gathering, cameToFuneral: number[], nowMin: number): void {
  const tavern = tavernVenue();
  if (!tavern) return;
  let start = dayStartOf(funeral.startMin) + WAKE_HOUR * HOUR;
  if (start < nowMin) start = nowMin + HOUR;
  scheduleGathering({
    kind: 'wake',
    venueLocationId: tavern.id,
    startMin: start,
    endMin: start + WAKE_LENGTH_MIN,
    subjectId: funeral.subjectId,
    payload: { deadName: String(funeral.payload.deadName ?? ''), funeralGoers: cameToFuneral },
  });
}

// ─── wake ───────────────────────────────────────────────────────────────────

export const WAKE: GatheringKind = {
  id: 'wake',
  leadMin: 30,
  stayMin: { may: 90 },
  mayChancePerMin: 0.008,
  encounterPerMin: 0.08,
  momentsAt: [60],
  invite(g) {
    const deadId = g.subjectId!;
    for (const id of mournersOf(deadId)) invite(g, id, 'should', g.startMin - 20);
    for (const id of (g.payload.funeralGoers as number[] | undefined) ?? []) {
      if (isActive(id) && !statesOf(id).includes('arrested')) invite(g, id, 'may', g.startMin - 10);
    }
    for (const c of gatherCandidates(deadId, { anyTarget: true })) {
      if (!c.hostile && c.age >= 16 && holds(c, FRIENDS)) invite(g, c.id, 'may', g.startMin - 10);
    }
  },
  label(g) {
    const dead = firstName(String(g.payload.deadName ?? 'someone'));
    return { walking: `On the way to drink to ${dead}`, there: `Drinking to ${dead}'s memory` };
  },
  topic: (g) => GATHERING_TOPIC.wake(firstName(String(g.payload.deadName ?? 'them'))),
  moment(g, present, nowMin) {
    if (present.length < 2) return;
    const dead = firstName(String(g.payload.deadName ?? 'them'));
    // Shared grief bonds people: a small warmth between everyone at the table, capped.
    let pairs = 0;
    for (let i = 0; i < present.length && pairs < WAKE_PAIRS_MAX; i++) {
      for (let j = i + 1; j < present.length && pairs < WAKE_PAIRS_MAX; j++) {
        feel(present[i], present[j], 'wake', `drank to ${dead} together`, {
          fromCaller: { friendship: 2 }, fromTarget: { friendship: 2 }, sentiment: 0.4,
        });
        pairs++;
      }
    }
    for (const id of present) mood(id, 3, 'wake', 12 * HOUR, nowMin);
    const drunk = present.find((id) => statesOf(id).includes('drunk'));
    if (drunk != null) g.payload.drunkId = drunk;
    g.payload.toasted = present;
  },
  onClose(g, att) {
    const dead = String(g.payload.deadName ?? 'someone');
    const came = [...att.attended].filter(isActive);
    for (const id of came) {
      remember(id, `We drank to ${firstName(dead)} at the tavern tonight and told the old stories.`, 0.2, 6, g.subjectId!);
    }
    if (came.length < 2) return;
    const drunk = typeof g.payload.drunkId === 'number' ? g.payload.drunkId : null;
    const scene = drunk != null ? ` ${nameOf(drunk)}, deep in ${pronoun(drunk).pos} cups, wept for ${firstName(dead)}.` : '';
    gatheringFeed(g, 'wake', `${came.length} gathered ${atPlace(g.venueLocationId)} that evening to drink to ${dead}: ${nameList(came.map(nameOf))}.${scene}`, 0.35, came);
  },
};

// ─── wiring ─────────────────────────────────────────────────────────────────

/**
 * A death (life:death): set the funeral for the next morning on the square.
 * With no square at all, the old behaviour: the event at once, nowhere.
 */
export function onDeath(deadId: number, name: string, nowMin: number): void {
  const venue = squareVenue();
  if (!venue) {
    startWorldEvent('funeral', {
      triggeredBy: `death:${deadId}`, name: `Funeral of ${name}`, description: `The town mourns ${name}.`,
      enforceLimits: false, announce: false,
    });
    return;
  }
  const start = funeralStart(nowMin);
  scheduleGathering({
    kind: 'funeral',
    venueLocationId: venue.id,
    startMin: start,
    endMin: start + FUNERAL_LENGTH_MIN,
    subjectId: deadId,
    payload: { deadName: name },
  });
}
