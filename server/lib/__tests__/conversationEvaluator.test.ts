import { describe, it, expect } from 'vitest';
import { evaluateConversation } from '../conversationEvaluator';

const base = {
  injectedMemories: [],
  topic: null,
  maxTurns: 4,
  relationshipDeltas: { friendship: 0, romance: 0, trust: 0 },
};

describe('evaluateConversation — canned fallbacks', () => {
  it('leaves fallback actions out of content metrics but still counts the turn', () => {
    const spoken = [
      { text: 'I missed you so much.', sentiment: 0.6 },
      { text: 'I missed you too.', sentiment: 0.6 },
    ];
    const withFallbacks = [
      ...spoken,
      // A stored sentiment on narration would have faked emotional range.
      { text: 'Omar Haddad shrugged.', sentiment: -0.9, fallback: true },
      { text: '"Hmm, interesting," Sofia Reyes said.', sentiment: 0.9, fallback: true },
    ];

    const a = evaluateConversation({ ...base, messages: spoken });
    const b = evaluateConversation({ ...base, messages: withFallbacks });

    expect(b.quality_breakdown.sentiment_variance).toBe(a.quality_breakdown.sentiment_variance);
    expect(a.quality_breakdown.turn_engagement).toBe(0.5);
    expect(b.quality_breakdown.turn_engagement).toBe(1);
  });
});
