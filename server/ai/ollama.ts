/**
 * Ollama HTTP Client
 *
 * Plain async functions for LLM chat and embeddings via Ollama REST API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { CONFIG } from '../lib/constants';

export interface OllamaChatRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  baseUrl?: string;
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
}

export async function callOllamaChat(
  request: OllamaChatRequest
): Promise<OllamaChatResponse> {
  const baseUrl =
    request.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const url = `${baseUrl}/api/chat`;

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

    const content = data.message?.content ?? '';
    if (!content && !data.message?.thinking) {
      throw new Error("Ollama response missing message content");
    }

    // Some models (e.g., Gemma 4) return thinking + content; use content if available, else extract from thinking
    return { text: content || '' };
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error(`Ollama request timed out after ${CONFIG.AI.TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callOllamaEmbedding(
  text: string,
  baseUrl?: string
): Promise<number[]> {
  const url_base =
    baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const url = `${url_base}/api/embeddings`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.AI.TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mxbai-embed-large",
        prompt: text,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `Ollama embedding request failed (${response.status}): ${errorText}`
      );
    }

    const data = await response.json();

    if (!Array.isArray(data.embedding)) {
      throw new Error("Ollama response missing embedding array");
    }

    return data.embedding;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error(`Ollama request timed out after ${CONFIG.AI.TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
