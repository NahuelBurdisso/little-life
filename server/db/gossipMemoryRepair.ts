import type Database from 'better-sqlite3';

/**
 * Every start: name "someone" in gossip memories that were stored with "undefined".
 *
 * spreadGossip (gossip.ts) emitted `gossip:shared` with `otherName` while
 * MemoryObserver read `targetName`, so every teller stored "I told undefined
 * that ..." and those lines are fed back to the LLM as the agent's own memory.
 * The emit is fixed, but worlds played before still carry the old rows, and the
 * listener's real name is not recoverable from the text. "Someone" reads
 * naturally and stops the model repeating "undefined" in dialogue.
 *
 * Only the two lead-ins the old templates produced ("I told ...", "I shared
 * with ...") are touched, so a memory that merely mentions the word is left
 * alone. A repaired row no longer matches, so a second run changes nothing:
 * idempotent without a user_version bump.
 */
export function repairUndefinedGossipMemories(sqlite: Database.Database): number {
  const { changes } = sqlite.prepare(`
    UPDATE memories
       SET description = CASE
             WHEN description LIKE 'I told undefined %'
               THEN 'I told someone ' || substr(description, length('I told undefined ') + 1)
             ELSE 'I shared with someone ' || substr(description, length('I shared with undefined ') + 1)
           END
     WHERE description LIKE 'I told undefined %'
        OR description LIKE 'I shared with undefined %'
  `).run();
  if (changes > 0) console.log(`[db] Repaired ${changes} gossip memor${changes === 1 ? 'y' : 'ies'} that named "undefined"`);
  return changes;
}
