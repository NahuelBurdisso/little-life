import { MutationCtx } from "../_generated/server";
import { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { clamp } from "../lib/utils";

// Need names for iteration
const NEED_KEYS = ["hunger", "energy", "social", "comfort", "fun"] as const;
type NeedKey = (typeof NEED_KEYS)[number];

// Action modifier table: how each action affects need decay
// Negative = restorative, >1 = accelerated decay, <1 = slowed, 0 = no change
const ACTION_MODIFIERS: Record<string, Record<NeedKey, number>> = {
  sleeping:    { hunger: 0.5,  energy: -2.3, social: 1,    comfort: -0.5, fun: 0    },
  eating:      { hunger: -4.0, energy: 0.8,  social: 0.8,  comfort: -0.3, fun: 0.9  },
  working:     { hunger: 1.2,  energy: 1.5,  social: 0.9,  comfort: 1.2,  fun: 1.3  },
  talking:     { hunger: 1,    energy: 1.1,  social: -2.5, comfort: 1,    fun: -0.5 },
  socializing: { hunger: 1,    energy: 1.1,  social: -3.0, comfort: -0.3, fun: -1.5 },
  idle:        { hunger: 0.8,  energy: -0.5, social: 1,    comfort: -1.0, fun: 1.2  },
  walking:     { hunger: 1.1,  energy: 1.2,  social: 1,    comfort: 0.9,  fun: -0.3 },
  shopping:    { hunger: 1,    energy: 1,    social: 0.9,  comfort: 1,    fun: -0.5 },
};

const DEFAULT_MODIFIERS: Record<NeedKey, number> = {
  hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1,
};

function applyModifier(baseDecay: number, modifier: number): number {
  if (modifier < 0) {
    // Restorative: return negative value (will restore the need when subtracted)
    return modifier * Math.abs(baseDecay);
  }
  return baseDecay * modifier;
}

function getWeatherMoodEffect(weather: string, isIndoors: boolean): number {
  if (weather === "rainy" && !isIndoors) return -2;
  if (weather === "rainy" && isIndoors) return 1; // Cozy
  if (weather === "stormy" && !isIndoors) return -5;
  if (weather === "stormy" && isIndoors) return 0;
  if (weather === "foggy" && !isIndoors) return -1;
  if (weather === "sunny") return 1;
  return 0; // cloudy or unknown
}

export async function tick(ctx: MutationCtx, world: Doc<"worldState">): Promise<void> {
  const gameHoursElapsed = world.tickSpeed / 60;

  // Fetch all active agents and all needs records
  const agents = await ctx.db
    .query("agents")
    .filter((q) => q.eq(q.field("isActive"), true))
    .collect();
  const allNeeds = await ctx.db.query("needs").collect();

  // Index needs by agentId for fast lookup
  const needsByAgent = new Map<string, Doc<"needs">>();
  for (const n of allNeeds) {
    needsByAgent.set(n.agentId as string, n);
  }

  // Fetch economy records for money checks (location service affordability)
  const allEconomy = await ctx.db.query("economy").collect();
  const economyByAgent = new Map<string, Doc<"economy">>();
  for (const e of allEconomy) {
    economyByAgent.set(e.agentId as string, e);
  }

  const currentTime =
    world.time.day * 24 * 60 + world.time.hour * 60 + world.time.minute;

  for (const agent of agents) {
    const needs = needsByAgent.get(agent._id as string);
    if (!needs) continue;

    // Step 1-2: Get action type and look up modifiers
    const actionType: string = agent.currentAction?.type ?? "idle";
    const modifiers = ACTION_MODIFIERS[actionType] ?? DEFAULT_MODIFIERS;

    // Steps 3-6: Calculate decay per need with action modifier and stress amplifier
    const stressMultiplier = 1 + (needs.stress / 200);
    const updatedNeeds: Record<NeedKey, number> = {} as Record<NeedKey, number>;

    for (const key of NEED_KEYS) {
      const decayRate = needs.decayRates[key];
      const baseDecay = decayRate * gameHoursElapsed;
      const modifiedDecay = applyModifier(baseDecay, modifiers[key]);
      const finalDecay = modifiedDecay * stressMultiplier;
      updatedNeeds[key] = needs[key] - finalDecay;
    }

    // Step 7: Apply location service bonuses
    if (agent.currentLocation) {
      const location = await ctx.db.get(agent.currentLocation);
      if (location && location.services) {
        const economy = economyByAgent.get(agent._id as string);
        const hasMoney = economy ? economy.money > 0 : false;

        for (const service of location.services) {
          const needKey = service.needSatisfied as NeedKey;
          if (NEED_KEYS.includes(needKey)) {
            if (service.cost <= 0 || hasMoney) {
              updatedNeeds[needKey] += service.amount * gameHoursElapsed;
            }
          }
        }
      }
    }

    // Step 8: Weather mood effect
    const isIndoors = agent.currentLocation !== null;
    const weatherModifier = getWeatherMoodEffect(world.weather, isIndoors);

    // Step 9: Clamp all need values to 0-100
    for (const key of NEED_KEYS) {
      updatedNeeds[key] = clamp(updatedNeeds[key], 0, 100);
    }

    // Step 10: Expire mood modifiers past their expiresAt
    const activeMoodModifiers = needs.moodModifiers.filter(
      (m) => m.expiresAt > currentTime
    );

    // Step 11: Recalculate mood
    const moodModifierSum = activeMoodModifiers.reduce(
      (sum, m) => sum + m.value,
      0
    );
    const baseMood =
      updatedNeeds.hunger * 0.2 +
      updatedNeeds.energy * 0.2 +
      updatedNeeds.social * 0.25 +
      updatedNeeds.comfort * 0.15 +
      updatedNeeds.fun * 0.2 +
      moodModifierSum +
      weatherModifier;
    const mood = clamp(baseMood, 0, 100);

    // Step 12: Recalculate stress
    const needValues = NEED_KEYS.map((k) => updatedNeeds[k]);
    const lowestNeed = Math.min(...needValues);
    const averageNeed =
      needValues.reduce((sum, v) => sum + v, 0) / needValues.length;
    const stress = clamp(100 - (lowestNeed * 0.6 + averageNeed * 0.4), 0, 100);

    // Detect sleep transition: schedule daily reflection when agent starts sleeping.
    // We detect the transition by checking if the action is "sleeping" and the
    // needs record was last updated before the action started (meaning this is
    // the first tick processing this sleep action).
    if (actionType === "sleeping" && needs.lastUpdated < agent.actionStarted) {
      try {
        await ctx.scheduler.runAfter(
          0,
          internal.actions.generateReflection.generateReflection,
          { agentId: agent._id }
        );
      } catch {
        // Silently ignore if scheduling fails
      }
    }

    // Step 13: Write updated values
    await ctx.db.patch(needs._id, {
      hunger: updatedNeeds.hunger,
      energy: updatedNeeds.energy,
      social: updatedNeeds.social,
      comfort: updatedNeeds.comfort,
      fun: updatedNeeds.fun,
      mood,
      stress,
      moodModifiers: activeMoodModifiers,
      lastUpdated: currentTime,
    });
  }
}
