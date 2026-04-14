import { describe, it, expect } from 'vitest';
import { parseSnapResponse, SnapResolver } from '../lib/cascade/SnapResolver';

describe('parseSnapResponse', () => {
  it('exact match: confront', () => {
    expect(parseSnapResponse('confront')).toBe('confront');
  });

  it('uppercase: FLEE', () => {
    expect(parseSnapResponse('FLEE')).toBe('flee');
  });

  it('verbose with label: Action: breakdown', () => {
    expect(parseSnapResponse('Action: breakdown')).toBe('breakdown');
  });

  it('mid-sentence uppercase: I think the best action would be to PLOT revenge.', () => {
    expect(parseSnapResponse('I think the best action would be to PLOT revenge.')).toBe('plot');
  });

  it('lash_out at start of sentence', () => {
    expect(parseSnapResponse('lash_out seems right')).toBe('lash_out');
  });

  it('empty string → breakdown', () => {
    expect(parseSnapResponse('')).toBe('breakdown');
  });

  it('gibberish → breakdown', () => {
    expect(parseSnapResponse('xkcd quantum banana')).toBe('breakdown');
  });

  it('self_destruct exact match', () => {
    expect(parseSnapResponse('self_destruct')).toBe('self_destruct');
  });

  it('mixed case: pLoT', () => {
    expect(parseSnapResponse('pLoT')).toBe('plot');
  });
});

describe('SnapResolver.buildSnapPrompt', () => {
  const resolver = new SnapResolver();

  const baseCtx = {
    agentName: 'Maria',
    personalitySummary: 'Empathetic but easily overwhelmed, prone to anxiety',
    tensionSources: [
      { event: 'argument', description: 'Had a heated argument with her boss', tick: 42 },
      { event: 'gossip', description: 'Found out her friend spread rumors about her', tick: 45 },
    ],
    activeStates: ['stressed', 'anxious'],
    activeGoals: ['find a new job', 'repair friendship with Luis'],
  };

  it('contains the agent name', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('Maria');
  });

  it('contains the personality summary', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('Empathetic but easily overwhelmed, prone to anxiety');
  });

  it('contains each tension source description', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('Had a heated argument with her boss');
    expect(prompt).toContain('Found out her friend spread rumors about her');
  });

  it('contains all 6 action options', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('confront');
    expect(prompt).toContain('flee');
    expect(prompt).toContain('plot');
    expect(prompt).toContain('breakdown');
    expect(prompt).toContain('lash_out');
    expect(prompt).toContain('self_destruct');
  });

  it('lists active states', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('stressed');
    expect(prompt).toContain('anxious');
  });

  it('lists active goals', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('find a new job');
  });

  it('shows "none" when no states are present', () => {
    const ctx = { ...baseCtx, activeStates: [] };
    const prompt = resolver.buildSnapPrompt(ctx);
    expect(prompt).toContain('none');
  });

  it('shows "none" when no goals are present', () => {
    const ctx = { ...baseCtx, activeGoals: [] };
    const prompt = resolver.buildSnapPrompt(ctx);
    expect(prompt).toContain('none');
  });
});
