/**
 * Openings: a trade nobody holds any more, and residents who want a different one.
 *
 * Why this exists. One death could take a whole trade with it. The doctor
 * died and nobody treated the sick again; the baker died and there was never
 * bread again; the farmer died and the farm stood idle while the farmhand who
 * had worked it for years kept on as a farmhand. Only the building changed
 * hands (to a friend who never set foot in it). And nobody ever changed jobs,
 * however loudly their ambition said "run my own bakery".
 *
 * The vacancy pass — at each day change (engine/tick.ts) and straight after a
 * death or a departure — looks for essential trades (data/jobs.ts `essential`)
 * whose building stands in town with nobody alive in the job, and fills each:
 *
 *   1. promotion: the trade's apprentice (`promotesTo` — medical assistant →
 *      doctor, farmhand → farmer, shop assistant → shopkeeper) steps up;
 *   2. a hire: the jobless, the retired (not the very old) and musicians,
 *      scored on how their personality suits the work (`fit`) and whether
 *      their ambition names the trade;
 *   3. otherwise the town posts "Help wanted" once and asks the population flow
 *      (lib/populationFlow.ts `setWantedTrades`) for a stranger in that trade.
 * Whoever takes the job runs its workplace (lib/careers.ts `changeJob`).
 *
 * Ambitions: when the goal reviewer gives someone a new ambition (or their
 * first), and it names a trade the town has an opening for — or they have no
 * job at all — they decide to make the move, and a few game hours later they
 * do. The sole holder of an essential trade never walks out of it this way:
 * the town would be left without its baker for someone's dream of farming.
 *
 * Side-effect module: importing it registers the `life:death`,
 * `life:departed` and `goal:ambition_*` listeners (engine/tick.ts imports it).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { agents, agentStates, aspirations, economy, locations } from '../db/schema';
import { ESSENTIAL_JOBS, JOBS, isJobKey, jobDef, type JobKey } from '../data/jobs';
import { JOBLESS, changeJob, jobFit, jobTitleOf, jobsNamedIn } from './careers';
import { getPopulationFlowState, setWantedTrades } from './populationFlow';
import { logActivity } from './activityLogger';
import { memoryService } from './memory/instance';
import { simEvents } from './simEvents';
import { gameMinutesNow } from './worldClock';

export const VACANCIES = {
  /** Game minutes between deciding on an ambition's trade and taking it up (asking around, a word with the owner). */
  AMBITION_DELAY_MINUTES: 180,
  /** A helper trade (farmhand, musician…) has room for this many. */
  HELPER_CAP: 2,
  /** The retired are asked to take a trade only below this age. */
  RETIRED_MAX_AGE: 70,
  /** Nobody this old is hired. */
  MAX_AGE: 78,
  /** Score bonus when the candidate's own ambition names the trade. */
  AMBITION_BONUS: 2,
  /** Score bonus for having no work at all (a wage is welcome) / malus for giving up music. */
  UNEMPLOYED_BONUS: 1,
  MUSICIAN_MALUS: 0.5,
} as const;

// ─── State ───────────────────────────────────────────────────────────────────

interface PendingMove {
  agentId: number;
  job: JobKey;
  /** Game minute they take it up. */
  at: number;
  /** The ambition that named it, re-read when the time comes. */
  ambition: string;
}

const state = {
  /** Trades already posted as "Help wanted" (so the feed says it once). */
  announced: new Set<string>(),
  pending: new Map<number, PendingMove>(),
};

/** World replace (engine/worldCaches.ts): ids and the clock restart. */
export function clearVacancies(): void {
  state.announced.clear();
  state.pending.clear();
}

/** Read-only view for tests and diagnostics. */
export function pendingCareerMoves(): PendingMove[] {
  return [...state.pending.values()].map((p) => ({ ...p }));
}

// ─── Reading the town ────────────────────────────────────────────────────────

interface Person {
  id: number;
  name: string;
  age: number;
  personality: Record<string, number> | null;
  job: string;
  performance: number;
  ambition: string | null;
  /** Jailed or on their way out of town: not asked. */
  unavailable: boolean;
}

interface Town {
  people: Person[];
  locationTypes: Set<string>;
}

function readTown(): Town {
  const living = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const ids = living.map((a) => a.id);
  const econ = ids.length === 0 ? [] : db.select().from(economy).where(inArray(economy.agent_id, ids)).all();
  const econOf = new Map(econ.map((e) => [e.agent_id, e]));
  const ambitions = ids.length === 0 ? [] : db.select({ agent_id: aspirations.agent_id, description: aspirations.description, type: aspirations.type })
    .from(aspirations).where(and(eq(aspirations.status, 'active'), inArray(aspirations.agent_id, ids))).all();
  const ambitionOf = new Map(ambitions.map((a) => [a.agent_id, a.description ?? a.type]));
  const jailed = new Set(ids.length === 0 ? [] : db.select({ agent_id: agentStates.agent_id }).from(agentStates)
    .where(and(eq(agentStates.type, 'arrested'), inArray(agentStates.agent_id, ids))).all().map((s) => s.agent_id));
  const leaving = new Set(getPopulationFlowState().departing.map((d) => d.agentId));
  return {
    people: living.flatMap((a) => {
      const e = econOf.get(a.id);
      if (!e) return [];
      return [{
        id: a.id,
        name: a.name,
        age: a.age,
        personality: a.personality as Record<string, number> | null,
        job: e.job,
        performance: e.work_performance,
        ambition: ambitionOf.get(a.id) ?? null,
        unavailable: jailed.has(a.id) || leaving.has(a.id),
      }];
    }),
    locationTypes: new Set(db.select({ type: locations.type }).from(locations).all().map((l) => l.type)),
  };
}

function hasWorkplace(town: Town, job: string): boolean {
  const type = jobDef(job)?.workplaceType;
  return type != null && town.locationTypes.has(type);
}

function holders(town: Town, job: string): number {
  return town.people.filter((p) => p.job === job).length;
}

/** Essential trades with a building in town and nobody alive in the job, most urgent first. */
function vacanciesIn(town: Town): JobKey[] {
  return ESSENTIAL_JOBS.filter((j) => hasWorkplace(town, j) && holders(town, j) === 0);
}

export function openVacancies(): JobKey[] {
  return vacanciesIn(readTown());
}

/** How much a hire suits the trade (higher is better); null = not a candidate. */
function hireScore(p: Pick<Person, 'job' | 'age' | 'personality' | 'ambition' | 'unavailable'>, job: string): number | null {
  if (p.unavailable || p.age >= VACANCIES.MAX_AGE) return null;
  let base: number;
  if (p.job === 'retired') {
    if (p.age >= VACANCIES.RETIRED_MAX_AGE) return null;
    base = 0;
  } else if (JOBLESS.has(p.job)) {
    base = VACANCIES.UNEMPLOYED_BONUS;
  } else if (p.job === 'musician') {
    base = -VACANCIES.MUSICIAN_MALUS;
  } else {
    return null;
  }
  const named = jobsNamedIn(p.ambition).includes(job as JobKey);
  return base + jobFit(p.personality, job) + (named ? VACANCIES.AMBITION_BONUS : 0);
}

// ─── The pass ────────────────────────────────────────────────────────────────

export interface Hire {
  agentId: number;
  job: JobKey;
  how: 'promotion' | 'hire';
}

/**
 * Fill every open essential trade from within the town, post the rest.
 * `because` words the trade that just fell vacant ("Dr. Petrov has died").
 */
export function fillVacancies(opts: { because?: { job: string; text: string } } = {}): { filled: Hire[]; wanted: JobKey[] } {
  const town = readTown();
  const filled: Hire[] = [];
  const wanted: JobKey[] = [];
  const taken = new Set<number>();

  for (const job of vacanciesIn(town)) {
    const because = opts.because?.job === job ? opts.because.text : undefined;
    const free = town.people.filter((p) => !taken.has(p.id) && !p.unavailable);

    // 1. The apprentice steps up: the best worker first.
    const apprentice = free
      .filter((p) => isJobKey(p.job) && jobDef(p.job)?.promotesTo === job)
      .sort((a, b) => b.performance - a.performance || a.id - b.id)[0];
    if (apprentice && changeJob(apprentice.id, job, 'promotion', { because })) {
      taken.add(apprentice.id);
      apprentice.job = job;
      filled.push({ agentId: apprentice.id, job, how: 'promotion' });
      continue;
    }

    // 2. Someone without a trade (or with only a fiddle) takes it up.
    const hire = free
      .map((p) => ({ p, score: hireScore(p, job) }))
      .filter((c): c is { p: Person; score: number } => c.score != null)
      .sort((a, b) => b.score - a.score || a.p.id - b.p.id)[0];
    if (hire && changeJob(hire.p.id, job, 'vacancy', { because })) {
      taken.add(hire.p.id);
      hire.p.job = job;
      filled.push({ agentId: hire.p.id, job, how: 'hire' });
      continue;
    }

    // 3. Nobody here can: post it, and ask the road for someone.
    wanted.push(job);
    if (!state.announced.has(job)) {
      state.announced.add(job);
      const title = jobTitleOf(job).toLowerCase();
      const hall = db.select({ id: locations.id, name: locations.name }).from(locations)
        .where(eq(locations.type, 'town_hall')).limit(1).get();
      logActivity({
        type: 'drama',
        severity: 0.3,
        ...(hall ? { location: hall.id } : {}),
        templateData: {
          description: `Help wanted: ${because ? `now that ${because}, ` : ''}the town has no ${title}.${hall ? ` A notice goes up at ${hall.name}.` : ''}`,
        },
        metadata: { beat: 'help_wanted' },
      });
    }
  }

  // A trade filled since (by this pass, a newcomer or the player) comes off the board.
  const stillOpen = new Set(vacanciesIn(town));
  for (const job of [...state.announced]) if (!stillOpen.has(job as JobKey)) state.announced.delete(job);
  setWantedTrades(wanted);
  return { filled, wanted };
}

/** At each day change (engine/tick.ts), before the population flow decides on a newcomer. */
export function vacanciesDaily(): void {
  fillVacancies();
}

// ─── Ambitions ───────────────────────────────────────────────────────────────

/**
 * The trade an ambition would take this resident into, or null. An opening
 * is an essential trade nobody holds, or a helper trade under its cap. The
 * jobless also get a foot in the door of a trade that is taken: its
 * apprenticeship (wants to doctor → medical assistant), when there is one
 * with room.
 */
export function careerForAmbition(agentId: number, ambition: string): JobKey | null {
  const town = readTown();
  const me = town.people.find((p) => p.id === agentId);
  if (!me || me.unavailable) return null;
  const named = jobsNamedIn(ambition).filter((j) => j !== me.job && j !== 'retired');
  if (named.length === 0) return null;
  const jobless = JOBLESS.has(me.job) || !isJobKey(me.job);
  // Never leave the town without its only baker (or doctor…) for a dream.
  if (!jobless && jobDef(me.job)?.essential != null && holders(town, me.job) <= 1) return null;
  if (me.job === 'retired' && me.age >= VACANCIES.MAX_AGE) return null;

  for (const job of named) {
    if (!hasWorkplace(town, job)) continue;
    const def = jobDef(job)!;
    const n = holders(town, job);
    if (def.essential != null) {
      if (n === 0) return job;
      if (!jobless) continue;
      const apprenticeship = (Object.keys(JOBS) as JobKey[]).find((j) => jobDef(j)?.promotesTo === job);
      if (apprenticeship && apprenticeship !== me.job && hasWorkplace(town, apprenticeship)
        && holders(town, apprenticeship) < VACANCIES.HELPER_CAP) return apprenticeship;
      continue;
    }
    if (n < VACANCIES.HELPER_CAP) return job;
  }
  return null;
}

/** A new ambition was set: if it names a trade within reach, plan the move. */
export function considerAmbition(agentId: number, ambition: string, nowMinutes: number): JobKey | null {
  if (state.pending.has(agentId)) state.pending.delete(agentId);
  const job = careerForAmbition(agentId, ambition);
  if (!job) return null;
  state.pending.set(agentId, { agentId, job, at: nowMinutes + VACANCIES.AMBITION_DELAY_MINUTES, ambition });
  const title = jobTitleOf(job).toLowerCase();
  memoryService.record(agentId, 'reflection',
    `I've made up my mind: I'm going to work as ${/^[aeiou]/.test(title) ? 'an' : 'a'} ${title}. I'll go and ask about it today.`,
    { subtype: 'career_decision', job }, 0.4, 6);
  return job;
}

/** Every 10 game minutes (engine/tick.ts): the moves whose time has come, if the opening is still there. */
export function careerMovesTick(nowMinutes: number): void {
  if (state.pending.size === 0) return;
  for (const move of [...state.pending.values()]) {
    if (nowMinutes < move.at) continue;
    state.pending.delete(move.agentId);
    // The town may have changed in the meantime (someone else took it, they went to jail).
    if (careerForAmbition(move.agentId, move.ambition) !== move.job) continue;
    changeJob(move.agentId, move.job, 'ambition');
  }
}

// ─── Listeners ───────────────────────────────────────────────────────────────

function onGone(agentId: number, name: string, verb: string): void {
  const job = db.select({ job: economy.job }).from(economy).where(eq(economy.agent_id, agentId)).get()?.job;
  state.pending.delete(agentId);
  fillVacancies(job ? { because: { job, text: `${name} ${verb}` } } : {});
}

let initialized = false;

function initVacancies(): void {
  if (initialized) return;
  initialized = true;
  // Listeners run inside the emitting phase's transaction: never let a
  // failure here take the death (or the goal review) down with it.
  const guard = (what: string, fn: () => void) => {
    try { fn(); } catch (err) { console.warn(`[vacancies] ${what} failed:`, (err as Error).message); }
  };
  simEvents.on('life:death', (p: { agentId: number; name: string }) =>
    guard('death', () => onGone(p.agentId, p.name, 'has died')));
  simEvents.on('life:departed', (p: { agentId: number; name: string; reason: string }) =>
    guard('departure', () => onGone(p.agentId, p.name, p.reason === 'left' ? 'has left town' : 'is gone')));
  simEvents.on('goal:ambition_shifted', (p: { agentId: number; to: string }) =>
    guard('ambition', () => { considerAmbition(p.agentId, p.to, gameMinutesNow()); }));
  simEvents.on('goal:ambition_generated', (p: { agentId: number; description: string }) =>
    guard('ambition', () => { considerAmbition(p.agentId, p.description, gameMinutesNow()); }));
}

// Auto-initialize on import
initVacancies();
