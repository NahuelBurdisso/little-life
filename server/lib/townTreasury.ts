/**
 * The town treasury (`world_state.tax_pool`) and the money loop around it.
 * Pure functions only — economy.ts applies them to the database.
 *
 * Why this exists (E1): every salary used to be minted from nothing at shift
 * end (~$280 a day for the default 13) while the only sink was a flat $9/day
 * living cost that was burned. Food supply caps what people can actually buy
 * (~20 meals a day town-wide), so most of each wage just piled up: the money
 * supply climbed ~10% a day until the balancer's robbery/scam/hyperinflation
 * events fired — from inflation the sim itself caused, not from anything a
 * resident did. Sales tax and venue fees flowed into `tax_pool` and sat there.
 *
 * The loop now is closed: money moves between residents and the treasury but
 * is not created or destroyed by the daily cycle.
 *
 *   treasury ──wages──────────▶ residents (staff of a shop: paid by the owner)
 *   treasury ──stipend────────▶ residents who can't afford a day of meals
 *   residents ──upkeep────────▶ treasury (daily: base rent + lifestyle share)
 *   residents ──sales tax, town-venue fees, estates without heir──▶ treasury
 *
 * Upkeep is what closes it. A flat charge can't: the lowest wage must leave
 * room for three meals, so a flat rent recovers only a fraction of the wage
 * bill, and whatever a high earner doesn't spend accumulates. The lifestyle
 * share — a fraction of cash above a savings allowance — is the rich living
 * bigger: it caps a resident's savings near `allowance + dailySurplus / rate`
 * and returns that surplus to the treasury, which pays it out again as wages.
 * Its rate follows the money supply (`balancerMultipliers`): a fixed rate
 * settles wherever the cast's wages put it (~$95 a head for the default 13,
 * still climbing on day 7), a rate that stiffens as residents' money rises
 * above the per-capita target holds it near the target whatever the salaries.
 *
 * The treasury is the only account that pays before it collects: wages go out
 * at each shift end, upkeep comes in at midnight. A new town therefore starts
 * with a reserve (`startingTreasury`, minted once like residents' starting
 * money) so the evening low stays above zero. It may still dip into debt
 * (a negative pool) in a save made before the treasury existed; that is
 * allowed — wages are never withheld — and the lifestyle share refills it.
 *
 * The other direction is capped: money that enters from outside the loop
 * (player gifts, shoplifting, an old save's minted inflation) is swept into
 * the treasury by the upkeep and the balancer, and whatever sits above the
 * cap at settlement is retired (`treasuryExcess`). That is the one sink left,
 * and it only bites when the town holds more money than it started with.
 */

const cents = (n: number) => Math.round(n * 100) / 100;

/** A new town's treasury: a reserve per resident, enough for a day of wages. */
export function startingTreasury(residents: number, perCapita: number): number {
  return Math.max(0, residents) * perCapita;
}

/** Treasury balance above the cap (per resident), retired at settlement. */
export function treasuryExcess(pool: number, residents: number, capPerCapita: number): number {
  return cents(Math.max(0, pool - Math.max(1, residents) * capPerCapita));
}

export interface UpkeepParams {
  /** Flat daily charge (rent, utilities) — the old housing living cost. */
  base: number;
  /** Cash a resident keeps without paying the lifestyle share. */
  allowance: number;
  /** Share of cash above the allowance paid each day. */
  rate: number;
  /** Money-supply multiplier on the lifestyle share (1 at the target). */
  multiplier?: number;
}

/**
 * The lifestyle share never takes more than this of the excess in one night.
 * Normal play stays well under it (0.35 × a multiplier near 1); it binds when a
 * save from before the treasury loads with residents' money at ~1.5× the
 * target, so that town deflates over a few nights instead of in one.
 */
const MAX_LIFESTYLE_RATE = 0.6;

/**
 * One resident's upkeep for the day, never more than they hold. Someone with
 * nothing pays nothing (they get the stipend instead); the base charge is not
 * carried over as debt. The money-supply multiplier only moves the lifestyle
 * share: the poor don't pay more rent because the rich saved too much.
 */
export function dailyUpkeep(cash: number, p: UpkeepParams): number {
  if (cash <= 0) return 0;
  const rate = Math.min(MAX_LIFESTYLE_RATE, p.rate * (p.multiplier ?? 1));
  const due = p.base + rate * Math.max(0, cash - p.allowance);
  return cents(Math.min(cash, Math.max(0, due)));
}

/**
 * The treasury's safety-net payment: tops a resident up to `floor` (about a
 * day of meals at the priced venues). Paid at settlement, after upkeep, so the
 * next morning's breakfast and lunch are bought rather than begged from the
 * pantry (E5: low earners lived on the once-a-day pantry meal).
 */
export function stipendFor(cash: number, floor: number): number {
  return cents(Math.max(0, floor - Math.max(0, cash)));
}

export type WagePayer = { kind: 'employer'; employerId: number } | { kind: 'treasury' };

/**
 * Who pays a resident's wage. Staff of a business someone else owns (the shop
 * assistant at the general store, the nurse at the clinic) are paid out of the
 * owner's till — that is where the customers' money went — as long as the
 * owner keeps `employerFloor` of working capital afterwards (the till also
 * buys tomorrow's stock). Everyone else, and staff whose employer can't cover
 * it today, is paid by the treasury.
 */
export function wagePayer(args: {
  agentId: number;
  workplaceOwner: number | null | undefined;
  workplaceIsBusiness: boolean;
  employerCash: number | undefined;
  wage: number;
  employerFloor: number;
}): WagePayer {
  const { agentId, workplaceOwner, workplaceIsBusiness, employerCash, wage, employerFloor } = args;
  if (workplaceOwner != null && workplaceOwner !== agentId && workplaceIsBusiness
    && employerCash !== undefined && employerCash - wage >= employerFloor) {
    return { kind: 'employer', employerId: workplaceOwner };
  }
  return { kind: 'treasury' };
}

/**
 * The money-supply balancer's multipliers for tomorrow, from today's ratio of
 * residents' money to the per-capita target.
 *
 * `upkeep` scales the lifestyle share continuously, ratio cubed (0.73 at 0.9,
 * 1.52 at 1.15, capped 0.25-4): the proportional pull that keeps the supply
 * near 1. It used to be a dead band up to 1.5 with a quadratic ramp on the
 * whole living cost, which only started once the town was already inflated
 * and then charged the broke as much as the rich.
 *
 * `tax` (sales tax) keeps its old shape: flat inside 0.5-1.5, quadratic above,
 * halved below.
 */
export function balancerMultipliers(ratio: number): { upkeep: number; tax: number } {
  const upkeep = Math.min(4, Math.max(0.25, ratio ** 3));
  if (ratio > 1.5) {
    const excess = ratio - 1.0;
    return { upkeep, tax: 1.0 + excess * excess * 0.8 };
  }
  if (ratio < 0.5) return { upkeep, tax: 0.5 };
  return { upkeep, tax: 1.0 };
}
