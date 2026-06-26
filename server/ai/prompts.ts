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
    parts.push(`You deeply distrust ${otherName}.`);
  } else if (trust < -30) {
    parts.push(`You're wary of ${otherName}.`);
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
): string {
  if (messageCount === 0) {
    if (isFirstMeeting) {
      const approach = friendship >= 0
        ? `Introduce yourself to ${otherName}. You haven't really talked before. Be curious but cautious — first impressions matter.`
        : `You're meeting ${otherName} for the first time. Size them up. Your personality decides how open you are.`;
      return topic ? `${approach} The topic is ${topic}.` : approach;
    }
    if (topic) {
      return `Start talking to ${otherName} about ${topic}. Reference your [Memory] entries naturally — "I was thinking about what you said..." or "Remember when...". Don't repeat the memory text verbatim, just weave it in.`;
    }
    return `Start talking to ${otherName}. Use your [Memory] entries as conversation fuel. Be authentic to your personality and mood.`;
  }
  if (messageCount >= maxTurns - 2) return `Wrap up the conversation naturally. If something important was discussed, acknowledge it.`;
  if (messageCount >= maxTurns - 4) return `Continue with ${otherName}. The conversation is winding down — make your point if you have one.`;
  return `Respond to ${otherName}. React to what they said. Stay in character. Reference your memories or secrets if relevant.`;
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

  // Mood
  const moodLine = buildMoodLine(needs.mood);

  // States — dramatize for LLM
  let stateLines = '';
  if (statePrompts?.length) {
    stateLines = 'Right now:\n' + statePrompts.map(s => `• ${s}`).join('\n');
  }

  // Critical needs
  const criticalNeedsLine = buildCriticalNeedsLine(needs, economy.money);

  // Financial status
  const econLine = `Your financial situation: ${describeFinancialStatus(economy.money)} ($${Math.round(economy.money)}).`;

  // Build prompt parts, filtering empties
  const header = [identity, traitsLine, voiceDirective].filter(Boolean).join(' ');
  const middle = [descriptionLine, moodLine, stateLines, criticalNeedsLine, econLine].filter(Boolean).join('\n');
  const instruction = "Reply in 1-2 sentences. Natural speech, not prose. You can be rude, evasive, flirty, or dismissive — whatever fits.";

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

  // Build system prompt (new signature — no toneModifiers/situationalPrompt)
  const system = buildAgentSystemPrompt(
    speaker,
    speakerNeeds,
    speakerEcon,
    effectivePersonality,
    statePrompts,
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

  // Turn instruction
  const messageCount = conversation.messages.length;
  const maxTurns = conversation.max_turns ?? 6;
  const isFirstMeeting = relationship ? relationship.familiarity < 5 : true;
  userParts.push(buildTurnInstruction(messageCount, maxTurns, otherAgent.name, conversation.topic, friendship, isFirstMeeting));

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
