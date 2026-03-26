import { db } from '../../db';
import { agents, needs, economy, locations, worldState } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { clamp } from '../../lib/utils';
import { emitter } from '../emitter';
import { taskRunner } from '../../ai/taskRunner';
import { getAgentStates } from '../../lib/states';

// Need names for iteration
const NEED_KEYS = ['hunger', 'energy', 'social', 'comfort', 'fun'] as const;
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
  if (weather === 'rainy' && !isIndoors) return -2;
  if (weather === 'rainy' && isIndoors) return 1; // Cozy
  if (weather === 'stormy' && !isIndoors) return -5;
  if (weather === 'stormy' && isIndoors) return 0;
  if (weather === 'foggy' && !isIndoors) return -1;
  if (weather === 'sunny') return 1;
  return 0; // cloudy or unknown
}

export function needsTick(): void {
  const world = db.select().from(worldState).get();
  if (!world) return;

  const gameHoursElapsed = world.tick_speed / 60;

  // Fetch all active agents and all needs records
  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const allNeeds = db.select().from(needs).all();

  // Index needs by agent_id for fast lookup
  const needsByAgent = new Map<number, typeof allNeeds[0]>();
  for (const n of allNeeds) {
    needsByAgent.set(n.agent_id, n);
  }

  // Fetch economy records for money checks (location service affordability)
  const allEconomy = db.select().from(economy).all();
  const economyByAgent = new Map<number, typeof allEconomy[0]>();
  for (const e of allEconomy) {
    economyByAgent.set(e.agent_id, e);
  }

  const currentTime =
    world.time!.day * 24 * 60 + world.time!.hour * 60 + world.time!.minute;

  for (const agent of activeAgents) {
    const agentNeeds = needsByAgent.get(agent.id);
    if (!agentNeeds) continue;

    // Step 1-2: Get action type and look up modifiers
    const actionType: string = (agent.current_action as any)?.type ?? 'idle';
    const modifiers = ACTION_MODIFIERS[actionType] ?? DEFAULT_MODIFIERS;

    // Steps 3-6: Calculate decay per need with action modifier and stress amplifier
    const stressMultiplier = 1 + (agentNeeds.stress / 200);
    const updatedNeeds: Record<NeedKey, number> = {} as Record<NeedKey, number>;
    const agentStateTypes = getAgentStates(agent.id);

    for (const key of NEED_KEYS) {
      const decayRate = agentNeeds.decay_rates[key];
      const baseDecay = decayRate * gameHoursElapsed;
      let modifiedDecay = applyModifier(baseDecay, modifiers[key]);

      // Sick → double energy decay
      if (key === 'energy' && agentStateTypes.includes('sick')) {
        modifiedDecay *= 2;
      }

      // Only amplify decay (positive values) with stress — never amplify restoration
      const finalDecay = modifiedDecay > 0 ? modifiedDecay * stressMultiplier : modifiedDecay;
      updatedNeeds[key] = agentNeeds[key] - finalDecay;
    }

    // Step 7: Apply location service bonuses
    if (agent.current_location) {
      const location = db.select().from(locations).where(eq(locations.id, agent.current_location)).get();
      if (location && location.services) {
        const agentEcon = economyByAgent.get(agent.id);
        const hasMoney = agentEcon ? agentEcon.money > 0 : false;

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
    const isIndoors = agent.current_location !== null;
    const weatherModifier = getWeatherMoodEffect(world.weather, isIndoors);

    // Step 9: Clamp all need values to 0-100
    for (const key of NEED_KEYS) {
      updatedNeeds[key] = clamp(updatedNeeds[key], 0, 100);
    }

    // Step 10: Expire mood modifiers past their expiresAt
    const activeMoodModifiers = agentNeeds.mood_modifiers.filter(
      (m) => m.expiresAt > currentTime
    );

    // Step 11: Recalculate mood
    const moodModifierSum = activeMoodModifiers.reduce(
      (sum, m) => sum + m.value,
      0
    );
    let baseMood =
      updatedNeeds.hunger * 0.2 +
      updatedNeeds.energy * 0.2 +
      updatedNeeds.social * 0.25 +
      updatedNeeds.comfort * 0.15 +
      updatedNeeds.fun * 0.2 +
      moodModifierSum +
      weatherModifier;

    // Depressed → halve positive mood gains (clamp positive delta)
    if (agentStateTypes.includes('depressed')) {
      const currentMood = agentNeeds.mood;
      const moodDelta = baseMood - currentMood;
      if (moodDelta > 0) {
        baseMood = currentMood + moodDelta * 0.5;
      }
    }

    const mood = clamp(baseMood, 0, 100);

    // Step 12: Recalculate stress — base from needs + modifiers from states and overwork
    const needValues = NEED_KEYS.map((k) => updatedNeeds[k]);
    const lowestNeed = Math.min(...needValues);
    const averageNeed =
      needValues.reduce((sum, v) => sum + v, 0) / needValues.length;
    let stress = clamp(100 - (lowestNeed * 0.6 + averageNeed * 0.4), 0, 100);

    // Overwork: working action adds stress proportional to consecutive work time
    if (actionType === 'working') {
      const workDuration = currentTime - (agent.action_started ?? currentTime);
      if (workDuration > 360) { // More than 6 hours straight
        stress = clamp(stress + (workDuration - 360) * 0.02, 0, 100);
      }
    }

    // State-driven stress modifiers
    if (agentStateTypes.includes('in_debt')) stress = clamp(stress + 10, 0, 100);
    if (agentStateTypes.includes('jealous')) stress = clamp(stress + 8, 0, 100);
    if (agentStateTypes.includes('alcoholic')) stress = clamp(stress + 5, 0, 100);
    if (agentStateTypes.includes('heartbroken')) stress = clamp(stress + 12, 0, 100);
    if (agentStateTypes.includes('angry')) stress = clamp(stress + 6, 0, 100);

    // Detect sleep transition: schedule daily reflection when agent starts sleeping.
    if (actionType === 'sleeping' && agentNeeds.last_updated < agent.action_started) {
      try {
        taskRunner.triggerReflection(agent.id);
      } catch {
        // Silently ignore if scheduling fails
      }
    }

    // Step 13: Write updated values
    db.update(needs).set({
      hunger: updatedNeeds.hunger,
      energy: updatedNeeds.energy,
      social: updatedNeeds.social,
      comfort: updatedNeeds.comfort,
      fun: updatedNeeds.fun,
      mood,
      stress,
      mood_modifiers: activeMoodModifiers,
      last_updated: currentTime,
    }).where(eq(needs.id, agentNeeds.id)).run();
  }

  emitter.markDirty('agents.all');
}
