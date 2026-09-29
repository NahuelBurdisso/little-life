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
  /**
   * A trade the town can't do without, ranked by how much its absence hurts (1 = most): nobody to
   * treat the sick, bake, grow food, sell it, pour a drink, keep the peace, run the town. A town
   * with a building for it and nobody alive in the job posts a vacancy (lib/vacancies.ts), and the
   * population flow sends a stranger in that trade first (lib/populationFlow.ts `pickArrivalJob`).
   */
  essential?: number;
  /** Whoever holds this job RUNS its workplace (`locations.owner`: the till, the recipe, the staff's wages). */
  runsPlace?: boolean;
  /** The job this one is apprenticed to: its holder is first in line when that job falls vacant. */
  promotesTo?: string;
  /**
   * Word starts an ambition names the trade by ("become the town's baker", "open a bakery"),
   * matched by lib/careers.ts `jobsNamedIn`. Picked so the common false friends don't hit:
   * no 'sing' (single), 'pub' (public), 'heal' (health), 'smith' (a surname).
   */
  keywords?: readonly string[];
  /**
   * Personality leanings that suit the work, axis → +1 (high suits) or -1 (low suits). Who fills
   * a vacancy from the jobless is scored on them (lib/vacancies.ts). Axis names are
   * PersonalityProfile's (lib/personality.ts), plain strings to keep this file import-free.
   */
  fit?: Readonly<Record<string, 1 | -1>>;
}

export const JOBS = {
  farmer:            { title: 'Farmer',            salary: 24, workplace: 'Green Acres Farm',    workplaceType: 'farm',
    essential: 3, runsPlace: true, keywords: ['farm', 'crop', 'harvest', 'plough', 'livestock', 'orchard'], fit: { neuroticism: -1, loyalty: 1 } },
  farmhand:          { title: 'Farmhand',          salary: 20, workplace: 'Green Acres Farm',    workplaceType: 'farm',
    promotesTo: 'farmer', keywords: ['farmhand', 'farm hand'], fit: { loyalty: 1 } },
  baker:             { title: 'Baker',             salary: 22, workplace: "Priya's Bakery",      workplaceType: 'bakery',
    essential: 2, runsPlace: true, keywords: ['bake', 'baking', 'bread', 'pastr'], fit: { warmth: 1, impulsiveness: -1 } },
  bartender:         { title: 'Bartender',         salary: 22, workplace: 'The Rusty Lantern',   workplaceType: 'tavern',
    essential: 5, runsPlace: true, keywords: ['tavern', 'bartend', 'barkeep', 'innkeep', 'publican', 'saloon'], fit: { warmth: 1, impulsiveness: 1 } },
  shopkeeper:        { title: 'Shopkeeper',        salary: 24, workplace: "Rosa's General Store", workplaceType: 'shop',
    essential: 4, runsPlace: true, keywords: ['shopkeep', 'store', 'merchant', 'trader', 'grocer', 'own a shop', 'run the shop'], fit: { honesty: 1, vanity: 1 } },
  shop_assistant:    { title: 'Shop Assistant',    salary: 20, workplace: "Rosa's General Store", workplaceType: 'shop',
    promotesTo: 'shopkeeper', keywords: ['shop assistant', 'clerk'], fit: { warmth: 1 } },
  doctor:            { title: 'Doctor',            salary: 28, workplace: "Dr. Petrov's Clinic", workplaceType: 'clinic',
    essential: 1, runsPlace: true, keywords: ['doctor', 'physician', 'medic', 'healer', 'healing', 'surgeon', 'clinic'], fit: { curiosity: 1, morality: 1, warmth: 1 } },
  medical_assistant: { title: 'Medical Assistant', salary: 21, workplace: "Dr. Petrov's Clinic", workplaceType: 'clinic',
    promotesTo: 'doctor', keywords: ['nurse', 'nursing', 'medical assistant'], fit: { warmth: 1, morality: 1 } },
  mayor:             { title: 'Mayor',             salary: 26, workplace: 'Town Hall',           workplaceType: 'town_hall',
    essential: 7, runsPlace: true, keywords: ['mayor', 'town hall', 'politic', 'govern', 'lead the town', 'run the town'], fit: { vanity: 1, warmth: 1 } },
  handyperson:       { title: 'Handyperson',       salary: 20, workplace: "Carlos' Workshop",    workplaceType: 'workshop',
    runsPlace: true, keywords: ['carpent', 'craftsm', 'workshop', 'repair', 'blacksmith', 'handy'], fit: { curiosity: 1 } },
  musician:          { title: 'Musician',          salary: 20, workplace: 'The Rusty Lantern',   workplaceType: 'tavern',
    keywords: ['music', 'song', 'singer', 'singing', 'perform', 'fiddl', 'lute', 'compose'], fit: { sensuality: 1, impulsiveness: 1 } },
  constable:         { title: 'Constable',         salary: 24, workplace: 'Town Jail',           workplaceType: 'prison',
    essential: 6, runsPlace: true, keywords: ['constable', 'lawman', 'police', 'sheriff', 'keep the peace', 'law and order'], fit: { morality: 1, aggression: 1 } },
  retired:           { title: 'Retired',           salary: 20, workplace: null,                  workplaceType: null },
} as const satisfies Record<string, JobDef>;

export type JobKey = keyof typeof JOBS;

/** Whether this is a job of the table (not free text such as 'unemployed'). */
export function isJobKey(job: string): job is JobKey {
  return Object.prototype.hasOwnProperty.call(JOBS, job);
}

/** Essential trades, most urgent first (see `JobDef.essential`). */
export const ESSENTIAL_JOBS: readonly JobKey[] = (Object.keys(JOBS) as JobKey[])
  .filter((j) => (JOBS[j] as JobDef).essential != null)
  .sort((a, b) => ((JOBS[a] as JobDef).essential ?? 0) - ((JOBS[b] as JobDef).essential ?? 0));

export function jobDef(job: string): JobDef | undefined {
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
