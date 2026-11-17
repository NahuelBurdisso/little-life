/**
 * Where a meal can be had, grocery runs, and the meal thresholds the schedule and free time use.
 */

import { isOpenAt } from '../../../lib/gameClock';
import { distance } from '../../../lib/utils';
import { quoteMeal, pantryWouldServe } from '../economy';
import { foodCount, isFood } from '../../../lib/economyEngine';
import { TRADE_RULES, ITEM_REGISTRY } from '../../../data/economyData';
import type { AgentRow, EconRow, LocationRow, ScoredAction } from './types';

// --- Meals and groceries (G2 / E4) ---
//
// Hunger is only restored by a meal someone actually has: bought at a food
// vendor, or an item from the agent's own inventory (see serveMeal in
// economy.ts). Eating used to be free anywhere, so these choices didn't matter;
// now "eat at home" with an empty pantry feeds nobody, and the decision has to
// send the agent somewhere a meal exists.

/**
 * Where an eating decision should happen: a location id, or `here: true` for
 * "right where they stand" (a packed lunch at the farm, a snack on the bench).
 */
export type MealPlan = { locationId: number | undefined; here: boolean };

/**
 * Where this agent can actually eat right now, given where they meant to.
 * 1. already standing in a vendor that will serve them (open, food in stock,
 *    affordable — or their own): eat there;
 * 2. carrying food: eat it where they stand. Walking across town to buy a meal
 *    with groceries in the bag cost farmers an hour of their shift per meal,
 *    and the food at home went uneaten;
 * 3. the requested vendor, if it will serve them;
 * 4. the nearest vendor that will serve them;
 * 5. home, if the pantry would feed them (broke or starving, once a day);
 * 6. null: no meal to be had right now (vendors closed or sold out, pantry
 *    used). The caller drops the eating option instead — sitting at an empty
 *    table is what pinned a starving town in a 9999-score "eating" loop.
 */
export function chooseMealTarget(
  agent: Pick<AgentRow, 'id' | 'home' | 'position' | 'current_location'>,
  econ: Pick<EconRow, 'money' | 'inventory'> | null,
  requested: number | undefined,
  allLocations: LocationRow[],
  econMap: Map<number, EconRow>,
  time: { hour: number; season: string; day: number },
  hunger?: number,
  critical?: number,
): MealPlan | null {
  const money = econ?.money ?? 0;
  const canServe = (loc: LocationRow): boolean => {
    if (loc.owner == null || !isOpenAt(loc.operating_hours, time.hour)) return false;
    const ownerEcon = econMap.get(loc.owner);
    if (!ownerEcon) return false;
    const quote = quoteMeal(loc, ownerEcon, time.season, agent.id);
    return quote != null && (loc.owner === agent.id || money >= quote.price);
  };
  const at = (id: number): MealPlan => ({ locationId: id, here: false });

  const current = agent.current_location != null ? allLocations.find((l) => l.id === agent.current_location) : undefined;
  if (current && canServe(current)) return at(current.id);

  if (econ && foodCount(econ.inventory) > 0) {
    return { locationId: agent.current_location ?? undefined, here: true };
  }

  const req = requested != null ? allLocations.find((l) => l.id === requested) : undefined;
  if (req && canServe(req)) return at(req.id);

  let best: LocationRow | null = null;
  let bestDist = Infinity;
  for (const loc of allLocations) {
    if (!canServe(loc)) continue;
    const d = distance(agent.position, loc.entry_point);
    if (d < bestDist) { bestDist = d; best = loc; }
  }
  if (best) return at(best.id);
  if (agent.home != null && pantryWouldServe(agent.id, money, hunger, time.day, critical)) return at(agent.home);
  return null;
}

/**
 * Resolve an eating decision to where the meal is (see chooseMealTarget), or
 * null to drop it so the caller falls through to its next-best option.
 */
export function withMeal(
  decision: ScoredAction,
  plan: (requested: number | undefined) => MealPlan | null,
): ScoredAction | null {
  if (decision.action !== 'eating') return decision;
  const meal = plan(decision.targetLocationId);
  if (!meal) return null;
  return { ...decision, targetLocationId: meal.locationId };
}

/** A shopping trip restocks food only while the agent holds fewer than this. */
export const PANTRY_TARGET = 2;
/** Free-time score of a grocery run before hunger is added (a stroll on the square is 35+). */
export const GROCERY_BASE_SCORE = 40;

/**
 * What a shopping trip to `shop` should buy, from needs: the two cheapest foods
 * the shop sells while the agent's pantry is low. The list used to be always
 * empty (`items: []`), so a trip bought nothing (E4).
 */
export function groceryList(econ: Pick<EconRow, 'inventory'> | null, shop: LocationRow | undefined): string[] {
  if (!econ || !shop) return [];
  const rule = TRADE_RULES[shop.type];
  if (!rule || foodCount(econ.inventory) >= PANTRY_TARGET) return [];
  return rule.sells
    .filter(isFood)
    .sort((a, b) => ITEM_REGISTRY[a].basePrice - ITEM_REGISTRY[b].basePrice)
    .slice(0, PANTRY_TARGET);
}

/**
 * The nearest open store (not the agent's own) with food on its shelves, for a
 * grocery run. Null if the agent can't afford even the cheapest thing there.
 */
export function nearestGrocer(
  agent: Pick<AgentRow, 'id' | 'position'>,
  money: number,
  allLocations: LocationRow[],
  econMap: Map<number, EconRow> | undefined,
  hour: number,
): LocationRow | null {
  if (!econMap) return null;
  let best: LocationRow | null = null;
  let bestDist = Infinity;
  for (const loc of allLocations) {
    const rule = TRADE_RULES[loc.type];
    if (!rule || loc.owner == null || loc.owner === agent.id || !isOpenAt(loc.operating_hours, hour)) continue;
    const shelf = econMap.get(loc.owner)?.inventory ?? [];
    const affordable = shelf.some((i) => i.quantity > 0 && rule.sells.includes(i.itemId) && isFood(i.itemId)
      && ITEM_REGISTRY[i.itemId].basePrice * 2 <= money);
    if (!affordable) continue;
    const d = distance(agent.position, loc.entry_point);
    if (d < bestDist) { bestDist = d; best = loc; }
  }
  return best;
}

/** Added to the free-time eating score below the agent's "low" hunger threshold. */
export const HUNGRY_EAT_BONUS = 60;

/** Too tired for a meal before bed below this energy: sleep first. */
export const SUPPER_MIN_ENERGY = 5;

/** Dinner starts no earlier than this hour (at the end of a shift for workers). */
export const DINNER_HOUR = 18;
/** Dinner is skipped by anyone fuller than this. */
export const DINNER_BELOW_HUNGER = 60;

/** Lunch is skipped by anyone fuller than this. */
export const LUNCH_BELOW_HUNGER = 70;
