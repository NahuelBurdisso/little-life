import { db } from '../db';
import { agents, needs } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { CONFIG } from './constants';

// ─── Aging & Birthday Engine ──────────────────────────────────────────────────
// Agents age as years pass (1 year = 4 seasons of CONFIG.TIME.SEASON_LENGTH_DAYS).
// Each agent has a birth day-of-year. When that day arrives, they celebrate.
// Aging slightly increases energy decay rate (older = tires faster).

// Derived from the season length tick.ts uses, so a year always spans exactly
// one spring-to-winter cycle (112 days at the default 28-day seasons).
const DAYS_PER_YEAR = CONFIG.TIME.SEASON_LENGTH_DAYS * 4;

// Track birth day per agent (assigned on first encounter, based on initial age)
const birthDays = new Map<number, number>(); // agentId → day-of-year (0-111)
const lastBirthdayYear = new Map<number, number>(); // prevent double celebration

/**
 * Drop per-agent birthday tracking for a world replace. Birth days are derived
 * from the agent's name, so a reused id would otherwise keep a stranger's date.
 */
export function clearAgingTracking(): void {
  birthDays.clear();
  lastBirthdayYear.clear();
}

/** Initialize birth days for all agents. Call once on startup. */
export function initBirthdays(): void {
  const allAgents = db.select().from(agents).all();
  for (const agent of allAgents) {
    if (!birthDays.has(agent.id)) {
      // Deterministic birth day based on agent ID and name
      const hash = agent.name.split('').reduce((acc, c) => acc + c.charCodeAt(0), agent.id * 17);
      birthDays.set(agent.id, hash % DAYS_PER_YEAR);
    }
  }
}

/** Called on day change. Checks for birthdays and handles aging. */
export function agingTick(currentDay: number): void {
  const dayOfYear = currentDay % DAYS_PER_YEAR;
  const currentYear = Math.floor(currentDay / DAYS_PER_YEAR);

  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();

  for (const agent of activeAgents) {
    let birthDay = birthDays.get(agent.id);
    if (birthDay === undefined) {
      const hash = agent.name.split('').reduce((acc, c) => acc + c.charCodeAt(0), agent.id * 17);
      birthDay = hash % DAYS_PER_YEAR;
      birthDays.set(agent.id, birthDay);
    }

    // Check if today is birthday
    if (dayOfYear === birthDay) {
      const lastYear = lastBirthdayYear.get(agent.id);
      if (lastYear === currentYear) continue; // already celebrated this year
      lastBirthdayYear.set(agent.id, currentYear);

      // Age up
      const newAge = agent.age + 1;
      db.update(agents).set({ age: newAge }).where(eq(agents.id, agent.id)).run();

      // Birthday mood boost
      const agentNeeds = db.select().from(needs).where(eq(needs.agent_id, agent.id)).get();
      if (agentNeeds) {
        db.update(needs).set({
          mood: Math.min(100, agentNeeds.mood + 15),
          fun: Math.min(100, agentNeeds.fun + 20),
          social: Math.min(100, agentNeeds.social + 10),
        }).where(eq(needs.agent_id, agent.id)).run();
      }

      logActivity({
        type: 'drama',
        initiator: agent.id,
        templateData: {
          description: `Happy birthday to ${agent.name}! They turned ${newAge} today!`,
        },
      });

      simEvents.emit('agent:birthday', { agentId: agent.id, age: newAge });

      // Co-located agents get a small fun/social boost (celebration)
      const coLocated = activeAgents.filter(
        a => a.id !== agent.id && a.current_location !== null && a.current_location === agent.current_location
      );
      for (const other of coLocated) {
        const otherNeeds = db.select().from(needs).where(eq(needs.agent_id, other.id)).get();
        if (otherNeeds) {
          db.update(needs).set({
            fun: Math.min(100, otherNeeds.fun + 8),
            social: Math.min(100, otherNeeds.social + 5),
          }).where(eq(needs.agent_id, other.id)).run();
        }
      }

      // Aging effect: slightly increase energy decay rate for older agents.
      // The stored rate already carries every previous birthday's increase, so
      // the multiplier is the single year's 0.5% — scaling by the full
      // `(age - 40) * 0.005` here would compound it (a 50-year-old would tire
      // 28% faster instead of the intended 5%).
      if (newAge > 40 && agentNeeds) {
        const currentRates = agentNeeds.decay_rates;
        const ageMultiplier = 1.005; // 0.5% per year over 40, applied once per birthday
        const newRates = {
          ...currentRates,
          energy: currentRates.energy * ageMultiplier,
        };
        db.update(needs).set({ decay_rates: newRates }).where(eq(needs.agent_id, agent.id)).run();
      }
    }
  }
}
