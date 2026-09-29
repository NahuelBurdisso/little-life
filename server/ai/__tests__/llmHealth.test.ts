import { describe, it, expect, vi } from 'vitest';
import {
  DOWN_AFTER_FAILURES, EVIDENCE_MAX_AGE_MS, LLMHealthTracker,
  describeLLMError, evaluateEmbeddingHealth, evaluateLLMHealth,
  type CallOutcome, type HealthEvidence,
} from '../llmHealth';

const NOW = 1_000_000;

function calls(spec: string, error = 'Ollama chat request failed (500): boom', gapMs = 1000): CallOutcome[] {
  // 'o' = ok, 'x' = failed, oldest first, the last one `gapMs` before NOW.
  return [...spec].map((c, i) => ({
    ok: c === 'o',
    atMs: NOW - (spec.length - i) * gapMs,
    error: c === 'x' ? error : undefined,
  }));
}

function evidence(over: Partial<HealthEvidence> = {}): HealthEvidence {
  return { nowMs: NOW, chatCalls: [], missingChatModel: null, breakerOpen: false, conversationsOnTemplates: false, ...over };
}

describe('evaluateLLMHealth', () => {
  it('is ok with no evidence (a fresh start says nothing)', () => {
    expect(evaluateLLMHealth(evidence())).toEqual({ status: 'ok', reason: null });
  });

  it('is ok while calls succeed', () => {
    expect(evaluateLLMHealth(evidence({ chatCalls: calls('oooooooooo') })).status).toBe('ok');
  });

  it('names the missing model and how to get it', () => {
    const v = evaluateLLMHealth(evidence({ missingChatModel: 'gemma4:26b' }));
    expect(v.status).toBe('down');
    expect(v.reason).toContain('gemma4:26b');
    expect(v.reason).toContain('ollama pull');
  });

  it('is down after a run of failures, with a readable cause', () => {
    const v = evaluateLLMHealth(evidence({ chatCalls: calls('oo' + 'x'.repeat(DOWN_AFTER_FAILURES), 'fetch failed') }));
    expect(v.status).toBe('down');
    expect(v.reason).toBe('cannot reach Ollama - is it running?');
  });

  it('one success ends the failure streak', () => {
    const v = evaluateLLMHealth(evidence({ chatCalls: calls('xxxxo') }));
    expect(v.status).not.toBe('down');
  });

  it('is down while the planning breaker is open, even with no chat evidence left', () => {
    expect(evaluateLLMHealth(evidence({ breakerOpen: true })).status).toBe('down');
  });

  it('is degraded when a real share of recent calls fail', () => {
    // 3 failures scattered in 10 calls: 30%, no streak.
    const v = evaluateLLMHealth(evidence({ chatCalls: calls('oxooxooxoo', 'LLM request timed out after 60000ms') }));
    expect(v.status).toBe('degraded');
    expect(v.reason).toBe('the model is not answering in time');
  });

  it('does not judge a rate from a handful of calls', () => {
    expect(evaluateLLMHealth(evidence({ chatCalls: calls('oxo') })).status).toBe('ok');
  });

  it('is degraded when conversations were demoted to templates by slow turns', () => {
    const v = evaluateLLMHealth(evidence({ conversationsOnTemplates: true }));
    expect(v.status).toBe('degraded');
  });

  it('ignores evidence older than the expiry (a paused game must not keep the banner up)', () => {
    const old: CallOutcome[] = [1, 2, 3, 4].map((i) => ({ ok: false, atMs: NOW - EVIDENCE_MAX_AGE_MS - i, error: 'fetch failed' }));
    expect(evaluateLLMHealth(evidence({ chatCalls: old })).status).toBe('ok');
  });
});

describe('describeLLMError', () => {
  it('maps the common failures to plain words', () => {
    expect(describeLLMError('LLM request timed out after 60000ms')).toBe('the model is not answering in time');
    expect(describeLLMError('Ollama chat request failed (404): {"error":"model \\"x\\" not found, try pulling it first"}')).toBe('the model is not installed');
    expect(describeLLMError('Ollama chat request failed (503): overloaded')).toBe('the LLM server is returning errors');
    expect(describeLLMError(undefined)).toBe('no answer from the model');
  });

  it('truncates anything else', () => {
    expect(describeLLMError('x'.repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe('evaluateEmbeddingHealth', () => {
  it('is ok until embeddings fail several times in a row', () => {
    expect(evaluateEmbeddingHealth({ nowMs: NOW, calls: calls('ox'), missingModel: null }).ok).toBe(true);
    expect(evaluateEmbeddingHealth({ nowMs: NOW, calls: calls('oxxx'), missingModel: null }).ok).toBe(false);
  });

  it('flags a missing embedding model', () => {
    const v = evaluateEmbeddingHealth({ nowMs: NOW, calls: [], missingModel: 'qwen3-embedding:0.6b' });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('qwen3-embedding:0.6b');
  });
});

describe('LLMHealthTracker', () => {
  it('records outcomes, tells listeners, and clears a missing model on the first success', () => {
    let t = NOW;
    const tracker = new LLMHealthTracker(() => t);
    const seen = vi.fn();
    tracker.onChange(seen);

    tracker.noteModelMissing('chat', 'gemma4');
    expect(tracker.evidence().missingChatModel).toBe('gemma4');

    t += 1000;
    tracker.noteChat(true, 'gemma4');
    expect(tracker.evidence().missingChatModel).toBeNull();
    expect(tracker.evidence().chatCalls).toHaveLength(1);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('notices "model not found" in an ordinary failure', () => {
    const tracker = new LLMHealthTracker(() => NOW);
    tracker.noteChat(false, 'gemma4', 'Ollama chat request failed (404): model "gemma4" not found, try pulling it first');
    expect(tracker.evidence().missingChatModel).toBe('gemma4');
  });

  it('keeps a bounded history and survives a throwing listener', () => {
    const tracker = new LLMHealthTracker(() => NOW);
    tracker.onChange(() => { throw new Error('boom'); });
    for (let i = 0; i < 100; i++) tracker.noteChat(true, 'm');
    expect(tracker.evidence().chatCalls.length).toBeLessThanOrEqual(40);
  });
});
