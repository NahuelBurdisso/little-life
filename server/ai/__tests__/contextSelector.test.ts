import { describe, it, expect } from 'vitest';
import { selectConversationContext } from '../contextSelector';

const makeMemory = (overrides: Partial<{
  content: string; emotional_valence: number; timestamp: number;
  related_agents: number[]; tags: string[];
}> = {}) => ({
  id: 1,
  agent_id: 1,
  content: overrides.content ?? 'A generic memory about something.',
  type: 'experience',
  importance: 5,
  emotional_valence: overrides.emotional_valence ?? 0,
  embedding: null,
  related_agents: overrides.related_agents ?? [],
  related_location: null,
  tags: overrides.tags ?? [],
  timestamp: overrides.timestamp ?? 0,
  access_count: 0,
  last_accessed: 0,
});

describe('selectConversationContext', () => {
  it('situational prompt always wins slot 1', () => {
    const result = selectConversationContext({
      memories: [makeMemory({ content: 'Great memory about Bob', related_agents: [2] })],
      facts: [{ content: 'Bob has a secret', sensitivity: 2 }],
      statePrompts: ['You are drunk.'],
      situationalPrompt: 'You need to confront Bob.',
      otherAgentName: 'Bob',
      otherAgentId: 2,
      topic: 'confrontation',
      currentTick: 100,
      friendship: -40,
    });
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result[0].type).toBe('situation');
    expect(result[0].text).toContain('confront Bob');
  });

  it('life state gets slot 2 when situational prompt present', () => {
    const result = selectConversationContext({
      memories: [],
      facts: [],
      statePrompts: ['You are drunk and loose-lipped.'],
      situationalPrompt: 'You need to beg for money.',
      otherAgentName: 'Marco',
      otherAgentId: 3,
      topic: 'begging',
      currentTick: 100,
      friendship: 40,
    });
    expect(result.length).toBe(2);
    expect(result[0].type).toBe('situation');
    expect(result[1].type).toBe('state');
  });

  it('picks highest-scored memory when no situational prompt', () => {
    const result = selectConversationContext({
      memories: [
        makeMemory({ content: 'Something about weather', timestamp: 50 }),
        makeMemory({ content: 'Argued with Bob last week about money', related_agents: [2], emotional_valence: -0.8, timestamp: 80 }),
      ],
      facts: [],
      statePrompts: [],
      situationalPrompt: null,
      otherAgentName: 'Bob',
      otherAgentId: 2,
      topic: 'money',
      currentTick: 100,
      friendship: -40,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].type).toBe('memory');
    expect(result[0].text).toContain('Argued with Bob');
  });

  it('picks fact when no relevant memory', () => {
    const result = selectConversationContext({
      memories: [makeMemory({ content: 'Something generic about nothing' })],
      facts: [{ content: 'Bob secretly hates his job.', sensitivity: 1 }],
      statePrompts: [],
      situationalPrompt: null,
      otherAgentName: 'Bob',
      otherAgentId: 2,
      topic: 'work',
      currentTick: 100,
      friendship: 0,
    });
    expect(result.some(i => i.type === 'fact')).toBe(true);
  });

  it('returns empty when nothing is relevant', () => {
    const result = selectConversationContext({
      memories: [makeMemory({ content: 'I ate a sandwich' })],
      facts: [],
      statePrompts: [],
      situationalPrompt: null,
      otherAgentName: 'Bob',
      otherAgentId: 2,
      topic: null,
      currentTick: 100,
      friendship: 0,
    });
    expect(result.length).toBe(0);
  });

  it('boosts negative memories for hostile relationships', () => {
    const negativeMemory = makeMemory({
      content: 'Bob stole from the shop',
      related_agents: [2],
      emotional_valence: -0.9,
      timestamp: 80,
    });
    const positiveMemory = makeMemory({
      content: 'Had a nice chat with Bob about music',
      related_agents: [2],
      emotional_valence: 0.6,
      timestamp: 90,
    });
    const result = selectConversationContext({
      memories: [positiveMemory, negativeMemory],
      facts: [],
      statePrompts: [],
      situationalPrompt: null,
      otherAgentName: 'Bob',
      otherAgentId: 2,
      topic: null,
      currentTick: 100,
      friendship: -50,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].text).toContain('stole');
  });
});
