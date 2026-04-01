import type { RetrievalStrategy, MemoryType } from './types';
import { CONVERSATION_TOKEN_BUDGET, CONVERSATION_TOP_K } from './constants';

export function conversationStrategy(otherAgentName: string, topic: string | null): RetrievalStrategy {
  return {
    queries: [
      `What is my relationship with ${otherAgentName}?`,
      topic ? `What do I know about ${topic}?` : 'What happened to me recently?',
    ],
    topK: CONVERSATION_TOP_K,
    tokenBudget: CONVERSATION_TOKEN_BUDGET,
    deduplicate: true,
    boostTypes: ['reflection'] as MemoryType[],
  };
}
