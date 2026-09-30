import { and, eq, inArray } from 'drizzle-orm';
import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { agents, relationshipEvents, relationships, shared_knowledge, worldState } from '../db/schema';
import { gameMinutes } from '../lib/gameClock';
import { marriedSinceOf } from '../lib/familyState';
import { buildLedger, type LedgerPair, type LedgerSnapshot } from '../lib/intimacy/ledger';
import { forEachAgentIntimacy, forEachPairIntimacy } from '../lib/intimacy/state';
import { isAdultContent } from '../lib/worldRules';

/** The fact types the ledger reads (ledger.ts decides which of them count as scandals). */
const LEDGER_FACT_TYPES = ['illegitimate_pregnancy', 'affair', 'tryst_seen', 'kiss_seen'];

/**
 * Gather what `buildLedger` folds: rows from the DB plus the in-memory intimacy
 * state. Everything here is a plain read; who may be listed and what the rule
 * hides is the builder's (pure, tested) business, not this function's.
 */
function readLedgerSnapshot(): LedgerSnapshot {
  const world = db.select({ time: worldState.time }).from(worldState).get();
  const nowMinute = world?.time ? gameMinutes(world.time) : 0;

  const people = db.select({ id: agents.id, name: agents.name, age: agents.age, is_active: agents.is_active }).from(agents).all();

  const rels = db.select().from(relationships).all().map((r) => ({
    a: r.agent_a,
    b: r.agent_b,
    status: r.status,
    tags: r.tags ?? [],
    romanceAB: r.romance_ab,
    romanceBA: r.romance_ba,
    statusSinceMinute: r.status_since_minute ?? null,
    marriedSinceMinute: marriedSinceOf(r.agent_a, r.agent_b) ?? null,
  }));

  const pairs: LedgerPair[] = [];
  forEachPairIntimacy((key, p) => {
    const [a, b] = key.split('-').map(Number);
    pairs.push({
      a, b, kisses: p.kisses, trysts: p.trysts,
      firstKissAt: p.firstKissAt ?? null, firstTrystAt: p.firstTrystAt ?? null, secret: p.secret,
    });
  });

  const longing: Record<number, number> = {};
  forEachAgentIntimacy((id, s) => { longing[id] = s.longing; });

  const facts = db.select().from(shared_knowledge)
    .where(and(eq(shared_knowledge.is_active, true), inArray(shared_knowledge.type, LEDGER_FACT_TYPES)))
    .all()
    .map((f) => ({
      id: f.id, type: f.type, subjectId: f.subject_id, targetId: f.target_id,
      isPublic: f.is_public, knownBy: (f.known_by ?? []) as number[],
    }));

  // The pivotal rows are kept forever (storyBeats.ts ROMANTIC_EVENTS), so this stays small.
  const events = db.select().from(relationshipEvents)
    .where(inArray(relationshipEvents.event_type, ['first_kiss', 'first_tryst']))
    .all()
    .map((e) => ({ a: Math.min(e.agent_a, e.agent_b), b: Math.max(e.agent_a, e.agent_b), type: e.event_type, minute: e.game_minute ?? nowMinute }));

  return { nowMinute, adultContent: isAdultContent(), agents: people, relationships: rels, pairs, longing, facts, events };
}

export const intimacyRouter = router({
  /**
   * The Hearts ledger (lib/intimacy/ledger.ts): couples, lovers, longing, crushes, scandals
   * and first-time milestones. Read-only. Refreshes off the relationships channel and the
   * agents flush (hooks/useAgents.ts), which is what moves everything it shows.
   */
  getLedger: publicProcedure.query(() => buildLedger(readLedgerSnapshot())),
});
