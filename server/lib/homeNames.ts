/**
 * Homes named after the people who live in them.
 *
 * Worldgen labels houses `Home 1..N` — the wizard places people by those
 * labels, and the social placer relabels plots by them — and the `names`
 * pipeline stage meant to replace them is still a stub. So the labels reached
 * everything the player reads: cast tooltips ("Spending time at Home 8"), plan
 * summaries, feed lines, and the prompts, where "I'll pop over to Home 3"
 * sounded like a filing cabinet, not a town.
 *
 * Naming happens here, on the DB rows, after the residents are in — never
 * inside worldgen: the layout (and its golden hashes) stays keyed on the
 * labels, and a name needs the residents anyway. Ids never change, only
 * `locations.name`.
 *
 *   - one resident:            "Rosa's cottage"
 *   - two or more:             "the Fernandez house" (family name of the
 *                              first resident, by id, who has one)
 *   - a clash with any other location name: the full name ("Marco Rivera's
 *     house"), then a number — plan parsing resolves places by name, so names
 *     must stay unique
 *   - nobody living there: left as it is (a house keeps its name when its
 *     people die or leave)
 *
 * Runs at world build (setup.replaceWorld, db/seed.ts), when a resident is
 * introduced (their new home), and at every start and save load for houses
 * still called `Home N` (initSchema) — idempotent, since a named house is no
 * longer generic.
 *
 * Raw `better-sqlite3` rather than drizzle so `server/db/index.ts` can run it
 * as a startup step without an import cycle.
 */
import type Database from 'better-sqlite3';

/** A worldgen label: what old worlds and fresh builds call a house. */
const GENERIC_HOME_RE = /^Home \d+$/;

const TITLE_RE = /^(dr|mr|mrs|ms|miss|mx|rev|sir|lady)\.?$/i;

/** First and family name, titles dropped ("Dr. Anna Petrov" → Anna, Petrov). */
export function splitName(name: string): { first: string; family: string | null } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && TITLE_RE.test(parts[0])) parts.shift();
  if (parts.length === 0) return { first: name.trim(), family: null };
  return { first: parts[0], family: parts.length > 1 ? parts[parts.length - 1] : null };
}

/** "Rosa's", "Carlos'" — the town's own sign-writers drop the s after an s ("Carlos' Workshop"). */
function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/**
 * Candidate names for a home with these residents, best first. The caller takes
 * the first one no other location already uses.
 */
export function homeNameCandidates(residents: readonly string[]): string[] {
  if (residents.length === 0) return [];
  const [head] = residents;
  const { first } = splitName(head);
  if (residents.length === 1) {
    return [`${possessive(first)} cottage`, `${possessive(head.trim())} cottage`];
  }
  const withFamily = residents.find((r) => splitName(r).family != null);
  const family = withFamily ? splitName(withFamily).family : null;
  const candidates = family ? [`the ${family} house`] : [];
  const named = withFamily ?? head;
  candidates.push(`${possessive(splitName(named).first)} house`, `${possessive(named.trim())} house`);
  return candidates;
}

/** The first candidate not in `taken`, numbering the last one if every candidate is. */
export function pickHomeName(residents: readonly string[], taken: ReadonlySet<string>): string | null {
  const candidates = homeNameCandidates(residents);
  if (candidates.length === 0) return null;
  const free = candidates.find((c) => !taken.has(c.toLowerCase()));
  if (free) return free;
  const last = candidates[candidates.length - 1];
  for (let n = 2; ; n++) {
    const numbered = `${last} (${n})`;
    if (!taken.has(numbered.toLowerCase())) return numbered;
  }
}

export interface NameHomesOptions {
  /** Only houses still called `Home N` (the startup pass). */
  onlyGeneric?: boolean;
  /** Only these homes (a resident just moved in). */
  homeIds?: readonly number[];
}

/** Name the homes in the DB after their residents. Returns how many were renamed. */
export function nameHomes(sqlite: Database.Database, opts: NameHomesOptions = {}): number {
  const homes = sqlite.prepare("SELECT id, name FROM locations WHERE type = 'home' ORDER BY id").all() as
    Array<{ id: number; name: string }>;
  const residents = sqlite.prepare('SELECT name, home FROM agents WHERE is_active = 1 AND home IS NOT NULL ORDER BY id').all() as
    Array<{ name: string; home: number }>;
  const byHome = new Map<number, string[]>();
  for (const r of residents) byHome.set(r.home, [...(byHome.get(r.home) ?? []), r.name]);

  // Case-insensitive: fuzzyMatchLocation and the decomposer compare lowercased.
  const taken = new Set(
    (sqlite.prepare('SELECT name FROM locations').all() as Array<{ name: string }>).map((l) => l.name.toLowerCase()),
  );
  const only = opts.homeIds ? new Set(opts.homeIds) : null;
  const rename = sqlite.prepare('UPDATE locations SET name = ? WHERE id = ?');

  let renamed = 0;
  for (const home of homes) {
    if (only && !only.has(home.id)) continue;
    if (opts.onlyGeneric && !GENERIC_HOME_RE.test(home.name)) continue;
    const people = byHome.get(home.id) ?? [];
    if (people.length === 0) continue;
    // Its own current name is free for it to keep.
    taken.delete(home.name.toLowerCase());
    const name = pickHomeName(people, taken) ?? home.name;
    taken.add(name.toLowerCase());
    if (name !== home.name) {
      rename.run(name, home.id);
      renamed++;
    }
  }
  return renamed;
}
