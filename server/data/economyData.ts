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
}

export const ITEM_REGISTRY: Record<string, ItemDef> = {
  food_raw:      { id: 'food_raw', name: 'Raw Food', category: 'food', basePrice: 3, perishable: true, satisfies: { need: 'hunger', amount: 8 } },
  food_prepared: { id: 'food_prepared', name: 'Prepared Food', category: 'food', basePrice: 6, perishable: true, satisfies: { need: 'hunger', amount: 15 } },
  bread:         { id: 'bread', name: 'Fresh Bread', category: 'food', basePrice: 5, perishable: true, satisfies: { need: 'hunger', amount: 12 } },
  drink:         { id: 'drink', name: 'Drink', category: 'drink', basePrice: 4, perishable: false, satisfies: { need: 'fun', amount: 8 } },
  medicine:      { id: 'medicine', name: 'Medicine', category: 'medical', basePrice: 12, perishable: false },
};

export interface Recipe {
  job: string;
  inputs: Record<string, number> | null;
  output: string;
  outputQuantity: number;
  rate: number;
  seasonal?: boolean;
}

export const RECIPE_REGISTRY: Recipe[] = [
  { job: 'farmer',            inputs: null,            output: 'food_raw',  outputQuantity: 1, rate: 1.0, seasonal: true },
  { job: 'farmhand',          inputs: null,            output: 'food_raw',  outputQuantity: 1, rate: 0.8, seasonal: true },
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

export interface LivingCost {
  type: 'food' | 'housing' | 'entertainment';
  amount: number;
  frequency: 'per_meal' | 'per_day' | 'per_visit';
}

export const LIVING_COSTS: LivingCost[] = [
  { type: 'housing', amount: 3, frequency: 'per_day' },
  { type: 'food', amount: 4, frequency: 'per_day' },
  { type: 'entertainment', amount: 2, frequency: 'per_day' },
];

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
