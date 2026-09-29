/**
 * LLM HTTP Client
 *
 * Supports two backends:
 *   - "ollama"  → Ollama REST API (/api/chat, /api/embeddings)
 *   - "openai"  → OpenAI-compatible API (/v1/chat/completions) — works with
 *                  llama-server, vLLM, LM Studio, LocalAI, etc.
 *
 * Embeddings always go through Ollama (separate base URL).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { CONFIG } from '../lib/constants';
import { acquireLLMSlot, acquireEmbeddingSlot, type LLMPriority } from './llmSemaphore';
import { LLMEmptyReplyError, LLMAbortedError } from './llmErrors';
import { recordLLMCall, traceLLMCall, type LLMPurpose, type LLMCallSample } from './llmMetrics';

export interface OllamaChatRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  baseUrl?: string;
  priority?: LLMPriority;
  /** What the call is for — metrics and the trace are grouped by it (llmMetrics.ts). */
  purpose?: LLMPurpose;
  /**
   * Constrain the reply: `'json'` or a JSON schema (Ollama structured outputs;
   * `response_format` on the OpenAI path). Grammar-constrained decoding makes a
   * malformed reply impossible instead of merely unlikely.
   */
  format?: 'json' | Record<string, unknown>;
  /**
   * Cancels the request (throws LLMAbortedError). A conversation turn passes
   * one so that closing the conversation frees its LLM and runner slots at once
   * instead of when a reply nobody will read finally arrives.
   */
  signal?: AbortSignal;
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
    repeat_penalty?: number;
    stop?: string[];
  };
}

export interface OllamaChatResponse {
  text: string;
  /**
   * The model stopped because it ran out of `num_predict` / `max_tokens`, not
   * because it finished (Ollama `done_reason: "length"`, OpenAI
   * `finish_reason: "length"`). Dialogue uses it to drop a half-sentence.
   */
  truncated?: boolean;
}

// ─── Chat ────────────────────────────────────────────────────────────────────

/** Ties the caller's signal to this request's own (timeout) controller. */
function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = (): void => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export async function callOllamaChat(
  request: OllamaChatRequest
): Promise<OllamaChatResponse> {
  const send = CONFIG.AI.BACKEND === 'openai' ? sendOpenAI : sendOllama;

  // Already cancelled: don't even queue for a slot.
  if (request.signal?.aborted) throw new LLMAbortedError();
  const queuedAt = performance.now();
  const release = await acquireLLMSlot(request.priority ?? 'normal');
  // Cancelled while queued for the slot: hand it straight back.
  if (request.signal?.aborted) {
    release();
    throw new LLMAbortedError();
  }

  const sample: LLMCallSample = {
    purpose: request.purpose ?? 'other',
    model: request.model,
    ok: false,
    totalMs: 0,
    queueMs: performance.now() - queuedAt,
  };
  let text: string | undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.AI.TIMEOUT_MS);
  const unlink = linkAbort(request.signal, controller);

  try {
    const result = await send(request, controller.signal, sample);
    sample.ok = true;
    text = result.text;
    return result;
  } catch (error: any) {
    sample.error = error?.message ?? String(error);
    if (error.name === "AbortError") {
      if (request.signal?.aborted) throw new LLMAbortedError();
      throw new Error(`LLM request timed out after ${CONFIG.AI.TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    unlink();
    release();
    // A call its owner cancelled says nothing about the model: not booked.
    if (!request.signal?.aborted) {
      sample.totalMs = performance.now() - queuedAt;
      recordLLMCall(sample);
      traceLLMCall({
        ...sample,
        ts: Date.now(),
        system: request.system,
        messages: request.messages,
        options: request.options,
        format: request.format,
        text,
      });
    }
  }
}

/** Ollama native /api/chat */
async function sendOllama(
  request: OllamaChatRequest,
  signal: AbortSignal,
  sample: LLMCallSample,
): Promise<OllamaChatResponse> {
  const baseUrl = request.baseUrl ?? CONFIG.AI.CHAT_BASE_URL;
  const body = {
    model: request.model,
    messages: [
      { role: "system" as const, content: request.system },
      ...request.messages,
    ],
    stream: false,
    think: false,
    keep_alive: CONFIG.AI.KEEP_ALIVE,
    ...(request.format ? { format: request.format } : {}),
    // num_ctx is pinned on every call: Ollama reloads the model whenever a
    // request asks for a different context size than the loaded one, and the
    // model's own default (32k on the Gemma 4 builds) sizes the KV cache of
    // every parallel slot for prompts that never pass ~3k tokens.
    options: { num_ctx: CONFIG.AI.NUM_CTX, ...request.options },
  };

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(
      `Ollama chat request failed (${response.status}): ${errorText}`
    );
  }

  const data = await response.json();
  const ms = (ns: unknown) => (typeof ns === 'number' ? ns / 1e6 : undefined);
  sample.promptTokens = data.prompt_eval_count;
  sample.outputTokens = data.eval_count;
  sample.prefillMs = ms(data.prompt_eval_duration);
  sample.genMs = ms(data.eval_duration);
  sample.loadMs = ms(data.load_duration);
  sample.truncated = data.done_reason === 'length';

  const content = (data.message?.content ?? '').trim();
  if (!content) {
    // Thinking-only response (Gemma 4 thinking mode, or the token cap spent
    // entirely on reasoning). This used to return the first line of the
    // reasoning as the answer, so a townsperson could say aloud "The user
    // wants me to respond as Omar…" and a plan or reflection could be built
    // from it. An empty answer is an error — typed, so callers can tell it
    // from the LLM being unreachable (see LLMEmptyReplyError).
    const thinkingOnly = Boolean(data.message?.thinking);
    throw new LLMEmptyReplyError(
      thinkingOnly
        ? "Ollama response had only thinking, no message content"
        : "Ollama response missing message content",
    );
  }

  return { text: content, truncated: data.done_reason === 'length' };
}

/** OpenAI-compatible /v1/chat/completions (llama-server, vLLM, etc.) */
async function sendOpenAI(
  request: OllamaChatRequest,
  signal: AbortSignal,
  sample: LLMCallSample,
): Promise<OllamaChatResponse> {
  const baseUrl = request.baseUrl ?? CONFIG.AI.CHAT_BASE_URL;
  const body: any = {
    model: request.model,
    messages: [
      { role: "system", content: request.system },
      ...request.messages,
    ],
    stream: false,
    temperature: request.options?.temperature ?? CONFIG.AI.CHAT_TEMPERATURE,
    top_p: request.options?.top_p ?? CONFIG.AI.CHAT_TOP_P,
    max_tokens: request.options?.num_predict ?? CONFIG.AI.CHAT_MAX_TOKENS,
    frequency_penalty: request.options?.repeat_penalty
      ? (request.options.repeat_penalty - 1.0) * 2 // rough Ollama→OpenAI conversion
      : 0,
  };

  if (request.options?.stop) {
    body.stop = request.options.stop;
  }
  if (request.format === 'json') {
    body.response_format = { type: 'json_object' };
  } else if (request.format) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema: request.format } };
  }

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(
      `OpenAI chat request failed (${response.status}): ${errorText}`
    );
  }

  const data = await response.json();
  sample.promptTokens = data.usage?.prompt_tokens;
  sample.outputTokens = data.usage?.completion_tokens;
  sample.truncated = data.choices?.[0]?.finish_reason === 'length';
  // Trimmed like the Ollama path: a whitespace-only answer is an empty one.
  const message = data.choices?.[0]?.message;
  const content = (message?.content ?? '').trim();
  if (!content) {
    throw new LLMEmptyReplyError(
      message?.reasoning_content
        ? "OpenAI response had only reasoning_content, no message content"
        : "OpenAI response missing message content",
    );
  }

  return { text: content, truncated: data.choices?.[0]?.finish_reason === 'length' };
}

// ─── Embeddings (always Ollama) ──────────────────────────────────────────────

export async function callOllamaEmbedding(
  text: string,
  baseUrl?: string
): Promise<number[]> {
  const url_base = baseUrl ?? CONFIG.AI.EMBED_BASE_URL;
  const url = `${url_base}/api/embeddings`;

  // Embedding pool, not the chat slots: see the header of llmSemaphore.ts.
  const release = await acquireEmbeddingSlot('low');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.AI.TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CONFIG.AI.EMBEDDING_MODEL,
        prompt: text,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `Embedding request failed (${response.status}): ${errorText}`
      );
    }

    const data = await response.json();

    if (!Array.isArray(data.embedding)) {
      throw new Error("Response missing embedding array");
    }

    return data.embedding;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error(`Embedding request timed out after ${CONFIG.AI.TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    release();
  }
}
