import { eq, or } from 'drizzle-orm';
import { db } from '../../db';
import { agents, relationships } from '../../db/schema';
import { ENGAGED_TAG, MARRIED_TAG } from '../marriage';

/**
 * Whom `agentId` is committed to, for the purposes of "is this cheating?".
 *
 * `marriage.ts` `isSpokenFor` / `betrothedTo` only know engagement and
 * marriage, and proposals rely on exactly that meaning (a partner may still be
 * courted and asked). Intimacy is stricter: someone who is openly a couple with
 * somebody (status `partners` / the derived `partner` tag) is betraying them by
 * kissing or spending a night with a third person, wedding ring or not. The
 * town's reaction still scales with the bond (`affairSensitivity` only goes to 4
 * when a MARRIAGE is betrayed); this just decides whether there is a betrayed
 * party at all.
 *
 * Returns the living partner's id, preferring a spouse, then a fiance(e), then
 * an established partner; `except` (the person they are being intimate with) is
 * never the answer, so a couple's own kiss or night is not an affair.
 */
export function committedTo(agentId: number, except?: number): number | null {
  const rows = db.select({ a: relationships.agent_a, b: relationships.agent_b, tags: relationships.tags, status: relationships.status })
    .from(relationships)
    .where(or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId)))
    .all();
  let best: { id: number; rank: number } | null = null;
  for (const r of rows) {
    const other = r.a === agentId ? r.b : r.a;
    if (other === except) continue;
    const tags = r.tags ?? [];
    const rank = tags.includes(MARRIED_TAG) ? 3
      : tags.includes(ENGAGED_TAG) ? 2
        : tags.includes('partner') || r.status === 'partners' ? 1 : 0;
    if (rank === 0 || (best && best.rank >= rank)) continue;
    const alive = db.select({ active: agents.is_active }).from(agents).where(eq(agents.id, other)).get();
    if (alive?.active) best = { id: other, rank };
  }
  return best ? best.id : null;
}
