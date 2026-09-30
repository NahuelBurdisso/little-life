import { db } from '../../db';
import { agents, relationships, relationshipEvents } from '../../db/schema';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { logActivity } from '../../lib/activityLogger';
import { clamp } from '../../lib/utils';
import { CONFIG } from '../../lib/constants';
import { gameMinutes, hourChanged, MINUTES_PER_DAY, type ClockTime } from '../../lib/gameClock';
import { PIVOTAL_EVENT_SQL } from '../../lib/storyBeats';
import { emitter } from '../emitter';
import type { RelationshipStatus } from '../../lib/types';
import { simEvents } from '../../lib/simEvents';
import { isMarriedTags, withoutMilestoneTags } from '../../lib/marriage';
import { mayRomanceGrow } from '../../lib/intimacy/attraction';

// --- Types ---

type AgentRow = typeof agents.$inferSelect;
type RelRow = typeof relationships.$inferSelect;

// --- Helpers ---

export function applyDiminishing(currentValue: number, delta: number): number {
  if (delta > 0 && currentValue > 0) {
    const resistance = currentValue / 100;
    return delta * (1 - resistance * CONFIG.RELATIONSHIPS.DIMINISHING_RETURNS_FACTOR);
  }
  if (delta < 0 && currentValue < 0) {
    const resistance = Math.abs(currentValue) / 100;
    return delta * (1 - resistance * CONFIG.RELATIONSHIPS.DIMINISHING_RETURNS_FACTOR);
  }
  return delta;
}

/**
 * Is the romance, both ways, that of a couple? The lower side past
 * PARTNERS_MIN_ROMANCE and the pair's average past PARTNERS_AVG_ROMANCE.
 *
 * Was "both > 70". Diminishing returns (applyDiminishing) make every point
 * near 70 cost ~1.7x one near 0, and the side with the lower sensuality gains
 * less per conversation, so in real play the lagging side stalled in the 60s:
 * in playtest #3 no couple became partners in five game days (Lucia/Diego
 * 60/72) and proposals and weddings never happened. With the reciprocity pull
 * (relationshipImpact.ts) a simulation of the conversation engine
 * (relationshipThresholds.test.ts) puts a devoted couple — two or three warm
 * talks a day, a third of them romantic — at partners in ~4-6 game days, while
 * warm friends and one-sided crushes never get there.
 */
export const PARTNERS_MIN_ROMANCE = 65;
export const PARTNERS_AVG_ROMANCE = 70;

export function romanceIsPartnership(minRomance: number, maxRomance: number): boolean {
  return minRomance > PARTNERS_MIN_ROMANCE && (minRomance + maxRomance) / 2 > PARTNERS_AVG_ROMANCE;
}

/**
 * Whether `id` is already someone's partner, other than `counterpart`'s: a row of theirs whose
 * status is `partners` (or that carries the `partner` tag, which is how a married or engaged pair
 * is always marked) with a person who is alive and in town (`activeIds`; a dead or departed partner
 * no longer holds anyone). A married or engaged pair is a `partners` row too, so a spouse blocks
 * exactly like any partner.
 *
 * Read off the tick's own `relMap`, which is updated row by row as events land: two pairs of one
 * person that both qualify in the same tick are seen one after the other, and the second finds the
 * first. Callers only ask when a pair is about to become partners, so the scan is rare.
 */
export function holdsPartnerElsewhere(
  relMap: ReadonlyMap<string, RelRow>,
  activeIds: ReadonlySet<number>,
  id: number,
  counterpart: number,
): boolean {
  for (const r of relMap.values()) {
    if (r.agent_a !== id && r.agent_b !== id) continue;
    const other = r.agent_a === id ? r.agent_b : r.agent_a;
    if (other === counterpart || !activeIds.has(other)) continue;
    if (r.status === 'partners' || r.tags.includes('partner')) return true;
  }
  return false;
}

/**
 * `partnerBlocked`: the pair would become partners on its numbers but one of them already has a
 * partner elsewhere (`holdsPartnerElsewhere`), so the label waits at `romantic_interest`. It gates
 * ONLY the partners-by-thresholds branch: estrangement and a marriage are decided before it, and a
 * married pair is partners whatever else is going on.
 */
export function deriveStatus(
  fAB: number,
  fBA: number,
  rAB: number,
  rBA: number,
  _trust: number,
  familiarity: number,
  estranged = false,
  married = false,
  partnerBlocked = false,
): RelationshipStatus {
  const avgFriendship = (fAB + fBA) / 2;
  const maxRomance = Math.max(rAB, rBA);
  const minRomance = Math.min(rAB, rBA);

  // Estrangement outranks everything — it is the one status that never lifts.
  if (estranged) return 'estranged';

  // A marriage is sticky: a couple who have a bad week, or simply drift for a
  // few game days of decay, are still married. Only a real breakup (the
  // affair-discovery paths in conversations.ts, or estrangement above) strips
  // the `married` tag and lets the thresholds speak again.
  if (married) return 'partners';

  if (!partnerBlocked && romanceIsPartnership(minRomance, maxRomance) && avgFriendship > 30) return 'partners';
  if (maxRomance > 30 && avgFriendship < -10) return 'complicated';
  if (maxRomance > 30) return 'romantic_interest';
  if (avgFriendship > 90) return 'best_friends';
  if (avgFriendship > 70) return 'close_friends';
  if (avgFriendship > 40) return 'friends';
  if (avgFriendship < -70) return 'enemies';
  if (avgFriendship < -40) return 'rivals';
  if (familiarity > 10) return 'acquaintances';
  return 'strangers';
}

function updateTags(
  existingTags: string[],
  metrics: {
    avgFriendship: number;
    maxRomance: number;
    minRomance: number;
    avgTrust: number;
    /**
     * False when the pair would be partners on its numbers but one of them is already someone's
     * partner (exclusivity): they take the crush branch instead, unless married. Default true.
     */
    partnerAllowed?: boolean;
  },
): string[] {
  // Only the six derived tags below are ever added or removed here, so any
  // static tag the caller already carries (coworker, neighbor, family,
  // roommate) survives untouched.
  const tags = new Set(existingTags);

  if (metrics.avgFriendship > 80) {
    tags.add('best_friend');
  } else {
    tags.delete('best_friend');
  }

  if (metrics.avgFriendship < -50) {
    tags.add('rival');
  } else {
    tags.delete('rival');
  }

  // A married pair stays each other's partner even when romance cools below the
  // courtship line: code that asks "are they together?" reads the `partner` tag
  // (goals, perception), and a marriage only ends by an explicit breakup.
  const partnerAllowed = metrics.partnerAllowed ?? true;
  if (isMarriedTags(existingTags) || (partnerAllowed && romanceIsPartnership(metrics.minRomance, metrics.maxRomance))) {
    tags.delete('crush');
    tags.add('partner');
  } else if (metrics.maxRomance > 40) {
    tags.delete('partner');
    tags.add('crush');
  } else {
    tags.delete('crush');
    tags.delete('partner');
  }

  if (metrics.avgTrust > 60) {
    tags.add('trusted');
  } else {
    tags.delete('trusted');
  }

  if (metrics.avgTrust < -40) {
    tags.add('distrusted');
  } else {
    tags.delete('distrusted');
  }

  return Array.from(tags);
}

function normalizePair(
  agentA: number,
  agentB: number,
): [number, number, boolean] {
  const swapped = agentA > agentB;
  const a = swapped ? agentB : agentA;
  const b = swapped ? agentA : agentB;
  return [a, b, swapped];
}

// --- Retention ---

/**
 * How long an ordinary (non-pivotal) processed event is kept, in GAME minutes.
 *
 * CLOCK: GAME MINUTES (`relationshipEvents.game_minute`). The old rule was six
 * REAL hours on `timestamp`, which is what made story history vanish: the
 * chronicle builds every arc from these rows, so after a long session or an
 * overnight pause each rivalry, romance and reconciliation lost its beats and
 * dropped off the Stories tab. Pausing the game also kept the real-time
 * retention running.
 *
 * Every windowed reader still sits well inside this: the heartbroken check in
 * states.ts looks back 60 ticks, the autoplay collectors one analysis window,
 * and the chronicle's heat halves every game day, so an ordinary beat three
 * days old is worth an eighth of a fresh one.
 */
export const EVENT_RETENTION_GAME_MINUTES = 3 * MINUTES_PER_DAY;

/**
 * Pivotal events (lib/storyBeats.ts: clashes, confessions, reconciliations,
 * anything felt at |sentiment| ≥ 0.5) are kept regardless of age, but only the
 * newest this many per pair per event type. Unbounded they would still grow for
 * the life of the world — a married couple trades gifts every few days — while
 * the chronicle only ever needs a pair's latest turns of each kind: the newest
 * clash and the newest mend decide whether it is a rivalry or a reconciliation,
 * and a handful of each is plenty to tell the story. The cap makes the table's
 * pivotal part O(pairs × types) instead of O(game days).
 */
export const PIVOTAL_EVENTS_KEPT_PER_PAIR_TYPE = 8;

/**
 * Prune processed relationship events: ordinary ones past their game-day
 * retention, pivotal ones beyond the per-pair-per-type cap. Runs once per game
 * day from the tick loop.
 *
 * The table is append-only — `tick` marks rows `processed` and nothing else
 * deletes them — so without this it grew for the life of the world at roughly
 * one row per interaction, dragging the `processed = false` scan and every
 * windowed read along with it.
 *
 * Unprocessed rows are never touched regardless of age: an old one means the
 * engine was down when it was written, and its deltas are still owed.
 *
 * Rows the insert trigger couldn't stamp (written before the world row existed)
 * are dated now first, so they get a full retention period instead of being
 * either immortal (NULL never compares older) or instantly stale.
 */
export function pruneRelationshipEvents(nowMinutes: number): number {
  db.update(relationshipEvents)
    .set({ game_minute: nowMinutes })
    .where(isNull(relationshipEvents.game_minute))
    .run();

  const ordinary = db
    .delete(relationshipEvents)
    .where(
      and(
        eq(relationshipEvents.processed, true),
        sql.raw(`NOT ${PIVOTAL_EVENT_SQL}`),
        lt(relationshipEvents.game_minute, nowMinutes - EVENT_RETENTION_GAME_MINUTES),
      ),
    )
    .run().changes;

  // Pair key is order-independent: most writers normalise a < b, but not all
  // (gifts and confrontations are recorded giver → receiver).
  const overflow = db.run(sql`
    DELETE FROM relationship_events WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY MIN(agent_a, agent_b), MAX(agent_a, agent_b), event_type
          ORDER BY game_minute DESC, id DESC
        ) AS rank
        FROM relationship_events
        WHERE processed = 1 AND ${sql.raw(PIVOTAL_EVENT_SQL)}
      ) WHERE rank > ${PIVOTAL_EVENTS_KEPT_PER_PAIR_TYPE}
    )
  `).changes;

  return ordinary + overflow;
}

// --- Main Tick ---

export function tick(
  world: {
    time: ClockTime;
    tick_speed: number;
    pending_transitions?: Array<{ type?: unknown }> | null;
  },
): void {
  const gameHoursElapsed = world.tick_speed / 60;
  const now = Date.now();
  // Decay's clock. `now` stays for the wall-clock columns (last_interaction,
  // last_updated, created_at) that other readers still use as "recently".
  const nowMinutes = gameMinutes(world.time);

  // --- 1. Proximity Familiarity ---
  const activeAgents = db
    .select()
    .from(agents)
    .where(eq(agents.is_active, true))
    .all();

  // Group agents by current_location (skip null)
  const locationGroups = new Map<number, AgentRow[]>();
  for (const agent of activeAgents) {
    if (agent.current_location !== null) {
      const key = agent.current_location;
      const group = locationGroups.get(key);
      if (group) {
        group.push(agent);
      } else {
        locationGroups.set(key, [agent]);
      }
    }
  }

  // Who is alive and in town, for partner exclusivity (a departed partner holds nobody).
  const activeIds = new Set<number>(activeAgents.map((ag) => ag.id));

  // Load all relationships into a map for fast lookup
  const allRels = db.select().from(relationships).all();
  const relMap = new Map<string, RelRow>();
  for (const rel of allRels) {
    relMap.set(`${rel.agent_a}:${rel.agent_b}`, rel);
  }

  let dirty = false;

  for (const [, group] of locationGroups) {
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = normalizePair(group[i].id, group[j].id);
        const key = `${a}:${b}`;
        const existing = relMap.get(key);

        if (existing) {
          const gain =
            CONFIG.RELATIONSHIPS.PROXIMITY_FAMILIARITY_RATE *
            gameHoursElapsed *
            (1 - existing.familiarity / 100);
          if (gain > 0.001) {
            const newFamiliarity = clamp(existing.familiarity + gain, 0, 100);
            db.update(relationships)
              .set({ familiarity: newFamiliarity, last_updated: now })
              .where(eq(relationships.id, existing.id))
              .run();
            // Update local cache
            existing.familiarity = newFamiliarity;
            existing.last_updated = now;
            dirty = true;
          }
        } else {
          const newRel = {
            agent_a: a,
            agent_b: b,
            friendship_ab: 0,
            friendship_ba: 0,
            romance_ab: 0,
            romance_ba: 0,
            trust_ab: 0,
            trust_ba: 0,
            familiarity: 1,
            interaction_count: 0,
            last_interaction: now,
            last_interaction_minute: nowMinutes,
            status_since_minute: nowMinutes,
            average_interaction_sentiment: 0,
            tags: [] as string[],
            status: 'strangers',
            created_at: now,
            last_updated: now,
          };
          const result = db.insert(relationships).values(newRel).run();
          const doc: RelRow = {
            ...newRel,
            id: Number(result.lastInsertRowid),
          };
          relMap.set(key, doc);
          dirty = true;
        }
      }
    }
  }

  // --- 2. Process Relationship Events ---
  // Agent rows for the romance gate below: the active ones are already loaded,
  // anyone else (a dead or departed party to a queued event) is read on demand.
  const romanceAgents = new Map<number, AgentRow | undefined>(activeAgents.map((ag) => [ag.id, ag]));
  const agentForRomance = (id: number): AgentRow | undefined => {
    if (!romanceAgents.has(id)) {
      romanceAgents.set(id, db.select().from(agents).where(eq(agents.id, id)).get());
    }
    return romanceAgents.get(id);
  };
  const events = db
    .select()
    .from(relationshipEvents)
    .where(eq(relationshipEvents.processed, false))
    .all();

  for (const event of events) {
    const [a, b, swapped] = normalizePair(event.agent_a, event.agent_b);
    const key = `${a}:${b}`;
    let rel = relMap.get(key);

    if (!rel) {
      // Create relationship on the fly
      const newRel = {
        agent_a: a,
        agent_b: b,
        friendship_ab: 0,
        friendship_ba: 0,
        romance_ab: 0,
        romance_ba: 0,
        trust_ab: 0,
        trust_ba: 0,
        familiarity: 1,
        interaction_count: 0,
        last_interaction: now,
        last_interaction_minute: nowMinutes,
        status_since_minute: nowMinutes,
        average_interaction_sentiment: 0,
        tags: [] as string[],
        status: 'strangers',
        created_at: now,
        last_updated: now,
      };
      const result = db.insert(relationships).values(newRel).run();
      rel = { ...newRel, id: Number(result.lastInsertRowid) };
      relMap.set(key, rel);
    }

    // Resolve directional deltas. If the event's agentA/agentB were swapped
    // during normalization, we need to swap the AB/BA deltas too.
    const rawFDeltaAB = swapped ? event.friendship_delta_ba : event.friendship_delta_ab;
    const rawFDeltaBA = swapped ? event.friendship_delta_ab : event.friendship_delta_ba;
    const rawRDeltaAB = swapped ? event.romance_delta_ba : event.romance_delta_ab;
    const rawRDeltaBA = swapped ? event.romance_delta_ab : event.romance_delta_ba;
    const tDeltaAB = swapped ? event.trust_delta_ba : event.trust_delta_ab;
    const tDeltaBA = swapped ? event.trust_delta_ab : event.trust_delta_ba;

    // Estrangement is a one-way door: once the tag is set, no interaction can
    // buy back goodwill. Negative deltas still land — they can always hurt
    // each other further — so only the positive half is discarded.
    const wasEstranged = rel.tags.includes('estranged');
    const fDeltaAB = wasEstranged ? Math.min(0, rawFDeltaAB) : rawFDeltaAB;
    const fDeltaBA = wasEstranged ? Math.min(0, rawFDeltaBA) : rawFDeltaBA;
    let rDeltaAB = wasEstranged ? Math.min(0, rawRDeltaAB) : rawRDeltaAB;
    let rDeltaBA = wasEstranged ? Math.min(0, rawRDeltaBA) : rawRDeltaBA;

    // The one guarantee for every romance source. Positive romance is queued by
    // conversations, but also by seduction (states.ts), gifts, ripple rules,
    // secret sharing, the town calendar and template beats, and most of those
    // know nothing about age or orientation. Rather than trust each writer,
    // this is where every queued delta finally lands: a POSITIVE romance delta
    // is dropped in any direction where the feeler or the target is not an
    // adult, or the feeler is not drawn to the target's gender. Per direction,
    // because unrequited love is fine (see mayRomanceGrow). Negative deltas
    // pass (a minor's crush can still be hurt by a rebuff); friendship and
    // trust are untouched. Fail closed: a missing agent row blocks the gain.
    if (rDeltaAB > 0 || rDeltaBA > 0) {
      const pa = agentForRomance(a);
      const pb = agentForRomance(b);
      if (rDeltaAB > 0 && !(pa && pb && mayRomanceGrow(pa, pb))) rDeltaAB = 0;
      if (rDeltaBA > 0 && !(pa && pb && mayRomanceGrow(pb, pa))) rDeltaBA = 0;
    }

    const newFriendshipAB = clamp(
      rel.friendship_ab + applyDiminishing(rel.friendship_ab, fDeltaAB),
      -100,
      100,
    );
    const newFriendshipBA = clamp(
      rel.friendship_ba + applyDiminishing(rel.friendship_ba, fDeltaBA),
      -100,
      100,
    );
    const newRomanceAB = clamp(
      rel.romance_ab + applyDiminishing(rel.romance_ab, rDeltaAB),
      -100,
      100,
    );
    const newRomanceBA = clamp(
      rel.romance_ba + applyDiminishing(rel.romance_ba, rDeltaBA),
      -100,
      100,
    );
    const newTrustAB = clamp(
      rel.trust_ab + applyDiminishing(rel.trust_ab, tDeltaAB),
      -100,
      100,
    );
    const newTrustBA = clamp(
      rel.trust_ba + applyDiminishing(rel.trust_ba, tDeltaBA),
      -100,
      100,
    );

    const newFamiliarity = clamp(rel.familiarity + 2, 0, 100);
    const newInteractionCount = rel.interaction_count + 1;

    // Running average of sentiment
    const newSentiment =
      (rel.average_interaction_sentiment * rel.interaction_count +
        event.sentiment) /
      newInteractionCount;

    const avgFriendship = (newFriendshipAB + newFriendshipBA) / 2;
    const maxRomance = Math.max(newRomanceAB, newRomanceBA);
    const minRomance = Math.min(newRomanceAB, newRomanceBA);
    const avgTrust = (newTrustAB + newTrustBA) / 2;

    const tagMetrics = { avgFriendship, maxRomance, minRomance, avgTrust };
    let newTags = updateTags(rel.tags, tagMetrics);

    // Two agents who know each other well and have bottomed out mutual
    // friendship are done for good. `updateTags` only deletes the tags it
    // owns, so `estranged` survives every later pass untouched.
    const isEstranged =
      wasEstranged || (avgFriendship <= -80 && newFamiliarity >= 30);
    if (isEstranged && !wasEstranged) {
      // Estrangement is the one breakup the thresholds can cause on their own:
      // no engagement or marriage survives it.
      newTags = [...withoutMilestoneTags(newTags), 'estranged'];
    }

    const oldStatus = rel.status;
    let newStatus = deriveStatus(
      newFriendshipAB,
      newFriendshipBA,
      newRomanceAB,
      newRomanceBA,
      avgTrust,
      newFamiliarity,
      isEstranged,
      isMarriedTags(newTags),
    );
    // Partner exclusivity. Asked only when this event is about to MAKE them partners (a pair that
    // already is one, by status or tag, is an incumbent and is never demoted here), and not for a
    // marriage. Blocked, the pair keeps its feelings but stays a romantic interest with a crush
    // tag. Lazy on purpose: the scan over the relationship map is rare, not per event.
    if (
      newStatus === 'partners' && !isMarriedTags(newTags)
      && oldStatus !== 'partners' && !rel.tags.includes('partner')
      && (holdsPartnerElsewhere(relMap, activeIds, a, b) || holdsPartnerElsewhere(relMap, activeIds, b, a))
    ) {
      newTags = updateTags(rel.tags, { ...tagMetrics, partnerAllowed: false });
      newStatus = deriveStatus(
        newFriendshipAB, newFriendshipBA, newRomanceAB, newRomanceBA,
        avgTrust, newFamiliarity, isEstranged, false, true,
      );
    }
    // The milestone clock: how long the pair has held this status.
    const statusSince = newStatus !== oldStatus ? nowMinutes : rel.status_since_minute;

    db.update(relationships)
      .set({
        friendship_ab: newFriendshipAB,
        friendship_ba: newFriendshipBA,
        romance_ab: newRomanceAB,
        romance_ba: newRomanceBA,
        trust_ab: newTrustAB,
        trust_ba: newTrustBA,
        familiarity: newFamiliarity,
        interaction_count: newInteractionCount,
        last_interaction: now,
        last_interaction_minute: nowMinutes,
        average_interaction_sentiment: newSentiment,
        tags: newTags,
        status: newStatus,
        status_since_minute: statusSince,
        last_updated: now,
      })
      .where(eq(relationships.id, rel.id))
      .run();

    // Update local cache
    rel.friendship_ab = newFriendshipAB;
    rel.friendship_ba = newFriendshipBA;
    rel.romance_ab = newRomanceAB;
    rel.romance_ba = newRomanceBA;
    rel.trust_ab = newTrustAB;
    rel.trust_ba = newTrustBA;
    rel.familiarity = newFamiliarity;
    rel.interaction_count = newInteractionCount;
    rel.last_interaction = now;
    rel.last_interaction_minute = nowMinutes;
    rel.average_interaction_sentiment = newSentiment;
    rel.tags = newTags;
    rel.status = newStatus;
    rel.status_since_minute = statusSince;
    rel.last_updated = now;

    // Log relationship status changes
    if (newStatus !== oldStatus) {
      const nameA = db.select({ name: agents.name }).from(agents).where(eq(agents.id, a)).get()?.name ?? `Agent#${a}`;
      const nameB = db.select({ name: agents.name }).from(agents).where(eq(agents.id, b)).get()?.name ?? `Agent#${b}`;
      logActivity({
        type: 'relationship_status_change',
        agents: [a, b],
        templateData: { agent1: nameA, agent2: nameB, status: newStatus },
      });
      simEvents.emit('relationship:changed', { agentId: a, otherName: nameB, status: newStatus });
      simEvents.emit('relationship:changed', { agentId: b, otherName: nameA, status: newStatus });

      if (isEstranged && !wasEstranged) {
        logActivity({
          type: 'drama',
          agents: [a, b],
          severity: 0.7,
          templateData: {
            description: `${nameA} and ${nameB} are estranged for good — neither will ever forgive the other.`,
          },
          metadata: { beat: 'estrangement' },
        });
      }
    }

    // Emit sentiment event if friendship or romance shift is significant
    if (Math.abs(fDeltaAB) > 10 || Math.abs(rDeltaAB) > 10 || Math.abs(fDeltaBA) > 10 || Math.abs(rDeltaBA) > 10) {
      const nameA = db.select({ name: agents.name }).from(agents).where(eq(agents.id, a)).get()?.name ?? `Agent#${a}`;
      const nameB = db.select({ name: agents.name }).from(agents).where(eq(agents.id, b)).get()?.name ?? `Agent#${b}`;
      const friendshipDeltaFromA = fDeltaAB;
      const friendshipDeltaFromB = fDeltaBA;
      const sentimentFromA = friendshipDeltaFromA > 0 ? 'closer to' : 'more distant from';
      const sentimentFromB = friendshipDeltaFromB > 0 ? 'closer to' : 'more distant from';
      simEvents.emit('relationship:sentiment', { agentId: a, otherName: nameB, sentiment: sentimentFromA });
      simEvents.emit('relationship:sentiment', { agentId: b, otherName: nameA, sentiment: sentimentFromB });
    }

    // Mark event as processed
    db.update(relationshipEvents)
      .set({ processed: true })
      .where(eq(relationshipEvents.id, event.id))
      .run();

    // Per event, after it is applied and any status change is logged: the one
    // moment the before/after status of a pair is known. The player-outcome
    // reporter (lib/playerOutcomes.ts) waits on this to say "now rivals" — a
    // conversation's events are written unprocessed and only land here on the
    // next relationships phase, so at `conversation:ended` the status is still
    // the old one.
    simEvents.emit('relationship:event_applied', {
      eventId: event.id,
      agentA: a,
      agentB: b,
      oldStatus,
      newStatus,
    });

    dirty = true;
  }

  // --- 3. Relationship Decay ---
  // Only run decay once per game hour to avoid O(n²) work every tick. Gated on
  // the clock crossing an hour, not `totalTicks % 60`: counting ticks made the
  // pass every 4 game hours at 4x and its cadence depend on when the world
  // started.
  if (!hourChanged(world.pending_transitions)) {
    if (dirty) emitter.markDirty('agents.all');
    return;
  }

  // Grace period and ramp are GAME days, measured on `last_interaction_minute`
  // (game minutes). They were once real days, so decay never started inside a
  // session; then the Date.now() gap was converted at the current speed, which
  // counted every minute the server was off or paused as game time — after a
  // night's break every pair decayed at full strength on the first pass.
  const gracePeriodMinutes = CONFIG.RELATIONSHIPS.DECAY_GRACE_PERIOD_DAYS * 1440;

  // Game hours since the *previous* decay pass, not since the previous tick:
  // the pass runs once per game hour at every speed. Section 1 above is
  // per-tick and correctly uses `gameHoursElapsed` (= tick_speed / 60); reusing
  // that value here made decay 60x too weak.
  const gameHoursSinceLastPass = 1;

  for (const [, rel] of relMap) {
    // Estranged pairs are exempt: decay pulls values toward 0, which would
    // quietly walk the hatred back to neutral and undo the permanence.
    if (rel.tags.includes('estranged')) continue;

    if (rel.last_interaction_minute == null) {
      // Written by something that doesn't know the column yet (startup backfills
      // the rest). Start its clock now rather than guess an age for it.
      db.update(relationships)
        .set({ last_interaction_minute: nowMinutes })
        .where(eq(relationships.id, rel.id))
        .run();
      rel.last_interaction_minute = nowMinutes;
      continue;
    }
    const minutesSinceInteraction = nowMinutes - rel.last_interaction_minute;
    if (minutesSinceInteraction <= gracePeriodMinutes) continue;

    const daysSinceInteraction = minutesSinceInteraction / 1440;
    const decayStrength = Math.min(
      daysSinceInteraction / CONFIG.RELATIONSHIPS.DECAY_MAX_STRENGTH_DAYS,
      1,
    );
    const dailyDecayRate =
      CONFIG.RELATIONSHIPS.DECAY_DAILY_RATE *
      decayStrength *
      (gameHoursSinceLastPass / 24);

    let changed = false;

    function decayValue(value: number, rateMultiplier: number): number {
      if (Math.abs(value) < 0.01) return value;

      let effectiveRate = dailyDecayRate * rateMultiplier;

      // Strong relationships resist decay
      if (Math.abs(value) > 70) {
        effectiveRate *= CONFIG.RELATIONSHIPS.STRONG_RELATIONSHIP_RESISTANCE;
      }

      // Negative values decay slower (grudges persist)
      if (value < 0) {
        effectiveRate *= CONFIG.RELATIONSHIPS.GRUDGE_DECAY_MULTIPLIER;
      }

      if (value > 0) {
        return Math.max(0, value - effectiveRate);
      } else {
        return Math.min(0, value + effectiveRate);
      }
    }

    const newFAB = decayValue(rel.friendship_ab, 1);
    const newFBA = decayValue(rel.friendship_ba, 1);
    const newRAB = decayValue(
      rel.romance_ab,
      CONFIG.RELATIONSHIPS.ROMANCE_DECAY_MULTIPLIER,
    );
    const newRBA = decayValue(
      rel.romance_ba,
      CONFIG.RELATIONSHIPS.ROMANCE_DECAY_MULTIPLIER,
    );

    if (
      newFAB !== rel.friendship_ab ||
      newFBA !== rel.friendship_ba ||
      newRAB !== rel.romance_ab ||
      newRBA !== rel.romance_ba
    ) {
      changed = true;
    }

    if (changed) {
      const avgTrust = (rel.trust_ab + rel.trust_ba) / 2;
      let newStatus = deriveStatus(
        newFAB, newFBA, newRAB, newRBA, avgTrust, rel.familiarity, false, isMarriedTags(rel.tags),
      );
      // The same exclusivity guard as the event path: without it a pair the events left blocked at
      // romantic_interest was promoted here on the next quiet hour (raw thresholds still met) while
      // the incumbent stood, and the two paths took turns flipping it.
      if (
        newStatus === 'partners' && !isMarriedTags(rel.tags)
        && rel.status !== 'partners' && !rel.tags.includes('partner')
        && (holdsPartnerElsewhere(relMap, activeIds, rel.agent_a, rel.agent_b)
          || holdsPartnerElsewhere(relMap, activeIds, rel.agent_b, rel.agent_a))
      ) {
        newStatus = deriveStatus(newFAB, newFBA, newRAB, newRBA, avgTrust, rel.familiarity, false, false, true);
      }

      db.update(relationships)
        .set({
          friendship_ab: newFAB,
          friendship_ba: newFBA,
          romance_ab: newRAB,
          romance_ba: newRBA,
          status: newStatus,
          ...(newStatus !== rel.status ? { status_since_minute: nowMinutes } : {}),
          last_updated: now,
        })
        .where(eq(relationships.id, rel.id))
        .run();

      dirty = true;
    }
  }

  if (dirty) {
    emitter.markDirty('agents.all');
  }
}
