/**
 * The stored half of lib/selfFacts.ts: reads a resident's tenure from the
 * agent row, deriving and saving it the first time (old saves and worldgen
 * casts have none), and assembles the "Facts about you" prompt line with the
 * household from the relationships table.
 *
 * Derived from the bio plus the seeded backstory memories (created at or
 * before tick 0) — that is where "mayor for twelve years" or "came to Little
 * Life ... two years ago" is written, and the numbers must agree with it.
 */

import { and, eq, lte, or } from 'drizzle-orm';
import { db } from '../db';
import { agents, economy, memories, relationships } from '../db/schema';
import { deriveTenure, isWidowed, selfFactsLine, type Tenure } from '../lib/selfFacts';
import { isNewcomer } from '../lib/newcomers';
import { addressName } from '../ai/names';

type AgentRow = typeof agents.$inferSelect;

/** Tenure for `agent`, filling any missing column once. */
export function getTenure(agent: AgentRow, nowTick: number): Tenure {
  const job = db.select({ job: economy.job }).from(economy).where(eq(economy.agent_id, agent.id)).get()?.job ?? null;
  if (agent.years_in_town != null && (agent.job_years != null || !job || /^(?:retired|unemployed)$/.test(job))) {
    return { yearsInTown: agent.years_in_town, jobYears: agent.job_years ?? null };
  }
  const backstory = db.select({ d: memories.description }).from(memories)
    .where(and(eq(memories.agent_id, agent.id), lte(memories.created_at, 0))).all()
    .map((m) => m.d);
  const derived = deriveTenure({
    name: agent.name,
    age: agent.age,
    bio: [agent.bio, ...backstory].join(' '),
    job,
    newcomer: isNewcomer(agent.created_at, nowTick),
  });
  const tenure: Tenure = {
    yearsInTown: agent.years_in_town ?? derived.yearsInTown,
    jobYears: agent.job_years ?? derived.jobYears,
  };
  db.update(agents)
    .set({ years_in_town: tenure.yearsInTown, job_years: tenure.jobYears })
    .where(eq(agents.id, agent.id)).run();
  return tenure;
}

/** "married to Rosa" / "engaged to Diego" / "courting Yuki", or null. */
function householdOf(agentId: number): string | null {
  const rows = db.select().from(relationships)
    .where(or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId))).all();
  const ranked: Array<[string, string]> = [['married', 'married to'], ['engaged', 'engaged to'], ['partner', 'courting']];
  for (const [tag, phrase] of ranked) {
    for (const r of rows) {
      if (!(r.tags as string[]).includes(tag)) continue;
      const otherId = r.agent_a === agentId ? r.agent_b : r.agent_a;
      const other = db.select({ name: agents.name, active: agents.is_active }).from(agents).where(eq(agents.id, otherId)).get();
      if (other?.active) return `${phrase} ${addressName(other.name)}`;
    }
  }
  return null;
}

/** The "Facts about you" line for the dialogue system prompt. */
export function selfFactsFor(agent: AgentRow, jobTitle: string | null, nowTick: number): string {
  const tenure = getTenure(agent, nowTick);
  return selfFactsLine({
    jobTitle,
    tenure,
    age: agent.age,
    household: householdOf(agent.id),
    widowed: isWidowed(agent.bio),
  });
}
