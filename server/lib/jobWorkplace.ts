import { jobWorkplaceType } from '../data/jobs';

/**
 * Location TYPE each job works at, for residents the player adds mid-game
 * (`nudge.introduce_agent`). The setup wizard places people by workplace NAME,
 * but a procedural town names its buildings per seed, so a mid-game arrival has
 * to go by type. The old lookup matched the job against type/name substrings
 * ("farm".includes("farmer") is false), so every job but baker fell through to
 * the first non-home location — the town square — as their "workplace".
 * The job → type table is `workplaceType` in data/jobs.ts, shared with the
 * wizard's job list so the two can't disagree about where a job works.
 *
 * The place this job works at, or null (unemployed, retired, or no such building in town).
 */
export function workplaceForJob<T extends { type: string }>(job: string, places: readonly T[]): T | null {
  const type = jobWorkplaceType(job);
  if (!type) return null;
  return places.find((p) => p.type === type) ?? null;
}
