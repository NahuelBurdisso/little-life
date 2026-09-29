/**
 * The job table: the ONE place a job's daily wage, generic title and workplace live (E9).
 *
 * Wages used to be typed three times — on each seed in data/agents.ts, on each wizard default in
 * src/components/setup/defaults.ts and in the wizard's JOB_OPTIONS — plus a flat `salary: 20` for
 * mid-game arrivals (routers/nudge.ts) and a job → building-type map in lib/jobWorkplace.ts. Raising
 * the wage floor (E5) meant editing all of them and they drifted. Every one of those now derives
 * from `JOBS`.
 *
 * Pure data, no Node/DB imports: the setup wizard imports it directly.
 *
 * Wages (daily, paid by the town treasury or, for shop staff, the owner): floor $20 = three meals
 * at the $5-6 menus plus the $4 base upkeep (a musician on $14 lived on the pantry). Top $28: the
 * lifestyle upkeep returns what the best paid don't spend (townTreasury.ts).
 */

/** Lowest daily wage; `CONFIG.ECONOMY.WAGE_FLOOR` is this value and the one-time wage migration raises old saves to it. */
export const WAGE_FLOOR = 20;

export interface JobDef {
  /** Generic title, for the wizard's job dropdown (each seed keeps its own flavoured `jobTitle`). */
  title: string;
  /** Daily wage. */
  salary: number;
  /** Where the default town places this job, by name (the wizard and seed towns); null = no workplace. */
  workplace: string | null;
  /**
   * Location TYPE the job works at, for arrivals in a procedural town whose buildings are named
   * per seed (lib/jobWorkplace.ts); null = no fixed workplace.
   */
  workplaceType: string | null;
}

export const JOBS = {
  farmer:            { title: 'Farmer',            salary: 24, workplace: 'Green Acres Farm',    workplaceType: 'farm' },
  farmhand:          { title: 'Farmhand',          salary: 20, workplace: 'Green Acres Farm',    workplaceType: 'farm' },
  baker:             { title: 'Baker',             salary: 22, workplace: "Priya's Bakery",      workplaceType: 'bakery' },
  bartender:         { title: 'Bartender',         salary: 22, workplace: 'The Rusty Lantern',   workplaceType: 'tavern' },
  shopkeeper:        { title: 'Shopkeeper',        salary: 24, workplace: "Rosa's General Store", workplaceType: 'shop' },
  shop_assistant:    { title: 'Shop Assistant',    salary: 20, workplace: "Rosa's General Store", workplaceType: 'shop' },
  doctor:            { title: 'Doctor',            salary: 28, workplace: "Dr. Petrov's Clinic", workplaceType: 'clinic' },
  medical_assistant: { title: 'Medical Assistant', salary: 21, workplace: "Dr. Petrov's Clinic", workplaceType: 'clinic' },
  mayor:             { title: 'Mayor',             salary: 26, workplace: 'Town Hall',           workplaceType: 'town_hall' },
  handyperson:       { title: 'Handyperson',       salary: 20, workplace: "Carlos' Workshop",    workplaceType: 'workshop' },
  musician:          { title: 'Musician',          salary: 20, workplace: 'The Rusty Lantern',   workplaceType: 'tavern' },
  constable:         { title: 'Constable',         salary: 24, workplace: 'Town Jail',           workplaceType: 'prison' },
  retired:           { title: 'Retired',           salary: 20, workplace: null,                  workplaceType: null },
} as const satisfies Record<string, JobDef>;

export type JobKey = keyof typeof JOBS;

function jobDef(job: string): JobDef | undefined {
  const key = job.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(JOBS, key) ? JOBS[key as JobKey] : undefined;
}

/** A job's daily wage; an unknown job (a free-text one from a mid-game arrival) earns the floor. */
export function jobSalary(job: string): number {
  return jobDef(job)?.salary ?? WAGE_FLOOR;
}

/** The building type a job works at, or null (unknown, retired, or no fixed workplace). */
export function jobWorkplaceType(job: string): string | null {
  return jobDef(job)?.workplaceType ?? null;
}

/** The wizard's job dropdown, in table order. */
export const JOB_OPTIONS: ReadonlyArray<{ job: JobKey; title: string; salary: number; workplace: string | null }> =
  (Object.keys(JOBS) as JobKey[]).map((job) => ({
    job,
    title: JOBS[job].title,
    salary: JOBS[job].salary,
    workplace: JOBS[job].workplace,
  }));
