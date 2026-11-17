/**
 * Facts a finished LLM conversation adds to the gossip network.
 */

import { db } from '../../../db';
import { conversations, relationships } from '../../../db/schema';
import { eq, and, gt, lt } from 'drizzle-orm';
import { getAgentStates } from '../../../lib/states';
import { createFact } from '../../../lib/gossip';
import { extractConfidedQuote } from '../../../lib/factText';
import { pickLoadedLine } from '../../../lib/memory/conversationGist';
import type { CompletionContext } from './completionContext';

/** Fact: a drunk participant in a negative conversation made a scene. */
export function recordDrunkIncident(ctx: CompletionContext): void {
  const { overallSentiment, participantIds } = ctx;
  // Drunk incident: drunk participant in a negative conversation
  for (const participantId of participantIds) {
    const states = getAgentStates(participantId);
    if (states.includes('drunk') && overallSentiment < -0.3) {
      const otherId = participantIds.find(p => p !== participantId);
      if (otherId) {
        createFact('drunk_incident', participantId, otherId, 3, [...participantIds], 'witnessed');
      }
    }
  }
}

/** Fact: a heartbroken or lonely participant confided something to a close friend. */
export function recordSecretTold(ctx: CompletionContext): void {
  const { messages, isFallback, participantIds, participants } = ctx;
  // Secret told: heartbroken/lonely participant confides to a close friend
  for (const participantId of participantIds) {
    const states = getAgentStates(participantId);
    if (states.includes('heartbroken') || states.includes('lonely')) {
      const otherId = participantIds.find(p => p !== participantId);
      if (otherId) {
        const rel = db.select().from(relationships)
          .where(and(
            eq(relationships.agent_a, Math.min(participantId, otherId)),
            eq(relationships.agent_b, Math.max(participantId, otherId))
          )).get();
        const friendship = rel ? (participantId < otherId ? rel.friendship_ab : rel.friendship_ba) : 0;
        if (friendship > 60) {
          // The secret is what they actually said. Conversations carry no
          // structured summary, so take the speaker's most loaded line (the
          // gist's bar: emotional charge or a disclosure, never a canned
          // fallback or a goodbye), then whole sentences only. A fixed 80-char
          // cut used to turn "(My heart gives a little skip, and I feel a
          // warmth bloom…" into a sensitivity-3 secret the town then passed
          // around. No quotable line means nothing was confided — no fact.
          const loaded = pickLoadedLine(
            messages
              .filter(m => m.speakerId === participantId)
              .map(m => ({ speakerId: m.speakerId, text: m.text, sentiment: m.sentiment, fallback: isFallback(m) })),
            (id) => participants.find((p) => p.id === id)?.name,
          );
          const quote = loaded ? extractConfidedQuote(loaded.text) : null;
          if (quote) {
            createFact('secret_told', participantId, otherId, 3, [participantId, otherId], 'confided', {
              quote,
            });
          }
        }
      }
    }
  }
}

/** Fact: someone keeps ending up in negative conversations, and the town notices. */
export function recordReputation(ctx: CompletionContext): void {
  const { overallSentiment, participantIds } = ctx;
  // Reputation: negative conversation + agent has 3+ recent negative conversations
  if (overallSentiment < -0.2) {
    // Filter in SQL: this used to load every ended conversation ever, messages
    // included, each time a negative one finished.
    const recentNegative = db.select({ participants: conversations.participants })
      .from(conversations)
      .where(and(
        eq(conversations.status, 'ended'),
        lt(conversations.sentiment, -0.2),
        gt(conversations.ended_at, Date.now() - 1440000),
      ))
      .all();

    for (const pid of participantIds) {
      const recentConvos = recentNegative.filter(c => (c.participants as number[]).includes(pid));
      if (recentConvos.length >= 3) {
        createFact('reputation', pid, null, 1, [], 'observed');
      }
    }
  }
}
