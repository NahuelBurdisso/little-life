/**
 * The per-tick snapshot the decision phase loads once, and one agent's turn.
 */

import { db } from '../../../db';
import {
  agents, needs, economy, relationships, locations, conversationQueue, conversations, shared_knowledge, goals, worldEvents, worldState,
} from '../../../db/schema';
import { eq, and, gt } from 'drizzle-orm';
import { CONFIG } from '../../../lib/constants';
import { gameMinutes } from '../../../lib/gameClock';
import { gameMinutesToMs } from '../../../lib/worldClock';
import { countNegativeFactsBySubject } from '../../../lib/gossip';
import { withFamilies } from '../../../data/worldEventCatalog';
import { campaignCandidates } from '../../../lib/townCalendar';
import { conversationBacklog } from '../../../lib/conversationTier';
import { getLLMBacklog } from '../../../ai/llmSemaphore';
import { turnLatencyEstimateMs } from '../../../lib/conversationPacing';
import type {
  AgentRow, NeedsRow, EconRow, LocationRow, RelRow, WorldRow, GoalRow, QueueRow, ConversationRow, KnowledgeRow, WorldEventRow,
} from './types';
import { pairKey } from './state';
import type { MealPlan } from './meals';

/**
 * Everything the decision pass loads once per tick (`loadDecisionContext`).
 * One instance is handed to every agent's turn and to the passes after the
 * loop, so what a step changes the later ones see: `allQueuedConvos` is
 * pushed to as conversations are queued, which is how a pair queued by one
 * agent is not queued again by the other, nor by the location encounters.
 */
export interface DecisionTickContext {
  world: WorldRow;
  activeAgents: AgentRow[];
  allLocations: LocationRow[];
  allRelationships: RelRow[];
  needsMap: Map<number, NeedsRow>;
  econMap: Map<number, EconRow>;
  goalsMap: Map<number, GoalRow[]>;
  allQueuedConvos: QueueRow[];
  allActiveConvos: ConversationRow[];
  pairOnCooldown: (a: number, b: number) => boolean;
  tierBudget: { backlog: number; population: number; latencyMs: number | null };
  allActiveKnowledge: KnowledgeRow[];
  negativeFactCounts: Map<number, number>;
  activeWorldEvents: WorldEventRow[];
  activeEventTypes: Set<string>;
  campaigners: Set<number>;
  currentWeather: string;
  nowMinutes: number;
}

/** One agent's own reads for their turn, worked out once it gets past the jail and the plan request. */
export interface AgentTurn {
  agent: AgentRow;
  agentNeeds: NeedsRow;
  agentEcon: EconRow | null;
  critical: number;
  mealPlan: (requested: number | undefined) => MealPlan | null;
}

/** Where a decision sends the agent (`resolveDestination`): the door, the spot inside, and the zone it matched. */
export interface DecisionDestination {
  destination: { x: number; y: number; locationId?: number } | null;
  zoneTarget: { x: number; y: number } | null;
  matchedZoneId: string | undefined;
  matchedBuildingType: string | undefined;
  seatedZone: boolean;
}

/** Load once what every agent's turn reads (see `DecisionTickContext`). */
export function loadDecisionContext(world: WorldRow): DecisionTickContext {
  const activeAgents = db
    .select()
    .from(agents)
    .where(eq(agents.is_active, true))
    .all();
  const allLocations = db.select().from(locations).all();
  const allRelationships = db.select().from(relationships).all();

  // Pre-load per-agent data into Maps to avoid N queries in the loop
  const allNeeds = db.select().from(needs).all();
  const needsMap = new Map(allNeeds.map(n => [n.agent_id, n]));
  const allEcon = db.select().from(economy).all();
  const econMap = new Map(allEcon.map(e => [e.agent_id, e]));

  // Pre-load active goals for goal alignment scoring
  const allActiveGoals = db.select().from(goals).where(eq(goals.status, 'active')).all();
  const goalsMap = new Map<number, (typeof allActiveGoals)>();
  for (const g of allActiveGoals) {
    const arr = goalsMap.get(g.agent_id) ?? [];
    arr.push(g);
    goalsMap.set(g.agent_id, arr);
  }

  // Cache conversation/queue data once per tick to avoid repeated full-table scans
  const allQueuedConvos = db.select().from(conversationQueue).all();
  const allActiveConvos = db.select().from(conversations).where(eq(conversations.status, 'active')).all();
  // Same-pair cooldown. Only conversations that ended inside the cooldown window
  // can block a pair, so load just those and index them by pair. This used to
  // load every ended conversation ever, every tick, then filter + sort that list
  // once per candidate pair — cost grew without bound as the town talked.
  // `ended_at` is Date.now(), so the game-hour cooldown is converted to wall
  // clock at the current speed. It was `hours * 60 * 1000` ms, i.e. one real
  // second per game minute: right at 1x, two game hours at 4x.
  const pairCooldownMs = gameMinutesToMs(CONFIG.CONVERSATIONS.COOLDOWN_SAME_PAIR_HOURS * 60, world.tick_speed);
  const lastEndedByPair = new Map<string, number>();
  for (const c of db.select({ ended_at: conversations.ended_at, participants: conversations.participants })
    .from(conversations)
    .where(and(eq(conversations.status, 'ended'), gt(conversations.ended_at, Date.now() - pairCooldownMs)))
    .all()) {
    const p = c.participants as number[];
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const key = pairKey(p[i], p[j]);
        lastEndedByPair.set(key, Math.max(lastEndedByPair.get(key) ?? 0, c.ended_at ?? 0));
      }
    }
  }
  const pairOnCooldown = (a: number, b: number) => {
    const endedAt = lastEndedByPair.get(pairKey(a, b));
    return endedAt !== undefined && Date.now() - endedAt < pairCooldownMs;
  };

  // What the model can afford this tick, read once for every conversation the
  // pass queues (lib/conversationTier.ts): with the slots full and requests
  // backed up, off-screen small talk becomes a template chat and the pair on
  // screen goes first. Active conversations are LLM ones — a template chat is
  // written already ended.
  const tierBudget = {
    backlog: conversationBacklog({
      semaphoreWaiting: getLLMBacklog(),
      activeLLMConversations: allActiveConvos.length,
      maxConcurrentLLM: CONFIG.CONVERSATIONS.MAX_CONCURRENT_LLM,
      queuedLLMEntries: allQueuedConvos.filter(q => q.tier !== 'template').length,
    }),
    population: activeAgents.length,
    latencyMs: turnLatencyEstimateMs(gameMinutes(world.time)),
  };

  // Cache shared_knowledge for arrest mechanic
  const allActiveKnowledge = db.select().from(shared_knowledge)
    .where(eq(shared_knowledge.is_active, true))
    .all();
  // Negative facts per subject, counted once from that snapshot: scoring
  // socializing priced one shared_knowledge query per (agent, co-located other)
  // per tick, and the constable check one more per pair.
  const negativeFactCounts = countNegativeFactsBySubject(allActiveKnowledge);

  // Cache active world events — agents react to storms, festivals, etc.
  const activeWorldEvents = db.select().from(worldEvents)
    .where(eq(worldEvents.is_active, true))
    .all();
  // With each event's family (worldEventCatalog EVENT_FAMILY): the Spring Fair
  // pulls the town to the square and boosts socializing exactly like the
  // `festival` rules below, which were all written against the generic type.
  const activeEventTypes = withFamilies(activeWorldEvents.map(e => e.type));
  // Candidates in a running mayoral campaign (lib/townCalendar.ts): they seek
  // company and talk about the vote.
  const campaigners = campaignCandidates();

  // Cache current weather for activity availability
  const worldRow = db.select({ weather: worldState.weather }).from(worldState).limit(1).get();
  const currentWeather = worldRow?.weather ?? 'sunny';

  // Action and agent-state stamps are game minutes (see isActionComplete).
  const nowMinutes = gameMinutes(world.time);

  return {
    world, activeAgents, allLocations, allRelationships, needsMap, econMap, goalsMap,
    allQueuedConvos, allActiveConvos, pairOnCooldown, tierBudget, allActiveKnowledge, negativeFactCounts,
    activeWorldEvents, activeEventTypes, campaigners, currentWeather, nowMinutes,
  };
}
