/**
 * Prompt Builders for Agent Conversations
 *
 * Constructs system prompts and conversation prompts for LLM calls.
 * Pure functions — no I/O.
 */

import { PersonalityProfile } from '../lib/personality';
import { generateVoiceDirective } from './voiceDirective';
import { selectConversationContext, ContextItem } from './contextSelector';

// ---------------------------------------------------------------------------
// Row types (matching server/db/schema.ts column names)
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: number;
  name: string;
  bio: string;
  self_description?: string | null;
  traits: string[];
  age: number;
  gender: string;
  personality: {
    honesty: number;
    aggression: number;
    warmth: number;
    impulsiveness: number;
    vanity: number;
    curiosity: number;
    loyalty: number;
    morality: number;
    sensuality: number;
    neuroticism: number;
  } | null;
}

export interface NeedsRow {
  mood: number;
  energy: number;
  hunger: number;
  social: number;
}

export interface EconomyRow {
  job: string;
  job_title: string;
  money: number;
}

export interface RelationshipRow {
  agent_a: number;
  agent_b: number;
  friendship_ab: number;
  friendship_ba: number;
  romance_ab: number;
  romance_ba: number;
  trust_ab: number;
  trust_ba: number;
  familiarity: number;
  interaction_count: number;
  tags: string[];
}

export interface ConversationRow {
  id: number;
  messages: Array<Record<string, any>>;
  trigger_reason: string;
  topic: string | null;
  sentiment: number;
  max_turns?: number;
}

export interface MemoryRow {
  id: number;
  description: string;
  importance: number;
  created_at: number;
  emotional_valence: number;
  metadata: Record<string, unknown>;
}

export interface WorldStateRow {
  time: {
    day: number;
    hour: number;
    minute: number;
    totalTicks: number;
    season: string;
  };
  weather: string;
}

export interface LocationRow {
  id: number;
  name: string;
  description: string;
}

export interface AgentEnrichment {
  reputationLabel: string;
  reputationScore: number;
  hobbies: Array<{ hobby: string; level: number }>;
  moodMomentum: number;
  drinkCount: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function describeFinancialStatus(money: number): string {
  if (money < 10) return 'desperate';
  if (money < 25) return 'struggling';
  if (money < 50) return 'getting by';
  return 'comfortable';
}

function formatTimeOfDay(hour: number): string {
  if (hour >= 5 && hour < 7) return 'Dawn';
  if (hour >= 7 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 17) return 'Afternoon';
  if (hour >= 17 && hour <= 20) return 'Evening';
  return 'Night';
}

function buildTraitsLine(traits: string[]): string {
  if (traits.length === 0) return '';
  if (traits.length === 1) return `People describe you as ${traits[0]}.`;
  if (traits.length === 2) return `People describe you as ${traits[0]} and ${traits[1]}.`;
  const last = traits[traits.length - 1];
  const rest = traits.slice(0, -1);
  return `People describe you as ${rest.join(', ')}, and ${last}.`;
}

function buildMoodLine(mood: number): string {
  if (mood < 15) return "You're miserable right now.";
  if (mood < 35) return "You're in a bad mood.";
  if (mood > 90) return "You're in a great mood.";
  if (mood > 75) return "You're in a good mood.";
  return '';
}

function buildCriticalNeedsLine(needs: NeedsRow, money: number): string {
  const parts: string[] = [];
  if (needs.hunger < 15) parts.push('starving');
  if (needs.energy < 15) parts.push('exhausted');
  if (needs.social < 15) parts.push('desperately lonely');

  const moneyWarning = money < 10 ? `You have $${Math.round(money)}.` : '';

  if (parts.length === 0 && !moneyWarning) return '';

  let line = '';
  if (parts.length === 1) {
    line = `You're ${parts[0]}.`;
  } else if (parts.length === 2) {
    line = `You're ${parts[0]} and ${parts[1]}.`;
  } else if (parts.length > 2) {
    const last = parts[parts.length - 1];
    const rest = parts.slice(0, -1);
    line = `You're ${rest.join(', ')}, and ${last}.`;
  }

  return [line, moneyWarning].filter(Boolean).join(' ');
}

function buildSettingLine(world: WorldStateRow, locationName: string): string {
  const timeOfDay = formatTimeOfDay(world.time.hour);
  const season = world.time.season.charAt(0).toUpperCase() + world.time.season.slice(1);
  return `${timeOfDay}, day ${world.time.day}. ${season}, ${world.weather}. At ${locationName}.`;
}

function buildRelationshipTag(
  relationship: RelationshipRow | null,
  speakerId: number,
  otherName: string,
): string {
  if (!relationship) return `You don't know ${otherName}.`;

  const isA = relationship.agent_a === speakerId;
  const friendship = isA ? relationship.friendship_ab : relationship.friendship_ba;
  const romance = isA ? relationship.romance_ab : relationship.romance_ba;
  const trust = isA ? relationship.trust_ab : relationship.trust_ba;

  const parts: string[] = [];

  // Friendship tier
  if (friendship > 70) {
    parts.push(`You're close with ${otherName}. You'd do anything for them.`);
  } else if (friendship > 40) {
    parts.push(`You like ${otherName}.`);
  } else if (friendship >= 0) {
    parts.push(`You know ${otherName}. No strong feelings.`);
  } else if (friendship > -30) {
    parts.push(`You don't like ${otherName}. They annoy you.`);
  } else if (friendship > -60) {
    parts.push(`You can't stand ${otherName}. You don't hide your contempt.`);
  } else {
    parts.push(`You hate ${otherName}. Seeing them makes your blood boil.`);
  }

  // Structural tags
  const tagMap: Record<string, string> = {
    coworkers: 'You work together.',
    housemate: 'You live together.',
    roommate: 'You live together.',
    crush: 'You have a crush on them.',
    grudge: 'You hold a grudge against them.',
    drinking_buddy: 'You drink together.',
    antagonist: "They're your antagonist.",
    partner: "You're together.",
  };
  for (const tag of relationship.tags) {
    const mapped = tagMap[tag];
    if (mapped) parts.push(mapped);
  }

  // Romance
  if (romance > 60) {
    parts.push(`You have deep feelings for ${otherName}.`);
  } else if (romance > 40) {
    parts.push(`You're attracted to ${otherName}.`);
  } else if (romance > 20) {
    parts.push(`You find ${otherName} appealing.`);
  }

  // Trust
  if (trust > 50) {
    parts.push(`You trust ${otherName} deeply.`);
  } else if (trust < -50) {
    parts.push(`You deeply distrust ${otherName}. Watch what you say.`);
  } else if (trust < -30) {
    parts.push(`You're wary of ${otherName}.`);
  }

  // Asymmetric awareness: hint at other's feelings toward you
  const otherFriendship = isA ? relationship.friendship_ba : relationship.friendship_ab;
  const otherRomance = isA ? relationship.romance_ba : relationship.romance_ab;
  if (otherFriendship > 60 && friendship < 30) {
    parts.push(`${otherName} seems to like you more than you like them.`);
  } else if (otherFriendship < -30 && friendship > 0) {
    parts.push(`You sense ${otherName} doesn't like you much.`);
  }
  if (otherRomance > 40 && romance < 15) {
    parts.push(`You think ${otherName} might have feelings for you.`);
  }

  // Interaction history
  if (relationship.interaction_count > 20) {
    parts.push(`You've talked many times before.`);
  } else if (relationship.interaction_count === 0) {
    parts.push(`You've never really talked.`);
  }

  return parts.join(' ');
}

function buildTurnInstruction(
  messageCount: number,
  maxTurns: number,
  otherName: string,
  topic: string | null,
  friendship: number,
  isFirstMeeting: boolean,
  romance?: number,
  lastMessageSentiment?: number,
  goalContext?: string | null,
): string {
  const parts: string[] = [];

  if (messageCount === 0) {
    // Opening turn
    if (isFirstMeeting) {
      const approach = friendship >= 0
        ? `Introduce yourself to ${otherName}. You haven't really talked before. Be curious but cautious — first impressions matter.`
        : `You're meeting ${otherName} for the first time. Size them up. Your personality decides how open you are.`;
      parts.push(approach);
    } else if (topic) {
      parts.push(`You want to discuss ${topic} with ${otherName} — bring it up naturally, as if it's been on your mind. Use your [Memory] entries as fuel.`);
    } else {
      parts.push(`Start talking to ${otherName}. Use your [Memory] entries as conversation fuel. Be authentic to your personality and mood.`);
    }
  } else if (messageCount >= maxTurns - 2) {
    // Wrapping up
    parts.push(`Start wrapping up naturally. Say goodbye, make plans to meet again, or leave a lasting impression.`);
  } else if (messageCount >= maxTurns - 4) {
    // Winding down
    parts.push(`Continue with ${otherName}. The conversation is winding down — make your point if you have one.`);
  } else {
    // Mid-conversation
    parts.push(`Respond to ${otherName}. Build on what was just said — don't change topic abruptly.`);
  }

  // Emotional reaction to last message
  if (lastMessageSentiment !== undefined && messageCount > 0) {
    if (lastMessageSentiment > 0.5) {
      parts.push('They seemed happy. React to their energy.');
    } else if (lastMessageSentiment < -0.5) {
      parts.push('They seemed upset. Your personality decides if you comfort or dismiss them.');
    }
  }

  // Date mode
  if (romance && romance > 30 && messageCount > 0) {
    parts.push('This is a romantic moment. Be flirty, vulnerable, or playful — whatever fits you.');
  }

  // Goal stakes
  if (goalContext) {
    parts.push(goalContext);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildAgentSystemPrompt(
  agent: AgentRow,
  needs: NeedsRow,
  economy: EconomyRow,
  effectivePersonality?: PersonalityProfile | null,
  statePrompts?: string[],
  enrichment?: AgentEnrichment | null,
): string {
  const resolvedPersonality = effectivePersonality ?? agent.personality;

  // Identity line
  const identity = `You are ${agent.name}, ${agent.age}, ${economy.job_title}.`;

  // Traits
  const traitsLine = buildTraitsLine(agent.traits);

  // Voice directive
  const voiceDirective = resolvedPersonality
    ? generateVoiceDirective(agent.id, resolvedPersonality as PersonalityProfile)
    : '';

  // Self-description: use evolving self-concept if available, fall back to static bio
  const agentDescription = agent.self_description || agent.bio || '';
  const descriptionLine = agentDescription ? `About you: ${agentDescription}` : '';

  // Mood + momentum
  const moodLine = buildMoodLine(needs.mood);
  let momentumLine = '';
  if (enrichment) {
    if (enrichment.moodMomentum > 5) momentumLine = "You've been feeling increasingly happy lately.";
    else if (enrichment.moodMomentum < -5) momentumLine = "You've been going through a rough patch.";
  }

  // States — dramatize for LLM
  let stateLines = '';
  if (statePrompts?.length) {
    stateLines = 'Right now:\n' + statePrompts.map(s => `• ${s}`).join('\n');
  }

  // Drink state
  let drinkLine = '';
  if (enrichment && enrichment.drinkCount >= 5) {
    drinkLine = "You're drunk. Your words slur and your filter is gone.";
  } else if (enrichment && enrichment.drinkCount >= 3) {
    drinkLine = `You've had ${enrichment.drinkCount} drinks and you're feeling tipsy.`;
  }

  // Critical needs
  const criticalNeedsLine = buildCriticalNeedsLine(needs, economy.money);

  // Financial status
  const econLine = `Your financial situation: ${describeFinancialStatus(economy.money)} ($${Math.round(economy.money)}).`;

  // Reputation
  let repLine = '';
  if (enrichment && enrichment.reputationScore !== 0) {
    repLine = `The townspeople consider you ${enrichment.reputationLabel}.`;
  }

  // Hobbies
  let hobbyLine = '';
  if (enrichment && enrichment.hobbies.length > 0) {
    const hobbyParts = enrichment.hobbies.slice(0, 3).map(h => `${h.hobby} (lv${h.level})`);
    hobbyLine = `Your hobbies: ${hobbyParts.join(', ')}.`;
  }

  // Build prompt parts, filtering empties
  const header = [identity, traitsLine, voiceDirective].filter(Boolean).join(' ');
  const middle = [descriptionLine, moodLine, momentumLine, stateLines, drinkLine, criticalNeedsLine, econLine, repLine, hobbyLine].filter(Boolean).join('\n');
  // Adaptive instruction based on personality extremes
  const p = resolvedPersonality as { impulsiveness?: number; warmth?: number; aggression?: number } | null;
  let toneHint = '';
  if (p) {
    if (p.impulsiveness && p.impulsiveness > 70) toneHint = ' Keep it raw and unfiltered.';
    else if (p.warmth && p.warmth > 70) toneHint = ' Be genuine and caring.';
    else if (p.aggression && p.aggression > 60) toneHint = " Don't hold back.";
  }
  const instruction = `Reply in 1-2 sentences. Natural speech, not prose. You can be rude, evasive, flirty, or dismissive — whatever fits your personality.${toneHint}`;

  const sections = [header, middle, instruction].filter(Boolean);
  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Conversation prompt builder
// ---------------------------------------------------------------------------

export interface ConversationPromptParams {
  speaker: AgentRow;
  speakerNeeds: NeedsRow;
  speakerEcon: EconomyRow;
  conversation: ConversationRow;
  relationship: RelationshipRow | null;
  otherAgent: AgentRow;
  memories: MemoryRow[];
  world: WorldStateRow;
  location: LocationRow;
  effectivePersonality?: PersonalityProfile | null;
  statePrompts?: string[];
  gossipFacts?: Array<{ content: string; sensitivity: number }>;
  situationalPrompt?: string | null;
  enrichment?: AgentEnrichment | null;
}

export function buildConversationPrompt(
  params: ConversationPromptParams,
): { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const {
    speaker,
    speakerNeeds,
    speakerEcon,
    conversation,
    relationship,
    otherAgent,
    memories,
    world,
    location,
    effectivePersonality,
    statePrompts,
    gossipFacts,
    situationalPrompt,
  } = params;

  // Extract friendship for context selector
  const friendship = relationship
    ? (relationship.agent_a === speaker.id ? relationship.friendship_ab : relationship.friendship_ba)
    : 0;

  // Select context items
  const contextItems = selectConversationContext({
    memories: memories.map(m => ({
      description: m.description,
      emotional_valence: (m as any).emotional_valence ?? 0,
      created_at: m.created_at,
      metadata: (m as any).metadata ?? {},
    })),
    facts: gossipFacts ?? [],
    statePrompts: statePrompts ?? [],
    situationalPrompt: situationalPrompt ?? null,
    otherAgentName: otherAgent.name,
    otherAgentId: otherAgent.id,
    topic: conversation.topic,
    currentTick: world.time.totalTicks,
    friendship,
  });

  // Build system prompt with enrichment data
  const system = buildAgentSystemPrompt(
    speaker,
    speakerNeeds,
    speakerEcon,
    effectivePersonality,
    statePrompts,
    params.enrichment,
  );

  // Build user message parts
  const userParts: string[] = [];

  // Setting line
  userParts.push(buildSettingLine(world, location.name));

  // Relationship tag
  userParts.push(buildRelationshipTag(relationship, speaker.id, otherAgent.name));

  // Context items with prefixes
  const contextPrefixes: Record<ContextItem['type'], string> = {
    situation: '[Situation]',
    state: '[State]',
    memory: '[Memory]',
    fact: '[You know]',
  };
  for (const item of contextItems) {
    userParts.push(`${contextPrefixes[item.type]} ${item.text}`);
  }

  // Turn instruction with enriched context
  const messageCount = conversation.messages.length;
  const maxTurns = conversation.max_turns ?? 6;
  const isFirstMeeting = relationship ? relationship.familiarity < 5 : true;
  const romance = relationship
    ? (relationship.agent_a === speaker.id ? relationship.romance_ab : relationship.romance_ba)
    : 0;
  // Get sentiment from last message (if any)
  const lastMsg = conversation.messages.length > 0
    ? conversation.messages[conversation.messages.length - 1] as Record<string, any>
    : null;
  const lastSentiment = lastMsg?.sentiment as number | undefined;

  userParts.push(buildTurnInstruction(
    messageCount, maxTurns, otherAgent.name, conversation.topic,
    friendship, isFirstMeeting, romance, lastSentiment,
  ));

  // Build message array
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  // First message is context
  messages.push({ role: "user", content: userParts.join('\n') });

  // Add recent conversation history (last 6 messages)
  const recentMessages = conversation.messages.slice(-6) as Array<{
    speakerId: number;
    text: string;
  }>;

  for (const msg of recentMessages) {
    const role: "user" | "assistant" =
      msg.speakerId === speaker.id ? "assistant" : "user";
    messages.push({ role, content: msg.text });
  }

  return { system, messages };
}
