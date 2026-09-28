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

export interface OllamaChatRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  baseUrl?: string;
  priority?: LLMPriority;
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

  const release = await acquireLLMSlot(request.priority ?? 'normal');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.AI.TIMEOUT_MS);

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
      // Thinking-only response (Gemma 4 thinking mode) — extract thinking as fallback
      const thinking = data.message?.thinking ?? '';
      if (thinking) {
        // Use a brief summary from thinking if available
        return { text: thinking.split('\n')[0].slice(0, 100) || 'Hmm...' };
      }
      throw new Error("Ollama response missing message content");
    }

    return { text: content, truncated: data.done_reason === 'length' };
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error(`LLM request timed out after ${CONFIG.AI.TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    release();
  }
}

/** OpenAI-compatible /v1/chat/completions (llama-server, vLLM, etc.) */
async function callOpenAIChat(
  request: OllamaChatRequest
): Promise<OllamaChatResponse> {
  const baseUrl = request.baseUrl ?? CONFIG.AI.CHAT_BASE_URL;
  const url = `${baseUrl}/v1/chat/completions`;

  const release = await acquireLLMSlot(request.priority ?? 'normal');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.AI.TIMEOUT_MS);

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
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) {
      throw new Error("OpenAI response missing message content");
    }

    return { text: content, truncated: data.choices?.[0]?.finish_reason === 'length' };
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error(`LLM request timed out after ${CONFIG.AI.TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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
