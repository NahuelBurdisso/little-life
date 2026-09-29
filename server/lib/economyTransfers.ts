import { db } from '../db';
import { economy, worldState } from '../db/schema';
import { eq } from 'drizzle-orm';

/**
 * Small money moves outside economy.ts that used to create or destroy money.
 * The treasury loop (server/lib/townTreasury.ts) only stays flat if every
 * dollar a resident gains is a dollar someone else — a resident or the
 * treasury — loses.
 */

/**
 * A tavern round: the drinker pays `price` to whoever runs the tavern, or to
 * the treasury when nobody does (the same rule as a town venue's fee). It used
 * to vanish. Someone drinking at their own bar pays nobody. Returns what the
 * drinker paid.
 */
export function payTavernRound(drinkerId: number, tavernOwnerId: number | null, price: number): number {
  if (tavernOwnerId === drinkerId) return 0;
  const drinker = db.select().from(economy).where(eq(economy.agent_id, drinkerId)).get();
  if (!drinker || drinker.money < price) return 0;
  db.update(economy).set({ money: drinker.money - price }).where(eq(economy.id, drinker.id)).run();
  const owner = tavernOwnerId != null
    ? db.select().from(economy).where(eq(economy.agent_id, tavernOwnerId)).get()
    : undefined;
  if (owner) {
    db.update(economy).set({ money: owner.money + price }).where(eq(economy.id, owner.id)).run();
  } else {
    const world = db.select().from(worldState).get();
    if (world) db.update(worldState).set({ tax_pool: world.tax_pool + price }).where(eq(worldState.id, world.id)).run();
  }
  return price;
}

/**
 * Shoplifting: up to `amount` leaves the shop owner's till for the thief's
 * pocket. It used to be minted. Nothing is taken from one's own shop, from a
 * shop nobody owns (that would be the treasury's money) or beyond what the
 * till holds. Returns what was taken (0 = nothing).
 */
export function shopliftFrom(thiefId: number, shopOwnerId: number | null, amount: number): number {
  if (shopOwnerId == null || shopOwnerId === thiefId) return 0;
  const owner = db.select().from(economy).where(eq(economy.agent_id, shopOwnerId)).get();
  const thief = db.select().from(economy).where(eq(economy.agent_id, thiefId)).get();
  if (!owner || !thief) return 0;
  const taken = Math.max(0, Math.min(amount, Math.floor(owner.money)));
  if (taken <= 0) return 0;
  db.update(economy).set({ money: owner.money - taken }).where(eq(economy.id, owner.id)).run();
  db.update(economy).set({ money: thief.money + taken }).where(eq(economy.id, thief.id)).run();
  return taken;
}
