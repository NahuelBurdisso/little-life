/**
 * Per-purpose LLM call metrics + optional JSONL trace.
 *
 * Every chat call is tagged with what it is for (a conversation turn, a daily
 * plan, a reflection…). Before this the only numbers were "slots active /
 * queued", which can say the model is falling behind but not *which* system is
 * feeding it or whether a slow turn was queueing, prefilling a huge prompt or
 * generating. Ollama reports token counts and phase durations with every
 * reply; they are kept here per purpose so a model or prompt change can be
 * judged on real traffic (`world.getLLMMetrics`, `scripts/llm-bench.ts`).
 *
 * `LLM_TRACE=<path>` additionally appends every request and reply as one JSON
 * line: the corpus `scripts/llm-bench.ts` replays against candidate models.
 * Off unless set — it stores full prompts.
 */

import fs from 'fs';
import path from 'path';

export type LLMPurpose =
  | 'conversation'
  | 'conversation.retry'
  | 'conversation.summary'
  | 'gazette'
  | 'intimacy.consent'
  | 'snap'
  | 'goal.review'
  | 'goal.ambition'
  | 'goal.pivot'
  | 'reflection.questions'
  | 'reflection.insights'
  | 'self_description'
  | 'plan.daily'
  | 'plan.decompose'
  | 'plan.revise'
  | 'other';

export interface LLMCallSample {
  purpose: LLMPurpose;
  model: string;
  ok: boolean;
  /** Wall time from asking for a slot to the reply (queue + model). */
  totalMs: number;
  /** Time spent waiting for a semaphore slot. */
  queueMs: number;
  promptTokens?: number;
  outputTokens?: number;
  /** Ollama prompt_eval_duration — prefill. */
  prefillMs?: number;
  /** Ollama eval_duration — generation. */
  genMs?: number;
  /** Ollama load_duration — > ~100 ms means the model was (re)loaded. */
  loadMs?: number;
  truncated?: boolean;
  error?: string;
}

interface PurposeStats {
  calls: number;
  errors: number;
  truncated: number;
  reloads: number;
  totalMs: number[];
  queueMs: number;
  promptTokens: number;
  outputTokens: number;
  genMs: number;
}

/** Latency samples kept per purpose for percentiles. */
const WINDOW = 200;

const stats = new Map<LLMPurpose, PurposeStats>();

function bucket(purpose: LLMPurpose): PurposeStats {
  let s = stats.get(purpose);
  if (!s) {
    s = { calls: 0, errors: 0, truncated: 0, reloads: 0, totalMs: [], queueMs: 0, promptTokens: 0, outputTokens: 0, genMs: 0 };
    stats.set(purpose, s);
  }
  return s;
}

export function recordLLMCall(sample: LLMCallSample): void {
  const s = bucket(sample.purpose);
  s.calls++;
  if (!sample.ok) s.errors++;
  if (sample.truncated) s.truncated++;
  if ((sample.loadMs ?? 0) > 500) s.reloads++;
  s.totalMs.push(sample.totalMs);
  if (s.totalMs.length > WINDOW) s.totalMs.shift();
  s.queueMs += sample.queueMs;
  s.promptTokens += sample.promptTokens ?? 0;
  s.outputTokens += sample.outputTokens ?? 0;
  s.genMs += sample.genMs ?? 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export interface PurposeSummary {
  purpose: LLMPurpose;
  calls: number;
  errors: number;
  truncated: number;
  reloads: number;
  p50Ms: number;
  p95Ms: number;
  avgQueueMs: number;
  avgPromptTokens: number;
  avgOutputTokens: number;
  /** Generation speed per request (not aggregate throughput). */
  tokPerSec: number;
}

export function getLLMMetrics(): PurposeSummary[] {
  return [...stats.entries()]
    .map(([purpose, s]) => {
      const sorted = [...s.totalMs].sort((a, b) => a - b);
      return {
        purpose,
        calls: s.calls,
        errors: s.errors,
        truncated: s.truncated,
        reloads: s.reloads,
        p50Ms: Math.round(percentile(sorted, 0.5)),
        p95Ms: Math.round(percentile(sorted, 0.95)),
        avgQueueMs: Math.round(s.queueMs / s.calls),
        avgPromptTokens: Math.round(s.promptTokens / s.calls),
        avgOutputTokens: Math.round(s.outputTokens / s.calls),
        tokPerSec: s.genMs > 0 ? Math.round((s.outputTokens / s.genMs) * 1000 * 10) / 10 : 0,
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

export function resetLLMMetrics(): void {
  stats.clear();
}

// ─── Trace ────────────────────────────────────────────────────────────────────

let traceStream: fs.WriteStream | null | undefined;

function traceOut(): fs.WriteStream | null {
  if (traceStream !== undefined) return traceStream;
  const file = process.env.LLM_TRACE;
  if (!file) return (traceStream = null);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  traceStream = fs.createWriteStream(file, { flags: 'a' });
  return traceStream;
}

export interface LLMTraceEntry extends LLMCallSample {
  ts: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
  options?: Record<string, unknown>;
  format?: unknown;
  text?: string;
}

export function traceLLMCall(entry: LLMTraceEntry): void {
  const out = traceOut();
  if (out) out.write(JSON.stringify(entry) + '\n');
}
