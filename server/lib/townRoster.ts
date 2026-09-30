/**
 * The town's roster as one prompt line: who lives here, and what they do.
 *
 * Why: no prompt named the townsfolk, so the model filled the gap with people
 * of its own ("Silas", "old Mrs. Hargrove") — in dialogue, in day plans and in
 * the paper — and those inventions then became memories and gossip about
 * nobody. Listing the residents stops the invention and, as a side effect, lets
 * a plan or a line of dialogue name a real neighbour, which is what ties one
 * resident's story to another's.
 *
 * `formatRoster` is pure (unit-tested); `rosterLine` is the thin DB read.
 * Callers put the result in the SYSTEM part of a prompt: it is the same for
 * every turn of a conversation, so it belongs in the cached prefix, and it is
 * the first thing to drop if a prompt ever has to be trimmed (~6 tokens a head,
 * 32 heads: about 200 of the 8192-token `NUM_CTX`).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { agents, economy } from '../db/schema';

/** More than this and the line costs more than it saves; ids are stable, so the same ones always make the cut. */
export const ROSTER_MAX = 32;

export interface RosterRow {
  id: number;
  name: string;
  age: number;
  is_active: boolean;
  /** `economy.job_title`; null for someone with no economy row. */
  job_title: string | null;
}

const CLOSING = 'Anyone not on this list is a stranger to town; never make up names for townsfolk.';

/** Placeholder titles that mean "no job": naming them ("Silas (unemployed)") teaches nothing. */
const NO_JOB = /^(?:unemployed|none|jobless|)$/i;

/** What to put in brackets after a name: the trade, else "child"/"teen" for a minor, else nothing. */
function tag(row: Pick<RosterRow, 'age' | 'job_title'>): string {
  const job = row.job_title?.trim() ?? '';
  if (!NO_JOB.test(job)) return job;
  if (typeof row.age !== 'number' || !Number.isFinite(row.age) || row.age >= 18) return '';
  return row.age < 13 ? 'child' : 'teen';
}

/**
 * "People in town: Rosa Chen (Shopkeeper), Tomas Reyes (child). Anyone not on
 * this list is a stranger…", or '' when nobody qualifies (an empty town has no
 * strangers to warn about).
 */
export function formatRoster(rows: readonly RosterRow[], excludeIds: readonly number[] = []): string {
  const skip = new Set(excludeIds);
  const people = rows
    .filter((r) => r.is_active && !skip.has(r.id))
    .sort((a, b) => a.id - b.id)
    .slice(0, ROSTER_MAX)
    .map((r) => {
      const t = tag(r);
      return t ? `${r.name} (${t})` : r.name;
    });
  if (people.length === 0) return '';
  return `People in town: ${people.join(', ')}. ${CLOSING}`;
}

/** The living, active residents as a roster line; `excludeIds` are left out (the speaker and listener, the planner). */
export function rosterLine(excludeIds: number[] = []): string {
  const rows = db
    .select({ id: agents.id, name: agents.name, age: agents.age, is_active: agents.is_active, job_title: economy.job_title })
    .from(agents)
    .leftJoin(economy, eq(economy.agent_id, agents.id))
    .all();
  return formatRoster(rows, excludeIds);
}
