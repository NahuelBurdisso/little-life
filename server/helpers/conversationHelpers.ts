import { db } from '../db';
import { agents, needs, economy, conversations, relationships, locations, worldState, agentStates, shared_knowledge, goals } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';

import { getEffectivePersonality, getActiveStatePrompts, getAgentStates } from '../lib/states';
import { getShareableFacts, getAgentName } from '../lib/gossip';
import type { MemoryRow } from '../ai/prompts';
import { isFallbackMessage } from '../ai/sanitizeDialogue';
import { contextBuilder, memoryService } from '../lib/memory/instance';
import { generateSituationalPrompt } from '../lib/personality';
import { getReputation, getReputationLabel } from '../lib/reputationEngine';
import { getAgentHobbies } from '../lib/hobbyEngine';
import { getMoodMomentum } from '../lib/moodMomentum';
import { gameMinutes } from '../lib/gameClock';
import { goalClause } from '../lib/goalText';
import { firstName } from '../ai/names';
import { isNewcomer } from '../lib/newcomers';
import { selfFactsFor } from './selfFactsStore';
import { repeatedSubjects } from '../lib/topicMemory';

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
  otherJobTitle: string | null;
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

/**
 * The speaker's goals as the "Your goals:" line of a dialogue prompt (at most 3).
 *
 * Trigger- and cascade-made goals have no text of their own: a boot backfill
 * (db/index.ts) copies their registry key into `description`, so the prompt read
 * "Your goals: Keep a watchful eye on the Constable's temperament.; protect"
 * (playtest #3) — a bare verb the model can't place, after a doubled ".;".
 * `goalClause` turns keys into prose and drops trailing full stops; a keyed goal
 * with a target names them ("looking after Rosa"), since "someone" says nothing.
 */
export function goalPromptLines(
  rows: ReadonlyArray<{ type: string; description: string | null; target_id: number | null }>,
  nameOf: (id: number) => string,
): string[] {
  return rows
    .filter((g) => g.description && g.description.trim())
    .slice(0, 3)
    .map((g) => {
      const clause = goalClause(g.description);
      const keyed = g.description!.trim() === g.type;
      return keyed && g.target_id != null
        ? clause.replace(/\bsomeone\b/, firstName(nameOf(g.target_id)))
        : clause;
    });
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
      // Tenure, years in town, household — stable numbers the model must not reinvent.
      selfFacts: selfFactsFor(speaker, speakerEcon?.job_title ?? null, world.time?.totalTicks ?? 0),
    };

    const otherJobTitle = db.select({ t: economy.job_title }).from(economy).where(eq(economy.agent_id, otherId)).get()?.t ?? null;
    cached = { speaker, otherAgent, relationship, location, effectivePersonality, enrichment, speakerEcon, otherJobTitle };
    identityCache.set(cacheKey, cached);
  }

  const { speaker, otherAgent, location, effectivePersonality, enrichment, otherJobTitle } = cached;

  // Needs and economy change every turn — always reload
  const speakerNeeds = db.select().from(needs).where(eq(needs.agent_id, speakerId)).get();
  const speakerEcon = db.select().from(economy).where(eq(economy.agent_id, speakerId)).get();
  if (!speakerNeeds || !speakerEcon) return null;

  // Load speaker's active goals for conversation context
  const allGoals = db.select().from(goals)
    .where(and(eq(goals.agent_id, speakerId), eq(goals.status, 'active')))
    .all();
  const speakerGoals = goalPromptLines(allGoals, (id) => getAgentName(id));

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
  const statePrompts = getActiveStatePrompts(speaker.id, world?.time ? gameMinutes(world.time) : undefined);

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

  // Only a recent arrival is met for the first time; everyone else in town is
  // known by sight and reputation (prompts.ts `firstMeetingOf`).
  // Subjects the speaker kept returning to in other conversations today.
  const recentSubjects = world.time ? repeatedSubjects(speakerId, gameMinutes(world.time)) : [];

  const newcomer: 'speaker' | 'listener' | null = isNewcomer(speaker.created_at, currentTick)
    ? 'speaker'
    : isNewcomer(otherAgent.created_at, currentTick) ? 'listener' : null;

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
    newcomer,
    otherJobTitle,
    recentSubjects,
  };
}

export function addMessage(
  conversationId: number,
  speakerId: number,
  text: string,
  sentiment: number,
  topics: string[],
  timestamp: number,
  /** The text is a canned fallback action, not speech (see sanitizeDialogue.ts). */
  fallback = false,
) {
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  // A timeout force-end can land while taskRunner is mid-turn. Appending here
  // kept the ended transcript growing and, because the caller saw a normal
  // result, chained yet another critical-priority LLM turn onto a dead conversation.
  if (!conversation || conversation.status === 'ended') return null;
  // Same for a conversation the scheduler has closed but not yet ended: when a
  // wrap-up gives up on the in-flight turn it appends the farewell and lowers
  // `max_turns` to the transcript length, and a reply landing after that would
  // follow the goodbye. The runner never starts a turn past `max_turns`, so
  // this only ever refuses such a late line.
  if ((conversation.messages as unknown[]).length >= conversation.max_turns) return null;

  const messages = [
    ...(conversation.messages as Array<Record<string, unknown>>),
    {
      speakerId,
      text,
      sentiment,
      topics,
      timestamp,
      // Always written, true or false: its presence is what tells a new
      // message from a legacy one (see isFallbackMessage).
      fallback,
    },
  ];

  db.update(conversations).set({ messages }).where(eq(conversations.id, conversationId)).run();
  return { messageCount: messages.length, maxTurns: conversation.max_turns };
}

/**
 * `isFallbackMessage` for one conversation's transcript. Loads the participants'
 * names once: a legacy message (stored before the `fallback` flag) only counts
 * as a canned fallback if it is the exact canned line with its speaker's name.
 */
export function fallbackDetector(
  participantIds: number[],
): (msg: { speakerId: number; text?: string; fallback?: boolean }) => boolean {
  const names = new Map(
    db.select({ id: agents.id, name: agents.name }).from(agents)
      .where(inArray(agents.id, participantIds)).all()
      .map((a) => [a.id, a.name] as const),
  );
  return (msg) => isFallbackMessage(msg, names.get(msg.speakerId));
}

export function markConversationEnded(conversationId: number) {
  clearConversationCache(conversationId);
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conversation || conversation.status === 'ended') return;

  // Canned fallback actions aren't speech; they don't count toward the mood.
  const isFallback = fallbackDetector(conversation.participants as number[]);
  const msgs = (conversation.messages as Array<{ speakerId: number; text?: string; sentiment?: number; fallback?: boolean }>)
    .filter((m) => !isFallback(m));
  const avgSentiment =
    msgs.length > 0
      ? msgs.reduce((sum, m) => sum + (m.sentiment ?? 0), 0) / msgs.length
      : 0;

  db.update(conversations)
    .set({ status: 'ended', ended_at: Date.now(), sentiment: avgSentiment })
    .where(eq(conversations.id, conversationId))
    .run();
}
