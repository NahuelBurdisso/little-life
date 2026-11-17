/**
 * Queueing the conversation a socializing decision asks for, and choosing its topic.
 */

import { db } from '../../../db';
import { conversationQueue } from '../../../db/schema';
import { logActivity } from '../../../lib/activityLogger';
import { CONFIG } from '../../../lib/constants';
import { gameMinutes } from '../../../lib/gameClock';
import { distance } from '../../../lib/utils';
import { PersonalityProfile, selectPersonalityTopic } from '../../../lib/personality';
import { getAgentStates } from '../../../lib/states';
import { getShareableFacts, getAgentName } from '../../../lib/gossip';
import { getSharedHobbies } from '../../../lib/hobbyEngine';
import { completeComfortVisit } from '../../../lib/lonelinessEngine';
import { newbornOf } from '../../../lib/familyState';
import { congratsTopic } from '../../../ai/prompts';
import { chooseTier, hasDramaticState } from '../../../lib/conversationTier';
import { isAnyWatched } from '../../../lib/spotlight';
import { queueMaxWait } from '../../../lib/conversationPacing';
import type { ScoredAction } from './types';
import { shouldAnnounceDate } from './state';
import { getRelationshipValues, isEvening } from './helpers';
import type { DecisionTickContext, AgentTurn } from './context';

/**
 * Queue the conversation a socializing decision asks for, when the two are
 * together and free to talk. The last step of the agent's turn: each early
 * `return` was a `continue` of the per-agent loop, with nothing after it.
 */
export function queueSocialConversation(t: AgentTurn, decision: ScoredAction, d: DecisionTickContext): void {
  const { agent, agentNeeds } = t;
  const {
    world, activeAgents, allRelationships, allQueuedConvos, allActiveConvos, pairOnCooldown, tierBudget, nowMinutes,
  } = d;
  // Social decisions -> conversation queue (only if agents are at same location)
  // Skip if queue is already full
  if (decision.action === 'socializing' && decision.targetAgentId && decision.source !== 'proposal_seek' && decision.source !== 'rendezvous_seek'
    && allQueuedConvos.length < CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE * 3) {
    const agentId = agent.id;
    const targetId = decision.targetAgentId;

    // Both agents must be at the same location to start a conversation
    const targetAgent = activeAgents.find(a => a.id === targetId);
    if (!targetAgent) return;
    const sameLocation = agent.current_location != null &&
      agent.current_location === targetAgent.current_location;
    const closeEnough = !sameLocation && targetAgent.position &&
      distance(agent.position, targetAgent.position) < 64; // within 2 tiles
    if (!sameLocation && !closeEnough) return;

    // Check if this pair already has a queued conversation (from cached data)
    const existingQueue = allQueuedConvos.filter(q => {
      const p = q.participants as number[];
      return p.includes(agentId) && p.includes(targetId);
    });
    if (existingQueue.length > 0) return; // Already queued

    // Check if this pair already has an active conversation (from cached data)
    const existingActive = allActiveConvos.filter(c => {
      const p = c.participants as number[];
      return p.includes(agentId) && p.includes(targetId);
    });
    if (existingActive.length > 0) return; // Already talking

    // Cooldown: skip if this pair talked recently (prevents pair domination)
    if (pairOnCooldown(agentId, targetId)) return;

    const rel = getRelationshipValues(
      allRelationships,
      agentId,
      targetId,
    );
    const friendship = rel?.friendship ?? 0;
    const romance = rel?.romance ?? 0;

    // Date detection: romantic socializing in evening = date. Announced
    // below, once the chat is actually queued.
    const isDate = romance > 30 && isEvening(world.time.hour);

    // Topic selection: use plan-provided topic if available, else personality-driven
    const agentPersonality = agent.personality as PersonalityProfile | null;
    const topic = chooseConversationTopic(t, decision, { targetId, agentPersonality, friendship, romance, isDate }, d);

    // --- Determine conversation tier: LLM only for meaningful interactions ---
    const agentStatesArr = getAgentStates(agentId);
    // Depressed agents skip conversations entirely — don't queue them
    if ((agentStatesArr as string[]).includes('depressed')) return;
    const targetStatesArr = getAgentStates(targetId);

    // Check familiarity for first meetings
    const relRow = allRelationships.find(
      r => (r.agent_a === agentId && r.agent_b === targetId) ||
           (r.agent_b === agentId && r.agent_a === targetId),
    );

    // A comfort visit is the whole point of the walk over — chooseTier never
    // lets it collapse into a one-line template exchange.
    const isComfortVisit = decision.source === 'comfort_visit';
    const { tier, priority, maxWaitGameMin } = chooseTier({
      ...tierBudget,
      source: 'social',
      friendship,
      romance,
      mood: agentNeeds.mood,
      social: agentNeeds.social,
      dramaticState: hasDramaticState(agentStatesArr, targetStatesArr),
      topic,
      firstMeeting: !relRow || relRow.familiarity < 5,
      // Check for gossip to share
      hasGossip: agentPersonality
        ? getShareableFacts(agentId, targetId, agentPersonality).length > 0
        : false,
      comfortVisit: isComfortVisit,
      watched: isAnyWatched([agentId, targetId]),
      basePriority: Math.round(100 - agentNeeds.social + (friendship > 50 ? 20 : 0)),
    });

    // Recorded in the per-tick snapshot too: it was read once at the top of the
    // pass, so when A and B each decided to socialize with the other in the
    // same tick, both saw an empty queue and [A,B] and [B,A] were both queued.
    // The location-encounter pass below reads the same snapshot.
    allQueuedConvos.push(db.insert(conversationQueue)
      .values({
        participants: [agentId, targetId],
        tier,
        priority,
        trigger_reason: isComfortVisit ? 'comfort_visit' : 'needs_social',
        topic,
        queued_at: Date.now(),
        max_wait: queueMaxWait(maxWaitGameMin),
      })
      .returning()
      .get());
    if (isComfortVisit) completeComfortVisit(agentId);
    if (isDate && shouldAnnounceDate(agentId, targetId, nowMinutes)) {
      logActivity({
        type: 'drama',
        initiator: agentId,
        target: targetId,
        templateData: { description: `${agent.name} and ${targetAgent.name} are on a date` },
        metadata: { beat: 'date' },
      });
    }
  }
}

/** What `chooseConversationTopic` needs to know about the pair. */
interface TopicPair {
  targetId: number;
  agentPersonality: PersonalityProfile | null;
  friendship: number;
  romance: number;
  isDate: boolean;
}

/**
 * The topic of a socializing chat: the decision's own, else the first of the
 * overrides below that applies. Each override draws `Math.random()` only when
 * the ones before it left the topic empty, which is the order the tests sequence.
 */
function chooseConversationTopic(t: AgentTurn, decision: ScoredAction, pair: TopicPair, d: DecisionTickContext): string | null {
  const { agent, agentNeeds, agentEcon } = t;
  const { world, activeAgents, activeEventTypes, campaigners } = d;
  const { targetId, agentPersonality, friendship, romance, isDate } = pair;
  const agentId = agent.id;
  let topic: string | null = decision.topic ?? null;
  // A friend meeting new parents congratulates them (lib/family.ts): the
  // baby is the news for a couple of days. Half the time, so the friends
  // still have other things to say to each other in that window.
  if (!topic && friendship > 20 && Math.random() < 0.5) {
    const baby = newbornOf(targetId, gameMinutes(world.time));
    if (baby) topic = congratsTopic(baby.name);
  }
  if (!topic && agentPersonality) {
    // Generate drama topic from current states
    const agentStatesForTopic = getAgentStates(agentId);
    let recentDrama: string | null = null;
    if (agentStatesForTopic.includes('heartbroken')) recentDrama = 'heartbreak';
    else if (agentStatesForTopic.includes('jealous')) recentDrama = 'jealousy and suspicion';
    else if (agentStatesForTopic.includes('in_debt')) recentDrama = 'money troubles';
    else if (agentStatesForTopic.includes('angry')) recentDrama = 'something that made you angry';
    else if (agentStatesForTopic.includes('infatuated')) recentDrama = 'someone special';

    const otherActiveAgents = activeAgents.filter(a => a.id !== agent.id && a.id !== targetId);
    topic = selectPersonalityTopic(
      agentPersonality,
      agentNeeds.mood,
      friendship,
      romance,
      otherActiveAgents.map(a => ({ name: a.name })),
      recentDrama,
    );
  }

  // Gossip override: dishonest + curious agents prefer to share real facts
  if (!topic && agentPersonality && agentPersonality.honesty < 40 && agentPersonality.curiosity > 60) {
    const gossipFacts = getShareableFacts(agentId, targetId, agentPersonality);
    if (gossipFacts.length > 0) {
      const subjectName = getAgentName(gossipFacts[0].subject_id);
      topic = `gossip about ${subjectName}`;
    }
  }

  // Economic topic override
  if (!topic && agentEcon) {
    if (agentEcon.money < 15 && Math.random() < 0.3) {
      topic = 'financial struggles';
    } else if (agentEcon.money > 80 && friendship > 40 && Math.random() < 0.15) {
      topic = 'the town economy';
    }
  }

  // The campaign: a candidate asks for votes, and the town talks about
  // little else in the last days (lib/townCalendar.ts reads the topic to
  // weigh the chat's support).
  if (!topic && campaigners.size > 0) {
    const candidateTalking = campaigners.has(agentId) || campaigners.has(targetId);
    if (candidateTalking && Math.random() < 0.6) topic = 'the upcoming election for mayor';
    else if (!candidateTalking && Math.random() < 0.15) topic = 'who to vote for in the election';
  }

  // Date topic override: romantic conversations
  if (!topic && isDate) {
    const dateTopics = [
      'flirting and getting to know each other better',
      'dreams and hopes for the future',
      'favorite memories together',
      'what they find attractive about each other',
      'planning something fun to do together',
    ];
    topic = dateTopics[Math.floor(Math.random() * dateTopics.length)];
  }

  // Context-driven topic overrides: weather, events, hobbies
  if (!topic && Math.random() < 0.35) {
    const contextTopics: string[] = [];

    // Weather commentary
    if (world.time.season === 'winter' && Math.random() < 0.4) contextTopics.push('the cold weather');
    if (world.time.season === 'spring' && Math.random() < 0.3) contextTopics.push('the beautiful spring weather');

    // Active world events
    if (activeEventTypes.has('festival')) contextTopics.push('the town festival');
    if (activeEventTypes.has('storm')) contextTopics.push('the terrible storm');
    if (activeEventTypes.has('wedding')) contextTopics.push('the wedding celebration');
    if (activeEventTypes.has('sickness')) contextTopics.push('the flu going around');
    if (activeEventTypes.has('full_moon')) contextTopics.push('the beautiful full moon');
    if (activeEventTypes.has('competition')) contextTopics.push('the town competition');
    if (activeEventTypes.has('mysterious_stranger')) contextTopics.push('the mysterious stranger in town');
    if (activeEventTypes.has('traveling_merchant')) contextTopics.push('the traveling merchant and their wares');

    // Shared hobbies
    const sharedHobbies = getSharedHobbies(agentId, targetId);
    if (sharedHobbies.length > 0) {
      contextTopics.push(`their shared love of ${sharedHobbies[0]}`);
    }

    if (contextTopics.length > 0) {
      topic = contextTopics[Math.floor(Math.random() * contextTopics.length)];
    }
  }
  return topic;
}
