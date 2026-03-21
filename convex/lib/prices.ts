import { CONFIG } from "../engine/constants";
import type { Season } from "./types";

export function getItemPrice(
  item: string,
  season: Season,
  activeEventEffects: Record<string, number>,
): number {
  let price = CONFIG.ECONOMY.BASE_PRICES[item] ?? 5;

  // Apply season modifier for food items
  if (item === "food_raw" || item === "food_prepared") {
    price *= CONFIG.ECONOMY.SEASON_PRICE_MODIFIERS[season] ?? 1;
  }

  // Apply event modifiers (e.g., shop_prices: 0.5 halves prices)
  if (activeEventEffects["shop_prices"]) {
    price *= activeEventEffects["shop_prices"];
  }
  if (
    activeEventEffects["food_prices"] &&
    (item === "food_raw" || item === "food_prepared")
  ) {
    price *= activeEventEffects["food_prices"];
  }

  return Math.round(price);
}
