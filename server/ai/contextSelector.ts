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

// Topic synonym map — expands keyword matching for better memory retrieval
const TOPIC_SYNONYMS: Record<string, string[]> = {
  fishing: ['river', 'catch', 'fish', 'rod', 'bait', 'water'],
  cooking: ['food', 'kitchen', 'meal', 'recipe', 'eat', 'cook', 'bake'],
  gardening: ['garden', 'plant', 'flower', 'grow', 'soil', 'harvest'],
  performing: ['perform', 'sing', 'music', 'dance', 'stage', 'audience'],
  love: ['romance', 'heart', 'feelings', 'crush', 'date', 'kiss', 'attraction'],
  work: ['job', 'career', 'boss', 'salary', 'workplace', 'colleagues'],
  money: ['financial', 'debt', 'broke', 'rich', 'pay', 'afford', 'expense'],
  weather: ['rain', 'sun', 'storm', 'snow', 'cold', 'hot', 'wind'],
  family: ['home', 'house', 'parent', 'child', 'sibling'],
  health: ['sick', 'doctor', 'illness', 'pain', 'tired', 'energy'],
  gossip: ['rumor', 'heard', 'secret', 'scandal', 'affair'],
  fight: ['argue', 'conflict', 'angry', 'grudge', 'confrontation'],
};

function getTopicKeywords(topic: string): string[] {
  const lower = topic.toLowerCase();
  const keywords = [lower];
  for (const [key, synonyms] of Object.entries(TOPIC_SYNONYMS)) {
    if (lower.includes(key) || synonyms.some(s => lower.includes(s))) {
      keywords.push(...synonyms, key);
    }
  }
  return [...new Set(keywords)];
}

function scoreMemory(
  memory: MemoryInput,
  otherAgentName: string,
  otherAgentId: number,
  topic: string | null,
  currentTick: number,
  friendship: number,
): number {
  let score = 0;
  const desc = memory.description.toLowerCase();

  const relatedAgents = (memory.metadata?.related_agents as number[] | undefined) ?? [];
  // Mentions other agent
  if (desc.includes(otherAgentName.toLowerCase()) || relatedAgents.includes(otherAgentId)) {
    score += 0.5;
  }

  // Topic matching with synonym expansion
  if (topic) {
    const keywords = getTopicKeywords(topic);
    const matchCount = keywords.filter(kw => desc.includes(kw)).length;
    if (matchCount > 0) {
      score += Math.min(0.5, 0.15 * matchCount); // up to 0.5 from topic matching
    }
  }

  // Recency bonus
  const ticksAgo = currentTick - memory.created_at;
  if (ticksAgo >= 0 && ticksAgo < 1440) {
    score += 0.2;
  } else if (ticksAgo >= 0 && ticksAgo < 4320) {
    score += 0.1; // slight boost for memories from last 3 days
  }

  // Emotional memories are more salient
  if (Math.abs(memory.emotional_valence) > 0.5) {
    score += 0.1;
  }

  // Grudge-relevant negative memories
  if (friendship < -20 && memory.emotional_valence < -0.3) {
    score += 0.3;
  }

  return score;
}

const MAX_CONTEXT_ITEMS = 6;
const MAX_MEMORIES = 4;
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
