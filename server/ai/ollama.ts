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

export interface OllamaChatRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  baseUrl?: string;
  priority?: LLMPriority;
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
  const backend = CONFIG.AI.BACKEND;
  if (backend === 'openai') {
    return callOpenAIChat(request);
  }
  return callOllamaBackend(request);
}

/** Ollama native /api/chat */
async function callOllamaBackend(
  request: OllamaChatRequest
): Promise<OllamaChatResponse> {
  const baseUrl = request.baseUrl ?? CONFIG.AI.CHAT_BASE_URL;
  const url = `${baseUrl}/api/chat`;

  // Already cancelled: don't even queue for a slot.
  if (request.signal?.aborted) throw new LLMAbortedError();
  const release = await acquireLLMSlot(request.priority ?? 'normal');
  // Cancelled while queued for the slot: hand it straight back.
  if (request.signal?.aborted) {
    release();
    throw new LLMAbortedError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.AI.TIMEOUT_MS);
  const unlink = linkAbort(request.signal, controller);

  try {
    const body = {
      model: request.model,
      messages: [
        { role: "system" as const, content: request.system },
        ...request.messages,
      ],
      stream: false,
      think: false,
      options: request.options,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `Ollama chat request failed (${response.status}): ${errorText}`
      );
    }

    const data = await response.json();

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
  } catch (error: any) {
    if (error.name === "AbortError") {
      if (request.signal?.aborted) throw new LLMAbortedError();
      throw new Error(`LLM request timed out after ${CONFIG.AI.TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    unlink();
    release();
  }
}

/** OpenAI-compatible /v1/chat/completions (llama-server, vLLM, etc.) */
async function callOpenAIChat(
  request: OllamaChatRequest
): Promise<OllamaChatResponse> {
  const baseUrl = request.baseUrl ?? CONFIG.AI.CHAT_BASE_URL;
  const url = `${baseUrl}/v1/chat/completions`;

  // Already cancelled: don't even queue for a slot.
  if (request.signal?.aborted) throw new LLMAbortedError();
  const release = await acquireLLMSlot(request.priority ?? 'normal');
  // Cancelled while queued for the slot: hand it straight back.
  if (request.signal?.aborted) {
    release();
    throw new LLMAbortedError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.AI.TIMEOUT_MS);
  const unlink = linkAbort(request.signal, controller);

  try {
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

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `OpenAI chat request failed (${response.status}): ${errorText}`
      );
    }

    const data = await response.json();
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
  } catch (error: any) {
    if (error.name === "AbortError") {
      if (request.signal?.aborted) throw new LLMAbortedError();
      throw new Error(`LLM request timed out after ${CONFIG.AI.TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    unlink();
    release();
  }
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
