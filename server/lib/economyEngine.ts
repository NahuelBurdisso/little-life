/**
 * Economy Engine
 *
 * Centralized economic calculations. All price, inventory, and trade
 * logic lives here. Consumers call these helpers — no hardcoded economy
 * logic elsewhere.
 */

import { ITEM_REGISTRY, SEASON_PRICE_MODIFIERS, RECIPE_REGISTRY, TRADE_RULES } from '../data/economyData';
import type { ItemDef, Recipe, TradeRule } from '../data/economyData';

// --- Types ---

type InventoryItem = { itemId: string; quantity: number; acquiredAt: number };

// --- Price Engine ---

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
  }

  // Supply/demand curve
  const supplyFactor = Math.max(0.7, Math.min(1.8, 1.5 - shopSupply * 0.05));
  price *= supplyFactor;

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

export function getItemDef(itemId: string): ItemDef | undefined {
  return ITEM_REGISTRY[itemId];
}

export function getFoodItems(): ItemDef[] {
  return Object.values(ITEM_REGISTRY).filter(i => i.satisfies?.need === 'hunger');
}

export function getBestFoodInInventory(inventory: InventoryItem[]): string | null {
  let bestItem: string | null = null;
  let bestAmount = 0;
  for (const inv of inventory) {
    const def = ITEM_REGISTRY[inv.itemId];
    if (def?.satisfies?.need === 'hunger' && inv.quantity > 0) {
      if (def.satisfies.amount > bestAmount) {
        bestAmount = def.satisfies.amount;
        bestItem = inv.itemId;
      }
    }
  }
  return bestItem;
}

// --- Location helpers ---

export function getLocationsThatSell(itemId: string): string[] {
  return Object.entries(TRADE_RULES)
    .filter(([, rule]) => rule.sells.includes(itemId))
    .map(([locType]) => locType);
}

export function getLocationsThatSellFood(): string[] {
  const foodItems = getFoodItems().map(i => i.id);
  const locTypes = new Set<string>();
  for (const [locType, rule] of Object.entries(TRADE_RULES)) {
    if (rule.sells.some(s => foodItems.includes(s))) {
      locTypes.add(locType);
    }
  }
  return Array.from(locTypes);
}
