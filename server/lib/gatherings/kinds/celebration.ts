/**
 * Guests who matter at the town's celebrations: a wedding (lib/milestonesEngine.ts)
 * and a christening (lib/family.ts) already pull the idle crowd (phases.ts
 * `eventCrowdPhase`) and the couple / parents themselves (`ownWeddingPhase`).
 * What was missing is that the people closest to them came only if idle: a best
 * friend with an LLM plan for the afternoon missed the wedding. The gathering
 * wraps the event (never a second one) and makes:
 *
 *   must   — the couple / the parents (their own phase already brings them; this
 *            only records them as the hosts);
 *   should — their family, household and friends: they come even with a plan.
 *
 * The crowd stays the crowd pull's. The moment is the toast: close friends there
 * give a gift (giftEngine.giveCallGift), everyone present lifts a glass. At a
 * wedding, a guest who carries a torch for the bride or groom reacts through the
 * existing states — heartbroken, announced on `state:triggered` like the
 * intimacy layer's witnesses (lib/intimacy/reactions.ts) — adults only, and no new
 * romance path: it is only what seeing the wedding does to them.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, agentStates } from '../../../db/schema';
import { firstName } from '../../../ai/names';
import { parseWeddingTrigger } from '../../marriage';
import { parentsOfChild, parseChristeningTrigger } from '../../familyState';
import { giveCallGift } from '../../giftEngine';
import { TORCH_ROMANCE } from '../../intimacy/reactions';
import { simEvents } from '../../simEvents';
import { gatherCandidates } from '../../socialCalls/ties';
import { feel, mood, remember } from '../../socialCalls/effects';
import { invite, scheduleGathering } from '../engine';
import { DAY, HOUR, atPlace, excused, gatheringFeed, isActive, nameList, relRow, squareVenue } from '../common';
import { GATHERING_TOPIC } from '../topics';
import type { Gathering, GatheringKind } from '../types';
import { FRIENDS, KIN, holds } from './invites';

/** How long a wedding guest's broken heart lasts (game minutes). */
const WEDDING_HEARTBREAK_MIN = DAY;
/** Gifts at the toast, at most. */
const MAX_GIFTS = 4;
const ADULT = 18;

function nameOf(id: number): string {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? 'someone';
}

function ageOf(id: number): number {
  return db.select({ age: agents.age }).from(agents).where(eq(agents.id, id)).get()?.age ?? 0;
}

function title(g: Gathering): string {
  return String(g.payload.title ?? (g.kind === 'wedding' ? 'the wedding' : 'the christening'));
}

function inviteClose(g: Gathering): void {
  const close = new Set<number>();
  for (const h of g.hostIds) invite(g, h, 'must', g.startMin);
  for (const h of g.hostIds) {
    for (const c of gatherCandidates(h)) {
      if (c.hostile || c.age < 12 || g.hostIds.includes(c.id)) continue;
      if (holds(c, [...KIN, ...FRIENDS])) {
        invite(g, c.id, 'should', g.startMin);
        close.add(c.id);
      }
    }
  }
  g.payload.closeTies = [...close];
}

/**
 * Whether `guest` carries a torch for one of the couple (romance above the
 * intimacy layer's TORCH_ROMANCE) and is not with them: the one they pine for, or null.
 * Adults only, every party.
 */
export function torchFor(guest: number, hosts: readonly number[]): number | null {
  if (ageOf(guest) < ADULT || hosts.some((h) => ageOf(h) < ADULT)) return null;
  let best: { id: number; romance: number } | null = null;
  for (const h of hosts) {
    const rel = relRow(guest, h);
    if (!rel || rel.status === 'partners' || rel.tags.includes('married') || rel.tags.includes('engaged')) continue;
    const romance = rel.agent_a === guest ? rel.romance_ab : rel.romance_ba;
    if (romance > TORCH_ROMANCE && (!best || romance > best.romance)) best = { id: h, romance };
  }
  return best?.id ?? null;
}

/** Heartbroken about `loved`, unless already (states are not stacked); the cascade hears it as every heartbreak. */
function breakHeart(guest: number, loved: number, nowMin: number): void {
  const held = db.select({ id: agentStates.id }).from(agentStates)
    .where(and(eq(agentStates.agent_id, guest), eq(agentStates.type, 'heartbroken'))).get();
  if (held) return;
  db.insert(agentStates).values({
    agent_id: guest, type: 'heartbroken', severity: 0.5, started_at: nowMin, duration: WEDDING_HEARTBREAK_MIN,
    target_agent_id: loved, source: 'wedding:witnessed', metadata: null,
  }).run();
  simEvents.emit('state:triggered', { agentId: guest, state: 'heartbroken', cause: 'wedding:witnessed' });
}

function toast(g: Gathering, present: number[], nowMin: number): void {
  const close = new Set((g.payload.closeTies as number[] | undefined) ?? []);
  const gifts: number[] = [];
  for (const id of present) {
    if (g.hostIds.includes(id)) continue;
    mood(id, 4, `${g.kind}_toast`, 12 * HOUR, nowMin);
    if (close.has(id) && gifts.length < MAX_GIFTS) {
      const to = g.hostIds[gifts.length % g.hostIds.length];
      if (to != null && giveCallGift(id, to, { reason: g.kind })) gifts.push(id);
    }
  }
  for (const h of g.hostIds) mood(h, 5, `${g.kind}_toast`, DAY, nowMin);
  g.payload.gifts = gifts;
  if (g.kind !== 'wedding') return;
  const torches: number[] = [];
  for (const id of present) {
    if (g.hostIds.includes(id)) continue;
    const loved = torchFor(id, g.hostIds);
    if (loved == null) continue;
    breakHeart(id, loved, nowMin);
    const other = g.hostIds.find((h) => h !== loved);
    remember(id, `I watched ${firstName(nameOf(loved))} marry ${other != null ? firstName(nameOf(other)) : 'someone else'} today and raised my glass with the rest. It should have been me.`, -0.7, 8, loved);
    torches.push(id);
  }
  g.payload.torches = torches;
}

function closeCelebration(g: Gathering, came: number[], absent: number[]): void {
  const close = new Set((g.payload.closeTies as number[] | undefined) ?? []);
  const missing = absent.filter((id) => close.has(id) && !excused(id));
  const guests = came.filter((id) => !g.hostIds.includes(id) && isActive(id));
  const hostNames = g.hostIds.map((h) => firstName(nameOf(h)));
  for (const id of guests) {
    remember(id, g.kind === 'wedding'
      ? `I was at the wedding of ${nameList(hostNames)} today and drank their health.`
      : `I was at the christening of ${String(g.payload.childName ?? 'the baby')} today.`, 0.5, 5, g.hostIds[0]);
  }
  for (const m of missing) {
    for (const h of g.hostIds) {
      feel(h, m, `${g.kind}_absent`, `${nameOf(m)} stayed away from ${title(g)}`, { fromCaller: { friendship: -2 }, fromTarget: {}, sentiment: -0.2 });
      remember(h, `${firstName(nameOf(m))} didn't come to ${g.kind === 'wedding' ? 'our wedding' : 'the christening'}.`, -0.4, 6, m);
    }
  }
  const gifts = ((g.payload.gifts as number[] | undefined) ?? []).filter((id) => guests.includes(id));
  const torches = ((g.payload.torches as number[] | undefined) ?? []).filter(isActive);
  const parts = [`${title(g)} ${atPlace(g.venueLocationId)}: ${guests.length} came to raise a glass${guests.length > 0 ? ` — ${nameList(guests.map(nameOf))}` : ''}.`];
  if (gifts.length > 0) parts.push(`${nameList(gifts.map(nameOf), 2)} brought gifts.`);
  if (torches.length > 0) parts.push(`${nameOf(torches[0])} smiled through the toast, and left early.`);
  if (missing.length > 0) parts.push(`${nameList(missing.map(nameOf), 2)} did not come.`);
  gatheringFeed(g, 'toast', parts.join(' '), 0.2, guests);
}

const celebration = (id: 'wedding' | 'christening'): GatheringKind => ({
  id,
  leadMin: 30,
  stayMin: { should: 3 * HOUR },
  encounterPerMin: 0.06,
  momentsAt: [60],
  stillRelevant: (g) => g.hostIds.some(isActive),
  invite: (g) => inviteClose(g),
  label(g) {
    const hosts = g.hostIds.map((h) => firstName(nameOf(h)));
    return id === 'wedding'
      ? { walking: `On the way to ${nameList(hosts)}'s wedding`, there: `At ${nameList(hosts)}'s wedding` }
      : { walking: `On the way to the christening of little ${String(g.payload.childName ?? 'the baby')}`, there: `At little ${String(g.payload.childName ?? 'the baby')}'s christening` };
  },
  topic: (g) => (id === 'wedding'
    ? GATHERING_TOPIC.wedding(nameList(g.hostIds.map((h) => firstName(nameOf(h)))))
    : GATHERING_TOPIC.christening(String(g.payload.childName ?? 'the baby'))),
  moment: (g, present, nowMin) => toast(g, present, nowMin),
  onClose: (g, att) => closeCelebration(g, [...att.attended], att.absent),
});

export const WEDDING = celebration('wedding');
export const CHRISTENING = celebration('christening');

/** A wedding or christening started (world:event_started): wrap it. */
export function onCelebrationStarted(
  type: 'wedding' | 'christening', eventId: number, triggeredBy: string, locationId: number | null,
  startedAtMin: number, durationHours: number, name: string,
): void {
  let hosts: number[] = [];
  let childName: string | null = null;
  if (type === 'wedding') hosts = [...(parseWeddingTrigger(triggeredBy) ?? [])];
  else {
    const childId = parseChristeningTrigger(triggeredBy);
    if (childId != null) hosts = parentsOfChild(childId);
    childName = /little (.+)$/.exec(name)?.[1] ?? null;
  }
  hosts = hosts.filter(isActive);
  const venue = locationId ?? squareVenue()?.id ?? null;
  if (hosts.length === 0 || venue == null) return;
  scheduleGathering({
    kind: type,
    venueLocationId: venue,
    startMin: startedAtMin,
    endMin: startedAtMin + durationHours * HOUR,
    hostIds: hosts,
    eventId,
    payload: { title: name, ...(childName ? { childName } : {}) },
  });
}
