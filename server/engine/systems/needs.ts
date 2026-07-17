import { db } from '../../db';
import { agents, needs, economy, locations, worldState, worldEvents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { clamp } from '../../lib/utils';
import { emitter } from '../emitter';
import { getAgentStates } from '../../lib/states';
import { updateHungerTracking } from '../../lib/lifeEventsEngine';
import { simEvents } from '../../lib/simEvents';
import { sampleMood, getMoodMomentum } from '../../lib/moodMomentum';
import { getHobbyLevel, getMentorshipOpportunity, applyMentorship } from '../../lib/hobbyEngine';

// Track which agents already have an active critical need event to avoid spamming
const criticalNeedFired = new Map<number, Set<string>>();

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
  comfort:     { hunger: 0.8, energy: -0.3, social: -0.5, comfort: -2.5, fun: -0.8 },
};

const DEFAULT_MODIFIERS: Record<NeedKey, number> = {
  hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1,
};

// Zone activities provide better restoration than generic idle
const ZONE_ACTIVITY_MODIFIERS: Record<string, Partial<Record<NeedKey, number>>> = {
  contemplate: { comfort: -1.5, fun: -0.5, energy: -0.3 },
  fish:        { fun: -2.0, comfort: -0.8, hunger: 0.5 },
  garden:      { fun: -1.5, comfort: -1.0 },
  forage:      { fun: -1.0, hunger: -0.5 },
  perform:     { fun: -2.5, social: -1.5 },
  jog:         { comfort: -1.8, energy: 1.5, fun: -0.5 },
  browse:      { fun: -1.8, comfort: -0.3 },
  rest:        { energy: -1.5, comfort: -1.2, fun: -0.3 },
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
  if (weather === 'snowy' && !isIndoors) return -1; // Cold but pretty
  if (weather === 'snowy' && isIndoors) return 2;   // Very cozy by the fire
  if (weather === 'windy' && !isIndoors) return -1;  // Annoying wind
  if (weather === 'hot' && !isIndoors) return -3;     // Oppressive heat
  if (weather === 'hot' && isIndoors) return -1;      // Still hot inside
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

  // Pre-load all locations into a Map to avoid per-agent queries
  const allLocations = db.select().from(locations).all();
  const locationsById = new Map<number, typeof allLocations[0]>();
  for (const loc of allLocations) {
    locationsById.set(loc.id, loc);
  }

  const currentTime =
    world.time!.day * 24 * 60 + world.time!.hour * 60 + world.time!.minute;

  // Load active world events and extract their effects for need modifiers
  const activeEvents = db.select().from(worldEvents).where(eq(worldEvents.is_active, true)).all();
  const eventEffects: Record<string, number> = {};
  for (const event of activeEvents) {
    if (event.effects && typeof event.effects === 'object') {
      for (const [key, value] of Object.entries(event.effects)) {
        if (typeof value === 'number') {
          eventEffects[key] = (eventEffects[key] ?? 0) + value;
        }
      }
    }
  }

  for (const agent of activeAgents) {
    const agentNeeds = needsByAgent.get(agent.id);
    if (!agentNeeds) continue;

    // Step 1-2: Get action type and look up modifiers
    const actionType: string = (agent.current_action as any)?.type ?? 'idle';
    const zoneActivity: string | undefined = (agent.current_action as any)?.zoneActivity;
    const baseModifiers = ACTION_MODIFIERS[actionType] ?? DEFAULT_MODIFIERS;
    // Override with zone activity modifiers if present
    const zoneOverrides = zoneActivity ? ZONE_ACTIVITY_MODIFIERS[zoneActivity] : undefined;
    let modifiers = zoneOverrides ? { ...baseModifiers, ...zoneOverrides } : baseModifiers;

    // Food quality tiers: eating location affects hunger restoration
    if (actionType === 'eating' && agent.current_location) {
      const eatLoc = locationsById.get(agent.current_location);
      if (eatLoc) {
        const locType = eatLoc.type;
        if (locType === 'tavern') {
          // Tavern meals: best quality, also fun
          modifiers = { ...modifiers, hunger: -5.5, fun: -0.8 };
        } else if (locType === 'bakery') {
          // Bakery: good quality, comfort food
          modifiers = { ...modifiers, hunger: -4.8, comfort: -0.5 };
        } else if (locType === 'shop') {
          // Shop/market: decent quality
          modifiers = { ...modifiers, hunger: -4.5 };
        }
        // Home meals: base -4.0 (default), enhanced by cooking skill
      }
    }
    // Home cooking skill bonus
    if (actionType === 'eating' && agent.current_location === agent.home) {
      const cookingSkill = getHobbyLevel(agent.id, 'cook') as number;
      if (cookingSkill > 0) {
        // Skilled cooks make better meals at home
        const skillBonus = Math.min(2.0, cookingSkill * 0.04); // up to -2.0 extra at level 50
        modifiers = { ...modifiers, hunger: (modifiers.hunger ?? -4.0) - skillBonus };
      }
    }

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

      // Sleep quality: stress/drunk/mood affect energy restoration while sleeping
      // Penalties are soft to prevent unrecoverable energy spirals
      if (key === 'energy' && actionType === 'sleeping' && modifiedDecay < 0) {
        // Stressed agents sleep slightly worse
        if (agentNeeds.stress > 60) {
          modifiedDecay *= 0.75; // 25% less restoration
        } else if (agentNeeds.stress > 40) {
          modifiedDecay *= 0.85;
        }
        // Drunk agents pass out — poor but not terrible sleep
        if (agentStateTypes.includes('drunk')) {
          modifiedDecay *= 0.7; // 30% penalty
        }
        // Good mood momentum = better sleep
        const momentum = getMoodMomentum(agent.id);
        if (momentum > 5) {
          modifiedDecay *= 1.2; // well-rested from good mood
        } else if (momentum < -5) {
          modifiedDecay *= 0.8; // restless from bad mood
        }
      }

      // Weather-aware decay modifiers for outdoor agents
      const agentIsOutdoors = agent.current_location === null;
      if (agentIsOutdoors && modifiedDecay > 0) {
        if (world.weather === 'rainy') {
          if (key === 'comfort') modifiedDecay *= 1.8;
          if (key === 'fun') modifiedDecay *= 1.3;
        } else if (world.weather === 'stormy') {
          if (key === 'comfort') modifiedDecay *= 2.5;
          if (key === 'energy') modifiedDecay *= 1.5;
          if (key === 'fun') modifiedDecay *= 1.8;
        } else if (world.weather === 'sunny') {
          if (key === 'energy') modifiedDecay *= 0.8;
          if (key === 'fun') modifiedDecay *= 0.85;
        } else if (world.weather === 'foggy') {
          if (key === 'comfort') modifiedDecay *= 1.3;
        } else if (world.weather === 'snowy') {
          if (key === 'comfort') modifiedDecay *= 2.0;  // cold and wet
          if (key === 'energy') modifiedDecay *= 1.4;   // trudging through snow
          if (key === 'fun') modifiedDecay *= 0.7;      // snow is fun!
        } else if (world.weather === 'windy') {
          if (key === 'comfort') modifiedDecay *= 1.5;  // wind chill
          if (key === 'energy') modifiedDecay *= 1.2;   // fighting the wind
        } else if (world.weather === 'hot') {
          if (key === 'energy') modifiedDecay *= 1.8;   // heat exhaustion
          if (key === 'comfort') modifiedDecay *= 1.6;  // sweating
        }
      }
      // Indoors during bad weather: cozy bonus
      if (!agentIsOutdoors && modifiedDecay > 0) {
        if (['rainy', 'stormy', 'snowy'].includes(world.weather) && key === 'comfort') {
          modifiedDecay *= 0.6; // cozy inside
        }
      }

      // Only amplify decay (positive values) with stress — never amplify restoration
      const finalDecay = modifiedDecay > 0 ? modifiedDecay * stressMultiplier : modifiedDecay;
      updatedNeeds[key] = agentNeeds[key] - finalDecay;
    }

    // Step 7: Apply location service bonuses
    if (agent.current_location) {
      const location = locationsById.get(agent.current_location);
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

    // Step 7b: Performer/spectator fun boost — co-located agents benefit from performances
    if (agent.current_location) {
      const coLocated = activeAgents.filter(
        (other) => other.id !== agent.id && other.current_location === agent.current_location,
      );
      const performerNearby = coLocated.some(
        (other) => (other.current_action as any)?.zoneActivity === 'perform',
      );
      if (performerNearby) {
        updatedNeeds.fun += 1.5 * gameHoursElapsed; // watching a performance is fun
        updatedNeeds.social += 0.5 * gameHoursElapsed;
      }

      // Group activity bonus: 3+ agents at same location creates emergent gathering
      if (coLocated.length >= 2) { // agent + 2 others = 3 total
        const groupSize = coLocated.length + 1;
        const socializingCount = coLocated.filter(
          (other) => {
            const action = (other.current_action as any)?.type;
            return action === 'socializing' || action === 'talking' || action === 'idle';
          },
        ).length;

        // Group synergy: more people socializing = better atmosphere
        if (socializingCount >= 2) {
          const groupBonus = Math.min(3.0, 0.5 * socializingCount); // caps at 3.0
          updatedNeeds.social += groupBonus * gameHoursElapsed;
          updatedNeeds.fun += groupBonus * 0.6 * gameHoursElapsed;

          // Large gatherings (5+) create party atmosphere
          if (groupSize >= 5) {
            updatedNeeds.fun += 1.0 * gameHoursElapsed;
            updatedNeeds.comfort += 0.5 * gameHoursElapsed;
          }
        }
      }

      // Mentorship: experienced agents teaching co-located agents with same zone activity
      if (zoneActivity && coLocated.length > 0) {
        for (const other of coLocated) {
          const otherActivity = (other.current_action as any)?.zoneActivity;
          if (otherActivity !== zoneActivity) continue;
          const mentorHobby = getMentorshipOpportunity(agent.id, other.id);
          if (mentorHobby) {
            // Agent is mentoring — boost social and fun
            updatedNeeds.social += 1.5 * gameHoursElapsed;
            updatedNeeds.fun += 1.0 * gameHoursElapsed;
            applyMentorship(agent.id, other.id, mentorHobby, world.time!.totalTicks);
            break; // Only mentor one agent at a time
          }
        }
      }
    }

    // Step 7c: Apply world event effects to needs
    const isIndoors = agent.current_location !== null;
    if (eventEffects.social_boost) {
      updatedNeeds.social += eventEffects.social_boost * gameHoursElapsed * 0.1;
    }
    if (eventEffects.fun_boost) {
      updatedNeeds.fun += eventEffects.fun_boost * gameHoursElapsed * 0.1;
    }
    if (eventEffects.energy_drain) {
      updatedNeeds.energy -= (eventEffects.energy_drain - 1) * 2 * gameHoursElapsed;
    }
    if (eventEffects.mood_outdoor && !isIndoors) {
      // Applied later as mood modifier; store for mood calc
    }
    // Romance boost from events (weddings, full moon, starry night) → social/fun boost
    if (eventEffects.romance_boost) {
      if (actionType === 'socializing' || actionType === 'talking') {
        updatedNeeds.social += eventEffects.romance_boost * gameHoursElapsed * 0.05;
        updatedNeeds.fun += eventEffects.romance_boost * gameHoursElapsed * 0.03;
      }
    }

    // Step 8: Weather mood effect
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
    // World event mood effects (outdoor penalty from storms, etc.)
    const eventMoodEffect = (!isIndoors && eventEffects.mood_outdoor) ? eventEffects.mood_outdoor : 0;

    // Mood momentum: yesterday's average mood affects today's baseline
    const moodMomentum = getMoodMomentum(agent.id);

    let baseMood =
      updatedNeeds.hunger * 0.2 +
      updatedNeeds.energy * 0.2 +
      updatedNeeds.social * 0.25 +
      updatedNeeds.comfort * 0.15 +
      updatedNeeds.fun * 0.2 +
      moodModifierSum +
      weatherModifier +
      eventMoodEffect +
      moodMomentum;

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


    // Step 12.4: Emit critical need events (once per threshold crossing, not every tick)
    const agentCritical = criticalNeedFired.get(agent.id) ?? new Set<string>();
    const CRITICAL_THRESHOLD = 15;
    const needActionMap: Record<string, string> = {
      hunger: 'eat',
      energy: 'sleep',
      social: 'socialize',
    };
    for (const [needKey, action] of Object.entries(needActionMap)) {
      const value = updatedNeeds[needKey as NeedKey];
      if (value <= CRITICAL_THRESHOLD && !agentCritical.has(needKey)) {
        simEvents.emit('need:critical', { agentId: agent.id, action });
        agentCritical.add(needKey);
      } else if (value > CRITICAL_THRESHOLD + 10) {
        agentCritical.delete(needKey); // Reset so it can fire again if need drops again
      }
    }
    criticalNeedFired.set(agent.id, agentCritical);

    // Step 12.5: Track hunger-at-zero for death mechanic
    updateHungerTracking(agent.id, updatedNeeds.hunger);

    // Step 12.6: Sample mood for momentum tracking (once per game hour)
    if (world.time!.minute === 0) {
      sampleMood(agent.id, mood);
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
