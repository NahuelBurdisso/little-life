interface EvaluationInput {
  messages: Array<{ text: string; sentiment: number }>;
  injectedMemories: string[];
  topic: string | null;
  maxTurns: number;
  relationshipDeltas: { friendship: number; romance: number; trust: number };
}

interface EvaluationResult {
  quality_score: number;
  quality_breakdown: Record<string, number>;
}

export function evaluateConversation(params: EvaluationInput): EvaluationResult {
  const { messages, injectedMemories, topic, maxTurns, relationshipDeltas } = params;

  // 1. Memory Reference (0-1): did messages reference injected memories?
  let memoryRef = 0;
  if (injectedMemories.length > 0) {
    const allText = messages.map(m => m.text.toLowerCase()).join(' ');
    let matches = 0;
    for (const mem of injectedMemories) {
      // Check if key phrases from the memory appear in conversation
      const keywords = mem.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const found = keywords.some(kw => allText.includes(kw));
      if (found) matches++;
    }
    memoryRef = matches / injectedMemories.length;
  }

  // 2. Sentiment Variance (0-1): emotional range across messages
  let sentimentVar = 0;
  if (messages.length >= 2) {
    const sentiments = messages.map(m => m.sentiment);
    const mean = sentiments.reduce((a, b) => a + b, 0) / sentiments.length;
    const variance = sentiments.reduce((sum, s) => sum + (s - mean) ** 2, 0) / sentiments.length;
    const stddev = Math.sqrt(variance);
    // Normalize: stddev of 0.5 = fully varied, 0 = flat
    sentimentVar = Math.min(1, stddev / 0.5);
  }

  // 3. Relationship Impact (0-1): did anything actually change?
  const totalDelta = Math.abs(relationshipDeltas.friendship) + Math.abs(relationshipDeltas.romance) + Math.abs(relationshipDeltas.trust);
  const relationshipImpact = Math.min(1, totalDelta / 30); // 30 total delta = max score

  // 4. Turn Engagement (0-1): used the available turns?
  const turnEngagement = maxTurns > 0 ? Math.min(1, messages.length / maxTurns) : 0.5;

  // 5. Topic Coherence (0-1): did conversation stay on topic?
  let topicCoherence = 0.5; // default: no topic provided
  if (topic) {
    const topicWords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const allText = messages.map(m => m.text.toLowerCase()).join(' ');
    if (topicWords.length > 0) {
      const found = topicWords.filter(w => allText.includes(w)).length;
      topicCoherence = found / topicWords.length;
    }
  }

  // Combined score (weighted)
  // If no injected memories available, redistribute that weight to other factors
  const hasMemories = injectedMemories.length > 0;
  const memWeight = hasMemories ? 0.20 : 0;
  const sentWeight = hasMemories ? 0.20 : 0.30;
  const relWeight = hasMemories ? 0.25 : 0.30;
  const turnWeight = hasMemories ? 0.15 : 0.20;
  const topicWeight = hasMemories ? 0.20 : 0.20;

  const quality_score =
    memoryRef * memWeight +
    sentimentVar * sentWeight +
    relationshipImpact * relWeight +
    turnEngagement * turnWeight +
    topicCoherence * topicWeight;

  return {
    quality_score: Math.round(quality_score * 1000) / 1000,
    quality_breakdown: {
      memory_reference: Math.round(memoryRef * 100) / 100,
      sentiment_variance: Math.round(sentimentVar * 100) / 100,
      relationship_impact: Math.round(relationshipImpact * 100) / 100,
      turn_engagement: Math.round(turnEngagement * 100) / 100,
      topic_coherence: Math.round(topicCoherence * 100) / 100,
    },
  };
}
