/**
 * Relationship Impact Engine
 *
 * Single source of truth for how conversations affect relationships.
 * Takes conversation properties + personality profiles → outputs deltas.
 *
 * To add a new relationship effect: modify this file only.
 * To change how romance grows: change it here, everything updates.
 */

import { PersonalityProfile } from './personality';

// --- Input: everything about the conversation ---

export interface ConversationImpactContext {
  overallSentiment: number;         // -1 to 1
  turnCount: number;                // number of messages
  topic: string | null;             // conversation topic
  personalityA: PersonalityProfile | null;
  personalityB: PersonalityProfile | null;
  compatibility: number;            // 0-2, from calculateCompatibility
  existingFriendshipAB: number;     // current friendship A→B
  existingFriendshipBA: number;     // current friendship B→A
  existingRomanceAB: number;
  existingRomanceBA: number;
  isTemplate: boolean;              // template vs LLM conversation
}

// --- Output: all relationship deltas ---

export interface RelationshipDeltas {
  friendshipAB: number;
  friendshipBA: number;
  romanceAB: number;
  romanceBA: number;
  trustAB: number;
  trustBA: number;
}

// --- Topic classifiers ---

const ROMANTIC_TOPICS = ['flirting', 'romance', 'deep conversation', 'sharing secrets', 'celebrating'];
const DEEP_TOPICS = ['sharing secrets', 'deep conversation', 'confession', 'venting worries', 'seeking comfort', 'reminiscing'];
const CONFLICT_TOPICS = ['confrontation', 'tension', 'argument', 'tense encounter', 'passive-aggressive exchange', 'snide remark'];
const BONDING_TOPICS = ['catching up', 'inside joke', 'making plans', 'offering help', 'checking in'];

function matchesTopic(topic: string | null, keywords: string[]): boolean {
  if (!topic) return false;
  return keywords.some(k => topic.includes(k));
}

// --- Engine ---

export function computeRelationshipDeltas(ctx: ConversationImpactContext): RelationshipDeltas {
  const {
    overallSentiment, turnCount, topic,
    personalityA, personalityB, compatibility,
    existingFriendshipAB, existingFriendshipBA,
  } = ctx;

  // Base multiplier from conversation length
  const turnMultiplier = Math.min(2.0, 1 + turnCount * 0.15);
  const templateMultiplier = ctx.isTemplate ? 0.6 : 1.0; // templates have less impact

  // ── Friendship ──────────────────────────────────────────────────────────
  const friendshipBase = overallSentiment > 0
    ? overallSentiment * 8
    : overallSentiment * 12; // negative hits harder

  let friendshipAB = friendshipBase * turnMultiplier * compatibility * templateMultiplier;
  let friendshipBA = friendshipAB;

  // Bonding topics boost friendship
  if (matchesTopic(topic, BONDING_TOPICS) && overallSentiment > 0) {
    friendshipAB += 2;
    friendshipBA += 2;
  }

  // Personality amplifiers
  if (personalityA?.aggression && personalityA.aggression > 60 && overallSentiment < -0.2) {
    friendshipAB *= 1.5; // aggressive agents escalate conflict
  }
  if (personalityB?.aggression && personalityB.aggression > 60 && overallSentiment < -0.2) {
    friendshipBA *= 1.5;
  }
  if (personalityA?.vanity && personalityA.vanity > 60 && overallSentiment < -0.2) {
    friendshipAB *= 1.3; // vain agents perceive insult
  }
  if (personalityB?.vanity && personalityB.vanity > 60 && overallSentiment < -0.2) {
    friendshipBA *= 1.3;
  }

  // Loyalty bonus: loyal agents with existing friendships build faster
  if (personalityA?.loyalty && personalityA.loyalty > 60 && existingFriendshipAB > 50 && overallSentiment > 0) {
    friendshipAB *= 1.2;
  }
  if (personalityB?.loyalty && personalityB.loyalty > 60 && existingFriendshipBA > 50 && overallSentiment > 0) {
    friendshipBA *= 1.2;
  }

  // ── Romance ─────────────────────────────────────────────────────────────
  let romanceAB = 0;
  let romanceBA = 0;

  const isRomantic = matchesTopic(topic, ROMANTIC_TOPICS);
  const romanceTopicMultiplier = isRomantic ? 3.0 : 1.0;

  if (personalityA && personalityB) {
    // Positive conversations build romance for sensual agents
    if (overallSentiment > 0 && personalityA.sensuality > 30) {
      romanceAB = overallSentiment * 6 * (personalityA.sensuality / 100) * compatibility * romanceTopicMultiplier * turnMultiplier * templateMultiplier;
    }
    if (overallSentiment > 0 && personalityB.sensuality > 30) {
      romanceBA = overallSentiment * 6 * (personalityB.sensuality / 100) * compatibility * romanceTopicMultiplier * turnMultiplier * templateMultiplier;
    }

    // Negative conversations reduce romance
    if (overallSentiment < -0.2) {
      if (personalityA.sensuality > 30) romanceAB = overallSentiment * 4 * turnMultiplier;
      if (personalityB.sensuality > 30) romanceBA = overallSentiment * 4 * turnMultiplier;
    }

    // Warmth amplifies romance growth
    if (personalityA.warmth > 60 && romanceAB > 0) romanceAB *= 1.2;
    if (personalityB.warmth > 60 && romanceBA > 0) romanceBA *= 1.2;
  }

  // ── Trust ───────────────────────────────────────────────────────────────
  // Every interaction builds/erodes trust based on sentiment
  let trustAB = overallSentiment * 4 * turnMultiplier * templateMultiplier;
  let trustBA = trustAB;

  // Deep topics build trust
  if (matchesTopic(topic, DEEP_TOPICS) && overallSentiment > 0) {
    trustAB += 3;
    trustBA += 3;
  }

  // Conflict erodes trust faster
  if (matchesTopic(topic, CONFLICT_TOPICS)) {
    trustAB -= 3;
    trustBA -= 3;
  }

  // Honesty amplifies trust gain — honest agents' positive interactions are worth more
  if (personalityA?.honesty && personalityA.honesty > 60 && overallSentiment > 0) {
    trustAB *= 1.3;
  }
  if (personalityB?.honesty && personalityB.honesty > 60 && overallSentiment > 0) {
    trustBA *= 1.3;
  }

  // Loyalty amplifies trust with existing friends
  if (personalityA?.loyalty && personalityA.loyalty > 60 && existingFriendshipAB > 50) {
    trustAB *= 1.2;
  }
  if (personalityB?.loyalty && personalityB.loyalty > 60 && existingFriendshipBA > 50) {
    trustBA *= 1.2;
  }

  return {
    friendshipAB: Math.round(friendshipAB * 10) / 10,
    friendshipBA: Math.round(friendshipBA * 10) / 10,
    romanceAB: Math.round(romanceAB * 10) / 10,
    romanceBA: Math.round(romanceBA * 10) / 10,
    trustAB: Math.round(trustAB * 10) / 10,
    trustBA: Math.round(trustBA * 10) / 10,
  };
}
