export interface ContextItem {
  type: 'situation' | 'state' | 'memory' | 'fact';
  text: string;
}

interface MemoryInput {
  content: string;
  emotional_valence: number;
  timestamp: number;
  related_agents: number[];
  tags: string[];
}

interface FactInput {
  content: string;
  sensitivity: number;
}

export interface ContextSelectorParams {
  memories: MemoryInput[];
  facts: FactInput[];
  statePrompts: string[];
  situationalPrompt: string | null;
  otherAgentName: string;
  otherAgentId: number;
  topic: string | null;
  currentTick: number;
  friendship: number;
}

const RELEVANCE_THRESHOLD = 0.3;

function scoreMemory(
  memory: MemoryInput,
  otherAgentName: string,
  otherAgentId: number,
  topic: string | null,
  currentTick: number,
  friendship: number,
): number {
  let score = 0;

  if (
    memory.content.toLowerCase().includes(otherAgentName.toLowerCase()) ||
    memory.related_agents.includes(otherAgentId)
  ) {
    score += 0.5;
  }

  if (topic && memory.content.toLowerCase().includes(topic.toLowerCase())) {
    score += 0.3;
  }

  const ticksAgo = currentTick - memory.timestamp;
  if (ticksAgo >= 0 && ticksAgo < 1440) {
    score += 0.2;
  }

  if (Math.abs(memory.emotional_valence) > 0.5) {
    score += 0.1;
  }

  if (friendship < -20 && memory.emotional_valence < -0.3) {
    score += 0.3;
  }

  return score;
}

export function selectConversationContext(params: ContextSelectorParams): ContextItem[] {
  const {
    memories, facts, statePrompts, situationalPrompt,
    otherAgentName, otherAgentId, topic, currentTick, friendship,
  } = params;

  const items: ContextItem[] = [];

  if (situationalPrompt) {
    items.push({ type: 'situation', text: situationalPrompt });
  }

  if (items.length < 2 && statePrompts.length > 0) {
    items.push({ type: 'state', text: statePrompts[0] });
  }

  if (items.length >= 2) return items;

  const scoredMemories = memories
    .map(m => ({ memory: m, score: scoreMemory(m, otherAgentName, otherAgentId, topic, currentTick, friendship) }))
    .filter(m => m.score >= RELEVANCE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scoredMemories.length > 0 && items.length < 2) {
    items.push({ type: 'memory', text: scoredMemories[0].memory.content });
  }

  if (items.length >= 2) return items;

  if (facts.length > 0 && items.length < 2) {
    items.push({ type: 'fact', text: facts[0].content });
  }

  return items;
}
