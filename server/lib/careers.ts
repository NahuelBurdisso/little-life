/**
 * Careers: the one way a resident's job changes.
 *
 * Why this exists. A job was fixed for life: set at world build or arrival,
 * never touched again. When the doctor died, nobody ever treated the sick; a
 * dead baker meant no bread for the rest of the game; and an ambition to "open
 * my own bakery" was free text the goal reviewer wrote and nothing read. The
 * vacancy pass (lib/vacancies.ts) and ambition-driven moves now change jobs,
 * and a job is spread over several rows that must move together:
 *
 *   - `economy.job` / `job_title` / `salary` (the wage from data/jobs.ts);
 *   - `agents.workplace` (lib/jobWorkplace.ts: the building of that type);
 *   - `agents.schedule` hours — a baker rises at 5, a bartender works 15–23 —
 *     keeping the resident's own free-time preferences;
 *   - `locations.owner` of the new workplace, when the job runs the place and
 *     nobody working there runs it now (`takesOverWorkplace`);
 *   - today's plan, which was built around the old shift (a dramatic
 *     `plan:evaluate-replan`).
 *
 * The story side is here too because every caller wants the same three things:
 * a memory for the resident, a feed line (beat `new_job`) and `life:job_changed`
 * for listeners (director, sound, the vacancy pass itself).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { agents, economy, locations } from '../db/schema';
import { JOBS, jobDef, jobSalary, type JobKey } from '../data/jobs';
import { workplaceForJob } from './jobWorkplace';
import { scheduleFor } from './newResident';
import { memoryService } from './memory/instance';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { emitter } from '../engine/emitter';

/** Jobs that mean "no job": free to take one up. */
export const JOBLESS = new Set(['unemployed', 'retired', '']);

/** Jobs that treat the sick (engine/systems/states/effects.ts). */
export const HEALER_JOBS: readonly string[] = ['doctor', 'medical_assistant'];

/**
 * Whether anyone alive in town can treat the sick. With nobody, the sick rest
 * at home instead of waiting at an empty clinic (engine/systems/decisions/schedule.ts), and recover
 * there slowly (states/effects.ts `HOME_REST_RECOVERY`).
 */
export function healerInTown(): boolean {
  return db.select({ id: agents.id }).from(agents)
    .innerJoin(economy, eq(economy.agent_id, agents.id))
    .where(and(eq(agents.is_active, true), inArray(economy.job, [...HEALER_JOBS])))
    .limit(1).get() != null;
}

/**
 * Why a job changed. `election`: the mayor's chair changing hands at the
 * season's vote (lib/townCalendar.ts) — the winner in, the ousted mayor out.
 */
export type CareerReason = 'promotion' | 'vacancy' | 'ambition' | 'player' | 'election';

export interface JobChange {
  agentId: number;
  name: string;
  from: string;
  to: string;
  title: string;
  workplaceId: number | null;
  /** The place they now run, when they took it over. */
  tookOver: string | null;
}

/** The job's title for people: the table's title, or the key made readable. */
export function jobTitleOf(job: string): string {
  const def = jobDef(job);
  if (def) return def.title;
  if (!job || job === 'unemployed') return 'Unemployed';
  return job.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/**
 * Whether someone taking up `job` at `place` becomes the one who runs it:
 * the job runs its workplace (data/jobs.ts `runsPlace`) and nobody alive runs
 * it as that trade from there — no owner, a dead or departed one, or an heir
 * who inherited it but works elsewhere (a widow keeps her husband's savings;
 * the bakery goes to whoever bakes). Two bakers: the first keeps it.
 */
export function takesOverWorkplace(job: string, place: { id: number; owner: number | null }, agentId?: number): boolean {
  if (!jobDef(job)?.runsPlace) return false;
  if (place.owner == null) return true;
  if (place.owner === agentId) return false;
  const owner = db.select({ is_active: agents.is_active, workplace: agents.workplace }).from(agents)
    .where(eq(agents.id, place.owner)).get();
  if (!owner?.is_active || owner.workplace !== place.id) return true;
  const ownerJob = db.select({ job: economy.job }).from(economy).where(eq(economy.agent_id, place.owner)).get()?.job;
  return ownerJob !== job;
}

/**
 * Put a resident in a new job. Null when nothing changed (not a living
 * resident, no economy row, already in that job). `because` is a short third-
 * person clause for the feed and memory ("Dr. Petrov died").
 */
export function changeJob(
  agentId: number,
  rawJob: string,
  reason: CareerReason,
  opts: { because?: string } = {},
): JobChange | null {
  const job = rawJob.trim().toLowerCase() || 'unemployed';
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent || !agent.is_active) return null;
  const econ = db.select().from(economy).where(eq(economy.agent_id, agentId)).get();
  if (!econ || econ.job === job) return null;

  const allLocations = db.select().from(locations).all();
  const workplace = workplaceForJob(job, allLocations);
  const title = jobTitleOf(job);
  const oldTitle = econ.job_title || jobTitleOf(econ.job);
  const hours = scheduleFor(job);
  const oldSchedule = (agent.schedule ?? {}) as { freeTimePreferences?: string[] };
  const takeOver = workplace != null && takesOverWorkplace(job, workplace, agentId);

  db.transaction(() => {
    db.update(economy).set({ job, job_title: title, salary: jobSalary(job) })
      .where(eq(economy.agent_id, agentId)).run();
    db.update(agents).set({
      workplace: workplace?.id ?? null,
      // A new trade starts its own count ("Facts about you", lib/selfFacts.ts).
      job_years: 0,
      schedule: {
        wakeTime: hours.wakeTime,
        sleepTime: hours.sleepTime,
        workStart: hours.workStart,
        workEnd: hours.workEnd,
        lunchTime: hours.lunchTime,
        freeTimePreferences: oldSchedule.freeTimePreferences ?? [],
      },
    }).where(eq(agents.id, agentId)).run();
    if (takeOver && workplace) {
      db.update(locations).set({ owner: agentId }).where(eq(locations.id, workplace.id)).run();
    }
  });

  // The day was planned around the old shift.
  simEvents.emit('plan:evaluate-replan', {
    agentId,
    type: 'state',
    description: job === 'unemployed' || job === 'retired' ? `stopped working as ${article(oldTitle)} ${oldTitle.toLowerCase()}` : `just became ${article(title)} ${title.toLowerCase()}`,
    sentiment: 0.4,
    isDramatic: true,
  });

  const lower = title.toLowerCase();
  const essential = jobDef(job)?.essential != null;
  const role = essential ? `the town's new ${lower}` : `${article(lower)} ${lower}${workplace ? ` at ${workplace.name}` : ''}`;
  const because = opts.because ? ` now that ${opts.because}` : '';
  const takeLine = takeOver && workplace ? ` and takes over running ${workplace.name}` : '';
  // Losing an election leaves the old mayor with no trade at all; "X is an
  // unemployed" is not a sentence, and the town hears it as a fall.
  const ousted = reason === 'election' && JOBLESS.has(job);
  const feed = ousted
    ? `${agent.name} has cleared out the mayor's office${because}.`
    : reason === 'promotion'
      ? `${agent.name} has stepped up from ${oldTitle.toLowerCase()} to ${role}${because}${takeLine}.`
      : reason === 'ambition'
        ? `${agent.name} has followed a long-held wish and become ${role}${takeLine}.`
        : `${agent.name} is ${role}${because}${takeLine}.`;

  const memory = ousted
    ? `I'm not the mayor any more${because}. The office I ran is somebody else's now.`
    : reason === 'election'
      ? `The town chose me: I'm ${role} now${because}. I have promises to keep.`
      : reason === 'promotion'
        ? `I've stepped up: I'm ${role} now${because}. It's more responsibility than I've ever had.`
        : reason === 'ambition'
          ? `I did it — I'm ${role} now. It's what I've wanted, and I mean to be good at it.`
          : `I've taken up work as ${article(lower)} ${lower}${because}. A new start${workplace ? ` at ${workplace.name}` : ''}.`;
  memoryService.record(agentId, 'observation', memory, { subtype: 'new_job', from: econ.job, to: job }, 0.5, 7);

  logActivity({
    type: 'drama',
    initiator: agentId,
    ...(workplace ? { location: workplace.id } : {}),
    templateData: { description: feed },
    metadata: { beat: 'new_job' },
  });

  const change: JobChange = {
    agentId, name: agent.name, from: econ.job, to: job, title,
    workplaceId: workplace?.id ?? null,
    tookOver: takeOver && workplace ? workplace.name : null,
  };
  simEvents.emit('life:job_changed', { ...change, reason });
  emitter.markDirty('agents.all');
  return change;
}

// ─── Reading ambitions ───────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Word-start matchers per job, from data/jobs.ts `keywords`. */
const KEYWORD_RES: ReadonlyArray<{ job: JobKey; re: RegExp }> = (Object.keys(JOBS) as JobKey[])
  .flatMap((job) => {
    const words = jobDef(job)?.keywords ?? [];
    return words.length === 0 ? [] : [{ job, re: new RegExp(`\\b(?:${words.map(escapeRe).join('|')})`, 'i') }];
  });

/**
 * Jobs an ambition names, in the order they appear in the text ("leave the
 * farm and open a bakery" → farmer, baker; the caller skips the job they hold).
 */
export function jobsNamedIn(text: string | null | undefined): JobKey[] {
  if (!text) return [];
  return KEYWORD_RES
    .map(({ job, re }) => ({ job, at: re.exec(text)?.index ?? -1 }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((m) => m.job);
}

/**
 * How well a personality suits a job: the mean, over the job's `fit` axes, of
 * how far the axis leans the right way (-1..1). 0 for a job with no leanings
 * or a resident without a personality.
 */
export function jobFit(personality: Record<string, number> | null | undefined, job: string): number {
  const fit = jobDef(job)?.fit;
  if (!personality || !fit) return 0;
  const axes = Object.entries(fit);
  if (axes.length === 0) return 0;
  let sum = 0;
  for (const [axis, sign] of axes) sum += sign * (((personality[axis] ?? 50) - 50) / 50);
  return sum / axes.length;
}
