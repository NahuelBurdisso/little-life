import { db } from '../../db';
import { agents, needs, agentStates, relationships, conversations, conversationQueue, locations } from '../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { simEvents } from '../simEvents';
import { PERCEPTION_REGISTRY, REACTION_TYPES } from './perceptionRegistry';
import type { PerceptionRule } from './types';
import type { PersonalityProfile } from '../personality';
import { gameMinutes, type ClockTime } from '../gameClock';

// ─── Internal Types ───────────────────────────────────────────────────────────

interface AgentData {
  id: number;
  name: string;
  personality: PersonalityProfile | null;
  position: { x: number; y: number };
  current_location: number | null;
  current_action: Record<string, any>;
}

interface NeedData {
  agent_id: number;
  mood: number;
}

interface StateData {
  agent_id: number;
  type: string;
  target_agent_id: number | null;
}

interface RelationshipData {
  agent_a: number;
  agent_b: number;
  friendship_ab: number;
  friendship_ba: number;
  romance_ab: number;
  romance_ba: number;
}

/**
 * Payoff of a passing greeting (`action: 'emote'`). Deliberately far below what
 * a real conversation gives — this is the "nodded at each other in the street"
 * tier, it should register without competing with talking.
 */
const GREETING_FAMILIARITY_GAIN = 0.5;
const GREETING_SOCIAL_GAIN = 2;

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scorePerception(
  rule: PerceptionRule,
  personality: PersonalityProfile,
  friendship: number,
  romance: number,
): number {
  let score = rule.base_score;
  for (const [axis, weight] of Object.entries(rule.personality_weights)) {
    const value = ((personality as any)[axis] ?? 50) / 100;
    score += value * (weight as number) * 100;
  }
  if (rule.relationship_bonus?.friendship_weight) {
    score += (friendship / 100) * rule.relationship_bonus.friendship_weight * 50;
  }
  if (rule.relationship_bonus?.romance_weight) {
    score += (romance / 100) * rule.relationship_bonus.romance_weight * 50;
  }
  return score;
}

// ─── Rule Matching ────────────────────────────────────────────────────────────

function matchesRule(
  rule: PerceptionRule,
  target: AgentData,
  observerRelation: { friendship: number; romance: number },
  targetStates: string[],
  targetMood: number,
): boolean {
  const obs = rule.observes;

  if (obs.target_states && !obs.target_states.some(s => targetStates.includes(s))) return false;
  if (obs.mood_below != null && targetMood >= obs.mood_below) return false;
  if (obs.mood_above != null && targetMood <= obs.mood_above) return false;
  if (obs.min_friendship != null && observerRelation.friendship < obs.min_friendship) return false;
  if (obs.max_friendship != null && observerRelation.friendship > obs.max_friendship) return false;
  if (obs.min_romance != null && observerRelation.romance < obs.min_romance) return false;
  if (obs.target_action) {
    const actionType = (target.current_action as any)?.type;
    if (!obs.target_action.includes(actionType)) return false;
  }

  return true;
}

// ─── PerceptionSystem ─────────────────────────────────────────────────────────

const GLOBAL_PAIR_COOLDOWN = 30; // minimum game minutes between ANY perception for the same observer→target pair
const MAX_RULE_COOLDOWN = 180; // longest cooldown in the perception registry, used for pruning

export class PerceptionSystem {
  /** "agentId-targetId-ruleId" → game minute when this perception last fired */
  private cooldowns: Map<string, number> = new Map();
  /** "agentId-targetId" → game minute when ANY perception last fired for this pair */
  private pairCooldowns: Map<string, number> = new Map();

  /**
   * Remove expired cooldown entries to prevent unbounded Map growth.
   */
  private pruneExpiredCooldowns(nowMinutes: number): void {
    for (const [key, lastFired] of this.cooldowns) {
      if (nowMinutes - lastFired >= MAX_RULE_COOLDOWN) {
        this.cooldowns.delete(key);
      }
    }
    for (const [key, lastFired] of this.pairCooldowns) {
      if (nowMinutes - lastFired >= GLOBAL_PAIR_COOLDOWN) {
        this.pairCooldowns.delete(key);
      }
    }
  }

  scan(world: { time: ClockTime }): void {
    // CLOCK: cooldowns are GAME MINUTES. They were ticks, so at 4x a "2 hour"
    // rule cooldown lasted 8 and the same pair noticed each other a quarter as often.
    const nowMinutes = gameMinutes(world.time);

    this.pruneExpiredCooldowns(nowMinutes);

    // ── 1. Batch-load all data ──────────────────────────────────────────────

    const allAgents: AgentData[] = db
      .select({
        id: agents.id,
        name: agents.name,
        personality: agents.personality,
        position: agents.position,
        current_location: agents.current_location,
        current_action: agents.current_action,
      })
      .from(agents)
      .all() as AgentData[];

    const allNeeds: NeedData[] = db
      .select({ agent_id: needs.agent_id, mood: needs.mood })
      .from(needs)
      .all();

    const allStates: StateData[] = db
      .select({
        agent_id: agentStates.agent_id,
        type: agentStates.type,
        target_agent_id: agentStates.target_agent_id,
      })
      .from(agentStates)
      .all();

    const allRelationships: RelationshipData[] = db
      .select({
        agent_a: relationships.agent_a,
        agent_b: relationships.agent_b,
        friendship_ab: relationships.friendship_ab,
        friendship_ba: relationships.friendship_ba,
        romance_ab: relationships.romance_ab,
        romance_ba: relationships.romance_ba,
      })
      .from(relationships)
      .all();

    // ── 2. Build lookup Maps ────────────────────────────────────────────────

    const needsByAgent = new Map<number, number>(); // agentId → mood
    for (const n of allNeeds) {
      needsByAgent.set(n.agent_id, n.mood);
    }

    // agentId → string[] of state types
    const statesByAgent = new Map<number, string[]>();
    // agentId → full state records (for target_is_state_target check)
    const stateRecordsByAgent = new Map<number, StateData[]>();
    for (const s of allStates) {
      if (!statesByAgent.has(s.agent_id)) statesByAgent.set(s.agent_id, []);
      statesByAgent.get(s.agent_id)!.push(s.type);
      if (!stateRecordsByAgent.has(s.agent_id)) stateRecordsByAgent.set(s.agent_id, []);
      stateRecordsByAgent.get(s.agent_id)!.push(s);
    }

    // "min(a,b)-max(a,b)" → RelationshipData
    const relMap = new Map<string, RelationshipData>();
    for (const r of allRelationships) {
      relMap.set(`${r.agent_a}-${r.agent_b}`, r);
    }

    // ── 3. Load active conversations to avoid double-queuing ────────────────

    const activeConvs = db
      .select({ participants: conversations.participants })
      .from(conversations)
      .where(eq(conversations.status, 'active'))
      .all();

    const queuedConvs = db
      .select({ participants: conversationQueue.participants })
      .from(conversationQueue)
      .all();

    // agentId → Set of partner agentIds already in conversation or queue
    const busyPartners = new Map<number, Set<number>>();
    const addBusy = (participants: number[]) => {
      for (let i = 0; i < participants.length; i++) {
        for (let j = 0; j < participants.length; j++) {
          if (i === j) continue;
          if (!busyPartners.has(participants[i])) busyPartners.set(participants[i], new Set());
          busyPartners.get(participants[i])!.add(participants[j]);
        }
      }
    };
    for (const c of activeConvs) addBusy(c.participants);
    for (const q of queuedConvs) addBusy(q.participants);

    // ── 4. Filter to active agents (not dead, not sleeping) ─────────────────

    const activeAgents = allAgents.filter(a => {
      const actionType = a.current_action?.type;
      return actionType !== 'dead' && actionType !== 'sleeping';
    });

    // ── 5. Main perception loop ─────────────────────────────────────────────

    for (const observer of activeAgents) {
      // Find visible agents: same location OR distance < 80px
      const visibleTargets = activeAgents.filter(target => {
        if (target.id === observer.id) return false;

        if (
          observer.current_location !== null &&
          target.current_location !== null &&
          observer.current_location === target.current_location
        ) {
          return true;
        }

        const dx = (observer.position?.x ?? 0) - (target.position?.x ?? 0);
        const dy = (observer.position?.y ?? 0) - (target.position?.y ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy);
        return dist < 80;
      });

      for (const target of visibleTargets) {
        const targetMood = needsByAgent.get(target.id) ?? 50;
        const targetStates = statesByAgent.get(target.id) ?? [];
        const targetStateRecords = stateRecordsByAgent.get(target.id) ?? [];

        // Retrieve relationship from observer's perspective
        const relKey1 = `${observer.id}-${target.id}`;
        const relKey2 = `${target.id}-${observer.id}`;
        const rel = relMap.get(relKey1) ?? relMap.get(relKey2) ?? null;

        let friendship = 0;
        let romance = 0;
        if (rel) {
          if (rel.agent_a === observer.id) {
            friendship = rel.friendship_ab;
            romance = rel.romance_ab;
          } else {
            friendship = rel.friendship_ba;
            romance = rel.romance_ba;
          }
        }

        const observerRelation = { friendship, romance };

        // Global pair cooldown: skip if ANY perception fired recently for this pair
        const pairKey = `${observer.id}-${target.id}`;
        const lastPairFired = this.pairCooldowns.get(pairKey) ?? -Infinity;
        if (nowMinutes - lastPairFired < GLOBAL_PAIR_COOLDOWN) continue;

        // Evaluate all rules, collect matches with scores
        let bestScore = 30; // threshold
        let bestRule: PerceptionRule | null = null;

        for (const rule of PERCEPTION_REGISTRY) {
          // Check cooldown
          const cooldownKey = `${observer.id}-${target.id}-${rule.id}`;
          const lastFired = this.cooldowns.get(cooldownKey) ?? -Infinity;
          if (nowMinutes - lastFired < rule.cooldown) continue;

          // Handle target_is_state_target separately (needs state records)
          if (rule.observes.target_is_state_target) {
            const matchingState = targetStateRecords.find(s => s.target_agent_id === observer.id);
            if (!matchingState) continue;
          }

          if (!matchesRule(rule, target, observerRelation, targetStates, targetMood)) continue;

          // Score this rule
          const personality = observer.personality ?? {
            honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50,
            vanity: 50, curiosity: 50, loyalty: 50, morality: 50,
            sensuality: 50, neuroticism: 50,
          };
          const score = scorePerception(rule, personality, friendship, romance);

          if (score > bestScore) {
            bestScore = score;
            bestRule = rule;
          }
        }

        if (!bestRule) continue;

        // Fire the best rule
        const cooldownKey = `${observer.id}-${target.id}-${bestRule.id}`;
        this.cooldowns.set(cooldownKey, nowMinutes);
        this.pairCooldowns.set(pairKey, nowMinutes);

        const reaction = REACTION_TYPES[bestRule.reaction];
        if (!reaction) continue;

        // Emit perception memory event
        simEvents.emit('perception:observed', {
          agentId: observer.id,
          targetName: target.name,
          templateKey: reaction.memory_template,
        });

        // Execute reaction
        if (reaction.action === 'approach' && reaction.conversation_topic) {
          // Check if either party is already busy with this partner
          const observerBusy = busyPartners.get(observer.id)?.has(target.id) ?? false;
          const targetBusy = busyPartners.get(target.id)?.has(observer.id) ?? false;

          if (!observerBusy && !targetBusy) {
            const tier = reaction.conversation_tier ?? 'template';
            const priority = Math.round(bestScore);

            db.insert(conversationQueue)
              .values({
                participants: [observer.id, target.id],
                tier,
                priority,
                trigger_reason: reaction.trigger_reason,
                topic: reaction.conversation_topic,
                queued_at: Date.now(),
                max_wait: 10000,
              })
              .run();

            // Mark this pair as busy so subsequent perception pairs don't double-queue
            addBusy([observer.id, target.id]);
          }
        } else if (reaction.action === 'emote') {
          // A greeting in passing. No conversation row, no memory-bearing
          // exchange — just an overhead emote plus a small social payoff.
          // `scan` runs after every system phase, so nothing overwrites
          // `current_action` before the client polls; next tick's decisions
          // phase replaces it, which is what makes the marker short-lived.
          const stamped = {
            ...(observer.current_action ?? {}),
            emote: reaction.emote ?? 'wave',
            emote_at: Date.now(),
          };
          observer.current_action = stamped;
          db.update(agents)
            .set({ current_action: stamped })
            .where(eq(agents.id, observer.id))
            .run();

          const [relA, relB] = observer.id < target.id
            ? [observer.id, target.id]
            : [target.id, observer.id];
          if (relMap.has(`${relA}-${relB}`)) {
            db.update(relationships)
              .set({
                familiarity: sql`min(100, ${relationships.familiarity} + ${GREETING_FAMILIARITY_GAIN})`,
                last_updated: Date.now(),
              })
              .where(and(eq(relationships.agent_a, relA), eq(relationships.agent_b, relB)))
              .run();
          }

          db.update(needs)
            .set({ social: sql`min(100, ${needs.social} + ${GREETING_SOCIAL_GAIN})` })
            .where(eq(needs.agent_id, observer.id))
            .run();
        } else if (reaction.action === 'leave') {
          // Send agent walking home
          const observerRow = db.select({ home: agents.home })
            .from(agents).where(eq(agents.id, observer.id)).get();
          if (observerRow?.home) {
            const homeLoc = db.select({ entry_point: locations.entry_point })
              .from(locations).where(eq(locations.id, observerRow.home)).get();
            if (homeLoc) {
              const ep = homeLoc.entry_point as { x: number; y: number };
              db.update(agents).set({
                current_action: { type: 'walking', to: ep },
                current_destination: { x: ep.x, y: ep.y, locationId: observerRow.home },
                current_path: null,
                action_queue: [{ type: 'idle' }],
              }).where(eq(agents.id, observer.id)).run();
            }
          }
        }
      }
    }
  }

  clear(): void {
    this.cooldowns.clear();
    this.pairCooldowns.clear();
  }
}
