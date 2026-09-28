/**
 * Economy Engine
 *
 * Centralized economic calculations. All price, inventory, and trade
 * logic lives here. Consumers call these helpers — no hardcoded economy
 * logic elsewhere.
 */

import { ITEM_REGISTRY, SEASON_PRICE_MODIFIERS, RECIPE_REGISTRY, TRADE_RULES } from '../data/economyData';
import type { Recipe, TradeRule } from '../data/economyData';

// --- Types ---

type InventoryItem = { itemId: string; quantity: number; acquiredAt: number };

// --- Price Engine ---

// Cache active event types for price modifiers (updated by economy tick)
let cachedEventPriceModifiers: Record<string, number> = {};

export function setEventPriceModifiers(modifiers: Record<string, number>): void {
  cachedEventPriceModifiers = modifiers;
}

/** Get production multiplier from active events (e.g., harvest doubles farm output). */
export function getEventProductionMultiplier(): number {
  return cachedEventPriceModifiers.farm_production ?? 1.0;
}

export function getMarketPrice(
  itemId: string,
  season: string,
  shopSupply: number,
  ownerMorality?: number,
): number {
  const item = ITEM_REGISTRY[itemId];
  if (!item) return 5;

  let price = item.basePrice;

  // Season modifier for food items
  if (item.category === 'food') {
    price *= SEASON_PRICE_MODIFIERS[season] ?? 1.0;
    // Winter food is more expensive (scarcity)
    if (season === 'winter') price *= 1.15;
  }

  // Supply/demand curve
  const supplyFactor = Math.max(0.7, Math.min(1.8, 1.5 - shopSupply * 0.05));
  price *= supplyFactor;

  // Event-driven price modifiers
  if (cachedEventPriceModifiers.shop_prices) {
    price *= cachedEventPriceModifiers.shop_prices; // e.g. 0.5 for market_day, 0.7 for festival
  }
  if (cachedEventPriceModifiers.food_prices && item.category === 'food') {
    price *= cachedEventPriceModifiers.food_prices; // e.g. 0.6 for harvest
  }

  // Price gouging
  if (ownerMorality !== undefined && ownerMorality < 40 && shopSupply < 3) {
    price *= 2.0;
  }

  return Math.round(price * 10) / 10;
}

export function getCheapestFoodPrice(): number {
  let cheapest = Infinity;
  for (const item of Object.values(ITEM_REGISTRY)) {
    if (item.satisfies?.need === 'hunger' && item.basePrice < cheapest) {
      cheapest = item.basePrice;
    }
  }
  return cheapest === Infinity ? 3 : cheapest;
}

// --- Inventory Helpers ---

export function getInventoryCount(inventory: InventoryItem[], itemId: string): number {
  return inventory.find((i) => i.itemId === itemId)?.quantity ?? 0;
}

export function addToInventory(
  inventory: InventoryItem[], itemId: string, quantity: number, timestamp: number,
): InventoryItem[] {
  const existing = inventory.find((i) => i.itemId === itemId);
  if (existing) {
    return inventory.map((i) =>
      i.itemId === itemId ? { ...i, quantity: i.quantity + quantity } : i,
    );
  }
  return [...inventory, { itemId, quantity, acquiredAt: timestamp }];
}

export function removeFromInventory(
  inventory: InventoryItem[], itemId: string, quantity: number,
): InventoryItem[] {
  return inventory
    .map((i) => i.itemId === itemId ? { ...i, quantity: i.quantity - quantity } : i)
    .filter((i) => i.quantity > 0);
}

// --- Registry Lookups ---

export function getRecipeForJob(job: string): Recipe | undefined {
  return RECIPE_REGISTRY.find(r => r.job === job);
}

export function getTradeRuleForLocation(locationType: string): TradeRule | undefined {
  return TRADE_RULES[locationType];
}

