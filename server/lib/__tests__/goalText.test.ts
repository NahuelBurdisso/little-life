import { describe, it, expect, vi, beforeEach } from 'vitest';
import { goalClause } from '../goalText';
import { initMemoryObserver } from '../memory/MemoryObserver';
import type { MemoryService } from '../memory/MemoryService';
import { simEvents } from '../simEvents';
import { renderMessage } from '../activityMessage';

/**
 * G9: goal memories read "I've decided to Assess the situation with Marco....."
 * — an LLM-authored imperative, capitalised and already punctuated, spliced
 * after "decided to" and given one more full stop. Trigger-made goals carry a
 * registry key instead ("I've decided to revenge.").
 */
describe('goalClause', () => {
  it('turns a registry key into prose', () => {
    expect(goalClause('revenge')).toBe('getting revenge');
    expect(goalClause('some_new_key')).toBe('some new key');
  });

  it('drops trailing punctuation from LLM prose, keeping a cut-off as one ellipsis', () => {
    expect(goalClause('Win back Rosa\'s trust.')).toBe('Win back Rosa\'s trust');
    expect(goalClause('  Assess the situation with Marco .....')).toBe('Assess the situation with Marco…');
    expect(goalClause('Find out who took the money…')).toBe('Find out who took the money…');
    expect(goalClause('Is Marco lying?')).toBe('Is Marco lying?');
  });
});

describe('goal memories', () => {
  const record = vi.fn();
  initMemoryObserver({ record } as unknown as MemoryService);
  beforeEach(() => record.mockClear());
  const lastLine = () => record.mock.calls.at(-1)?.[2] as string;

  it('never splice a capitalised imperative after "decided to" or double the full stop', () => {
    simEvents.emit('goal:created', { agentId: 5, description: 'Assess the situation with Marco.....' });
    expect(lastLine()).toBe('I set myself a new goal: Assess the situation with Marco…');
    simEvents.emit('goal:created', { agentId: 5, goalType: 'revenge' });
    expect(lastLine()).toBe('I set myself a new goal: getting revenge.');
  });

  it('keep completed, abandoned and pivoted goals to one sentence end each', () => {
    simEvents.emit('goal:completed', { agentId: 5, description: 'Win back Rosa\'s trust.' });
    expect(lastLine()).toBe('I accomplished my goal: Win back Rosa\'s trust.');
    simEvents.emit('goal:abandoned', { agentId: 5, goalType: 'steal_from', reason: 'It was never going to work.' });
    expect(lastLine()).toBe('I gave up on my goal: stealing from someone. It was never going to work.');
    simEvents.emit('goal:pivoted', { agentId: 5, description: 'Win back Rosa\'s trust.', newStrategy: 'Apologise in public.' });
    expect(lastLine()).toBe('My approach to my goal (Win back Rosa\'s trust) wasn\'t working. I\'m going to try: Apologise in public.');
  });
});

describe('goal feed lines', () => {
  it('do not repeat the LLM\'s trailing dots', () => {
    expect(renderMessage({ type: 'goal_created', template_data: { name: 'Rosa', goal: 'Assess the situation.....' }, timestamp: 0 }))
      .toBe('Rosa set a new goal: Assess the situation…');
  });
});
