import { db } from '../db';
import { agents, needs, economy, agentStates, locations } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { getEffectivePersonality, stateClockNow } from './states';
import { adjustReputation } from './reputationEngine';

// ─── Tavern Engine ────────────────────────────────────────────────────────────
// Tracks drink count per agent when at tavern. More drinks = more social,
// worse impulse control, escalating behavior. Links to alcoholic state.

interface DrinkState {
  drinks: number;
  lastDrinkTick: number;
  sessionStart: number;
}

const drinkTracker = new Map<number, DrinkState>();

/** Drop per-agent drink state for a world replace (agent ids and ticks both reset). */
export function clearTavernTracking(): void {
  drinkTracker.clear();
}

/** Called each tick for agents at tavern doing socializing/idle. */
export function tavernTick(totalTicks: number): void {
  const allAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const allLocations = db.select().from(locations).all();
  const tavernIds = new Set(allLocations.filter(l => l.type === 'tavern').map(l => l.id));

  for (const agent of allAgents) {
    if (!agent.current_location || !tavernIds.has(agent.current_location)) {
      // Agent left tavern — process sober-up
      const state = drinkTracker.get(agent.id);
      if (state && state.drinks > 0) {
        // Gradual sober up: lose 1 drink per 60 ticks (~1 game hour)
        if (totalTicks - state.lastDrinkTick > 60) {
          state.drinks = Math.max(0, state.drinks - 1);
          state.lastDrinkTick = totalTicks;
          if (state.drinks === 0) {
            drinkTracker.delete(agent.id);
          }
        }
      }
      continue;
    }

    const action = (agent.current_action as any)?.type;
    if (action !== 'socializing' && action !== 'idle' && action !== 'talking') continue;

    const personality = getEffectivePersonality(agent.id);
    if (!personality) continue;

    let state = drinkTracker.get(agent.id);
    if (!state) {
      state = { drinks: 0, lastDrinkTick: totalTicks, sessionStart: totalTicks };
      drinkTracker.set(agent.id, state);
    }

    // Drink probability: every ~30 ticks (~30 game minutes) at tavern
    if (totalTicks - state.lastDrinkTick < 30) continue;
    state.lastDrinkTick = totalTicks;

    // Drinking probability based on personality
    let drinkChance = 0.3; // base 30%
    drinkChance += (personality.impulsiveness - 50) * 0.005; // impulsive = drinks more
    drinkChance += (personality.sensuality - 50) * 0.003;    // sensual = enjoys drinks
    if (personality.morality > 70) drinkChance *= 0.5;        // moral = drinks less

    // Already drunk? Higher chance of another
    if (state.drinks >= 2) drinkChance += 0.1;

    // Check money
    const econ = db.select().from(economy).where(eq(economy.agent_id, agent.id)).get();
    if (!econ || econ.money < 3) continue; // can't afford a drink

    if (Math.random() > drinkChance) continue;

    // Buy a drink
    state.drinks++;
    db.update(economy).set({ money: econ.money - 2 }).where(eq(economy.id, econ.id)).run();

    // Apply drink effects to needs
    const agentNeeds = db.select().from(needs).where(eq(needs.agent_id, agent.id)).get();
    if (agentNeeds) {
      const socialBoost = Math.min(8, 3 + state.drinks);
      const funBoost = Math.min(6, 2 + state.drinks * 0.5);
      db.update(needs).set({
        social: Math.min(100, agentNeeds.social + socialBoost),
        fun: Math.min(100, agentNeeds.fun + funBoost),
        energy: Math.max(0, agentNeeds.energy - 2),
      }).where(eq(needs.agent_id, agent.id)).run();
    }

    // Escalating behavior based on drink count
    if (state.drinks === 3) {
      logActivity({
        type: 'drama',
        initiator: agent.id,
        templateData: { description: `${agent.name} is getting tipsy at the tavern` },
      });
    }

    if (state.drinks === 5) {
      // Check for drunk state
      const hasDrunkState = db.select().from(agentStates)
        .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, 'drunk')))
        .get();
      if (!hasDrunkState) {
        db.insert(agentStates).values({
          agent_id: agent.id,
          type: 'drunk',
          severity: 0.6,
          // agentStates.started_at is in game minutes: states.ts expires with
          // `started_at + duration <= nowMinutes`.
          started_at: stateClockNow(),
          duration: 720, // ~12 game hours
          source: 'tavern_drinking',
          metadata: { drinks: state.drinks },
        }).run();
        logActivity({
          type: 'drama',
          initiator: agent.id,
          templateData: { description: `${agent.name} is now drunk at the tavern!` },
        });
      }
    }

    if (state.drinks >= 7 && Math.random() < 0.3) {
      // Drunk outburst: random embarrassing behavior
      const outbursts = [
        `${agent.name} is loudly singing off-key at the tavern`,
        `${agent.name} is telling embarrassing stories to everyone at the tavern`,
        `${agent.name} tried to arm-wrestle and fell off their chair`,
        `${agent.name} is crying into their drink at the tavern`,
        `${agent.name} is making a drunken speech about life`,
      ];
      logActivity({
        type: 'drama',
        initiator: agent.id,
        templateData: { description: outbursts[Math.floor(Math.random() * outbursts.length)] },
      });
      adjustReputation(agent.id, -2);
    }
  }
}

/** Get current drink count for an agent. */
export function getDrinkCount(agentId: number): number {
  return drinkTracker.get(agentId)?.drinks ?? 0;
}
