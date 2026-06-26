import type { MemoryService } from './MemoryService';
import type { ContextItem } from './types';
import { conversationStrategy } from './strategies';

export class ContextBuilder {
  constructor(private memoryService: MemoryService) {}

  async forConversation(params: {
    agentId: number;
    otherAgentName: string;
    topic: string | null;
    statePrompts: string[];
    situationalPrompt: string | null;
  }): Promise<ContextItem[]> {
    const items: ContextItem[] = [];

    // 1. Situation and state prompts (same priority as current system)
    if (params.situationalPrompt) {
      items.push({ type: 'situation', text: params.situationalPrompt });
    }
    for (const sp of params.statePrompts.slice(0, 4)) {
      items.push({ type: 'state', text: sp });
    }

    // 2. Memory retrieval
    try {
      const strategy = conversationStrategy(params.otherAgentName, params.topic);
      const memories = await this.memoryService.retrieveWithStrategy(params.agentId, strategy);
      for (const r of memories) {
        items.push({ type: 'memory', text: r.memory.description });
      }
    } catch (err) {
      console.warn('Memory retrieval failed, falling back to recency:', (err as Error).message);
      const recent = await this.memoryService.retrieveByType(params.agentId, 'conversation', 3);
      for (const m of recent) {
        items.push({ type: 'memory', text: m.description });
      }
    }

    return items;
  }
}
