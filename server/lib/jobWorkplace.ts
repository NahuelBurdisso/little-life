/**
 * Location TYPE each job works at, for residents the player adds mid-game
 * (`nudge.introduce_agent`). The setup wizard places people by workplace NAME,
 * but a procedural town names its buildings per seed, so a mid-game arrival has
 * to go by type. The old lookup matched the job against type/name substrings
 * ("farm".includes("farmer") is false), so every job but baker fell through to
 * the first non-home location — the town square — as their "workplace".
 * Same jobs and places as `JOB_OPTIONS` in src/components/setup/types.ts.
 */
const JOB_WORKPLACE_TYPE: Record<string, string> = {
  farmer: 'farm',
  farmhand: 'farm',
  baker: 'bakery',
  bartender: 'tavern',
  musician: 'tavern',
  shopkeeper: 'shop',
  shop_assistant: 'shop',
  doctor: 'clinic',
  medical_assistant: 'clinic',
  mayor: 'town_hall',
  handyperson: 'workshop',
  constable: 'prison',
};

/** The place this job works at, or null (unemployed, retired, or no such building in town). */
export function workplaceForJob<T extends { type: string }>(job: string, places: readonly T[]): T | null {
  const type = JOB_WORKPLACE_TYPE[job.trim().toLowerCase()];
  if (!type) return null;
  return places.find((p) => p.type === type) ?? null;
}
