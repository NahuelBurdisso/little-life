/**
 * Prompt Builders for Agent Conversations
 *
 * Constructs system prompts and conversation prompts for LLM calls.
 * Pure functions — no I/O.
 */

// ---------------------------------------------------------------------------
// Row types (matching server/db/schema.ts column names)
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: number;
  name: string;
  bio: string;
  traits: string[];
  age: number;
  gender: string;
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
}

export interface MemoryRow {
  id: number;
  content: string;
  importance: number;
  timestamp: number;
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
// Need description helpers
// ---------------------------------------------------------------------------

function describeMood(mood: number): string {
  if (mood > 80) return "very happy";
  if (mood > 60) return "content";
  if (mood > 40) return "okay";
  if (mood > 20) return "down";
  return "miserable";
}

function describeEnergy(energy: number): string {
  if (energy > 80) return "well-rested and energetic";
  if (energy > 60) return "feeling fine";
  if (energy > 40) return "a bit tired";
  if (energy > 20) return "exhausted";
  return "barely able to keep your eyes open";
}

function describeHunger(hunger: number): string {
  if (hunger > 80) return "well-fed";
  if (hunger > 60) return "not hungry";
  if (hunger > 40) return "getting hungry";
  if (hunger > 20) return "very hungry";
  return "starving";
}

function describeSocial(social: number): string {
  if (social > 80) return "socially fulfilled";
  if (social > 60) return "content with your social life";
  if (social > 40) return "could use some company";
  if (social > 20) return "feeling lonely";
  return "desperately lonely";
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildAgentSystemPrompt(
  agent: AgentRow,
  needs: NeedsRow,
  economy: EconomyRow,
): string {
  return `You are ${agent.name}, a ${agent.age}-year-old ${economy.job_title} living in a small town called Little Life.

## Your personality
${agent.bio}

## Your traits
${agent.traits.join(", ")}

## Your current state
- Mood: ${describeMood(needs.mood)} (${Math.round(needs.mood)}/100)
- Energy: ${describeEnergy(needs.energy)}
- Hunger: ${describeHunger(needs.hunger)}
- Social fulfillment: ${describeSocial(needs.social)}
- You have ${Math.round(economy.money)} coins

## Rules for your responses
- Speak naturally as ${agent.name} would, given your personality and current state
- Keep responses to 1-3 sentences. You're having a casual conversation, not writing an essay
- Your mood and energy affect how you talk
- Reference your memories and shared history when relevant
- You can express opinions about other townspeople based on your relationships
- Never break character or acknowledge being an AI
- If you want to end the conversation, say goodbye naturally`;
}

// ---------------------------------------------------------------------------
// Relationship context
// ---------------------------------------------------------------------------

export function buildRelationshipContext(
  relationship: RelationshipRow | null,
  speakerId: number,
  otherAgent: AgentRow,
): string {
  if (!relationship) {
    return `You don't really know ${otherAgent.name}. This might be one of your first conversations.`;
  }

  const isA = relationship.agent_a === speakerId;
  const friendship = isA ? relationship.friendship_ab : relationship.friendship_ba;
  const romance = isA ? relationship.romance_ab : relationship.romance_ba;
  const trust = isA ? relationship.trust_ab : relationship.trust_ba;

  const parts: string[] = [];

  // Friendship
  if (friendship > 70) {
    parts.push(`You consider ${otherAgent.name} one of your closest friends.`);
  } else if (friendship > 40) {
    parts.push(`You're friendly with ${otherAgent.name}.`);
  } else if (friendship > 10) {
    parts.push(`You know ${otherAgent.name} a little.`);
  } else if (friendship > -20) {
    parts.push(`You're mostly neutral toward ${otherAgent.name}.`);
  } else if (friendship > -50) {
    parts.push(`You don't get along well with ${otherAgent.name}.`);
  } else {
    parts.push(`You strongly dislike ${otherAgent.name}.`);
  }

  // Romance
  if (romance > 60) {
    parts.push(`You have deep romantic feelings for ${otherAgent.name}.`);
  } else if (romance > 40) {
    parts.push(`You're attracted to ${otherAgent.name}.`);
  } else if (romance > 20) {
    parts.push(`You find ${otherAgent.name} somewhat appealing.`);
  }

  // Trust
  if (trust > 50) {
    parts.push(`You trust ${otherAgent.name} deeply.`);
  } else if (trust > 30) {
    parts.push(`You generally trust ${otherAgent.name}.`);
  } else if (trust < -50) {
    parts.push(`You deeply distrust ${otherAgent.name}.`);
  } else if (trust < -30) {
    parts.push(`You're wary of ${otherAgent.name} and don't fully trust them.`);
  }

  // Tags
  if (relationship.tags.length > 0) {
    const tagStr = relationship.tags.join(", ");
    parts.push(`Notable aspects of your relationship: ${tagStr}.`);
  }

  // Interaction history
  if (relationship.interaction_count > 20) {
    parts.push(`You've talked many times before.`);
  } else if (relationship.interaction_count > 5) {
    parts.push(`You've had several conversations in the past.`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const displayMinute = String(minute).padStart(2, "0");
  return `${displayHour}:${displayMinute} ${period}`;
}

function formatTimeAgo(memoryTimestamp: number, currentTick: number): string {
  const tickDiff = currentTick - memoryTimestamp;
  // Each tick = 1 game minute
  if (tickDiff < 60) return `${tickDiff} minutes ago`;
  const hours = Math.floor(tickDiff / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
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
  } = params;

  const system = buildAgentSystemPrompt(speaker, speakerNeeds, speakerEcon);

  // Build context message
  const contextParts: string[] = [];

  // Current situation
  contextParts.push(
    `## Current situation`,
    `It's ${formatTime(world.time.hour, world.time.minute)} on day ${world.time.day} (${world.time.season}, ${world.weather}).`,
    `You're at ${location.name}: ${location.description}.`,
    "",
  );

  // Relationship
  contextParts.push(
    `## Your relationship with ${otherAgent.name}`,
    buildRelationshipContext(relationship, speaker.id, otherAgent),
    "",
  );

  // Memories
  if (memories.length > 0) {
    contextParts.push(`## Your relevant memories`);
    for (const memory of memories) {
      const timeAgo = formatTimeAgo(memory.timestamp, world.time.totalTicks);
      contextParts.push(`- ${memory.content} (${timeAgo})`);
    }
    contextParts.push("");
  }

  // What's happening
  contextParts.push(`## What's happening`);
  contextParts.push(`Trigger: ${conversation.trigger_reason}`);
  if (conversation.topic) {
    contextParts.push(`The conversation topic is: ${conversation.topic}`);
  }

  const messageCount = conversation.messages.length;
  if (messageCount === 0) {
    contextParts.push(
      `\nStart a conversation with ${otherAgent.name}. Greet them naturally based on your relationship and current mood.`,
    );
  } else {
    contextParts.push(
      `\nContinue the conversation naturally. Respond to what ${otherAgent.name} just said.`,
    );
  }

  // Build message array
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  // First message is context
  messages.push({ role: "user", content: contextParts.join("\n") });

  // Add recent conversation history (last 10 messages)
  const recentMessages = conversation.messages.slice(-10) as Array<{
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
