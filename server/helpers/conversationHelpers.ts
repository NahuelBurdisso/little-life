import { db } from '../db';
import { agents, needs, economy, conversations, relationships, locations, worldState, agentStates, shared_knowledge, goals } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';

import { getEffectivePersonality, getActiveStatePrompts, getAgentStates } from '../lib/states';
import { getShareableFacts, getAgentName } from '../lib/gossip';
import type { MemoryRow } from '../ai/prompts';
import { contextBuilder, memoryService } from '../lib/memory/instance';
import { generateSituationalPrompt } from '../lib/personality';
import { getReputation, getReputationLabel } from '../lib/reputationEngine';
import { getAgentHobbies } from '../lib/hobbyEngine';
import { getMoodMomentum } from '../lib/moodMomentum';

// ─── Conversation Context Cache ───────────────────────────────────────────────
// Caches agent identity, relationship, and enrichment data per conversation.
// These don't change mid-conversation, saving ~10 DB queries per turn.

interface CachedIdentity {
  speaker: any;
  otherAgent: any;
  relationship: any;
  location: any;
  effectivePersonality: any;
  enrichment: any;
  speakerEcon: any;
}

const identityCache = new Map<string, CachedIdentity>(); // key: `${conversationId}:${speakerId}`

export function clearConversationCache(conversationId: number): void {
  for (const key of identityCache.keys()) {
    if (key.startsWith(`${conversationId}:`)) identityCache.delete(key);
  }
}

/**
 * Drop every cached identity for a world replace.
 *
 * Per-conversation eviction only runs on normal conversation completion. A world
 * replace abandons in-flight LLM conversations (the `taskRunner.drain()` race in
 * `setup.replaceWorld`, then `resetSlots()`), so their entries are never evicted.
 * Both `conversations.id` and `agents.id` restart at 1 after the wipe, so the new
 * world's conversation 1 / speaker 1 would otherwise read the previous world's
 * identity, relationship and location straight into the LLM prompt.
 */
export function clearAllConversationCaches(): void {
  identityCache.clear();
}
import { getDrinkCount } from '../lib/tavernEngine';

export async function getConversationContext(conversationId: number, speakerId: number) {
  // Load conversation and world state first (needed to derive otherId and currentTick)
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conversation) return null;

  const otherId = (conversation.participants as number[]).find((p) => p !== speakerId);
  if (!otherId) return null;

  const world = db.select().from(worldState).get();
  if (!world) return null;

  // Check cache for stable identity data (agent, relationship, location, personality)
  const cacheKey = `${conversationId}:${speakerId}`;
  let cached = identityCache.get(cacheKey);

  if (!cached) {
    const location = conversation.location
      ? db.select().from(locations).where(eq(locations.id, conversation.location)).get()
      : null;
    if (!location) return null;

    const agentRows = db.select().from(agents).where(inArray(agents.id, [speakerId, otherId])).all();
    const speaker = agentRows.find((a) => a.id === speakerId);
    const otherAgent = agentRows.find((a) => a.id === otherId);
    if (!speaker || !otherAgent) return null;

    const [a, b] = speakerId < otherId ? [speakerId, otherId] : [otherId, speakerId];
    const relationship = db.select().from(relationships)
      .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b))).get();

    const effectivePersonality = getEffectivePersonality(speaker.id) ?? (speaker.personality as any);
    const speakerEcon = db.select().from(economy).where(eq(economy.agent_id, speakerId)).get();

    const rep = getReputation(speakerId);
    const enrichment = {
      reputationLabel: getReputationLabel(rep),
      reputationScore: rep,
      hobbies: getAgentHobbies(speakerId),
      moodMomentum: getMoodMomentum(speakerId),
      drinkCount: getDrinkCount(speakerId),
    };

    cached = { speaker, otherAgent, relationship, location, effectivePersonality, enrichment, speakerEcon };
    identityCache.set(cacheKey, cached);
  }

  const { speaker, otherAgent, location, effectivePersonality, enrichment } = cached;

  // Needs and economy change every turn — always reload
  const speakerNeeds = db.select().from(needs).where(eq(needs.agent_id, speakerId)).get();
  const speakerEcon = db.select().from(economy).where(eq(economy.agent_id, speakerId)).get();
  if (!speakerNeeds || !speakerEcon) return null;

  // Load speaker's active goals for conversation context
  const allGoals = db.select().from(goals)
    .where(and(eq(goals.agent_id, speakerId), eq(goals.status, 'active')))
    .all();
  const speakerGoals = allGoals
    .filter(g => (g as any).description)
    .map(g => (g as any).description as string)
    .slice(0, 3);

  // Check if any goal targets the conversation partner
  const GOAL_HINTS: Record<string, string> = {
    revenge: 'You want to get back at them. Subtly provoke or confront.',
    seduce: 'You want to win them over romantically. Be charming.',
    befriend: 'You want to become their friend. Be warm and relatable.',
    investigate: 'You want to find out what they know. Ask probing questions.',
    undermine: 'You want to damage their reputation. Be subtly manipulative.',
    protect: 'You feel protective of them. Show you care.',
    comfort_grieving: 'They need comfort. Be gentle and supportive.',
  };
  const targetedGoal = allGoals.find(g => g.target_id === otherId);
  const goalStakes = targetedGoal ? GOAL_HINTS[targetedGoal.type] ?? null : null;

  // Use cached relationship and personality
  const relationship = cached.relationship;

  const otherAgentName = otherAgent.name ?? '';
  const topic = (conversation.topic as string) ?? '';
  const currentTick = world?.time?.totalTicks ?? 0;

  // State prompts change per turn (mood-dependent) — always reload
  const statePrompts = getActiveStatePrompts(speaker.id, world?.time?.totalTicks);

  // Build situational prompt from the speaker's active dramatic states
  const speakerStates = getAgentStates(speakerId);
  let situationalPrompt: string | null = null;
  const otherName = otherAgent.name;

  if (speakerStates.includes('in_debt')) {
    situationalPrompt = generateSituationalPrompt({ type: 'begging', targetName: otherName });
  } else if (speakerStates.includes('jealous')) {
    const jealousState = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, speakerId), eq(agentStates.type, 'jealous'))).get();
    if (jealousState) {
      const meta = (jealousState.metadata as Record<string, any> | null) ?? {};
      const rivalId = meta.rivalId as number | undefined;
      const loveInterestId = meta.loveInterestId as number | undefined;
      if (rivalId && loveInterestId && otherId === rivalId) {
        situationalPrompt = generateSituationalPrompt({
          type: 'jealousy_confrontation',
          loveInterestName: getAgentName(loveInterestId),
          rivalName: otherName,
        });
      }
    }
  } else if (speakerStates.includes('heartbroken')) {
    // Check if otherAgent is the partner who caused heartbreak and speaker knows of an affair
    const affairFact = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.type, 'affair'), eq(shared_knowledge.subject_id, otherId), eq(shared_knowledge.is_active, true))).all()
      .find(f => (f.known_by as number[]).includes(speakerId));
    if (affairFact) {
      const rivalId = affairFact.target_id;
      situationalPrompt = generateSituationalPrompt({
        type: 'affair_discovery',
        targetName: otherName,
        rivalName: rivalId ? getAgentName(rivalId) : 'someone else',
      });
    }
  }

  // Sync tick so retrieval scoring is accurate
  memoryService.setTick(currentTick);

  // Retrieve memories using the new memory stream ContextBuilder
  const contextItems = await contextBuilder.forConversation({
    agentId: speakerId,
    otherAgentName,
    topic,
    statePrompts,
    situationalPrompt,
  });

  // Extract memory descriptions to pass as MemoryRow-compatible objects for the prompt builder
  const relevantMemories: MemoryRow[] = contextItems
    .filter(item => item.type === 'memory')
    .map((item, idx) => ({
      id: -(idx + 1), // placeholder ID since these come from retrieval, not direct DB query
      agent_id: speakerId,
      description: item.text,
      type: 'retrieved',
      importance: 5,
      emotional_valence: 0,
      embedding: null,
      depth: 0,
      created_at: currentTick,
      last_accessed: currentTick,
      metadata: {} as Record<string, unknown>,
      is_active: 1,
      parent_ids: [],
    }));

  const gossipFacts = effectivePersonality
    ? getShareableFacts(speakerId, otherAgent!.id, effectivePersonality as any)
    : [];

  // Every townsperson's name, so the dialogue sanitiser can spot a reply that
  // opens by addressing someone who isn't in the conversation. Read per turn
  // rather than cached: a ~13-row select is cheaper than keeping a per-world
  // cache honest across world replaces and newcomers. Inactive agents stay in —
  // greeting the dead by name is just as wrong.
  const townNames = db.select({ name: agents.name }).from(agents).all().map((a) => a.name);

  return {
    conversation,
    speaker,
    speakerNeeds,
    speakerEcon,
    otherAgent,
    relationship,
    memories: relevantMemories,
    location,
    world,
    effectivePersonality,
    statePrompts,
    gossipFacts,
    situationalPrompt,
    speakerGoals,
    enrichment,
    goalStakes,
    townNames,
  };
}

export function addMessage(
  conversationId: number,
  speakerId: number,
  text: string,
  sentiment: number,
  topics: string[],
  timestamp: number,
) {
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  // A timeout force-end can land while taskRunner is mid-turn. Appending here
  // kept the ended transcript growing and, because the caller saw a normal
  // result, chained yet another critical-priority LLM turn onto a dead conversation.
  if (!conversation || conversation.status === 'ended') return null;

  const messages = [
    ...(conversation.messages as Array<Record<string, unknown>>),
    {
      speakerId,
      text,
      sentiment,
      topics,
      timestamp,
    },
  ];

  db.update(conversations).set({ messages }).where(eq(conversations.id, conversationId)).run();
  return { messageCount: messages.length, maxTurns: conversation.max_turns };
}

export function markConversationEnded(conversationId: number) {
  clearConversationCache(conversationId);
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conversation || conversation.status === 'ended') return;

  const msgs = conversation.messages as Array<{ sentiment?: number }>;
  const avgSentiment =
    msgs.length > 0
      ? msgs.reduce((sum, m) => sum + (m.sentiment ?? 0), 0) / msgs.length
      : 0;

  db.update(conversations)
    .set({ status: 'ended', ended_at: Date.now(), sentiment: avgSentiment })
    .where(eq(conversations.id, conversationId))
    .run();
}
