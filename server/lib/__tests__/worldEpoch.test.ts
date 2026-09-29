import { describe, it, expect, vi, beforeEach } from 'vitest';

// generateEmbeddingForMemory's two collaborators: the model call is held open
// by the test, the write is recorded.
const embedding = vi.hoisted(() => ({ resolve: null as null | ((v: number[]) => void) }));
vi.mock('../../ai/ollama', () => ({
  callOllamaEmbedding: vi.fn(() => new Promise<number[]>((r) => { embedding.resolve = r; })),
}));
vi.mock('../../helpers/embeddingHelpers', () => ({ writeEmbedding: vi.fn() }));

import { currentWorldEpoch, isStaleWorldEpoch, worldAbortSignal, bumpWorldEpoch } from '../worldEpoch';
import { PlanLLMGate } from '../planning/PlanLLMGate';
import { generateEmbeddingForMemory } from '../../ai/generateEmbedding';
import { writeEmbedding } from '../../helpers/embeddingHelpers';

describe('world epoch', () => {
  beforeEach(() => {
    vi.mocked(writeEmbedding).mockClear();
  });

  it('makes every captured epoch stale and aborts the signal of the outgoing world', () => {
    const captured = currentWorldEpoch();
    const outgoing = worldAbortSignal();
    let epochSeenByListener = -1;
    outgoing.addEventListener('abort', () => { epochSeenByListener = currentWorldEpoch(); });

    expect(isStaleWorldEpoch(captured)).toBe(false);
    const next = bumpWorldEpoch();

    expect(next).toBe(captured + 1);
    expect(isStaleWorldEpoch(captured)).toBe(true);
    expect(isStaleWorldEpoch(next)).toBe(false);
    expect(outgoing.aborted).toBe(true);
    // The incoming world's signal is live, and was installed before the old
    // one fired: a listener reacting to the abort already sees the new epoch.
    expect(worldAbortSignal().aborted).toBe(false);
    expect(epochSeenByListener).toBe(next);
  });

  it("moves the planning gate's epoch, so an aborted plan job drops out instead of booking an outage", () => {
    const gate = new PlanLLMGate(() => 0);
    const before = gate.epoch;
    bumpWorldEpoch();
    expect(gate.epoch).not.toBe(before);
    // Its own clear() still moves it too.
    const afterBump = gate.epoch;
    gate.clear();
    expect(gate.epoch).not.toBe(afterBump);
  });

  it('drops a memory embedding that lands after a world swap (memory ids are reused)', async () => {
    const late = generateEmbeddingForMemory(7, 'old world memory');
    bumpWorldEpoch();
    embedding.resolve!([0.1, 0.2]);
    await late;
    expect(writeEmbedding).not.toHaveBeenCalled();

    const current = generateEmbeddingForMemory(7, 'new world memory');
    embedding.resolve!([0.3, 0.4]);
    await current;
    expect(writeEmbedding).toHaveBeenCalledTimes(1);
  });
});
