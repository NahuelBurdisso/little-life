import type Database from 'better-sqlite3';
import { adultIdSet, isRomanticSecret, sanitizeSeedRomance, type SeedRelationshipRow } from '../lib/intimacy/seedRomance';
import { isAdultAge, isAdultsOnlyFact } from '../lib/intimacy/eligibility';

/**
 * Every start (and save load): no minor is anybody's crush, partner or affair, in a
 * world that was made before the adults-only rule existed.
 *
 * The seeders run `sanitizeSeedRomance` over the rows of a NEW town; a save made
 * earlier, or a wizard world built before the sanitiser, still has relationships that
 * name a minor with romance, romantic tags or statuses, states such as `infatuated`
 * aimed at one, and facts (an affair, a crush, a seen kiss) that name one. Nothing at
 * runtime ever removes those: `mayRomanceGrow` only stops NEW romance. This applies the
 * same rules to what already exists:
 *
 *  - relationships with a minor in the pair: `sanitizeSeedRomance` (romance capped at 0,
 *    romantic tags and status removed);
 *  - the romantic states (`infatuated`, `jealous`, `afterglow`, `guilty`, `suspicious`)
 *    of a minor, or aimed at one (a jealous one also when its love interest is a minor);
 *  - active romantic facts (affair, seduction, crush, kiss_seen, tryst_seen,
 *    illegitimate_pregnancy...) whose subject or target is a minor are deactivated, and
 *    minors are taken out of the `known_by` of the ones that remain: a child never
 *    knows an adult's romance.
 *
 * Idempotent: a second run finds nothing left to change, so it needs no user_version.
 * Raw `sqlite` handle and plain SQL: this runs inside `initSchema`, before the drizzle
 * client exists. Returns how many rows it touched.
 */
export function repairMinorRomance(sqlite: Database.Database): number {
  const people = sqlite.prepare('SELECT id, age FROM agents').all() as Array<{ id: number; age: number }>;
  if (people.length === 0) return 0;
  const adults = adultIdSet(people);
  if (adults.size === people.length) return 0; // a town of adults: nothing to repair
  const isAdult = (id: number | null): boolean => id != null && adults.has(id);

  // ── Relationships ──────────────────────────────────────────────────────────
  type RelRow = SeedRelationshipRow & { id: number };
  const raw = sqlite.prepare(
    'SELECT id, agent_a, agent_b, friendship_ab, friendship_ba, romance_ab, romance_ba, tags, status FROM relationships',
  ).all() as Array<Omit<RelRow, 'tags'> & { tags: string }>;
  const parsed: RelRow[] = raw.map((r) => {
    let tags: string[] = [];
    try {
      const v = JSON.parse(r.tags);
      if (Array.isArray(v)) tags = v.filter((t): t is string => typeof t === 'string');
    } catch { /* a corrupt tag column reads as no tags */ }
    return { ...r, tags };
  });
  const cleaned = sanitizeSeedRomance(people, parsed);
  const setRel = sqlite.prepare('UPDATE relationships SET romance_ab = ?, romance_ba = ?, tags = ?, status = ? WHERE id = ?');

  // ── States ─────────────────────────────────────────────────────────────────
  const states = sqlite.prepare(
    `SELECT id, agent_id, target_agent_id, metadata FROM agent_states
      WHERE type IN ('infatuated', 'jealous', 'afterglow', 'guilty', 'suspicious')`,
  ).all() as Array<{ id: number; agent_id: number; target_agent_id: number | null; metadata: string | null }>;
  const badStates = states.filter((s) => {
    if (!isAdult(s.agent_id)) return true;
    if (s.target_agent_id != null && !isAdult(s.target_agent_id)) return true;
    // A jealous state's triangle: the love interest is part of the pair too.
    try {
      const interest = (JSON.parse(s.metadata ?? 'null') as { loveInterestId?: unknown } | null)?.loveInterestId;
      if (typeof interest === 'number' && !isAdult(interest)) return true;
    } catch { /* unreadable metadata names nobody */ }
    return false;
  });

  // ── Facts ──────────────────────────────────────────────────────────────────
  const facts = sqlite.prepare(
    'SELECT id, type, sensitivity, subject_id, target_id, known_by FROM shared_knowledge WHERE is_active = 1',
  ).all() as Array<{ id: number; type: string; sensitivity: number; subject_id: number; target_id: number | null; known_by: string }>;
  const romantic = facts.filter((f) => isRomanticSecret({ type: f.type }) || isAdultsOnlyFact(f));
  const deactivate: number[] = [];
  const trimmed: Array<{ id: number; known_by: number[] }> = [];
  for (const f of romantic) {
    if (!isAdult(f.subject_id) || (f.target_id != null && !isAdult(f.target_id))) { deactivate.push(f.id); continue; }
    let knownBy: unknown;
    try { knownBy = JSON.parse(f.known_by); } catch { continue; }
    if (!Array.isArray(knownBy)) continue;
    const kept = knownBy.filter((k): k is number => typeof k === 'number' && isAdultAge(people.find((p) => p.id === k)?.age));
    if (kept.length !== knownBy.length) trimmed.push({ id: f.id, known_by: kept });
  }

  const changedRels = cleaned.filter((r, i) => r !== parsed[i]);
  if (changedRels.length + badStates.length + deactivate.length + trimmed.length === 0) return 0;

  const delState = sqlite.prepare('DELETE FROM agent_states WHERE id = ?');
  const offFact = sqlite.prepare('UPDATE shared_knowledge SET is_active = 0 WHERE id = ?');
  const setKnown = sqlite.prepare('UPDATE shared_knowledge SET known_by = ? WHERE id = ?');
  sqlite.transaction(() => {
    for (const r of changedRels) setRel.run(r.romance_ab, r.romance_ba, JSON.stringify(r.tags), r.status, r.id);
    for (const s of badStates) delState.run(s.id);
    for (const id of deactivate) offFact.run(id);
    for (const t of trimmed) setKnown.run(JSON.stringify(t.known_by), t.id);
  })();
  const touched = changedRels.length + badStates.length + deactivate.length + trimmed.length;
  console.log(
    `[db] Removed romance involving minors: ${changedRels.length} relationship(s), ${badStates.length} state(s), `
    + `${deactivate.length} fact(s) retired, ${trimmed.length} fact(s) no longer known to a minor`,
  );
  return touched;
}
