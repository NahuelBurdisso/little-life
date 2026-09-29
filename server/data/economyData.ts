/**
 * Economy Data Registries
 *
 * Single source of truth for all economy data.
 * To add a new item: add one entry to ITEM_REGISTRY.
 * To add a new production job: add one entry to RECIPE_REGISTRY.
 * To add a new shop type: add one entry to TRADE_RULES.
 */

export interface ItemDef {
  id: string;
  name: string;
  category: 'food' | 'drink' | 'medical' | 'material' | 'luxury';
  basePrice: number;
  perishable: boolean;
  satisfies?: { need: string; amount: number };
  /**
   * Prose for feed lines and memories, which used to print the id ("gave
   * food_raw to Rosa"; G9): `phrase` stands alone ("gave Rosa a loaf of
   * bread"), `unit` follows a count ("2 loaves of bread"). See itemPhrase.
   */
  phrase: string;
  unit: [singular: string, plural: string];
}

export const ITEM_REGISTRY: Record<string, ItemDef> = {
  food_raw:      { id: 'food_raw', name: 'Raw Food', category: 'food', basePrice: 3, perishable: true, satisfies: { need: 'hunger', amount: 8 },
                   phrase: 'some raw food', unit: ['portion of raw food', 'portions of raw food'] },
  food_prepared: { id: 'food_prepared', name: 'Prepared Food', category: 'food', basePrice: 6, perishable: true, satisfies: { need: 'hunger', amount: 15 },
                   phrase: 'a hot meal', unit: ['hot meal', 'hot meals'] },
  bread:         { id: 'bread', name: 'Fresh Bread', category: 'food', basePrice: 5, perishable: true, satisfies: { need: 'hunger', amount: 12 },
                   phrase: 'a loaf of bread', unit: ['loaf of bread', 'loaves of bread'] },
  drink:         { id: 'drink', name: 'Drink', category: 'drink', basePrice: 4, perishable: false, satisfies: { need: 'fun', amount: 8 },
                   phrase: 'a drink', unit: ['drink', 'drinks'] },
  medicine:      { id: 'medicine', name: 'Medicine', category: 'medical', basePrice: 12, perishable: false,
                   phrase: 'some medicine', unit: ['dose of medicine', 'doses of medicine'] },
};

/**
 * An item as a noun phrase for prose. Unknown ids (gift items the registry
 * doesn't define) read as their words; text that is already prose ("$12",
 * "a visit to the tavern") passes through, so emitters that send either can
 * share one template.
 */
export function itemPhrase(item: string): string {
  return ITEM_REGISTRY[item]?.phrase ?? item.replace(/_/g, ' ');
}

/** "1 loaf of bread", "2 loaves of bread". */
export function itemCountPhrase(item: string, count: number): string {
  const unit = ITEM_REGISTRY[item]?.unit;
  const words = unit ? unit[count === 1 ? 0 : 1] : item.replace(/_/g, ' ');
  return `${count} ${words}`;
}

export interface Recipe {
  job: string;
  inputs: Record<string, number> | null;
  output: string;
  outputQuantity: number;
  rate: number;
  seasonal?: boolean;
}

// Farm rates are units per game hour at work. Raised from 1.0/0.8 to 3.0/2.4
// once meals had to be real food (G2), when farmers were at work only 2-3 h of
// their 8-9 h shifts. With routed walks at 1.5 tiles/game min (E6) they now
// work ~6 h, and 3.0/2.4 grew 33-62 food_raw a day against ~28 meals, pinning
// hunger at 70+. 2.0/1.6 keeps ~20-40 a day in spring; winter's 0.4 bites
// hardest. Re-check against real shift time whenever labour changes.
export const RECIPE_REGISTRY: Recipe[] = [
  { job: 'farmer',           inputs: null,            output: 'food_raw',  outputQuantity: 1, rate: 2.0, seasonal: true },
  { job: 'farmhand',          inputs: null,            output: 'food_raw',  outputQuantity: 1, rate: 1.6, seasonal: true },
  { job: 'baker',             inputs: { food_raw: 1 }, output: 'bread',     outputQuantity: 2, rate: 1.0 },
  { job: 'bartender',         inputs: { food_raw: 2 }, output: 'drink',     outputQuantity: 4, rate: 1.0 },
  { job: 'doctor',            inputs: null,            output: 'medicine',  outputQuantity: 1, rate: 0.5 },
  { job: 'medical_assistant', inputs: null,            output: 'medicine',  outputQuantity: 1, rate: 0.3 },
];

export interface TradeRule {
  locationType: string;
  sells: string[];
  buys: string[];
  entertainmentCost: number;
}

export const TRADE_RULES: Record<string, TradeRule> = {
  shop:    { locationType: 'shop',    sells: ['food_raw', 'food_prepared', 'bread'], buys: ['food_raw', 'bread', 'food_prepared'], entertainmentCost: 0 },
  tavern:  { locationType: 'tavern',  sells: ['drink', 'food_prepared'],             buys: ['drink', 'food_raw'],                  entertainmentCost: 3 },
  bakery:  { locationType: 'bakery',  sells: ['bread'],                              buys: ['food_raw'],                            entertainmentCost: 0 },
  clinic:  { locationType: 'clinic',  sells: ['medicine'],                            buys: [],                                      entertainmentCost: 0 },
};

// Daily living costs are the treasury upkeep now (CONFIG.ECONOMY.UPKEEP,
// server/lib/townTreasury.ts): paid to the town instead of burned, and without
// the flat food/entertainment charges that meals and venue fees replaced.

export const SEASON_PRICE_MODIFIERS: Record<string, number> = {
  spring: 0.9,
  summer: 0.8,
  autumn: 1.0,
  winter: 1.5,
};

export const SEASON_PRODUCTION_MODIFIERS: Record<string, number> = {
  spring: 1.2,
  summer: 1.0,
  autumn: 0.8,
  winter: 0.4,
};
