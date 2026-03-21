/**
 * Ollama HTTP Client
 *
 * IMPORTANT: These functions use `fetch` and can ONLY be called from
 * Convex `action` functions, never from queries or mutations.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// Convex action runtime provides these globals; declare for type-checking
// when DOM lib is not included in tsconfig.
declare const fetch: any;
declare const AbortController: any;
declare const setTimeout: (fn: () => void, ms: number) => any;
declare const clearTimeout: (id: any) => void;
declare const process: { env: Record<string, string | undefined> };

export interface OllamaChatRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
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
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const url = `${baseUrl}/api/chat`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const body = {
      model: request.model,
      messages: [
        { role: "system" as const, content: request.system },
        ...request.messages,
      ],
      stream: false,
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

    if (!data.message?.content) {
      throw new Error("Ollama response missing message content");
    }

    return { text: data.message.content };
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error("Ollama chat request timed out after 15s");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callOllamaEmbedding(text: string): Promise<number[]> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const url = `${baseUrl}/api/embeddings`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

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
      throw new Error("Ollama embedding request timed out after 15s");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
