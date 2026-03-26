import { db } from '../../db';
import { agents, relationships, relationshipEvents, activityLog } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { clamp } from '../../lib/utils';
import { CONFIG } from '../../lib/constants';
import { emitter } from '../emitter';
import type { RelationshipStatus } from '../../lib/types';

// --- Types ---

type AgentRow = typeof agents.$inferSelect;
type RelRow = typeof relationships.$inferSelect;
const STATIC_TAGS = new Set(['coworker', 'neighbor', 'family', 'roommate']);

// --- Helpers ---

function applyDiminishing(currentValue: number, delta: number): number {
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

function deriveStatus(
  fAB: number,
  fBA: number,
  rAB: number,
  rBA: number,
  _trust: number,
  familiarity: number,
): RelationshipStatus {
  const avgFriendship = (fAB + fBA) / 2;
  const maxRomance = Math.max(rAB, rBA);
  const minRomance = Math.min(rAB, rBA);

  if (minRomance > 70 && avgFriendship > 30) return 'partners';
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
  },
): string[] {
  const tags = new Set(existingTags);

  if (metrics.avgFriendship > 80) {
    tags.add('best_friend');
  } else {
    if (!STATIC_TAGS.has('best_friend')) tags.delete('best_friend');
  }

  if (metrics.avgFriendship < -50) {
    tags.add('rival');
  } else {
    if (!STATIC_TAGS.has('rival')) tags.delete('rival');
  }

  if (metrics.minRomance > 70) {
    tags.delete('crush');
    tags.add('partner');
  } else if (metrics.maxRomance > 40) {
    tags.delete('partner');
    tags.add('crush');
  } else {
    if (!STATIC_TAGS.has('crush')) tags.delete('crush');
    if (!STATIC_TAGS.has('partner')) tags.delete('partner');
  }

  if (metrics.avgTrust > 60) {
    tags.add('trusted');
  } else {
    if (!STATIC_TAGS.has('trusted')) tags.delete('trusted');
  }

  if (metrics.avgTrust < -40) {
    tags.add('distrusted');
  } else {
    if (!STATIC_TAGS.has('distrusted')) tags.delete('distrusted');
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

// --- Main Tick ---

export function tick(
  world: { tick_speed: number; time?: { totalTicks?: number } },
): void {
  const gameHoursElapsed = world.tick_speed / 60;
  const now = Date.now();

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
    const fDeltaAB = swapped ? event.friendship_delta_ba : event.friendship_delta_ab;
    const fDeltaBA = swapped ? event.friendship_delta_ab : event.friendship_delta_ba;
    const rDeltaAB = swapped ? event.romance_delta_ba : event.romance_delta_ab;
    const rDeltaBA = swapped ? event.romance_delta_ab : event.romance_delta_ba;
    const tDeltaAB = swapped ? event.trust_delta_ba : event.trust_delta_ab;
    const tDeltaBA = swapped ? event.trust_delta_ab : event.trust_delta_ba;

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

    const newTags = updateTags(rel.tags, {
      avgFriendship,
      maxRomance,
      minRomance,
      avgTrust,
    });

    const oldStatus = rel.status;
    const newStatus = deriveStatus(
      newFriendshipAB,
      newFriendshipBA,
      newRomanceAB,
      newRomanceBA,
      avgTrust,
      newFamiliarity,
    );

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
        average_interaction_sentiment: newSentiment,
        tags: newTags,
        status: newStatus,
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
    rel.average_interaction_sentiment = newSentiment;
    rel.tags = newTags;
    rel.status = newStatus;
    rel.last_updated = now;

    // Log relationship status changes
    if (newStatus !== oldStatus) {
      const nameA = db.select({ name: agents.name }).from(agents).where(eq(agents.id, a)).get()?.name ?? `Agent#${a}`;
      const nameB = db.select({ name: agents.name }).from(agents).where(eq(agents.id, b)).get()?.name ?? `Agent#${b}`;
      db.insert(activityLog).values({
        type: 'relationship',
        message: `${nameA} and ${nameB} are now ${newStatus}.`,
        agent_ids: [a, b],
        timestamp: world.time?.totalTicks ?? 0,
        real_timestamp: now,
      }).run();
    }

    // Mark event as processed
    db.update(relationshipEvents)
      .set({ processed: true })
      .where(eq(relationshipEvents.id, event.id))
      .run();

    dirty = true;
  }

  // --- 3. Relationship Decay ---
  // Only run decay once per game hour (every 60 ticks) to avoid O(n²) work every tick.
  const totalTicks = (world.time?.totalTicks ?? 0);
  if (totalTicks % 60 !== 0) {
    if (dirty) emitter.markDirty('agents.all');
    return;
  }

  const gracePeriodMs =
    CONFIG.RELATIONSHIPS.DECAY_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

  for (const [, rel] of relMap) {
    const timeSinceInteraction = now - rel.last_interaction;
    if (timeSinceInteraction <= gracePeriodMs) continue;

    const daysSinceInteraction = timeSinceInteraction / (24 * 60 * 60 * 1000);
    const decayStrength = Math.min(
      daysSinceInteraction / CONFIG.RELATIONSHIPS.DECAY_MAX_STRENGTH_DAYS,
      1,
    );
    const dailyDecayRate =
      CONFIG.RELATIONSHIPS.DECAY_DAILY_RATE *
      decayStrength *
      (gameHoursElapsed / 24);

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
      const newStatus = deriveStatus(
        newFAB,
        newFBA,
        newRAB,
        newRBA,
        (rel.trust_ab + rel.trust_ba) / 2,
        rel.familiarity,
      );

      db.update(relationships)
        .set({
          friendship_ab: newFAB,
          friendship_ba: newFBA,
          romance_ab: newRAB,
          romance_ba: newRBA,
          status: newStatus,
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
