/**
 * Market day: the weekly market (data/calendar.ts) had a venue and cheap prices
 * but pulled nobody, so the stalls stood in an empty square. Now residents with
 * shopping to do, things to sell or a free morning drift there over the morning
 * and stay an hour, chats among the stalls get market small talk, and a few
 * concrete things happen per market (three at most, drawn hourly among whoever is there):
 *
 *   - a haggle, won or lost: a real item for real money, buyer to seller
 *     (economyTransfers.payResident — money only ever moves between residents);
 *   - an old acquaintance bumped into: a little warmth both ways;
 *   - a pickpocket, only when someone desperate and unscrupulous is in the crowd
 *     and someone worth robbing is too: the EXISTING crime path does it
 *     (the gathering hands them a `pickpocket` errand; crime.ts executeCrime
 *     resolves the take and whether they're caught).
 *
 * Nobody is a `must`: shopping never leaves a work shift. A resident with an
 * empty larder or a full one to sell is a `should` (comes in their free time,
 * ahead of the day plan); everyone else a `may`.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, economy } from '../../../db/schema';
import { ITEM_REGISTRY, itemPhrase } from '../../../data/economyData';
import { firstName } from '../../../ai/names';
import { addToInventory, getInventoryCount, removeFromInventory, type InventoryItem } from '../../economyEngine';
import { payResident } from '../../economyTransfers';
import { getEffectivePersonality } from '../../states';
import type { PersonalityProfile } from '../../personality';
import { feel, remember } from '../../socialCalls/effects';
import { invite, scheduleGathering } from '../engine';
import { HOUR, atPlace, firstOfType, gatheringFeed, regard, rngFor, statesOf } from '../common';
import { GATHERING_TOPIC } from '../topics';
import type { Gathering, GatheringKind } from '../types';

/** What a market stall sells, and what a resident brings to sell. */
const MARKET_GOODS = ['bread', 'food_raw', 'food_prepared', 'drink'];
/** Arrivals spread over the first hours of the market. */
const DRIFT_MIN = 4 * HOUR;
/** Desperate enough to pick a pocket: this poor and this unscrupulous. */
const THIEF_MAX_MONEY = 15;
const THIEF_MAX_MORALITY = 35;
const VICTIM_MIN_MONEY = 25;
/** Things that happen at one market, at most: a few stories, not a ledger. */
const MAX_HIGHLIGHTS = 3;

interface Shopper {
  id: number;
  money: number;
  inventory: InventoryItem[];
  morality: number;
  age: number;
}

function shoppers(ids?: readonly number[]): Shopper[] {
  const rows = db.select({
    id: agents.id, age: agents.age, personality: agents.personality, active: agents.is_active,
    money: economy.money, inventory: economy.inventory,
  }).from(agents).innerJoin(economy, eq(economy.agent_id, agents.id)).where(eq(agents.is_active, true)).all();
  return rows.filter((r) => !ids || ids.includes(r.id)).map((r) => ({
    id: r.id, money: r.money, inventory: r.inventory, age: r.age,
    morality: (getEffectivePersonality(r.id) ?? (r.personality as PersonalityProfile | null))?.morality ?? 50,
  }));
}

const foodCount = (inv: InventoryItem[]) => MARKET_GOODS.reduce((s, id) => s + getInventoryCount(inv, id), 0);
const sellable = (inv: InventoryItem[]) => MARKET_GOODS.find((id) => getInventoryCount(inv, id) >= 3) ?? null;

function nameOf(id: number): string {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? 'someone';
}

/** Chance a resident is a `should` market-goer: an empty larder, goods to sell, a full purse. */
export function marketPull(s: Pick<Shopper, 'money' | 'inventory'>): number {
  let p = 0.15;
  if (foodCount(s.inventory) < 2) p += 0.3;
  if (sellable(s.inventory)) p += 0.2;
  if (s.money > 60) p += 0.1;
  return Math.min(0.75, p);
}

function highlights(g: Gathering): string[] {
  return (g.payload.highlights as string[] | undefined) ?? [];
}

function addHighlight(g: Gathering, line: string): void {
  g.payload.highlights = [...highlights(g), line];
}

/** A haggle between two people at the market: an item and money change hands. */
function haggle(g: Gathering, present: Shopper[], rng: () => number): boolean {
  const sellers = present.filter((s) => sellable(s.inventory));
  if (sellers.length === 0) return false;
  const seller = sellers[Math.floor(rng() * sellers.length)];
  const buyers = present.filter((s) => s.id !== seller.id && s.money >= 8);
  if (buyers.length === 0) return false;
  const buyer = buyers[Math.floor(rng() * buyers.length)];
  const item = sellable(seller.inventory)!;
  const base = ITEM_REGISTRY[item]?.basePrice ?? 4;
  const won = rng() < 0.5;
  const price = Math.max(1, Math.round(base * (won ? 0.7 : 1.25)));
  const paid = payResident(buyer.id, seller.id, price, 'market:haggle');
  if (paid <= 0) return false;
  const now = Date.now();
  const sellerRow = db.select().from(economy).where(eq(economy.agent_id, seller.id)).get();
  const buyerRow = db.select().from(economy).where(eq(economy.agent_id, buyer.id)).get();
  if (sellerRow && buyerRow) {
    db.update(economy).set({ inventory: removeFromInventory(sellerRow.inventory, item, 1) }).where(eq(economy.id, sellerRow.id)).run();
    db.update(economy).set({ inventory: addToInventory(buyerRow.inventory, item, 1, now) }).where(eq(economy.id, buyerRow.id)).run();
  }
  const b = nameOf(buyer.id), s = nameOf(seller.id);
  addHighlight(g, won
    ? `${b} haggled ${s} down to $${paid} for ${itemPhrase(item)}.`
    : `${s} held out, and ${b} paid $${paid} for ${itemPhrase(item)}.`);
  remember(buyer.id, won ? `I talked ${firstName(s)} down on ${itemPhrase(item)} at the market.` : `${firstName(s)} wouldn't budge on ${itemPhrase(item)} at the market.`, won ? 0.3 : -0.1, 3, seller.id);
  return true;
}

/** Two acquaintances run into each other between the stalls. */
function bumpInto(g: Gathering, present: Shopper[], rng: () => number): boolean {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const a = present[i].id, b = present[j].id;
      const ab = regard(a, b), ba = regard(b, a);
      if (ab >= 5 && ab < 45 && ba >= 5 && ba < 45) pairs.push([a, b]);
    }
  }
  if (pairs.length === 0) return false;
  const [a, b] = pairs[Math.floor(rng() * pairs.length)];
  feel(a, b, 'market_meeting', `ran into each other at the market`, {
    fromCaller: { friendship: 4 }, fromTarget: { friendship: 4 }, sentiment: 0.4,
  });
  remember(a, `I ran into ${firstName(nameOf(b))} at the market and we got talking. I'd forgotten how much I like them.`, 0.4, 4, b);
  remember(b, `I ran into ${firstName(nameOf(a))} at the market and we got talking.`, 0.3, 4, a);
  addHighlight(g, `${nameOf(a)} and ${nameOf(b)} ran into each other between the stalls and got talking.`);
  return true;
}

/** Someone desperate eyes a full purse: the errand is theirs to run (errandFor). */
function markPickpocket(g: Gathering, present: Shopper[], rng: () => number): boolean {
  if (g.payload.thiefId != null || g.payload.pickDone === true) return false;
  const thieves = present.filter((s) => s.age >= 16 && s.money < THIEF_MAX_MONEY && s.morality < THIEF_MAX_MORALITY
    && !statesOf(s.id).includes('arrested'));
  if (thieves.length === 0) return false;
  const thief = thieves[Math.floor(rng() * thieves.length)];
  const victims = present.filter((s) => s.id !== thief.id && s.money >= VICTIM_MIN_MONEY);
  if (victims.length === 0) return false;
  // Only a chance even then: most desperate people at a market just look.
  if (rng() >= 0.5) return false;
  g.payload.thiefId = thief.id;
  g.payload.victimId = victims[Math.floor(rng() * victims.length)].id;
  return true;
}

export const MARKET: GatheringKind = {
  id: 'market',
  leadMin: 0,
  stayMin: { should: 60, may: 45 },
  mayChancePerMin: 0.004,
  encounterPerMin: 0.05,
  // A draw every hour among whoever is there then, until the market has its few stories.
  momentsAt: [60, 120, 180, 240, 300, 360, 420],
  invite(g, nowMin) {
    for (const s of shoppers()) {
      if (s.age < 16 || statesOf(s.id).includes('arrested')) continue;
      const rng = rngFor(`market|${g.id}|${s.id}`);
      const level = rng() < marketPull(s) ? 'should' : 'may';
      invite(g, s.id, level, Math.max(nowMin, g.startMin + Math.round(rng() * DRIFT_MIN)));
    }
  },
  label: (_g, venue) => ({ walking: `On the way to the market at ${venue}`, there: 'Browsing the market stalls' }),
  topic: () => GATHERING_TOPIC.market,
  moment(g, presentIds, nowMin, index) {
    if (presentIds.length < 2 || highlights(g).length >= MAX_HIGHLIGHTS) return;
    const present = shoppers(presentIds);
    const rng = rngFor(`market-moment|${g.id}|${index}|${nowMin}`);
    // A pickpocket only when the crowd holds both a desperate soul and a full purse;
    // otherwise a haggle or a meeting, whichever the crowd allows.
    if (markPickpocket(g, present, rng)) return;
    const first = rng() < 0.6 ? haggle : bumpInto;
    const second = first === haggle ? bumpInto : haggle;
    if (!first(g, present, rng)) second(g, present, rng);
  },
  errandFor(g, agentId) {
    if (g.payload.thiefId !== agentId || typeof g.payload.victimId !== 'number') return null;
    const victimId = g.payload.victimId;
    g.payload.thiefId = null;
    g.payload.pickDone = true;
    return { source: 'pickpocket', targetAgentId: victimId };
  },
  onClose(g, att) {
    const came = [...att.attended];
    if (came.length < 2) return;
    const lines = highlights(g);
    gatheringFeed(g, 'market_day',
      `Market day ${atPlace(g.venueLocationId)} drew ${came.length} through the morning.${lines.length > 0 ? ' ' + lines.join(' ') : ''}`,
      0.1, came);
  },
};

/** Market day started (world:event_started): the gathering wraps the calendar's event. */
export function onMarketStarted(eventId: number, locationId: number | null, startedAtMin: number, durationHours: number): void {
  const venue = locationId ?? firstOfType(['market_square', 'town_square'])?.id ?? null;
  if (venue == null) return;
  scheduleGathering({
    kind: 'market',
    venueLocationId: venue,
    startMin: startedAtMin,
    endMin: startedAtMin + durationHours * HOUR,
    eventId,
  });
}
