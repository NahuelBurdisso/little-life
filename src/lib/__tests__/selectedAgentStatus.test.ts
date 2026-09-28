import { describe, it, expect } from 'vitest';
import { selectedAgentStatus } from '../selectedAgentStatus';

const q = (data: unknown, isPending = false, isError = false) => ({ data, isPending, isError });

describe('selectedAgentStatus', () => {
  it('is none when nothing is selected', () => {
    expect(selectedAgentStatus(null, q(undefined, true))).toBe('none');
  });

  it('is loading only while the first fetch is in flight', () => {
    expect(selectedAgentStatus('3', q(undefined, true))).toBe('loading');
  });

  it('is notFound when the server answers null (removed agent / replaced world)', () => {
    expect(selectedAgentStatus('3', q(null))).toBe('notFound');
  });

  it('is notFound for an id the query can never run with', () => {
    expect(selectedAgentStatus('abc', q(undefined, true))).toBe('notFound');
    expect(selectedAgentStatus('0', q(undefined, true))).toBe('notFound');
  });

  it('is error when the fetch failed and there is nothing to show', () => {
    expect(selectedAgentStatus('3', q(undefined, false, true))).toBe('error');
  });

  it('keeps showing the last good summary through a failed refetch', () => {
    expect(selectedAgentStatus('3', q({ agent: { id: 3 } }, false, true))).toBe('ready');
  });

  it('is ready for a dead agent — the row survives with is_active false', () => {
    expect(selectedAgentStatus('3', q({ agent: { id: 3, is_active: false } }))).toBe('ready');
  });
});
