/**
 * A round for the house. The tavern was thirteen people drinking alone: each
 * paid for their own drink (tavernEngine.ts) and nothing passed between them. Now
 * and then someone in good spirits with money to spare — or celebrating: a
 * birthday, an engagement, an election won — stands a round for everyone there:
 *
 *   - real money: $2 a drink to whoever runs the tavern (economyTransfers.payTavernRound,
 *     the same move a drinker's own drink makes);
 *   - everyone's spirits lifted (social and fun, and a mood lift), a favour owed by
 *     each drinker to the buyer (favorEngine), a little warmth between them;
 *   - the one who is always broke and always drinking on others' coin gets
 *     noticed after a few rounds: a `reputation` fact, the small-misdeeds convention
 *     (gossip.learnFact: create, or add the witnesses to the one already going round).
 *
 * A gathering of its own (kind `tavern_round`), over the moment it is bought: the
 * soak's table and "who was there" read it like any other. Cooldowns keep it to a
 * couple of times a week in a small town: per tavern and per buyer.
 *
 * Called from tavernTick (every 10 game minutes, outside a transaction: this
 * opens its own). Seeded dice: tavernTick's own Math.random() draws are untouched.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, economy, locations, needs } from '../../../db/schema';
import { firstName } from '../../../ai/names';
import { payTavernRound } from '../../economyTransfers';
import { recordFavorGiven } from '../../favorEngine';
import { learnFact } from '../../gossip';
import { feel, mood, remember } from '../../socialCalls/effects';
import { closeGathering, invite, markPresent, scheduleGathering } from '../engine';
import { DAY, HOUR, gatheringFeed, nameList, rngFor, statesOf } from '../common';
import type { GatheringKind } from '../types';

export const ROUND = {
  /** A round per tavern at most this often (game minutes). */
  TAVERN_COOLDOWN_MIN: 36 * HOUR,
  /** The same buyer stands one at most this often. */
  BUYER_COOLDOWN_MIN: 4 * DAY,
  /** Chance per 10-minute pass, once everything else allows one. */
  CHANCE_PER_PASS: 0.12,
  /** Drinkers needed besides the buyer. */
  MIN_DRINKERS: 2,
  PRICE: 2,
  /** In good spirits with money to spare… */
  MOOD: 65,
  MONEY: 40,
  /** …or celebrating, with less. */
  CELEBRATING_MONEY: 20,
  /** Broke: drinking on others' coin with less than this in the purse. */
  BROKE: 5,
  /** Rounds drunk while broke before the town notices. */
  FREELOAD_NOTICED: 3,
} as const;

const lastRoundAt = new Map<number, number>();
const buyerLastAt = new Map<number, number>();
const freeloads = new Map<number, number>();
/** agentId → celebrating until (game minutes): a birthday, an engagement, an election won. */
const celebrating = new Map<number, { until: number; why: string }>();

export function clearTavernRoundState(): void {
  lastRoundAt.clear();
  buyerLastAt.clear();
  freeloads.clear();
  celebrating.clear();
}

/** Something to celebrate today (the listeners in ../index.ts). */
export function noteCelebrating(agentId: number, why: string, nowMin: number): void {
  celebrating.set(agentId, { until: nowMin + DAY, why });
}

export interface RoundCandidate {
  id: number;
  mood: number;
  money: number;
  celebrating: boolean;
}

/** Who would stand a round, richest first: good spirits and a full purse, or a reason to celebrate. */
export function roundBuyers(cands: readonly RoundCandidate[]): RoundCandidate[] {
  return cands
    .filter((c) => (c.mood >= ROUND.MOOD && c.money >= ROUND.MONEY) || (c.celebrating && c.money >= ROUND.CELEBRATING_MONEY))
    .sort((a, b) => Number(b.celebrating) - Number(a.celebrating) || b.money - a.money || a.id - b.id);
}

export const TAVERN_ROUND: GatheringKind = {
  id: 'tavern_round',
  leadMin: 0,
  invite: () => {},
  label: () => ({ walking: 'On the way to the tavern', there: 'Drinking a round on someone else' }),
  topic: () => 'a round of drinks',
  onClose(g, att) {
    const buyer = g.hostIds[0];
    const drinkers = [...att.attended].filter((id) => id !== buyer);
    const why = typeof g.payload.why === 'string' && g.payload.why ? ` ${g.payload.why}` : '';
    const venue = db.select({ name: locations.name }).from(locations).where(eq(locations.id, g.venueLocationId)).get()?.name ?? 'the tavern';
    let text = `${nameOf(buyer)} stood a round for the house at ${venue}${why}: ${nameList(drinkers.map(nameOf))} drank to ${firstName(nameOf(buyer))}'s health.`;
    if (typeof g.payload.freeloaderId === 'number') {
      text += ` ${nameOf(g.payload.freeloaderId)}, broke as ever, drank theirs too — and people are starting to notice.`;
    }
    gatheringFeed(g, 'round', text, 0, drinkers);
  },
};

function nameOf(id: number): string {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? 'someone';
}

/**
 * At each tavern: maybe someone stands a round. Returns the buyer's id, or null.
 * `present` maps a tavern to the drinkers there (tavernTick's own filter).
 */
export function maybeStandRound(nowMin: number, present: ReadonlyMap<number, number[]>): number | null {
  let bought: number | null = null;
  db.transaction(() => {
    for (const [tavernId, ids] of present) {
      if (ids.length < ROUND.MIN_DRINKERS + 1) continue;
      const last = lastRoundAt.get(tavernId);
      if (last != null && nowMin - last < ROUND.TAVERN_COOLDOWN_MIN) continue;
      const cands: RoundCandidate[] = ids.map((id) => {
        const c = celebrating.get(id);
        const lastBuy = buyerLastAt.get(id);
        return {
          id,
          mood: db.select({ m: needs.mood }).from(needs).where(eq(needs.agent_id, id)).get()?.m ?? 50,
          money: db.select({ m: economy.money }).from(economy).where(eq(economy.agent_id, id)).get()?.m ?? 0,
          celebrating: c != null && c.until > nowMin,
          _cool: lastBuy != null && nowMin - lastBuy < ROUND.BUYER_COOLDOWN_MIN,
        };
      }).filter((c) => !c._cool && !statesOf(c.id).includes('drunk'))
        .map(({ id, mood: m, money, celebrating: cel }) => ({ id, mood: m, money, celebrating: cel }));
      const buyers = roundBuyers(cands);
      if (buyers.length === 0) continue;
      if (rngFor(`round|${tavernId}|${nowMin}`)() >= ROUND.CHANCE_PER_PASS) continue;
      standRound(buyers[0].id, tavernId, ids, nowMin);
      bought = buyers[0].id;
    }
  });
  return bought;
}

/** The round itself (exported for the tests). */
export function standRound(buyer: number, tavernId: number, presentIds: readonly number[], nowMin: number): void {
  const owner = db.select({ owner: locations.owner }).from(locations).where(eq(locations.id, tavernId)).get()?.owner ?? null;
  const drinkers = presentIds.filter((id) => id !== buyer);
  const g = scheduleGathering({ kind: 'tavern_round', venueLocationId: tavernId, startMin: nowMin, endMin: nowMin, hostIds: [buyer], payload: {} });
  if (!g) return;
  lastRoundAt.set(tavernId, nowMin);
  buyerLastAt.set(buyer, nowMin);
  const c = celebrating.get(buyer);
  g.payload.why = c && c.until > nowMin ? c.why : '';
  invite(g, buyer, 'must', nowMin);
  for (const id of drinkers) invite(g, id, 'may', nowMin);
  g.status = 'open';
  markPresent(g, [buyer, ...drinkers], nowMin);

  const broke: number[] = [];
  for (const id of drinkers) {
    payTavernRound(buyer, owner, ROUND.PRICE);
    const n = db.select().from(needs).where(eq(needs.agent_id, id)).get();
    if (n) db.update(needs).set({ social: Math.min(100, n.social + 4), fun: Math.min(100, n.fun + 4) }).where(eq(needs.agent_id, id)).run();
    mood(id, 3, 'stood_a_round', 6 * HOUR, nowMin);
    recordFavorGiven(buyer, id, 1);
    feel(buyer, id, 'round', `${nameOf(buyer)} stood ${nameOf(id)} a drink`, {
      fromCaller: { friendship: 1 }, fromTarget: { friendship: 2 }, sentiment: 0.5,
    });
    const money = db.select({ m: economy.money }).from(economy).where(eq(economy.agent_id, id)).get()?.m ?? 0;
    if (money < ROUND.BROKE) broke.push(id);
  }
  mood(buyer, 4, 'stood_a_round', 6 * HOUR, nowMin);
  remember(buyer, `I stood a round for everyone at the tavern tonight. Worth every coin.`, 0.5, 4, drinkers[0] ?? buyer);

  for (const id of broke) {
    const n = (freeloads.get(id) ?? 0) + 1;
    freeloads.set(id, n);
    if (n < ROUND.FREELOAD_NOTICED) continue;
    freeloads.delete(id);
    // "X has a bad reputation — drinks on everyone else's coin…": what the bar says of them.
    learnFact('reputation', id, null, 2, [buyer, ...drinkers.filter((x) => x !== id)], 'witnessed', {
      detail: "drinks on everyone else's coin and never stands a round",
    });
    g.payload.freeloaderId = id;
  }
  closeGathering(g.id, nowMin);
}
