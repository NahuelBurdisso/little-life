/**
 * Prompt Builders for Agent Conversations
 *
 * Constructs system prompts and conversation prompts for LLM calls.
 * Pure functions — no I/O, can be called from any Convex function.
 */

import { Doc, Id } from "../_generated/dataModel";

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
  agent: Doc<"agents">,
  needs: Doc<"needs">,
  economy: Doc<"economy">,
): string {
  return `You are ${agent.name}, a ${agent.age}-year-old ${economy.jobTitle} living in a small town called Little Life.

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
  relationship: Doc<"relationships"> | null,
  speakerId: Id<"agents">,
  otherAgent: Doc<"agents">,
): string {
  if (!relationship) {
    return `You don't really know ${otherAgent.name}. This might be one of your first conversations.`;
  }

  const isA = relationship.agentA === speakerId;
  const friendship = isA ? relationship.friendshipAB : relationship.friendshipBA;
  const romance = isA ? relationship.romanceAB : relationship.romanceBA;
  const trust = isA ? relationship.trustAB : relationship.trustBA;

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
  if (relationship.interactionCount > 20) {
    parts.push(`You've talked many times before.`);
  } else if (relationship.interactionCount > 5) {
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
  speaker: Doc<"agents">;
  speakerNeeds: Doc<"needs">;
  speakerEcon: Doc<"economy">;
  conversation: Doc<"conversations">;
  relationship: Doc<"relationships"> | null;
  otherAgent: Doc<"agents">;
  memories: Array<Doc<"memories">>;
  world: Doc<"worldState">;
  location: Doc<"locations">;
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
    buildRelationshipContext(relationship, speaker._id, otherAgent),
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
  contextParts.push(`Trigger: ${conversation.triggerReason}`);
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
    speakerId: string;
    text: string;
  }>;

  for (const msg of recentMessages) {
    const role: "user" | "assistant" =
      msg.speakerId === speaker._id ? "assistant" : "user";
    messages.push({ role, content: msg.text });
  }

  return { system, messages };
}
