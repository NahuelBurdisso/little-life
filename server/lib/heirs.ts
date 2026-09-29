/**
 * Who inherits from a resident, in order.
 *
 * Why this exists. A death used to hand everything — money, belongings — to
 * the deceased's closest friend (lifeEventsEngine `processInheritance`), and
 * their shop to whoever that friend was by a second, slightly different rule
 * (residents.ts `handOverOwnedPlaces`, friendship > 0 instead of > 30). A widow
 * watched her husband's savings go to his drinking companion. Now both read
 * this one list:
 *
 *   1. the living spouse (lib/marriage.ts `spouseOf`);
 *   2. children — the town has no parent/child ties yet; when it does, they
 *      go here, eldest first, and nothing else has to change;
 *   3. friends, closest first (their friendship toward the deceased above
 *      HEIR_MIN_FRIENDSHIP — someone who barely liked them inherits nothing).
 *
 * An empty list means no heir: money goes to the town (lifeEventsEngine),
 * belongings are lost, places stand unowned until someone in the trade takes
 * them over (lib/careers.ts `changeJob`).
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db';
import { agents, relationships } from '../db/schema';
import { spouseOf } from './marriage';

/** A friend must feel at least this warmly toward the deceased to be left anything. */
export const HEIR_MIN_FRIENDSHIP = 30;

export type HeirKind = 'spouse' | 'child' | 'friend';

export interface Heir {
  agentId: number;
  kind: HeirKind;
}

/** Living heirs of `agentId`, first in line first. Works for someone already retired (dead or gone). */
export function heirsOf(agentId: number): Heir[] {
  const out: Heir[] = [];
  const spouse = spouseOf(agentId);
  if (spouse != null) out.push({ agentId: spouse, kind: 'spouse' });

  // (children: none yet — see the header.)

  const rels = db.select().from(relationships)
    .where(or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId))).all();
  const others = rels.map((r) => (r.agent_a === agentId ? r.agent_b : r.agent_a));
  const alive = others.length === 0 ? new Set<number>() : new Set(
    db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.is_active, true), inArray(agents.id, others))).all().map((r) => r.id),
  );
  const friends = rels
    .map((r) => {
      const otherId = r.agent_a === agentId ? r.agent_b : r.agent_a;
      // The other's feeling toward the deceased: who mourns them, not whom they favoured.
      const friendship = r.agent_a === otherId ? r.friendship_ab : r.friendship_ba;
      return { otherId, friendship };
    })
    .filter((f) => alive.has(f.otherId) && f.friendship > HEIR_MIN_FRIENDSHIP && !out.some((h) => h.agentId === f.otherId))
    .sort((a, b) => b.friendship - a.friendship || a.otherId - b.otherId);
  for (const f of friends) out.push({ agentId: f.otherId, kind: 'friend' });
  return out;
}
