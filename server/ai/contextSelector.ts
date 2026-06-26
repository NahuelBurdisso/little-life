export interface ContextItem {
  type: 'situation' | 'state' | 'memory' | 'fact';
  text: string;
}

interface MemoryInput {
  description: string;
  emotional_valence: number;
  created_at: number;
  metadata: Record<string, unknown>;
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

  const relatedAgents = (memory.metadata?.related_agents as number[] | undefined) ?? [];
  if (
    memory.description.toLowerCase().includes(otherAgentName.toLowerCase()) ||
    relatedAgents.includes(otherAgentId)
  ) {
    score += 0.5;
  }

  if (topic && memory.description.toLowerCase().includes(topic.toLowerCase())) {
    score += 0.3;
  }

  const ticksAgo = currentTick - memory.created_at;
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

const MAX_CONTEXT_ITEMS = 5;
const MAX_MEMORIES = 3;
const MAX_FACTS = 2;

export function selectConversationContext(params: ContextSelectorParams): ContextItem[] {
  const {
    memories, facts, statePrompts, situationalPrompt,
    otherAgentName, otherAgentId, topic, currentTick, friendship,
  } = params;

  const items: ContextItem[] = [];

  // 1. Situational prompt (always first if present)
  if (situationalPrompt) {
    items.push({ type: 'situation', text: situationalPrompt });
  }

  // 2. State prompts (up to 2 most relevant)
  for (const sp of statePrompts.slice(0, 2)) {
    if (items.length < MAX_CONTEXT_ITEMS) {
      items.push({ type: 'state', text: sp });
    }
  }

  // 3. Relevant memories (up to MAX_MEMORIES)
  const scoredMemories = memories
    .map(m => ({ memory: m, score: scoreMemory(m, otherAgentName, otherAgentId, topic, currentTick, friendship) }))
    .filter(m => m.score >= RELEVANCE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  for (let i = 0; i < Math.min(scoredMemories.length, MAX_MEMORIES); i++) {
    if (items.length < MAX_CONTEXT_ITEMS) {
      items.push({ type: 'memory', text: scoredMemories[i].memory.description });
    }
  }

  // 4. Gossip facts (up to MAX_FACTS — prioritize high sensitivity)
  const sortedFacts = [...facts].sort((a, b) => b.sensitivity - a.sensitivity);
  for (let i = 0; i < Math.min(sortedFacts.length, MAX_FACTS); i++) {
    if (items.length < MAX_CONTEXT_ITEMS) {
      items.push({ type: 'fact', text: sortedFacts[i].content });
    }
  }

  return items;
}
