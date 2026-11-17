/**
 * The send-off: a resident who has made up their mind to leave town
 * (lib/populationFlow.ts) sets off at LEAVE_HOUR; the hour before, their
 * friends gather on the square to see them off, press something for the road
 * on them, and remember it. People used to walk out of town with nobody
 * noticing but the feed.
 *
 *   must   — the leaver (the host: they come to the square before setting off);
 *   should — family, the household, friends, and whoever went to ask them to stay
 *            (step 2's `plead_to_stay`: those who pleaded and lost come to say goodbye);
 *   may    — acquaintances, coworkers, neighbours.
 *
 * Nothing here changes who leaves or why: the departure is populationFlow's, and
 * it still sets them walking at the hour it chose.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents } from '../../../db/schema';
import { firstName, pronounsFor } from '../../../ai/names';
import { giveCallGift } from '../../giftEngine';
import { callsMadeTo } from '../../socialCalls/engine';
import { feel, remember } from '../../socialCalls/effects';
import { gatherCandidates } from '../../socialCalls/ties';
import { invite, scheduleGathering } from '../engine';
import { DAY, atPlace, excused, gatheringFeed, isActive, nameList, squareVenue } from '../common';
import { GATHERING_TOPIC } from '../topics';
import type { GatheringKind } from '../types';
import { FRIENDS, KIN, holds } from './invites';

/** The send-off opens this long before the leaver sets off, and ends just after. */
export const SEND_OFF_BEFORE_MIN = 60;
export const SEND_OFF_AFTER_MIN = 10;

function nameOf(id: number): string {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? 'someone';
}

function objOf(id: number): string {
  return pronounsFor(db.select({ g: agents.gender }).from(agents).where(eq(agents.id, id)).get()?.g).obj;
}

export const SEND_OFF: GatheringKind = {
  id: 'send_off',
  leadMin: 20,
  stayMin: { may: 45 },
  mayChancePerMin: 0.01,
  encounterPerMin: 0.08,
  momentsAt: [SEND_OFF_BEFORE_MIN - 20],
  stillRelevant: (g) => isActive(g.hostIds[0]),
  invite(g, nowMin) {
    const leaver = g.hostIds[0];
    invite(g, leaver, 'must', g.startMin - 20);
    const pleaders = new Set(callsMadeTo(leaver, 'plead_to_stay', nowMin - 4 * DAY).map((r) => r.callerId));
    const close: number[] = [];
    for (const c of gatherCandidates(leaver)) {
      if (c.hostile || c.age < 12) continue;
      if (holds(c, [...KIN, ...FRIENDS]) || pleaders.has(c.id)) {
        invite(g, c.id, 'should', g.startMin - 15);
        if (holds(c, [...KIN, 'best_friend']) || pleaders.has(c.id)) close.push(c.id);
      } else if (holds(c, ['acquaintance', 'coworker', 'neighbour', 'clique'])) {
        invite(g, c.id, 'may', g.startMin);
      }
    }
    g.payload.closeTies = close;
    g.payload.pleaders = [...pleaders];
  },
  label(g) {
    const leaver = firstName(nameOf(g.hostIds[0]));
    return { walking: `On the way to see ${leaver} off`, there: `Seeing ${leaver} off` };
  },
  topic: (g) => GATHERING_TOPIC.send_off(firstName(nameOf(g.hostIds[0]))),
  moment(g, present) {
    const leaver = g.hostIds[0];
    if (!present.includes(leaver)) return;
    const gifts: number[] = [];
    for (const id of present) {
      if (id === leaver) continue;
      feel(id, leaver, 'send_off', `came to see ${nameOf(leaver)} off`, {
        fromCaller: { friendship: 2 }, fromTarget: { friendship: 4, trust: 2 }, sentiment: 0.5,
      });
      // Something for the road: food, never money — it leaves town with them.
      if (gifts.length < 3 && giveCallGift(id, leaver, { foodOnly: true, reason: 'send_off' })) gifts.push(id);
    }
    g.payload.gifts = gifts;
  },
  onClose(g, att) {
    const leaverId = g.hostIds[0];
    const leaver = nameOf(leaverId);
    const lf = firstName(leaver);
    const came = [...att.attended].filter((id) => id !== leaverId && isActive(id));
    const pleaders = new Set((g.payload.pleaders as number[] | undefined) ?? []);
    for (const id of came) {
      remember(id, pleaders.has(id)
        ? `I asked ${lf} to stay, and this morning I went to see them off anyway. I'll miss them.`
        : `I saw ${lf} off on the square this morning. The town won't be the same.`, -0.3, 6, leaverId);
    }
    const close = new Set((g.payload.closeTies as number[] | undefined) ?? []);
    const missing = att.absent.filter((id) => close.has(id) && !excused(id));
    for (const id of missing) remember(id, `I never went to see ${lf} off. Now they're gone.`, -0.4, 5, leaverId);
    const gifts = ((g.payload.gifts as number[] | undefined) ?? []).filter((id) => came.includes(id));

    let text: string;
    if (came.length === 0) {
      text = `${leaver} left town at dawn, and nobody came to see ${objOf(leaverId)} off.`;
    } else {
      text = `${came.length} gathered ${atPlace(g.venueLocationId)} to see ${leaver} off: ${nameList(came.map(nameOf))}.`;
      if (gifts.length > 0) text += ` ${nameList(gifts.map(nameOf), 2)} pressed something for the road on ${objOf(leaverId)}.`;
    }
    if (missing.length > 0) text += ` ${nameList(missing.map(nameOf), 2)}, of all people, did not come.`;
    gatheringFeed(g, 'send_off', text, 0.4, came);
  },
};

/** A resident has decided to leave (life:leaving_decided): the square, the hour before they set off. */
export function onLeavingDecided(agentId: number, leaveAtMin: number, nowMin: number): void {
  const venue = squareVenue();
  if (!venue) return;
  const start = Math.max(nowMin, leaveAtMin - SEND_OFF_BEFORE_MIN);
  scheduleGathering({
    kind: 'send_off',
    venueLocationId: venue.id,
    startMin: start,
    endMin: leaveAtMin + SEND_OFF_AFTER_MIN,
    hostIds: [agentId],
  });
}
