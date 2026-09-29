import type Database from 'better-sqlite3';

/**
 * Every start: turn sighting facts stored the old way round the right way up.
 *
 * Setup's "witness" secrets ("{subject} spotted {target} at a secret meeting…")
 * used to be stored with the WITNESS as the fact's subject and the person seen
 * as its target. setupGenerator.ts has written them the other way since
 * d111d34 (subject = the person seen, target = the witness), but worlds made
 * before that still carry the old rows — and there the own-secret gossip
 * filter (gossip.ts `isOwnSecret`) guarded the witness and let the person SEEN
 * spread it: playtest #2's "Diego Santos told Marco Rivera that Yuki Tanaka
 * spotted Diego Santos at a secret meeting" (G7).
 *
 * An old row is recognisable by its text: the sentence leads with the name of
 * its subject (the witness) while a target is set. Swapping subject and target
 * makes the text lead with the target's name instead, so a second run matches
 * nothing — idempotent without a user_version bump. `known_by` is left alone:
 * the old setup told both people, and un-telling the person seen would be a
 * change of story, not a repair.
 *
 * Only `witness` rows: other facts that lead with their subject's name ("Rosa
 * Chen has been extending Carlos credit") are the right way round already.
 */
export function repairLegacySightingFacts(sqlite: Database.Database): number {
  const { changes } = sqlite.prepare(`
    UPDATE shared_knowledge
       SET subject_id = target_id, target_id = subject_id
     WHERE type = 'witness'
       AND target_id IS NOT NULL
       AND target_id <> subject_id
       AND EXISTS (
         SELECT 1 FROM agents a
          WHERE a.id = shared_knowledge.subject_id
            AND substr(shared_knowledge.content, 1, length(a.name) + 1) = a.name || ' '
       )
  `).run();
  if (changes > 0) console.log(`[db] Re-pointed ${changes} legacy sighting fact(s) at the person seen`);
  return changes;
}
