import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { clamp } from "../lib/utils";
import { RelationshipStatus } from "../lib/types";
import { CONFIG } from "../engine/constants";

const STATIC_TAGS = new Set(["coworker", "neighbor", "family", "roommate"]);

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

  if (minRomance > 70 && avgFriendship > 30) return "partners";
  if (maxRomance > 30 && avgFriendship < -10) return "complicated";
  if (maxRomance > 30) return "romantic_interest";
  if (avgFriendship > 90) return "best_friends";
  if (avgFriendship > 70) return "close_friends";
  if (avgFriendship > 40) return "friends";
  if (avgFriendship < -70) return "enemies";
  if (avgFriendship < -40) return "rivals";
  if (familiarity > 10) return "acquaintances";
  return "strangers";
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

  // best_friend
  if (metrics.avgFriendship > 80) {
    tags.add("best_friend");
  } else {
    if (!STATIC_TAGS.has("best_friend")) tags.delete("best_friend");
  }

  // rival
  if (metrics.avgFriendship < -50) {
    tags.add("rival");
  } else {
    if (!STATIC_TAGS.has("rival")) tags.delete("rival");
  }

  // crush / partner
  if (metrics.minRomance > 70) {
    tags.delete("crush");
    tags.add("partner");
  } else if (metrics.maxRomance > 40) {
    tags.delete("partner");
    tags.add("crush");
  } else {
    if (!STATIC_TAGS.has("crush")) tags.delete("crush");
    if (!STATIC_TAGS.has("partner")) tags.delete("partner");
  }

  // trusted
  if (metrics.avgTrust > 60) {
    tags.add("trusted");
  } else {
    if (!STATIC_TAGS.has("trusted")) tags.delete("trusted");
  }

  // distrusted
  if (metrics.avgTrust < -40) {
    tags.add("distrusted");
  } else {
    if (!STATIC_TAGS.has("distrusted")) tags.delete("distrusted");
  }

  return Array.from(tags);
}

function normalizePair(
  agentA: Id<"agents">,
  agentB: Id<"agents">,
): [Id<"agents">, Id<"agents">, boolean] {
  const swapped = agentA > agentB;
  const a = swapped ? agentB : agentA;
  const b = swapped ? agentA : agentB;
  return [a, b, swapped];
}

export async function tick(
  ctx: MutationCtx,
  world: Doc<"worldState">,
): Promise<void> {
  const gameHoursElapsed = world.tickSpeed / 60;
  const now = Date.now();

  // --- 1. Proximity Familiarity ---
  const agents = await ctx.db
    .query("agents")
    .filter((q) => q.eq(q.field("isActive"), true))
    .collect();

  // Group agents by currentLocation (skip null)
  const locationGroups = new Map<string, Doc<"agents">[]>();
  for (const agent of agents) {
    if (agent.currentLocation !== null) {
      const key = agent.currentLocation as string;
      const group = locationGroups.get(key);
      if (group) {
        group.push(agent);
      } else {
        locationGroups.set(key, [agent]);
      }
    }
  }

  // Load all relationships into a map for fast lookup
  const allRels = await ctx.db.query("relationships").collect();
  const relMap = new Map<string, Doc<"relationships">>();
  for (const rel of allRels) {
    relMap.set(`${rel.agentA}:${rel.agentB}`, rel);
  }

  for (const [, group] of locationGroups) {
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = normalizePair(group[i]._id, group[j]._id);
        const key = `${a}:${b}`;
        const existing = relMap.get(key);

        if (existing) {
          const gain =
            CONFIG.RELATIONSHIPS.PROXIMITY_FAMILIARITY_RATE *
            gameHoursElapsed *
            (1 - existing.familiarity / 100);
          if (gain > 0.001) {
            const newFamiliarity = clamp(existing.familiarity + gain, 0, 100);
            await ctx.db.patch(existing._id, {
              familiarity: newFamiliarity,
              lastUpdated: now,
            });
            // Update local cache
            existing.familiarity = newFamiliarity;
            existing.lastUpdated = now;
          }
        } else {
          const newRel = {
            agentA: a,
            agentB: b,
            friendshipAB: 0,
            friendshipBA: 0,
            romanceAB: 0,
            romanceBA: 0,
            trustAB: 0,
            trustBA: 0,
            familiarity: 1,
            interactionCount: 0,
            lastInteraction: now,
            averageInteractionSentiment: 0,
            tags: [] as string[],
            status: "strangers" as string,
            createdAt: now,
            lastUpdated: now,
          };
          const id = await ctx.db.insert("relationships", newRel);
          const doc = { ...newRel, _id: id, _creationTime: now } as Doc<"relationships">;
          relMap.set(key, doc);
        }
      }
    }
  }

  // --- 2. Process Relationship Events ---
  const events = await ctx.db
    .query("relationshipEvents")
    .withIndex("by_processed", (q) => q.eq("processed", false))
    .collect();

  for (const event of events) {
    const [a, b, swapped] = normalizePair(event.agentA, event.agentB);
    const key = `${a}:${b}`;
    let rel = relMap.get(key);

    if (!rel) {
      // Create relationship on the fly
      const newRel = {
        agentA: a,
        agentB: b,
        friendshipAB: 0,
        friendshipBA: 0,
        romanceAB: 0,
        romanceBA: 0,
        trustAB: 0,
        trustBA: 0,
        familiarity: 1,
        interactionCount: 0,
        lastInteraction: now,
        averageInteractionSentiment: 0,
        tags: [] as string[],
        status: "strangers" as string,
        createdAt: now,
        lastUpdated: now,
      };
      const id = await ctx.db.insert("relationships", newRel);
      rel = { ...newRel, _id: id, _creationTime: now } as Doc<"relationships">;
      relMap.set(key, rel);
    }

    // Resolve directional deltas. If the event's agentA/agentB were swapped
    // during normalization, we need to swap the AB/BA deltas too.
    const fDeltaAB = swapped ? event.friendshipDeltaBA : event.friendshipDeltaAB;
    const fDeltaBA = swapped ? event.friendshipDeltaAB : event.friendshipDeltaBA;
    const rDeltaAB = swapped ? event.romanceDeltaBA : event.romanceDeltaAB;
    const rDeltaBA = swapped ? event.romanceDeltaAB : event.romanceDeltaBA;
    const tDeltaAB = swapped ? event.trustDeltaBA : event.trustDeltaAB;
    const tDeltaBA = swapped ? event.trustDeltaAB : event.trustDeltaBA;

    const newFriendshipAB = clamp(
      rel.friendshipAB + applyDiminishing(rel.friendshipAB, fDeltaAB),
      -100,
      100,
    );
    const newFriendshipBA = clamp(
      rel.friendshipBA + applyDiminishing(rel.friendshipBA, fDeltaBA),
      -100,
      100,
    );
    const newRomanceAB = clamp(
      rel.romanceAB + applyDiminishing(rel.romanceAB, rDeltaAB),
      -100,
      100,
    );
    const newRomanceBA = clamp(
      rel.romanceBA + applyDiminishing(rel.romanceBA, rDeltaBA),
      -100,
      100,
    );
    const newTrustAB = clamp(
      rel.trustAB + applyDiminishing(rel.trustAB, tDeltaAB),
      -100,
      100,
    );
    const newTrustBA = clamp(
      rel.trustBA + applyDiminishing(rel.trustBA, tDeltaBA),
      -100,
      100,
    );

    const newFamiliarity = clamp(rel.familiarity + 2, 0, 100);
    const newInteractionCount = rel.interactionCount + 1;

    // Running average of sentiment
    const newSentiment =
      (rel.averageInteractionSentiment * rel.interactionCount +
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

    const newStatus = deriveStatus(
      newFriendshipAB,
      newFriendshipBA,
      newRomanceAB,
      newRomanceBA,
      avgTrust,
      newFamiliarity,
    );

    await ctx.db.patch(rel._id, {
      friendshipAB: newFriendshipAB,
      friendshipBA: newFriendshipBA,
      romanceAB: newRomanceAB,
      romanceBA: newRomanceBA,
      trustAB: newTrustAB,
      trustBA: newTrustBA,
      familiarity: newFamiliarity,
      interactionCount: newInteractionCount,
      lastInteraction: now,
      averageInteractionSentiment: newSentiment,
      tags: newTags,
      status: newStatus,
      lastUpdated: now,
    });

    // Update local cache
    rel.friendshipAB = newFriendshipAB;
    rel.friendshipBA = newFriendshipBA;
    rel.romanceAB = newRomanceAB;
    rel.romanceBA = newRomanceBA;
    rel.trustAB = newTrustAB;
    rel.trustBA = newTrustBA;
    rel.familiarity = newFamiliarity;
    rel.interactionCount = newInteractionCount;
    rel.lastInteraction = now;
    rel.averageInteractionSentiment = newSentiment;
    rel.tags = newTags;
    rel.status = newStatus;
    rel.lastUpdated = now;

    // Mark event as processed
    await ctx.db.patch(event._id, { processed: true });
  }

  // --- 3. Relationship Decay ---
  const gracePeriodMs =
    CONFIG.RELATIONSHIPS.DECAY_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

  for (const [, rel] of relMap) {
    const timeSinceInteraction = now - rel.lastInteraction;
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

    // Helper to decay a value toward 0
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

    const newFAB = decayValue(rel.friendshipAB, 1);
    const newFBA = decayValue(rel.friendshipBA, 1);
    const newRAB = decayValue(
      rel.romanceAB,
      CONFIG.RELATIONSHIPS.ROMANCE_DECAY_MULTIPLIER,
    );
    const newRBA = decayValue(
      rel.romanceBA,
      CONFIG.RELATIONSHIPS.ROMANCE_DECAY_MULTIPLIER,
    );

    if (
      newFAB !== rel.friendshipAB ||
      newFBA !== rel.friendshipBA ||
      newRAB !== rel.romanceAB ||
      newRBA !== rel.romanceBA
    ) {
      changed = true;
    }

    if (changed) {
      const newStatus = deriveStatus(
        newFAB,
        newFBA,
        newRAB,
        newRBA,
        (rel.trustAB + rel.trustBA) / 2,
        rel.familiarity,
      );

      await ctx.db.patch(rel._id, {
        friendshipAB: newFAB,
        friendshipBA: newFBA,
        romanceAB: newRAB,
        romanceBA: newRBA,
        status: newStatus,
        lastUpdated: now,
      });
    }
  }
}
